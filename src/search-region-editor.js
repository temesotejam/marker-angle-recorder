import {
  DEFAULT_MARKER_SEARCH_REGION,
  clampMarkerSearchRegion,
  loadSavedMarkerSearchRegion,
  saveMarkerSearchRegion,
  clearSavedMarkerSearchRegion,
  setMarkerSearchRegionPreview,
} from './search-region.js';

const $ = id => document.getElementById(id);
const FRAME_W = 1280;
const FRAME_H = 720;
const MIN_W = 40;
const MIN_H = 40;

const el = {
  canvas: $('sourceCanvas'),
  x: $('regionX'), y: $('regionY'), w: $('regionW'), h: $('regionH'),
  save: $('saveRegion'), reset: $('resetRegion'), reload: $('reloadRegion'),
  state: $('regionState'), resetTracking: $('resetTracking'),
};

let savedInfo = loadSavedMarkerSearchRegion(DEFAULT_MARKER_SEARCH_REGION, FRAME_W, FRAME_H);
let savedRegion = [...savedInfo.region];
let region = setMarkerSearchRegionPreview(savedRegion, FRAME_W, FRAME_H);
let drag = null;

const sameRegion = (a, b) => a.every((v, i) => v === b[i]);

function syncInputs() {
  const [x, y, w, h] = region;
  el.x.value = x; el.y.value = y; el.w.value = w; el.h.value = h;
  const dirty = !sameRegion(region, savedRegion);
  const defaultActive = sameRegion(savedRegion, DEFAULT_MARKER_SEARCH_REGION) && savedInfo.source === 'default';
  el.state.textContent = dirty
    ? `未保存: [${region.join(', ')}]`
    : defaultActive
      ? `既定値を使用中: [${savedRegion.join(', ')}]`
      : `本番へ保存済み: [${savedRegion.join(', ')}]`;
  el.state.className = `region-state ${dirty ? 'warn' : 'good'}`;
}

function applyRegion(next, { resetTracking = false } = {}) {
  region = setMarkerSearchRegionPreview(clampMarkerSearchRegion(next, FRAME_W, FRAME_H), FRAME_W, FRAME_H);
  syncInputs();
  if (resetTracking && !el.resetTracking.disabled) el.resetTracking.click();
}

function applyInputs() {
  applyRegion([Number(el.x.value), Number(el.y.value), Number(el.w.value), Number(el.h.value)], { resetTracking: true });
}

for (const input of [el.x, el.y, el.w, el.h]) input.addEventListener('change', applyInputs);

el.save.addEventListener('click', () => {
  savedRegion = saveMarkerSearchRegion(region, FRAME_W, FRAME_H);
  savedInfo = { region: [...savedRegion], source: 'saved' };
  applyRegion(savedRegion, { resetTracking: true });
});

el.reset.addEventListener('click', () => {
  clearSavedMarkerSearchRegion();
  savedInfo = { region: [...DEFAULT_MARKER_SEARCH_REGION], source: 'default' };
  savedRegion = [...DEFAULT_MARKER_SEARCH_REGION];
  applyRegion(savedRegion, { resetTracking: true });
});

el.reload.addEventListener('click', () => {
  savedInfo = loadSavedMarkerSearchRegion(DEFAULT_MARKER_SEARCH_REGION, FRAME_W, FRAME_H);
  savedRegion = [...savedInfo.region];
  applyRegion(savedRegion, { resetTracking: true });
});

function pointFromEvent(event) {
  const r = el.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - r.left) * el.canvas.width / Math.max(1, r.width),
    y: (event.clientY - r.top) * el.canvas.height / Math.max(1, r.height),
  };
}

function hitMode(point) {
  const [x, y, w, h] = region;
  const right = x + w, bottom = y + h;
  const threshold = 16 * el.canvas.width / Math.max(1, el.canvas.getBoundingClientRect().width);
  const nearL = Math.abs(point.x - x) <= threshold;
  const nearR = Math.abs(point.x - right) <= threshold;
  const nearT = Math.abs(point.y - y) <= threshold;
  const nearB = Math.abs(point.y - bottom) <= threshold;
  const withinX = point.x >= x - threshold && point.x <= right + threshold;
  const withinY = point.y >= y - threshold && point.y <= bottom + threshold;
  if (nearL && nearT) return 'nw';
  if (nearR && nearT) return 'ne';
  if (nearR && nearB) return 'se';
  if (nearL && nearB) return 'sw';
  if (nearT && withinX) return 'n';
  if (nearR && withinY) return 'e';
  if (nearB && withinX) return 's';
  if (nearL && withinY) return 'w';
  if (point.x >= x && point.x <= right && point.y >= y && point.y <= bottom) return 'move';
  return null;
}

const cursors = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', move: 'move',
};

function regionFromDrag(mode, start, dx, dy) {
  let [x, y, w, h] = start;
  if (mode === 'move') return clampMarkerSearchRegion([x + dx, y + dy, w, h], FRAME_W, FRAME_H);

  let left = x, right = x + w, top = y, bottom = y + h;
  if (mode.includes('w')) left += dx;
  if (mode.includes('e')) right += dx;
  if (mode.includes('n')) top += dy;
  if (mode.includes('s')) bottom += dy;

  left = Math.max(0, Math.min(FRAME_W - 1, left));
  right = Math.max(1, Math.min(FRAME_W, right));
  top = Math.max(0, Math.min(FRAME_H - 1, top));
  bottom = Math.max(1, Math.min(FRAME_H, bottom));

  if (right - left < MIN_W) {
    if (mode.includes('w')) left = Math.max(0, right - MIN_W);
    else right = Math.min(FRAME_W, left + MIN_W);
  }
  if (bottom - top < MIN_H) {
    if (mode.includes('n')) top = Math.max(0, bottom - MIN_H);
    else bottom = Math.min(FRAME_H, top + MIN_H);
  }
  return clampMarkerSearchRegion([left, top, right - left, bottom - top], FRAME_W, FRAME_H);
}

el.canvas.addEventListener('pointerdown', event => {
  const point = pointFromEvent(event);
  const mode = hitMode(point);
  if (!mode) return;
  event.preventDefault();
  el.canvas.setPointerCapture(event.pointerId);
  drag = { pointerId: event.pointerId, mode, point, region: [...region] };
});

el.canvas.addEventListener('pointermove', event => {
  const point = pointFromEvent(event);
  if (!drag) {
    el.canvas.style.cursor = cursors[hitMode(point)] || 'default';
    return;
  }
  if (event.pointerId !== drag.pointerId) return;
  const dx = point.x - drag.point.x, dy = point.y - drag.point.y;
  applyRegion(regionFromDrag(drag.mode, drag.region, dx, dy));
});

function finishDrag(event) {
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag = null;
  if (!el.resetTracking.disabled) el.resetTracking.click();
}

el.canvas.addEventListener('pointerup', finishDrag);
el.canvas.addEventListener('pointercancel', finishDrag);

syncInputs();
