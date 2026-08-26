import { inspectRwlog, rwlogCompatibilityLabel } from './rwlog.js';
import { exportSessionZip, fileSha256 } from './zip.js';

const APP_VERSION = '0.1.0-v1';
const $ = id => document.getElementById(id);
const el = {
  sessionId: $('sessionId'), sessionState: $('sessionState'), cameraSelect: $('cameraSelect'), startCamera: $('startCamera'),
  newSession: $('newSession'), video: $('cameraVideo'), overlay: $('overlay'), analysis: $('analysisCanvas'),
  angle: $('angleValue'), rawAngle: $('rawAngle'), cameraAngle: $('cameraAngle'), markerState: $('markerState'),
  redState: $('redState'), blueState: $('blueState'), zeroState: $('zeroState'), signState: $('signState'),
  zero: $('zeroButton'), invertSign: $('invertSign'), confirmSign: $('confirmSign'), signDescription: $('signDescription'),
  record: $('recordButton'), stop: $('stopButton'), timer: $('recordTimer'), markerMode: $('markerMode'),
  minSat: $('minSat'), minValue: $('minValue'), whiteMaxSat: $('whiteMaxSat'), whiteMinValue: $('whiteMinValue'), minArea: $('minArea'),
  rwlogDrop: $('rwlogDrop'), rwlogInput: $('rwlogInput'), rwlogName: $('rwlogName'), rwlogDetails: $('rwlogDetails'),
  pairState: $('pairState'), pairDetails: $('pairDetails'), pairOverride: $('pairOverride'), emergencyExport: $('emergencyExport'),
  exportButton: $('exportButton'), exportState: $('exportState'), quality: $('quality'),
};

const state = {
  sessionId: null,
  stream: null,
  cameraToken: 0,
  recorder: null,
  chunks: [],
  videoBlob: null,
  videoMime: null,
  recording: false,
  recordingStartPerf: null,
  recordingStartIso: null,
  recordingEndIso: null,
  durationMs: null,
  rows: [],
  frameIndex: 0,
  zeroAngle: null,
  sign: 1,
  signConfirmed: false,
  baselineDistance: null,
  filteredAngle: null,
  current: null,
  validFrames: 0,
  totalFrames: 0,
  rwlogFile: null,
  rwlogInfo: null,
  rwlogHash: null,
  duplicateOf: null,
  pairing: { status: 'NOT READY', reason: 'Record a video and attach an RWLOG.' },
};

function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function createSessionId() {
  const d = new Date();
  const rand = new Uint16Array(1); crypto.getRandomValues(rand);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}_${rand[0].toString(16).padStart(4, '0')}`;
}
function normalizeDelta(deg) { return ((deg + 540) % 360) - 180; }
function fmt(v, digits = 3) { return Number.isFinite(v) ? Number(v).toFixed(digits) : '---'; }
function setText(node, text, cls = '') { node.textContent = text; node.className = cls; }

function resetMeasurementState() {
  state.videoBlob = null; state.videoMime = null; state.durationMs = null; state.rows = []; state.frameIndex = 0;
  state.recordingStartPerf = null; state.recordingStartIso = null; state.recordingEndIso = null;
  state.validFrames = 0; state.totalFrames = 0; state.rwlogFile = null; state.rwlogInfo = null; state.rwlogHash = null; state.duplicateOf = null;
  state.pairing = { status: 'NOT READY', reason: 'Record a video and attach an RWLOG.' };
  el.rwlogName.textContent = 'No RWLOG attached'; el.rwlogDetails.textContent = '';
  el.pairOverride.checked = false; el.emergencyExport.checked = false; el.exportState.textContent = '';
  renderPairing(); updateButtons();
}

function newSession() {
  if (state.recording) return;
  state.sessionId = createSessionId();
  state.zeroAngle = null; state.sign = 1; state.signConfirmed = false; state.baselineDistance = null; state.filteredAngle = null;
  el.sessionId.textContent = state.sessionId;
  resetMeasurementState();
  renderCalibration();
}

function renderCalibration() {
  setText(el.zeroState, state.zeroAngle == null ? 'NOT SET' : 'OK', state.zeroAngle == null ? 'bad' : 'good');
  setText(el.signState, state.signConfirmed ? 'CONFIRMED' : 'NOT CONFIRMED', state.signConfirmed ? 'good' : 'bad');
  el.signDescription.textContent = state.sign > 0 ? 'Current sign: camera-defined positive' : 'Current sign: inverted';
  updateButtons();
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const previous = el.cameraSelect.value;
  el.cameraSelect.innerHTML = '';
  devices.forEach((d, i) => {
    const option = document.createElement('option'); option.value = d.deviceId; option.textContent = d.label || `Camera ${i + 1}`; el.cameraSelect.appendChild(option);
  });
  if ([...el.cameraSelect.options].some(o => o.value === previous)) el.cameraSelect.value = previous;
}

function stopCamera() {
  state.cameraToken++;
  if (state.stream) state.stream.getTracks().forEach(t => t.stop());
  state.stream = null; el.video.srcObject = null;
  updateButtons();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API is unavailable. Use HTTPS and a supported browser.');
  stopCamera();
  const selected = el.cameraSelect.value;
  const constraints = {
    audio: false,
    video: selected ? { deviceId: { exact: selected }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
                    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
  };
  state.stream = await navigator.mediaDevices.getUserMedia(constraints);
  el.video.srcObject = state.stream;
  await el.video.play();
  await refreshCameraList();
  const token = ++state.cameraToken;
  scheduleFrame(token);
  updateButtons();
}

function rgbHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * (((b - r) / d) + 2);
  else h = 60 * (((r - g) / d) + 4);
  return h < 0 ? h + 360 : h;
}

function components(mask, w, h, minArea) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length), out = [];
  const dx = [-1, 1, 0, 0], dy = [0, 0, -1, 1];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || visited[p]) continue;
    let head = 0, tail = 0, area = 0, sx = 0, sy = 0, minx = w, maxx = -1, miny = h, maxy = -1;
    queue[tail++] = p; visited[p] = 1;
    while (head < tail) {
      const q = queue[head++], y = Math.floor(q / w), x = q - y * w;
      area++; sx += x; sy += y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (let k = 0; k < 4; k++) {
        const nx = x + dx[k], ny = y + dy[k]; if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const np = ny * w + nx; if (mask[np] && !visited[np]) { visited[np] = 1; queue[tail++] = np; }
      }
    }
    if (area >= minArea) {
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      out.push({ area, cx: sx / area, cy: sy / area, x: minx, y: miny, w: bw, h: bh, fill: area / (bw * bh) });
    }
  }
  return out;
}

function detectMarkers(imageData, w, h) {
  const mode = el.markerMode.value;
  const minArea = Math.max(3, Number(el.minArea.value) || 12);
  const rgba = imageData.data;
  if (mode === 'white-pair') {
    const mask = new Uint8Array(w * h), maxS = (Number(el.whiteMaxSat.value) || 25) / 100, minV = (Number(el.whiteMinValue.value) || 65) / 100;
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b);
      const s = max === 0 ? 0 : (max - min) / max, v = max / 255;
      if (s <= maxS && v >= minV) mask[p] = 1;
    }
    const cands = components(mask, w, h, minArea).filter(c => c.fill >= 0.2).sort((a, b) => b.area - a.area).slice(0, 12);
    let best = null;
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      let a = cands[i], b = cands[j]; if (a.cx > b.cx) [a, b] = [b, a];
      const dx = b.cx - a.cx, dy = Math.abs(b.cy - a.cy), sim = Math.min(a.area, b.area) / Math.max(a.area, b.area);
      if (dx < w * 0.08 || dy > h * 0.35 || sim < 0.25) continue;
      const score = Math.min(a.area, b.area) * sim - dy * 2;
      if (!best || score > best.score) best = { score, first: a, second: b };
    }
    return best ? { first: best.first, second: best.second, labels: ['LEFT', 'RIGHT'] } : null;
  }

  const red = new Uint8Array(w * h), blue = new Uint8Array(w * h);
  const minS = (Number(el.minSat.value) || 45) / 100, minV = (Number(el.minValue.value) || 30) / 100;
  for (let p = 0, i = 0; p < red.length; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const s = max === 0 ? 0 : d / max, v = max / 255;
    if (s < minS || v < minV) continue;
    const hDeg = rgbHue(r, g, b);
    if (hDeg <= 25 || hDeg >= 335) red[p] = 1;
    else if (hDeg >= 175 && hDeg <= 265) blue[p] = 1;
  }
  const reds = components(red, w, h, minArea).filter(c => c.fill >= 0.18).sort((a, b) => b.area - a.area);
  const blues = components(blue, w, h, minArea).filter(c => c.fill >= 0.18).sort((a, b) => b.area - a.area);
  if (!reds.length || !blues.length) return null;
  return { first: reds[0], second: blues[0], labels: ['RED', 'BLUE'] };
}

function drawOverlay(result, scaleX, scaleY) {
  const canvas = el.overlay, ctx = canvas.getContext('2d');
  const vw = el.video.videoWidth || 1280, vh = el.video.videoHeight || 720;
  if (canvas.width !== vw || canvas.height !== vh) { canvas.width = vw; canvas.height = vh; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!result?.detected) return;
  const a = result.a, b = result.b;
  ctx.lineWidth = Math.max(2, vw / 500); ctx.strokeStyle = '#f8fafc'; ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  for (const [point, label, color] of [[a, result.labels[0], '#fb7185'], [b, result.labels[1], '#60a5fa']]) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, vw / 400); ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(8, vw / 90), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color; ctx.font = `${Math.max(16, vw / 45)}px system-ui`; ctx.fillText(label, point.x + 12, point.y - 12);
  }
}

function processFrame() {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!vw || !vh) return;
  const aw = 320, ah = Math.max(1, Math.round(vh * aw / vw)), canvas = el.analysis, ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (canvas.width !== aw || canvas.height !== ah) { canvas.width = aw; canvas.height = ah; }
  ctx.drawImage(el.video, 0, 0, aw, ah);
  const detection = detectMarkers(ctx.getImageData(0, 0, aw, ah), aw, ah);
  const sx = vw / aw, sy = vh / ah;
  let current = { detected: false, valid: false, angleCamera: null, angleRaw: null, angleFiltered: null, distance: null, a: null, b: null, labels: ['', ''], areas: [null, null] };
  if (detection) {
    const a = { x: detection.first.cx * sx, y: detection.first.cy * sy }, b = { x: detection.second.cx * sx, y: detection.second.cy * sy };
    const distance = Math.hypot(b.x - a.x, b.y - a.y);
    const angleCamera = -Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    let valid = true;
    if (state.baselineDistance != null) {
      const ratio = distance / state.baselineDistance;
      if (ratio < 0.60 || ratio > 1.40) valid = false;
    }
    let angleRaw = null, angleFiltered = null;
    if (state.zeroAngle != null && valid) {
      angleRaw = state.sign * normalizeDelta(angleCamera - state.zeroAngle);
      state.filteredAngle = state.filteredAngle == null ? angleRaw : state.filteredAngle + 0.22 * (angleRaw - state.filteredAngle);
      angleFiltered = state.filteredAngle;
    }
    current = { detected: true, valid, angleCamera, angleRaw, angleFiltered, distance, a, b, labels: detection.labels, areas: [detection.first.area, detection.second.area] };
  }
  state.current = current;
  drawOverlay(current, sx, sy);
  renderAngle();

  if (state.recording) {
    state.totalFrames++;
    if (current.valid) state.validFrames++;
    const t = performance.now() - state.recordingStartPerf;
    state.rows.push({
      t_session_ms: t,
      video_time_ms: Number.isFinite(el.video.currentTime) ? el.video.currentTime * 1000 : null,
      frame: state.frameIndex++, marker_mode: el.markerMode.value, valid: current.valid ? 1 : 0,
      angle_camera_deg: current.angleCamera, angle_raw_deg: current.angleRaw, angle_filtered_deg: current.angleFiltered,
      marker1_x: current.a?.x ?? null, marker1_y: current.a?.y ?? null, marker2_x: current.b?.x ?? null, marker2_y: current.b?.y ?? null,
      marker_distance_px: current.distance, marker1_area_analysis_px: current.areas[0], marker2_area_analysis_px: current.areas[1]
    });
    el.timer.textContent = `${(t / 1000).toFixed(2)} s`;
    el.quality.textContent = `${state.validFrames}/${state.totalFrames} valid (${state.totalFrames ? (100 * state.validFrames / state.totalFrames).toFixed(1) : '0.0'}%)`;
  }
}

function scheduleFrame(token) {
  if (!state.stream || token !== state.cameraToken) return;
  const next = () => { if (state.stream && token === state.cameraToken) { processFrame(); scheduleFrame(token); } };
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) el.video.requestVideoFrameCallback(next);
  else requestAnimationFrame(next);
}

function renderAngle() {
  const c = state.current;
  if (!c?.detected) {
    el.angle.textContent = '---.---°'; el.rawAngle.textContent = '---'; el.cameraAngle.textContent = '---'; setText(el.markerState, 'MARKER LOST', 'bad');
    setText(el.redState, 'LOST', 'bad'); setText(el.blueState, 'LOST', 'bad'); return;
  }
  setText(el.redState, 'OK', 'good'); setText(el.blueState, 'OK', 'good');
  setText(el.markerState, c.valid ? 'TRACKING' : 'GEOMETRY CHECK', c.valid ? 'good' : 'warn');
  el.cameraAngle.textContent = `${fmt(c.angleCamera)}°`; el.rawAngle.textContent = c.angleRaw == null ? 'ZERO NOT SET' : `${fmt(c.angleRaw)}°`;
  el.angle.textContent = c.angleFiltered == null ? '---.---°' : `${c.angleFiltered >= 0 ? '+' : ''}${fmt(c.angleFiltered)}°`;
}

function zeroAngle() {
  if (!state.current?.detected) return;
  state.zeroAngle = state.current.angleCamera; state.baselineDistance = state.current.distance; state.filteredAngle = 0; state.signConfirmed = false;
  renderCalibration(); processFrame();
}

function chooseMime() {
  const choices = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return choices.find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  if (!state.stream || state.recording || state.zeroAngle == null || !state.signConfirmed || !state.current?.valid) return;
  resetMeasurementState();
  const mime = chooseMime(); state.chunks = [];
  state.recorder = mime ? new MediaRecorder(state.stream, { mimeType: mime }) : new MediaRecorder(state.stream);
  state.videoMime = state.recorder.mimeType || mime || 'video/webm';
  state.recorder.ondataavailable = e => { if (e.data?.size) state.chunks.push(e.data); };
  state.recording = true; state.recordingStartPerf = performance.now(); state.recordingStartIso = new Date().toISOString(); state.rows = []; state.frameIndex = 0; state.validFrames = 0; state.totalFrames = 0;
  state.recorder.start(1000); el.sessionState.textContent = 'RECORDING'; el.sessionState.className = 'recording'; updateButtons();
}

async function stopRecording() {
  if (!state.recording || !state.recorder) return;
  const recorder = state.recorder;
  await new Promise(resolve => {
    const old = recorder.onstop;
    recorder.onstop = e => { if (old) old(e); resolve(); };
    recorder.stop();
  });
  state.durationMs = performance.now() - state.recordingStartPerf; state.recordingEndIso = new Date().toISOString(); state.recording = false;
  state.videoBlob = new Blob(state.chunks, { type: state.videoMime || 'video/webm' });
  el.sessionState.textContent = 'RECORDED'; el.sessionState.className = 'ready'; el.timer.textContent = `${(state.durationMs / 1000).toFixed(2)} s`;
  updatePairing(); updateButtons();
}

async function sha256File(file) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function duplicateLookup(hash) {
  try {
    const history = JSON.parse(localStorage.getItem('marker-angle-recorder-rwlog-history') || '[]');
    return history.find(x => x.sha256 === hash && x.session_id !== state.sessionId) || null;
  } catch { return null; }
}
function rememberRwlog(hash) {
  if (!hash) return;
  try {
    const key = 'marker-angle-recorder-rwlog-history', history = JSON.parse(localStorage.getItem(key) || '[]').filter(x => x.sha256 !== hash);
    history.unshift({ sha256: hash, session_id: state.sessionId, exported_at: new Date().toISOString() });
    localStorage.setItem(key, JSON.stringify(history.slice(0, 100)));
  } catch { /* best effort only */ }
}

async function attachRwlog(file) {
  if (!file) return;
  el.rwlogName.textContent = 'Inspecting…'; el.rwlogDetails.textContent = '';
  const buffer = await file.arrayBuffer();
  state.rwlogFile = file; state.rwlogInfo = inspectRwlog(buffer); state.rwlogHash = await sha256File(file); state.duplicateOf = duplicateLookup(state.rwlogHash);
  const info = state.rwlogInfo;
  el.rwlogName.textContent = file.name;
  const bits = [`${(file.size / 1024).toFixed(1)} KiB`, rwlogCompatibilityLabel(info), `SHA-256 ${state.rwlogHash.slice(0, 16)}…`];
  if (info.crc.available) bits.push(info.crc.ok ? 'CRC PASS' : 'CRC FAIL');
  if (info.time_range?.duration_ms != null) bits.push(`RWLOG duration ${(info.time_range.duration_ms / 1000).toFixed(3)} s`);
  if (state.duplicateOf) bits.push(`DUPLICATE: already exported as ${state.duplicateOf.session_id}`);
  el.rwlogDetails.textContent = bits.join(' · ');
  updatePairing(); updateButtons();
}

function updatePairing() {
  if (!state.videoBlob) state.pairing = { status: 'NOT READY', reason: 'Record a video first.' };
  else if (!state.rwlogFile) state.pairing = { status: 'NO RWLOG', reason: 'Attach the RWLOG produced by this run.' };
  else if (state.duplicateOf) state.pairing = { status: 'CHECK', reason: `This exact RWLOG was already exported with ${state.duplicateOf.session_id}.` };
  else if (state.rwlogInfo?.crc.available && state.rwlogInfo.crc.ok === false) state.pairing = { status: 'CHECK', reason: 'RWLOG CRC failed. The file may be damaged.' };
  else if (state.rwlogInfo?.time_range?.duration_ms == null) state.pairing = { status: 'UNVERIFIED', reason: 'RWLOG duration is unavailable, but the file can still be paired and preserved.' };
  else {
    const a = state.durationMs, b = state.rwlogInfo.time_range.duration_ms, diff = Math.abs(a - b), base = Math.max(a, b, 1);
    const matchLimit = Math.max(500, base * 0.02), checkLimit = Math.max(2000, base * 0.10);
    if (diff <= matchLimit) state.pairing = { status: 'MATCH', reason: `Duration difference ${(diff / 1000).toFixed(3)} s.` };
    else if (diff <= checkLimit) state.pairing = { status: 'CHECK', reason: `Duration difference ${(diff / 1000).toFixed(3)} s; verify this pair.` };
    else state.pairing = { status: 'MISMATCH', reason: `Duration difference ${(diff / 1000).toFixed(3)} s strongly suggests another run.` };
  }
  renderPairing();
}

function renderPairing() {
  const s = state.pairing.status;
  setText(el.pairState, s, s === 'MATCH' ? 'good' : ['MISMATCH', 'NO RWLOG', 'NOT READY'].includes(s) ? 'bad' : 'warn');
  el.pairDetails.textContent = state.pairing.reason;
  updateButtons();
}

function csvEscape(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function angleCsv() {
  const headers = ['t_session_ms','video_time_ms','frame','marker_mode','valid','angle_camera_deg','angle_raw_deg','angle_filtered_deg','marker1_x','marker1_y','marker2_x','marker2_y','marker_distance_px','marker1_area_analysis_px','marker2_area_analysis_px'];
  const lines = [headers.join(',')];
  for (const row of state.rows) lines.push(headers.map(h => csvEscape(row[h])).join(','));
  return lines.join('\n') + '\n';
}

async function doExport() {
  if (!state.videoBlob) return;
  const needsOverride = ['MISMATCH', 'CHECK'].includes(state.pairing.status);
  if (!state.rwlogFile && !el.emergencyExport.checked) return;
  if (needsOverride && !el.pairOverride.checked) return;
  el.exportButton.disabled = true; el.exportState.textContent = 'Building hashes and ZIP…';
  try {
    const csv = angleCsv(), csvBlob = new Blob([csv], { type: 'text/csv' });
    const [videoHash, csvHash] = await Promise.all([fileSha256(state.videoBlob), fileSha256(csvBlob)]);
    const track = state.stream?.getVideoTracks()[0], settings = track?.getSettings?.() || {};
    const manifest = {
      schema_version: 1,
      app: { name: 'Marker Angle Session Recorder', version: APP_VERSION },
      session_id: state.sessionId,
      recording: { start_iso: state.recordingStartIso, end_iso: state.recordingEndIso, duration_ms: state.durationMs, rows: state.rows.length },
      camera: { width: settings.width ?? el.video.videoWidth, height: settings.height ?? el.video.videoHeight, frame_rate: settings.frameRate ?? null, device_label: track?.label || null },
      marker: { mode: el.markerMode.value, zero_camera_deg: state.zeroAngle, baseline_distance_px: state.baselineDistance, sign_multiplier: state.sign, sign_confirmed: state.signConfirmed,
        thresholds: { min_saturation_percent: Number(el.minSat.value), min_value_percent: Number(el.minValue.value), white_max_saturation_percent: Number(el.whiteMaxSat.value), white_min_value_percent: Number(el.whiteMinValue.value), min_component_area_analysis_px: Number(el.minArea.value) } },
      quality: { valid_frames: state.validFrames, total_frames: state.totalFrames, valid_ratio: state.totalFrames ? state.validFrames / state.totalFrames : null },
      video: { mime_type: state.videoMime, bytes: state.videoBlob.size, sha256: videoHash?.sha256 ?? null, hash_status: videoHash?.status ?? null },
      angle_csv: { bytes: csvBlob.size, sha256: csvHash?.sha256 ?? null },
      rwlog: state.rwlogFile ? { original_name: state.rwlogFile.name, bytes: state.rwlogFile.size, sha256: state.rwlogHash, inspection: state.rwlogInfo } : null,
      pairing: { ...state.pairing, override: needsOverride ? el.pairOverride.checked : false, emergency_without_rwlog: !state.rwlogFile },
    };
    const extension = state.videoMime?.includes('webm') ? 'webm' : 'webm';
    const result = await exportSessionZip({ sessionId: state.sessionId, videoBlob: state.videoBlob, videoExtension: extension, angleCsv: csv, rwlogFile: state.rwlogFile, manifest });
    if (state.rwlogHash) rememberRwlog(state.rwlogHash);
    el.exportState.textContent = `Exported ${result.filename} (${(result.bytes / 1024 / 1024).toFixed(1)} MiB)`;
    el.sessionState.textContent = 'COMPLETE'; el.sessionState.className = 'good';
  } catch (error) {
    el.exportState.textContent = `Export failed: ${String(error)}`;
  } finally { updateButtons(); }
}

function updateButtons() {
  el.record.disabled = !state.stream || state.recording || state.zeroAngle == null || !state.signConfirmed || !state.current?.valid;
  el.stop.disabled = !state.recording;
  el.zero.disabled = !state.stream || state.recording || !state.current?.detected;
  el.invertSign.disabled = state.recording; el.confirmSign.disabled = state.recording || state.zeroAngle == null;
  const needsOverride = ['MISMATCH', 'CHECK'].includes(state.pairing.status);
  el.exportButton.disabled = state.recording || !state.videoBlob || (!state.rwlogFile && !el.emergencyExport.checked) || (needsOverride && !el.pairOverride.checked);
}

el.newSession.addEventListener('click', newSession);
el.startCamera.addEventListener('click', () => startCamera().catch(e => { el.exportState.textContent = String(e); }));
el.zero.addEventListener('click', zeroAngle);
el.invertSign.addEventListener('click', () => { if (state.recording) return; state.sign *= -1; state.signConfirmed = false; state.filteredAngle = null; renderCalibration(); processFrame(); });
el.confirmSign.addEventListener('click', () => { if (state.zeroAngle == null) return; state.signConfirmed = true; renderCalibration(); });
el.record.addEventListener('click', startRecording);
el.stop.addEventListener('click', () => stopRecording().catch(e => { el.exportState.textContent = String(e); }));
el.rwlogInput.addEventListener('change', e => attachRwlog(e.target.files?.[0]).catch(err => { el.rwlogDetails.textContent = String(err); }));
el.rwlogDrop.addEventListener('click', () => el.rwlogInput.click());
el.rwlogDrop.addEventListener('dragover', e => { e.preventDefault(); el.rwlogDrop.classList.add('drag'); });
el.rwlogDrop.addEventListener('dragleave', () => el.rwlogDrop.classList.remove('drag'));
el.rwlogDrop.addEventListener('drop', e => { e.preventDefault(); el.rwlogDrop.classList.remove('drag'); attachRwlog(e.dataTransfer.files?.[0]).catch(err => { el.rwlogDetails.textContent = String(err); }); });
el.pairOverride.addEventListener('change', updateButtons); el.emergencyExport.addEventListener('change', updateButtons); el.exportButton.addEventListener('click', doExport);
el.markerMode.addEventListener('change', () => { state.zeroAngle = null; state.baselineDistance = null; state.signConfirmed = false; state.filteredAngle = null; renderCalibration(); });

window.addEventListener('beforeunload', () => stopCamera());
newSession(); refreshCameraList().catch(() => {}); renderPairing();
