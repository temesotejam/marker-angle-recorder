import { LEGACY_WHITE_MARKER_CONFIG as CFG, MARKER_REACQUIRE_AFTER_LOST_FRAMES } from './marker.js';

export const DEFAULT_RELATIVE_WHITE_OPTIONS = Object.freeze({
  deltaV: 28,
  localRadius: 20,
});

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

function sanitizeOptions(options = {}) {
  const deltaV = Math.max(1, Math.min(120, Number(options.deltaV ?? DEFAULT_RELATIVE_WHITE_OPTIONS.deltaV)));
  const localRadius = Math.max(2, Math.min(60, Math.round(Number(options.localRadius ?? DEFAULT_RELATIVE_WHITE_OPTIONS.localRadius))));
  return { deltaV, localRadius };
}

function boxSum(integral, stride, x0, y0, x1, y1) {
  return integral[y1 * stride + x1] - integral[y0 * stride + x1] - integral[y1 * stride + x0] + integral[y0 * stride + x0];
}

export function relativeWhiteMask(rgba, w, h, saturationMax255, options = {}) {
  const { deltaV, localRadius } = sanitizeOptions(options);
  const count = w * h;
  const values = new Uint8Array(count);
  const sats = new Float32Array(count);
  const stride = w + 1;
  const integral = new Float64Array((w + 1) * (h + 1));

  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    for (let x = 0; x < w; x++) {
      const p = y * w + x, i = p * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) * 255 / max;
      values[p] = max;
      sats[p] = sat;
      rowSum += max;
      integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + rowSum;
    }
  }

  const out = new Uint8Array(count);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - localRadius), y1 = Math.min(h, y + localRadius + 1);
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (sats[p] > saturationMax255) continue;
      const x0 = Math.max(0, x - localRadius), x1 = Math.min(w, x + localRadius + 1);
      const area = (x1 - x0) * (y1 - y0);
      const localMean = boxSum(integral, stride, x0, y0, x1, y1) / area;
      if (values[p] - localMean >= deltaV) out[p] = 1;
    }
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

export function components8(mask, w, h) {
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

function filterCandidates(mask, w, h, initial) {
  const rule = initial ? CFG.initial : CFG.tracking;
  const out = [];
  for (const c of components8(mask, w, h)) {
    if (c.area < rule.areaMin || c.area > rule.areaMax || c.w < rule.widthMin || c.w > rule.widthMax || c.h < rule.heightMin || c.h > rule.heightMax) continue;
    const fill = c.area / (c.w * c.h);
    if (fill < rule.fillMin) continue;
    out.push({ ...c, fill });
  }
  return out;
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

function analyzeInitial(ctx, searchRegion, options) {
  const [x0, y0, w, h] = clampRoi(searchRegion, CFG.canonicalWidth, CFG.canonicalHeight);
  const img = ctx.getImageData(x0, y0, w, h);
  const mask = relativeWhiteMask(img.data, w, h, CFG.initial.saturationMax255, options);
  const cands = filterCandidates(mask, w, h, true);
  const best = bestInitialPair(cands, x0, y0);
  const rois = best ? {
    white_l: roiFromCenter(best.l.cx, best.l.cy, CFG.roiWidth, CFG.roiHeight, CFG.canonicalWidth, CFG.canonicalHeight),
    white_r: roiFromCenter(best.r.cx, best.r.cy, CFG.roiWidth, CFG.roiHeight, CFG.canonicalWidth, CFG.canonicalHeight),
  } : null;
  return { roi: [x0, y0, w, h], img, mask, cands, best, rois };
}

function analyzeTracking(ctx, roi, previous, options) {
  const [x0, y0, w, h] = roi;
  const img = ctx.getImageData(x0, y0, w, h);
  const rawMask = relativeWhiteMask(img.data, w, h, CFG.tracking.saturationMax255, options);
  const morphMask = openClose(rawMask, w, h);
  const cands = filterCandidates(morphMask, w, h, false);
  const selected = chooseTrackingCandidate(cands, roi, previous);
  return { roi, img, rawMask, morphMask, cands, selected };
}

export function createRelativeWhiteMarkerTracker(options = {}) {
  let cfg = sanitizeOptions(options);
  let rois = null;
  let prev = { white_l: null, white_r: null };
  let lostStreak = 0;
  let reacquireCount = 0;

  const reset = () => {
    rois = null;
    prev = { white_l: null, white_r: null };
    lostStreak = 0;
  };

  return {
    reset,
    setOptions(next) { cfg = sanitizeOptions(next); reset(); },
    get options() { return { ...cfg }; },
    process(ctx, searchRegion = CFG.searchRegion) {
      const initial = analyzeInitial(ctx, searchRegion, cfg);
      if (!rois && initial.rois) rois = initial.rois;
      const tracking = {}, detections = {};

      if (rois) {
        for (const name of ['white_l', 'white_r']) {
          const base = rois[name];
          const normalRoi = prev[name]
            ? roiFromCenter(prev[name].cx, prev[name].cy, base[2], base[3], CFG.canonicalWidth, CFG.canonicalHeight)
            : base;
          const normal = analyzeTracking(ctx, normalRoi, prev[name], cfg);
          let expanded = null, selected = normal.selected;
          if (!selected && prev[name]) {
            const scale = CFG.tracking.expandedRoiScale;
            const expandedRoi = roiFromCenter(prev[name].cx, prev[name].cy, base[2] * scale, base[3] * scale, CFG.canonicalWidth, CFG.canonicalHeight);
            expanded = analyzeTracking(ctx, expandedRoi, prev[name], cfg);
            selected = expanded.selected;
          }
          if (selected) prev[name] = selected;
          detections[name] = selected;
          tracking[name] = { normal, expanded, selected };
        }
      }

      const left = detections.white_l, right = detections.white_r;
      if (left && right) {
        lostStreak = 0;
        return { detected: true, initialized: true, status: 'tracking', left, right, rois, lostStreak, reacquireCount, debug: { initial, tracking } };
      }

      if (!rois) return { detected: false, initialized: false, status: 'searching', left, right, lostStreak, reacquireCount, debug: { initial, tracking } };

      lostStreak++;
      if (lostStreak >= MARKER_REACQUIRE_AFTER_LOST_FRAMES) {
        reacquireCount++;
        rois = initial.rois;
        prev = { white_l: null, white_r: null };
        lostStreak = 0;
        return { detected: false, initialized: !!rois, status: rois ? 'reacquired_rois' : 'reacquiring', left, right, rois, lostStreak, reacquireCount, debug: { initial, tracking } };
      }

      return { detected: false, initialized: true, status: 'lost', left, right, rois, lostStreak, reacquireCount, debug: { initial, tracking } };
    },
  };
}
