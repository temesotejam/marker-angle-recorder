import assert from 'node:assert/strict';
import { LEGACY_WHITE_MARKER_CONFIG as CFG } from '../src/marker.js';
import { createRelativeWhiteMarkerTracker, relativeWhiteMask } from '../src/relative-white.js';

function makePatch(w, h, bg, marker, colored = false) {
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    const inside = x >= 20 && x < 48 && y >= 16 && y < 44;
    if (inside) {
      if (colored) { rgba[i] = marker; rgba[i + 1] = bg; rgba[i + 2] = bg; }
      else rgba[i] = rgba[i + 1] = rgba[i + 2] = marker;
    } else rgba[i] = rgba[i + 1] = rgba[i + 2] = bg;
    rgba[i + 3] = 255;
  }
  return rgba;
}

const w = 72, h = 60, options = { deltaV: 28, localRadius: 20 };
const bright = relativeWhiteMask(makePatch(w, h, 80, 180), w, h, CFG.initial.saturationMax255, options);
const dim = relativeWhiteMask(makePatch(w, h, 10, 110), w, h, CFG.initial.saturationMax255, options);
assert.deepEqual([...dim], [...bright], 'global brightness shift with the same local contrast should not change the relative mask');
assert.ok(dim.reduce((a, b) => a + b, 0) >= 180, 'dim white marker should remain detectable by relative brightness');
assert.ok(110 < CFG.initial.valueMin255, 'synthetic dim marker is intentionally below the current absolute initial V threshold');

const colored = relativeWhiteMask(makePatch(w, h, 10, 110, true), w, h, CFG.initial.saturationMax255, options);
assert.equal(colored.reduce((a, b) => a + b, 0), 0, 'relative mode must keep the existing low-saturation white constraint');

const FW = CFG.canonicalWidth, FH = CFG.canonicalHeight;
const full = new Uint8ClampedArray(FW * FH * 4);
for (let p = 0; p < FW * FH; p++) {
  const i = p * 4;
  full[i] = full[i + 1] = full[i + 2] = 10;
  full[i + 3] = 255;
}
function square(cx, cy, size, value) {
  const half = Math.floor(size / 2);
  for (let y = cy - half; y < cy - half + size; y++) for (let x = cx - half; x < cx - half + size; x++) {
    const i = (y * FW + x) * 4;
    full[i] = full[i + 1] = full[i + 2] = value;
  }
}
square(500, 440, 28, 110);
square(800, 440, 28, 110);

const ctx = {
  getImageData(x0, y0, cw, ch) {
    const data = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const src = ((y0 + y) * FW + (x0 + x)) * 4;
      const dst = (y * cw + x) * 4;
      data[dst] = full[src]; data[dst + 1] = full[src + 1]; data[dst + 2] = full[src + 2]; data[dst + 3] = 255;
    }
    return { data, width: cw, height: ch };
  },
};

const tracker = createRelativeWhiteMarkerTracker(options);
const result = tracker.process(ctx, CFG.searchRegion);
assert.equal(result.detected, true, 'relative tracker should detect a dim two-marker pair below the current absolute V threshold');
assert.ok(Math.abs(result.right.cx - result.left.cx - 300) < 2, 'relative pair geometry should preserve the same left/right marker spacing');

console.log('relative white tests: PASS');
