import { LEGACY_WHITE_MARKER_CONFIG as CFG, MARKER_REACQUIRE_AFTER_LOST_FRAMES } from './marker.js';

const $ = id => document.getElementById(id);
const el = {
  cameraSelect: $('cameraSelect'), startCamera: $('startCamera'), pauseButton: $('pauseButton'), resetTracking: $('resetTracking'), status: $('statusText'),
  video: $('cameraVideo'), canonical: $('canonicalCanvas'), source: $('sourceCanvas'), searchCrop: $('searchCropCanvas'), searchMask: $('searchMaskCanvas'),
  leftRoi: $('leftRoiCanvas'), leftRaw: $('leftRawMaskCanvas'), leftMorph: $('leftMorphCanvas'),
  rightRoi: $('rightRoiCanvas'), rightRaw: $('rightRawMaskCanvas'), rightMorph: $('rightMorphCanvas'),
  leftExpanded: $('leftExpandedCanvas'), leftExpandedMask: $('leftExpandedMaskCanvas'),
  rightExpanded: $('rightExpandedCanvas'), rightExpandedMask: $('rightExpandedMaskCanvas'), final: $('finalCanvas'),
};

const state = {
  stream: null, token: 0, paused: false,
  rois: null, prev: { white_l: null, white_r: null }, lostStreak: 0, reacquireCount: 0,
};

function pyRound(x) {
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return f % 2 === 0 ? f : f + 1;
}

function clampRoi(roi, fw, fh) {
  let [x, y, w, h] = roi;
  w = Math.min(fw, Math.max(1, pyRound(w)));
  h = Math.min(fh, Math.max(1, pyRound(h)));
  x = Math.min(Math.max(0, pyRound(x)), fw - w);
  y = Math.min(Math.max(0, pyRound(y)), fh - h);
  return [x, y, w, h];
}

function roiFromCenter(cx, cy, w, h, fw, fh) {
  return clampRoi([cx - w / 2, cy - h / 2, w, h], fw, fh);
}

function whiteMask(rgba, w, h, sMax, vMin) {
  const out = new Uint8Array(w * h);
  for (let p = 0, i = 0; p < out.length; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max === 0 ? 0 : (max - min) * 255 / max;
    if (max >= vMin && sat <= sMax) out[p] = 1;
  }
  return out;
}

function morphPass(mask, w, h, r, erode, horizontal) {
  const out = new Uint8Array(mask.length);
  if (horizontal) {
    for (let y = 0; y < h; y++) {
      const pref = new Int32Array(w + 1);
      for (let x = 0; x < w; x++) pref[x + 1] = pref[x] + mask[y * w + x];
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, x - r), b = Math.min(w, x + r + 1);
        const sum = pref[b] - pref[a], need = erode ? (b - a) : (2 * r + 1);
        out[y * w + x] = erode ? (sum === need ? 1 : 0) : (sum > 0 ? 1 : 0);
      }
    }
  } else {
    for (let x = 0; x < w; x++) {
      const pref = new Int32Array(h + 1);
      for (let y = 0; y < h; y++) pref[y + 1] = pref[y] + mask[y * w + x];
      for (let y = 0; y < h; y++) {
        const a = Math.max(0, y - r), b = Math.min(h, y + r + 1);
        const sum = pref[b] - pref[a], need = erode ? (b - a) : (2 * r + 1);
        out[y * w + x] = erode ? (sum === need ? 1 : 0) : (sum > 0 ? 1 : 0);
      }
    }
  }
  return out;
}

function morph(mask, w, h, op, r = CFG.tracking.morphRadius) {
  if (op === 'erode') return morphPass(morphPass(mask, w, h, r, true, true), w, h, r, true, false);
  return morphPass(morphPass(mask, w, h, r, false, true), w, h, r, false, false);
}

function openClose(mask, w, h) {
  let x = morph(mask, w, h, 'erode');
  x = morph(x, w, h, 'dilate');
  x = morph(x, w, h, 'dilate');
  x = morph(x, w, h, 'erode');
  return x;
}

function components(mask, w, h) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length), out = [];
  const dx = [-1, 0, 1, -1, 1, -1, 0, 1], dy = [-1, -1, -1, 0, 0, 1, 1, 1];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || visited[p]) continue;
    let head = 0, tail = 0; queue[tail++] = p; visited[p] = 1;
    let area = 0, sx = 0, sy = 0, minx = w, miny = h, maxx = -1, maxy = -1;
    while (head < tail) {
      const q = queue[head++], y = Math.floor(q / w), x = q - y * w;
      area++; sx += x; sy += y;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (let k = 0; k < 8; k++) {
        const nx = x + dx[k], ny = y + dy[k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const np = ny * w + nx;
        if (mask[np] && !visited[np]) { visited[np] = 1; queue[tail++] = np; }
      }
    }
    out.push({ area, x: minx, y: miny, w: maxx - minx + 1, h: maxy - miny + 1, cx: sx / area, cy: sy / area });
  }
  return out;
}

function initialCandidates(mask, w, h) {
  const cands = [], init = CFG.initial;
  for (const c of components(mask, w, h)) {
    if (c.area < init.areaMin || c.area > init.areaMax || c.w < init.widthMin || c.w > init.widthMax || c.h < init.heightMin || c.h > init.heightMax) continue;
    const fill = c.area / (c.w * c.h);
    if (fill < init.fillMin) continue;
    cands.push({ ...c, fill });
  }
  return cands;
}

function trackingCandidates(mask, w, h) {
  const cands = [], track = CFG.tracking;
  for (const c of components(mask, w, h)) {
    if (c.area < track.areaMin || c.area > track.areaMax || c.w < track.widthMin || c.w > track.widthMax || c.h < track.heightMin || c.h > track.heightMax) continue;
    const fill = c.area / (c.w * c.h);
    if (fill < track.fillMin) continue;
    cands.push({ ...c, fill });
  }
  return cands;
}

function bestInitialPair(cands, x0, y0) {
  const init = CFG.initial;
  const global = cands.map(c => ({ ...c, cx: c.cx + x0, cy: c.cy + y0, x: c.x + x0, y: c.y + y0 }));
  let best = null;
  for (let i = 0; i < global.length; i++) for (let j = i + 1; j < global.length; j++) {
    let [l, r] = global[i].cx < global[j].cx ? [global[i], global[j]] : [global[j], global[i]];
    const dx = r.cx - l.cx, dy = Math.abs(r.cy - l.cy);
    if (dx < init.pairDxMin || dx > init.pairDxMax || dy > init.pairDyMax) continue;
    const areaSim = Math.min(l.area, r.area) / Math.max(l.area, r.area);
    const shape = Math.min(l.w / r.w, r.w / l.w) * Math.min(l.h / r.h, r.h / l.h);
    const score = Math.min(l.area, r.area) * (1 + areaSim + shape) - 12 * dy;
    if (!best || score > best.score) best = { score, l, r };
  }
  return best;
}

function chooseTrackingCandidate(cands, roi, previous) {
  if (!cands.length) return null;
  const [x0, y0] = roi;
  const global = cands.map(c => ({ ...c, cx: c.cx + x0, cy: c.cy + y0, x: c.x + x0, y: c.y + y0 }));
  if (!previous) return global.reduce((a, b) => (b.area > a.area || (b.area === a.area && b.fill > a.fill)) ? b : a, global[0]);
  return global.reduce((a, b) => ((b.cx - previous.cx) ** 2 + (b.cy - previous.cy) ** 2 < (a.cx - previous.cx) ** 2 + (a.cy - previous.cy) ** 2) ? b : a, global[0]);
}

function analyzeInitial(ctx) {
  const [x0, y0, w, h] = clampRoi(CFG.searchRegion, CFG.canonicalWidth, CFG.canonicalHeight);
  const img = ctx.getImageData(x0, y0, w, h);
  const mask = whiteMask(img.data, w, h, CFG.initial.saturationMax255, CFG.initial.valueMin255);
  const cands = initialCandidates(mask, w, h);
  const best = bestInitialPair(cands, x0, y0);
  const rois = best ? {
    white_l: roiFromCenter(best.l.cx, best.l.cy, CFG.roiWidth, CFG.roiHeight, CFG.canonicalWidth, CFG.canonicalHeight),
    white_r: roiFromCenter(best.r.cx, best.r.cy, CFG.roiWidth, CFG.roiHeight, CFG.canonicalWidth, CFG.canonicalHeight),
  } : null;
  return { roi: [x0, y0, w, h], img, mask, cands, best, rois };
}

function analyzeTracking(ctx, roi, previous) {
  const [x0, y0, w, h] = roi;
  const img = ctx.getImageData(x0, y0, w, h);
  const rawMask = whiteMask(img.data, w, h, CFG.tracking.saturationMax255, CFG.tracking.valueMin255);
  const morphMask = openClose(rawMask, w, h);
  const cands = trackingCandidates(morphMask, w, h);
  const selected = chooseTrackingCandidate(cands, roi, previous);
  return { roi, img, rawMask, morphMask, cands, selected };
}

function drawImageData(canvas, imageData) {
  canvas.width = imageData.width; canvas.height = imageData.height;
  canvas.getContext('2d').putImageData(imageData, 0, 0);
}

function drawMask(canvas, mask, w, h, candidates = [], selected = null) {
  canvas.width = w; canvas.height = h;
  const out = new Uint8ClampedArray(w * h * 4);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    const v = mask[p] ? 255 : 0;
    out[i] = v; out[i + 1] = v; out[i + 2] = v; out[i + 3] = 255;
  }
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(out, w, h), 0, 0);
  ctx.lineWidth = Math.max(1, Math.round(Math.min(w, h) / 90));
  ctx.strokeStyle = '#ffb454';
  for (const c of candidates) ctx.strokeRect(c.x, c.y, c.w, c.h);
  if (selected) {
    ctx.strokeStyle = '#57e389'; ctx.lineWidth = Math.max(2, Math.round(Math.min(w, h) / 55));
    ctx.strokeRect(selected.x, selected.y, selected.w, selected.h);
  }
}

function clearCanvas(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#05080d'; ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawSourceOverlay(canvas, canonical, initial, tracking) {
  canvas.width = CFG.canonicalWidth; canvas.height = CFG.canonicalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(canonical, 0, 0);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#ffd166';
  ctx.strokeRect(...initial.roi);
  if (state.rois) {
    ctx.strokeStyle = '#6ea8fe';
    ctx.strokeRect(...state.rois.white_l); ctx.strokeRect(...state.rois.white_r);
  }
  for (const side of ['white_l', 'white_r']) {
    const t = tracking[side];
    if (!t) continue;
    ctx.strokeStyle = '#9b8cff';
    if (t.normal) ctx.strokeRect(...t.normal.roi);
    if (t.expanded) { ctx.strokeStyle = '#ff7b72'; ctx.strokeRect(...t.expanded.roi); }
    const d = t.selected;
    if (d) {
      ctx.fillStyle = side === 'white_l' ? '#ff6b8a' : '#5aa9ff';
      ctx.beginPath(); ctx.arc(d.cx, d.cy, 7, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawFinal(canvas, canonical, detections) {
  canvas.width = CFG.canonicalWidth; canvas.height = CFG.canonicalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(canonical, 0, 0);
  const l = detections.white_l, r = detections.white_r;
  if (!l || !r) return;
  ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(l.cx, l.cy); ctx.lineTo(r.cx, r.cy); ctx.stroke();
  for (const [d, color] of [[l, '#ff6b8a'], [r, '#5aa9ff']]) {
    ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.beginPath(); ctx.arc(d.cx, d.cy, 14, 0, Math.PI * 2); ctx.stroke();
  }
}

function renderTrackingPanel(side, normal, expanded) {
  const left = side === 'white_l';
  const actualCanvas = left ? el.leftRoi : el.rightRoi;
  const rawCanvas = left ? el.leftRaw : el.rightRaw;
  const morphCanvas = left ? el.leftMorph : el.rightMorph;
  const expandedCanvas = left ? el.leftExpanded : el.rightExpanded;
  const expandedMaskCanvas = left ? el.leftExpandedMask : el.rightExpandedMask;

  if (normal) {
    drawImageData(actualCanvas, normal.img);
    drawMask(rawCanvas, normal.rawMask, normal.img.width, normal.img.height);
    const localSelected = normal.selected ? { ...normal.selected, x: normal.selected.x - normal.roi[0], y: normal.selected.y - normal.roi[1] } : null;
    drawMask(morphCanvas, normal.morphMask, normal.img.width, normal.img.height, normal.cands, localSelected);
  } else {
    clearCanvas(actualCanvas); clearCanvas(rawCanvas); clearCanvas(morphCanvas);
  }

  if (expanded) {
    drawImageData(expandedCanvas, expanded.img);
    const localSelected = expanded.selected ? { ...expanded.selected, x: expanded.selected.x - expanded.roi[0], y: expanded.selected.y - expanded.roi[1] } : null;
    drawMask(expandedMaskCanvas, expanded.morphMask, expanded.img.width, expanded.img.height, expanded.cands, localSelected);
  } else {
    clearCanvas(expandedCanvas); clearCanvas(expandedMaskCanvas);
  }
}

function resetTracking() {
  state.rois = null; state.prev = { white_l: null, white_r: null }; state.lostStreak = 0;
}

function processFrame() {
  if (state.paused || !state.stream) return;
  const ctx = el.canonical.getContext('2d', { willReadFrequently: true, alpha: false });
  ctx.drawImage(el.video, 0, 0, CFG.canonicalWidth, CFG.canonicalHeight);

  const initial = analyzeInitial(ctx);
  drawImageData(el.searchCrop, initial.img);
  drawMask(el.searchMask, initial.mask, initial.img.width, initial.img.height, initial.cands, null);

  if (!state.rois && initial.rois) state.rois = initial.rois;

  const tracking = {}, detections = {};
  if (state.rois) {
    for (const name of ['white_l', 'white_r']) {
      const base = state.rois[name];
      const normalRoi = state.prev[name]
        ? roiFromCenter(state.prev[name].cx, state.prev[name].cy, base[2], base[3], CFG.canonicalWidth, CFG.canonicalHeight)
        : base;
      const normal = analyzeTracking(ctx, normalRoi, state.prev[name]);
      let expanded = null, selected = normal.selected;
      if (!selected && state.prev[name]) {
        const scale = CFG.tracking.expandedRoiScale;
        const expandedRoi = roiFromCenter(state.prev[name].cx, state.prev[name].cy, base[2] * scale, base[3] * scale, CFG.canonicalWidth, CFG.canonicalHeight);
        expanded = analyzeTracking(ctx, expandedRoi, state.prev[name]);
        selected = expanded.selected;
      }
      if (selected) state.prev[name] = selected;
      detections[name] = selected;
      tracking[name] = { normal, expanded, selected };
      renderTrackingPanel(name, normal, expanded);
    }
  } else {
    renderTrackingPanel('white_l', null, null); renderTrackingPanel('white_r', null, null);
  }

  const pairOk = !!(detections.white_l && detections.white_r);
  if (pairOk) {
    state.lostStreak = 0;
  } else if (state.rois) {
    state.lostStreak++;
    if (state.lostStreak >= MARKER_REACQUIRE_AFTER_LOST_FRAMES) {
      state.reacquireCount++;
      state.rois = initial.rois;
      state.prev = { white_l: null, white_r: null };
      state.lostStreak = 0;
    }
  }

  drawSourceOverlay(el.source, el.canonical, initial, tracking);
  drawFinal(el.final, el.canonical, detections);
  if (pairOk) el.status.textContent = '追跡中';
  else if (!state.rois) el.status.textContent = '初期探索中';
  else el.status.textContent = '見失い / 再捕捉待ち';
}

function schedule(token) {
  if (!state.stream || token !== state.token) return;
  const cb = () => { if (!state.stream || token !== state.token) return; processFrame(); schedule(token); };
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) el.video.requestVideoFrameCallback(cb);
  else requestAnimationFrame(cb);
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const previous = el.cameraSelect.value;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  el.cameraSelect.innerHTML = '';
  devices.forEach((d, i) => {
    const option = document.createElement('option'); option.value = d.deviceId; option.textContent = d.label || `カメラ ${i + 1}`; el.cameraSelect.appendChild(option);
  });
  if ([...el.cameraSelect.options].some(o => o.value === previous)) el.cameraSelect.value = previous;
}

function stopCamera() {
  state.token++;
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null; el.video.srcObject = null; resetTracking();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('このブラウザではカメラAPIを利用できません。');
  stopCamera();
  const deviceId = el.cameraSelect.value;
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  el.video.srcObject = state.stream; await el.video.play(); await refreshCameraList(); resetTracking();
  state.paused = false; el.pauseButton.textContent = '一時停止'; el.pauseButton.disabled = false; el.resetTracking.disabled = false;
  el.status.textContent = '初期探索中';
  const token = ++state.token; schedule(token);
}

el.startCamera.addEventListener('click', () => startCamera().catch(error => { el.status.textContent = String(error); }));
el.pauseButton.addEventListener('click', () => {
  state.paused = !state.paused;
  el.pauseButton.textContent = state.paused ? '再開' : '一時停止';
  el.status.textContent = state.paused ? '一時停止中' : '再開';
});
el.resetTracking.addEventListener('click', () => { resetTracking(); el.status.textContent = '追跡リセット'; });
window.addEventListener('beforeunload', stopCamera);
refreshCameraList().catch(() => {});
