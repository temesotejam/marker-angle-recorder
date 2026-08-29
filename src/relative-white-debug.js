import { LEGACY_WHITE_MARKER_CONFIG as CFG } from './marker.js';
import { createRelativeWhiteMarkerTracker, DEFAULT_RELATIVE_WHITE_OPTIONS as DEFAULTS } from './relative-white.js';

const $ = id => document.getElementById(id);
const el = {
  video: $('cameraVideo'), canonical: $('canonicalCanvas'), fixedState: $('fixedCompareState'), relativeState: $('relativeCompareState'), stats: $('relativeCompareStats'),
  deltaV: $('relativeDeltaV'), localRadius: $('relativeLocalRadius'), reset: $('resetRelativeTrial'),
  initialMask: $('relativeInitialMaskCanvas'), leftMask: $('relativeLeftMaskCanvas'), rightMask: $('relativeRightMaskCanvas'), final: $('relativeFinalCanvas'),
  fixedStatus: $('statusText'), resetTracking: $('resetTracking'),
};

const tracker = createRelativeWhiteMarkerTracker(DEFAULTS);
let history = [];
let lastProcessAt = 0;

function setBadge(node, text, cls = '') {
  node.textContent = text;
  node.className = `compare-badge ${cls}`.trim();
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function optionsFromUi() {
  return {
    deltaV: clamp(el.deltaV.value, 1, 120, DEFAULTS.deltaV),
    localRadius: Math.round(clamp(el.localRadius.value, 2, 60, DEFAULTS.localRadius)),
  };
}

function resetTrial() {
  tracker.setOptions(optionsFromUi());
  history = [];
  el.stats.textContent = '比較データ待ち';
  setBadge(el.relativeState, '未判定');
}

function drawMask(canvas, mask, w, h, candidates = [], selected = null) {
  canvas.width = Math.max(1, w); canvas.height = Math.max(1, h);
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

function localSelected(analysis) {
  const d = analysis?.selected;
  if (!d) return null;
  return { ...d, x: d.x - analysis.roi[0], y: d.y - analysis.roi[1] };
}

function renderTrackingMask(canvas, side) {
  const normal = side?.normal, expanded = side?.expanded;
  const chosen = normal?.selected ? normal : (expanded?.selected ? expanded : normal || expanded);
  if (!chosen) return clearCanvas(canvas);
  drawMask(canvas, chosen.morphMask, chosen.img.width, chosen.img.height, chosen.cands, localSelected(chosen));
}

function renderFinal(result) {
  const canvas = el.final;
  canvas.width = CFG.canonicalWidth; canvas.height = CFG.canonicalHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(el.canonical, 0, 0);
  if (!result.detected) return;
  const l = result.left, r = result.right;
  ctx.lineWidth = 4; ctx.strokeStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(l.cx, l.cy); ctx.lineTo(r.cx, r.cy); ctx.stroke();
  for (const [d, color] of [[l, '#ff6b8a'], [r, '#5aa9ff']]) {
    ctx.strokeStyle = color; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(d.cx, d.cy, 14, 0, Math.PI * 2); ctx.stroke();
  }
}

function updateStats(fixedDetected, relativeDetected) {
  history.push({ fixedDetected, relativeDetected });
  if (history.length > 300) history.shift();
  const n = history.length;
  const fixedOk = history.filter(x => x.fixedDetected).length;
  const relativeOk = history.filter(x => x.relativeDetected).length;
  const relativeOnly = history.filter(x => !x.fixedDetected && x.relativeDetected).length;
  const fixedOnly = history.filter(x => x.fixedDetected && !x.relativeDetected).length;
  const pct = x => n ? (100 * x / n).toFixed(1) : '0.0';
  el.stats.textContent = `直近${n}フレーム: 現行 ${pct(fixedOk)}% · 相対 ${pct(relativeOk)}% · 相対のみ ${relativeOnly} · 現行のみ ${fixedOnly}`;
}

function processComparison() {
  if (!el.video?.srcObject || el.video.readyState < 2 || !el.canonical.width || !el.canonical.height) return;
  const ctx = el.canonical.getContext('2d', { willReadFrequently: true, alpha: false });
  const result = tracker.process(ctx, CFG.searchRegion);
  const fixedDetected = el.fixedStatus?.textContent === '追跡中';

  setBadge(el.fixedState, fixedDetected ? '検出' : '未検出', fixedDetected ? 'good' : 'bad');
  setBadge(el.relativeState, result.detected ? '検出' : result.status === 'lost' ? '追跡中に欠落' : '未検出', result.detected ? 'good' : 'bad');
  updateStats(fixedDetected, result.detected);

  const initial = result.debug?.initial;
  if (initial) drawMask(el.initialMask, initial.mask, initial.img.width, initial.img.height, initial.cands, null);
  else clearCanvas(el.initialMask);

  renderTrackingMask(el.leftMask, result.debug?.tracking?.white_l);
  renderTrackingMask(el.rightMask, result.debug?.tracking?.white_r);
  renderFinal(result);
}

function loop(now) {
  if (now - lastProcessAt >= 50) {
    lastProcessAt = now;
    try { processComparison(); } catch { /* trial visualization must not affect production debug */ }
  }
  requestAnimationFrame(loop);
}

el.deltaV.value = String(DEFAULTS.deltaV);
el.localRadius.value = String(DEFAULTS.localRadius);
el.deltaV.addEventListener('change', resetTrial);
el.localRadius.addEventListener('change', resetTrial);
el.reset.addEventListener('click', resetTrial);
el.resetTracking?.addEventListener('click', resetTrial);

resetTrial();
requestAnimationFrame(loop);
