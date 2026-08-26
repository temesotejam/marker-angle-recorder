// 既存の video-rwlog-angle-analyzer/src/analysis.js で使っていた
// 白丸2点の認識・追跡方式を、そのしきい値を変えずにリアルタイム入力へ移植する。
// 認識方式を変える場合は、この互換契約を明示的に更新すること。

export const LEGACY_WHITE_MARKER_CONFIG = Object.freeze({
  canonicalWidth: 1280,
  canonicalHeight: 720,
  searchRegion: Object.freeze([300, 380, 700, 140]),
  roiWidth: 96,
  roiHeight: 90,
  initial: Object.freeze({
    saturationMax255: 85,
    valueMin255: 120,
    areaMin: 180,
    areaMax: 1600,
    widthMin: 12,
    widthMax: 55,
    heightMin: 12,
    heightMax: 55,
    fillMin: 0.35,
    pairDxMin: 180,
    pairDxMax: 450,
    pairDyMax: 45,
  }),
  tracking: Object.freeze({
    saturationMax255: 70,
    valueMin255: 145,
    areaMin: 140,
    areaMax: 2500,
    widthMin: 8,
    widthMax: 90,
    heightMin: 8,
    heightMax: 90,
    fillMin: 0.30,
    morphRadius: 2,
    expandedRoiScale: 1.8,
  }),
});

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

function morph(mask, w, h, op, r = LEGACY_WHITE_MARKER_CONFIG.tracking.morphRadius) {
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

function detectionFromFrame(ctx, roi, previous, initial = false) {
  const [x0, y0, w, h] = roi;
  const img = ctx.getImageData(x0, y0, w, h);
  const init = LEGACY_WHITE_MARKER_CONFIG.initial;
  const track = LEGACY_WHITE_MARKER_CONFIG.tracking;
  const mask0 = whiteMask(img.data, w, h, initial ? init.saturationMax255 : track.saturationMax255, initial ? init.valueMin255 : track.valueMin255);
  const mask = initial ? mask0 : openClose(mask0, w, h);
  const cs = components(mask, w, h), cands = [];
  for (const c of cs) {
    if (initial) {
      if (c.area < init.areaMin || c.area > init.areaMax || c.w < init.widthMin || c.w > init.widthMax || c.h < init.heightMin || c.h > init.heightMax) continue;
    } else {
      if (c.area < track.areaMin || c.area > track.areaMax || c.w < track.widthMin || c.w > track.widthMax || c.h < track.heightMin || c.h > track.heightMax) continue;
    }
    const fill = c.area / (c.w * c.h);
    if (fill < (initial ? init.fillMin : track.fillMin)) continue;
    cands.push({ ...c, cx: c.cx + x0, cy: c.cy + y0, x: c.x + x0, y: c.y + y0, fill });
  }
  if (!cands.length) return null;
  if (initial || !previous) return cands.reduce((a, b) => (b.area > a.area || (b.area === a.area && b.fill > a.fill)) ? b : a, cands[0]);
  return cands.reduce((a, b) => ((b.cx - previous.cx) ** 2 + (b.cy - previous.cy) ** 2 < (a.cx - previous.cx) ** 2 + (a.cy - previous.cy) ** 2) ? b : a, cands[0]);
}

function autoWhiteRoisFromCanvas(ctx, fw, fh) {
  const cfg = LEGACY_WHITE_MARKER_CONFIG, init = cfg.initial;
  const [x0, y0, w, h] = clampRoi(cfg.searchRegion, fw, fh);
  const img = ctx.getImageData(x0, y0, w, h);
  const mask = whiteMask(img.data, w, h, init.saturationMax255, init.valueMin255);
  const cs = components(mask, w, h), cands = [];
  for (const c of cs) {
    if (c.area < init.areaMin || c.area > init.areaMax || c.w < init.widthMin || c.w > init.widthMax || c.h < init.heightMin || c.h > init.heightMax) continue;
    const fill = c.area / (c.w * c.h);
    if (fill < init.fillMin) continue;
    cands.push({ ...c, cx: c.cx + x0, cy: c.cy + y0 });
  }
  let best = null;
  for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
    let [l, r] = cands[i].cx < cands[j].cx ? [cands[i], cands[j]] : [cands[j], cands[i]];
    const dx = r.cx - l.cx, dy = Math.abs(r.cy - l.cy);
    if (dx < init.pairDxMin || dx > init.pairDxMax || dy > init.pairDyMax) continue;
    const areaSim = Math.min(l.area, r.area) / Math.max(l.area, r.area);
    const shape = Math.min(l.w / r.w, r.w / l.w) * Math.min(l.h / r.h, r.h / l.h);
    const score = Math.min(l.area, r.area) * (1 + areaSim + shape) - 12 * dy;
    if (!best || score > best.score) best = { score, l, r };
  }
  if (!best) return null;
  return {
    white_l: roiFromCenter(best.l.cx, best.l.cy, cfg.roiWidth, cfg.roiHeight, fw, fh),
    white_r: roiFromCenter(best.r.cx, best.r.cy, cfg.roiWidth, cfg.roiHeight, fw, fh),
  };
}

export function createLegacyWhiteMarkerTracker() {
  let rois = null;
  let prev = { white_l: null, white_r: null };

  return {
    reset() { rois = null; prev = { white_l: null, white_r: null }; },
    get initialized() { return !!rois; },
    process(ctx, fw, fh) {
      if (!rois) {
        rois = autoWhiteRoisFromCanvas(ctx, fw, fh);
        if (!rois) return { detected: false, initialized: false, status: 'searching' };
      }

      const detections = {}, modes = {};
      for (const name of ['white_l', 'white_r']) {
        const base = rois[name];
        const roi = prev[name] ? roiFromCenter(prev[name].cx, prev[name].cy, base[2], base[3], fw, fh) : base;
        let mode = prev[name] ? 'previous_center' : 'initial_static';
        let d = detectionFromFrame(ctx, roi, prev[name], false);
        if (!d && prev[name]) {
          const scale = LEGACY_WHITE_MARKER_CONFIG.tracking.expandedRoiScale;
          const big = roiFromCenter(prev[name].cx, prev[name].cy, base[2] * scale, base[3] * scale, fw, fh);
          d = detectionFromFrame(ctx, big, prev[name], false);
          if (d) mode = 'previous_center_expanded';
        }
        if (d) prev[name] = d;
        detections[name] = d;
        modes[name] = mode;
      }

      const left = detections.white_l, right = detections.white_r;
      if (!left || !right) return { detected: false, initialized: true, status: 'lost', left, right, modes };
      return { detected: true, initialized: true, status: 'tracking', left, right, modes, rois };
    },
  };
}

export function drawMarkerOverlay(canvas, videoWidth, videoHeight, result) {
  const ctx = canvas.getContext('2d');
  if (canvas.width !== videoWidth || canvas.height !== videoHeight) { canvas.width = videoWidth; canvas.height = videoHeight; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!result?.detected) return;
  const a = result.a, b = result.b;
  ctx.lineWidth = Math.max(2, videoWidth / 500); ctx.strokeStyle = '#f8fafc';
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  for (const [point, label, color] of [[a, '左', '#fb7185'], [b, '右', '#60a5fa']]) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, videoWidth / 400); ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(8, videoWidth / 90), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color; ctx.font = `${Math.max(16, videoWidth / 45)}px system-ui`; ctx.fillText(label, point.x + 12, point.y - 12);
  }
}
