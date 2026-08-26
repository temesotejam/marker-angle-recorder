import { detectMarkerPair, drawMarkerOverlay } from './marker.js';
import { inspectRwlog, rwlogCompatibilityLabel } from './rwlog.js';
import { exportSessionZip, fileSha256 } from './zip.js';

const APP_VERSION = '0.2.0-v1';
const $ = id => document.getElementById(id);
const el = {
  sessionId: $('sessionId'), sessionState: $('sessionState'), cameraSelect: $('cameraSelect'), startCamera: $('startCamera'), newSession: $('newSession'),
  video: $('cameraVideo'), overlay: $('overlay'), analysis: $('analysisCanvas'), angle: $('angleValue'), rawAngle: $('rawAngle'), cameraAngle: $('cameraAngle'),
  markerState: $('markerState'), redState: $('redState'), blueState: $('blueState'), zeroState: $('zeroState'), signState: $('signState'), zero: $('zeroButton'),
  invertSign: $('invertSign'), confirmSign: $('confirmSign'), signDescription: $('signDescription'), record: $('recordButton'), stop: $('stopButton'), timer: $('recordTimer'),
  angleMode: $('angleMode'), fixedHorizontalDeg: $('fixedHorizontalDeg'), fixedHorizontalRow: $('fixedHorizontalRow'), markerMode: $('markerMode'),
  minSat: $('minSat'), minValue: $('minValue'), whiteMaxSat: $('whiteMaxSat'), whiteMinValue: $('whiteMinValue'), minArea: $('minArea'),
  rwlogDrop: $('rwlogDrop'), rwlogInput: $('rwlogInput'), rwlogName: $('rwlogName'), rwlogDetails: $('rwlogDetails'), pairState: $('pairState'), pairDetails: $('pairDetails'),
  pairOverride: $('pairOverride'), emergencyExport: $('emergencyExport'), exportButton: $('exportButton'), exportState: $('exportState'), quality: $('quality'),
};

const state = {
  sessionId: null, sessionCreatedIso: null, exported: false,
  stream: null, cameraToken: 0, recorder: null, chunks: [], videoBlob: null, videoMime: 'video/webm', recording: false,
  recordingStartPerf: null, recordingStartIso: null, recordingEndIso: null, recordingFirstMediaTime: null, durationMs: null, recordingConfig: null,
  rows: [], frameIndex: 0, relativeZeroAngle: null, sign: 1, signConfirmed: false, baselineDistance: null, filteredAngle: null, current: null,
  validFrames: 0, totalFrames: 0, rwlogFile: null, rwlogInfo: null, rwlogHash: null, duplicateOf: null,
  pairing: { status: 'NOT READY', reason: 'Record a video and attach an RWLOG.' },
};

const pad = (n, width = 2) => String(n).padStart(width, '0');
const fmt = (v, digits = 3) => Number.isFinite(v) ? Number(v).toFixed(digits) : '---';
const normalizeDelta = deg => ((deg + 540) % 360) - 180;
const finiteNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;

function sessionIdNow() {
  const d = new Date(), rand = new Uint16Array(1); crypto.getRandomValues(rand);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}_${pad(d.getMilliseconds(), 3)}_${rand[0].toString(16).padStart(4, '0')}`;
}
function setStatus(node, text, cls = '') { node.textContent = text; node.className = cls; }
function markerSettings() {
  return { mode: el.markerMode.value, minSat: el.minSat.value, minValue: el.minValue.value, whiteMaxSat: el.whiteMaxSat.value, whiteMinValue: el.whiteMinValue.value, minArea: el.minArea.value };
}
function angleMode() { return el.angleMode.value; }
function fixedHorizontal() { return finiteNumber(el.fixedHorizontalDeg.value, 0); }
function referenceReady() { return angleMode() === 'absolute-fixed-horizontal' || Number.isFinite(state.relativeZeroAngle); }

function clearRunFiles() {
  state.exported = false; state.videoBlob = null; state.durationMs = null; state.rows = []; state.frameIndex = 0; state.validFrames = 0; state.totalFrames = 0;
  state.recordingStartPerf = null; state.recordingStartIso = null; state.recordingEndIso = null; state.recordingFirstMediaTime = null; state.recordingConfig = null;
  state.rwlogFile = null; state.rwlogInfo = null; state.rwlogHash = null; state.duplicateOf = null;
  state.pairing = { status: 'NOT READY', reason: 'Record a video and attach an RWLOG.' };
  el.rwlogInput.value = ''; el.rwlogName.textContent = 'No RWLOG attached'; el.rwlogDetails.textContent = ''; el.pairOverride.checked = false; el.emergencyExport.checked = false;
  el.exportState.textContent = ''; el.timer.textContent = '0.00 s'; el.quality.textContent = '0/0 valid'; renderPairing();
}

function newSession() {
  if (state.recording || (state.videoBlob && !state.exported)) return;
  state.sessionId = sessionIdNow(); state.sessionCreatedIso = new Date().toISOString(); state.relativeZeroAngle = null; state.sign = 1; state.signConfirmed = false;
  state.baselineDistance = null; state.filteredAngle = null;
  el.sessionId.textContent = state.sessionId; el.sessionState.textContent = 'READY'; el.sessionState.className = 'ready';
  clearRunFiles(); renderCalibration(); updateButtons();
}

function renderCalibration() {
  if (angleMode() === 'absolute-fixed-horizontal') {
    setStatus(el.zeroState, `FIXED ${fmt(fixedHorizontal())}°`, 'good');
    el.fixedHorizontalRow.hidden = false;
    el.signDescription.textContent = 'Absolute mode: body marker line − fixed horizontal reference. Per-run ZERO subtraction is disabled.';
  } else {
    setStatus(el.zeroState, Number.isFinite(state.relativeZeroAngle) ? 'ZERO OK' : 'ZERO NOT SET', Number.isFinite(state.relativeZeroAngle) ? 'good' : 'bad');
    el.fixedHorizontalRow.hidden = true;
    el.signDescription.textContent = 'Relative ZERO is diagnostic only and must not replace the fixed-horizontal absolute reference for passive research data.';
  }
  setStatus(el.signState, state.signConfirmed ? 'CONFIRMED' : 'NOT CONFIRMED', state.signConfirmed ? 'good' : 'bad');
  updateButtons();
}

function loadPersistentReference() {
  try {
    const saved = localStorage.getItem('marker-angle-recorder-fixed-horizontal-deg');
    if (saved != null && Number.isFinite(Number(saved))) el.fixedHorizontalDeg.value = Number(saved).toFixed(3);
  } catch { /* optional persistence */ }
}
function savePersistentReference() {
  const value = Math.max(-180, Math.min(180, fixedHorizontal())); el.fixedHorizontalDeg.value = value.toFixed(3);
  try { localStorage.setItem('marker-angle-recorder-fixed-horizontal-deg', String(value)); } catch { /* optional persistence */ }
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const previous = el.cameraSelect.value, devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  el.cameraSelect.innerHTML = '';
  devices.forEach((d, i) => { const option = document.createElement('option'); option.value = d.deviceId; option.textContent = d.label || `Camera ${i + 1}`; el.cameraSelect.appendChild(option); });
  if ([...el.cameraSelect.options].some(o => o.value === previous)) el.cameraSelect.value = previous;
}

function stopCamera() {
  state.cameraToken++; state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; el.video.srcObject = null; state.current = null;
  renderAngle(); updateButtons();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera API unavailable. Open this page over HTTPS in a supported browser.');
  stopCamera();
  const deviceId = el.cameraSelect.value;
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video }); el.video.srcObject = state.stream; await el.video.play(); await refreshCameraList();
  const token = ++state.cameraToken; scheduleFrame(token); updateButtons();
}

function processFrame(frameMetadata = null) {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!vw || !vh) return;
  const aw = 320, ah = Math.max(1, Math.round(vh * aw / vw)), ctx = el.analysis.getContext('2d', { willReadFrequently: true });
  if (el.analysis.width !== aw || el.analysis.height !== ah) { el.analysis.width = aw; el.analysis.height = ah; }
  ctx.drawImage(el.video, 0, 0, aw, ah);
  const pair = detectMarkerPair(ctx.getImageData(0, 0, aw, ah), aw, ah, markerSettings());
  let current = { detected: false, valid: false, angleCamera: null, angleAbsolute: null, angleRelative: null, angleRaw: null, angleFiltered: null, distance: null, a: null, b: null, labels: ['', ''], areas: [null, null] };
  if (pair) {
    const sx = vw / aw, sy = vh / ah;
    const a = { x: pair.first.cx * sx, y: pair.first.cy * sy }, b = { x: pair.second.cx * sx, y: pair.second.cy * sy };
    const distance = Math.hypot(b.x - a.x, b.y - a.y), angleCamera = -Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI;
    let valid = true;
    if (state.baselineDistance != null) { const ratio = distance / state.baselineDistance; valid = ratio >= 0.60 && ratio <= 1.40; }
    const angleAbsolute = state.sign * normalizeDelta(angleCamera - fixedHorizontal());
    const angleRelative = Number.isFinite(state.relativeZeroAngle) ? state.sign * normalizeDelta(angleCamera - state.relativeZeroAngle) : null;
    const angleRaw = angleMode() === 'absolute-fixed-horizontal' ? angleAbsolute : angleRelative;
    let angleFiltered = null;
    if (Number.isFinite(angleRaw) && valid) {
      state.filteredAngle = state.filteredAngle == null ? angleRaw : state.filteredAngle + 0.22 * (angleRaw - state.filteredAngle);
      angleFiltered = state.filteredAngle;
    }
    current = { detected: true, valid, angleCamera, angleAbsolute, angleRelative, angleRaw, angleFiltered, distance, a, b, labels: pair.labels, areas: [pair.first.area, pair.second.area] };
  }
  state.current = current; drawMarkerOverlay(el.overlay, vw, vh, current); renderAngle();

  if (state.recording) {
    state.totalFrames++; if (current.valid) state.validFrames++;
    const t = performance.now() - state.recordingStartPerf;
    const mediaTime = Number.isFinite(frameMetadata?.mediaTime) ? frameMetadata.mediaTime : (Number.isFinite(el.video.currentTime) ? el.video.currentTime : null);
    if (state.recordingFirstMediaTime == null && Number.isFinite(mediaTime)) state.recordingFirstMediaTime = mediaTime;
    const recordingMediaMs = Number.isFinite(mediaTime) && Number.isFinite(state.recordingFirstMediaTime) ? (mediaTime - state.recordingFirstMediaTime) * 1000 : null;
    state.rows.push({
      t_session_ms: t, video_recording_time_ms: recordingMediaMs, video_element_media_time_ms: Number.isFinite(mediaTime) ? mediaTime * 1000 : null,
      frame: state.frameIndex++, angle_mode: angleMode(), marker_mode: el.markerMode.value, valid: current.valid ? 1 : 0,
      angle_camera_line_deg: current.angleCamera, fixed_horizontal_reference_deg: fixedHorizontal(), angle_absolute_deg: current.angleAbsolute,
      relative_zero_camera_deg: state.relativeZeroAngle, angle_relative_deg: current.angleRelative, angle_raw_deg: current.angleRaw, angle_filtered_deg: current.angleFiltered,
      marker1_x: current.a?.x ?? null, marker1_y: current.a?.y ?? null, marker2_x: current.b?.x ?? null, marker2_y: current.b?.y ?? null,
      marker_distance_px: current.distance, marker1_area_analysis_px: current.areas[0], marker2_area_analysis_px: current.areas[1]
    });
    el.timer.textContent = `${(t / 1000).toFixed(2)} s`;
    el.quality.textContent = `${state.validFrames}/${state.totalFrames} valid (${state.totalFrames ? (100 * state.validFrames / state.totalFrames).toFixed(1) : '0.0'}%)`;
  }
  updateButtons();
}

function scheduleFrame(token) {
  if (!state.stream || token !== state.cameraToken) return;
  const callback = (_now, metadata) => { if (!state.stream || token !== state.cameraToken) return; processFrame(metadata); scheduleFrame(token); };
  if ('requestVideoFrameCallback' in HTMLVideoElement.prototype) el.video.requestVideoFrameCallback(callback);
  else requestAnimationFrame(() => callback(performance.now(), null));
}

function renderAngle() {
  const c = state.current;
  if (!c?.detected) {
    el.angle.textContent = '---.---°'; el.rawAngle.textContent = '---'; el.cameraAngle.textContent = '---'; setStatus(el.markerState, 'MARKER LOST', 'bad');
    setStatus(el.redState, 'LOST', 'bad'); setStatus(el.blueState, 'LOST', 'bad'); return;
  }
  setStatus(el.redState, 'OK', 'good'); setStatus(el.blueState, 'OK', 'good'); setStatus(el.markerState, c.valid ? 'TRACKING' : 'GEOMETRY CHECK', c.valid ? 'good' : 'warn');
  el.cameraAngle.textContent = `${fmt(c.angleCamera)}°`; el.rawAngle.textContent = Number.isFinite(c.angleRaw) ? `${fmt(c.angleRaw)}°` : 'REFERENCE NOT SET';
  el.angle.textContent = Number.isFinite(c.angleFiltered) ? `${c.angleFiltered >= 0 ? '+' : ''}${fmt(c.angleFiltered)}°` : '---.---°';
}

function setRelativeZero() {
  if (angleMode() !== 'relative-zero' || !state.current?.detected || state.recording) return;
  state.relativeZeroAngle = state.current.angleCamera; state.filteredAngle = 0; state.signConfirmed = false; renderCalibration(); processFrame();
}

function chooseMime() {
  if (!window.MediaRecorder) throw new Error('MediaRecorder is unavailable in this browser.');
  return ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
}

function startRecording() {
  if (!state.stream || state.recording || state.videoBlob || !referenceReady() || !state.signConfirmed || !state.current?.valid) return;
  clearRunFiles();
  const mime = chooseMime(); state.chunks = [];
  state.recorder = mime ? new MediaRecorder(state.stream, { mimeType: mime }) : new MediaRecorder(state.stream);
  state.videoMime = state.recorder.mimeType || mime || 'video/webm';
  state.recorder.addEventListener('dataavailable', event => { if (event.data?.size) state.chunks.push(event.data); });
  state.recordingConfig = {
    angle_mode: angleMode(), fixed_horizontal_reference_deg: fixedHorizontal(), relative_zero_camera_deg: state.relativeZeroAngle,
    per_run_zero_subtraction: angleMode() === 'relative-zero', sign_multiplier: state.sign, sign_confirmed: state.signConfirmed,
    marker: markerSettings(), baseline_distance_px: state.baselineDistance,
  };
  state.recording = true; state.recordingStartPerf = performance.now(); state.recordingStartIso = new Date().toISOString(); state.recordingFirstMediaTime = null;
  state.rows = []; state.frameIndex = 0; state.validFrames = 0; state.totalFrames = 0; state.recorder.start(1000);
  el.sessionState.textContent = 'RECORDING'; el.sessionState.className = 'recording'; updateButtons();
}

async function stopRecording() {
  if (!state.recording || !state.recorder) return;
  const recorder = state.recorder;
  await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
  state.durationMs = performance.now() - state.recordingStartPerf; state.recordingEndIso = new Date().toISOString(); state.recording = false;
  state.videoBlob = new Blob(state.chunks, { type: state.videoMime || 'video/webm' });
  el.sessionState.textContent = 'RECORDED'; el.sessionState.className = 'ready'; el.timer.textContent = `${(state.durationMs / 1000).toFixed(2)} s`;
  updatePairing(); updateButtons();
}

function duplicateLookup(hash) {
  try { return JSON.parse(localStorage.getItem('marker-angle-recorder-rwlog-history') || '[]').find(x => x.sha256 === hash && x.session_id !== state.sessionId) || null; }
  catch { return null; }
}
function rememberRwlog(hash) {
  if (!hash) return;
  try {
    const key = 'marker-angle-recorder-rwlog-history', history = JSON.parse(localStorage.getItem(key) || '[]').filter(x => x.sha256 !== hash);
    history.unshift({ sha256: hash, session_id: state.sessionId, exported_at: new Date().toISOString() }); localStorage.setItem(key, JSON.stringify(history.slice(0, 100)));
  } catch { /* best effort */ }
}

function passiveAudit(info) { return info?.decoder?.details?.passive_audit ?? null; }

async function attachRwlog(file) {
  if (!file || state.recording) return;
  el.rwlogName.textContent = 'Inspecting…'; el.rwlogDetails.textContent = '';
  const buffer = await file.arrayBuffer(), hashInfo = await fileSha256(file, Number.POSITIVE_INFINITY);
  state.rwlogFile = file; state.rwlogInfo = inspectRwlog(buffer); state.rwlogHash = hashInfo?.sha256 ?? null; state.duplicateOf = duplicateLookup(state.rwlogHash);
  const info = state.rwlogInfo, audit = passiveAudit(info), bits = [`${(file.size / 1024).toFixed(1)} KiB`, rwlogCompatibilityLabel(info)];
  if (info.header?.run_id != null) bits.push(`run ${info.header.run_id}`);
  if (info.header?.sample_count != null) bits.push(`${info.header.sample_count} samples`);
  if (state.rwlogHash) bits.push(`SHA-256 ${state.rwlogHash.slice(0, 16)}…`);
  if (info.crc.available) bits.push(info.crc.ok ? 'CRC PASS' : 'CRC FAIL');
  if (info.time_range?.log_duration_ms != null) bits.push(`log ${(info.time_range.log_duration_ms / 1000).toFixed(3)} s`);
  if (info.time_range?.t_test_duration_ms != null) bits.push(`t_test ${(info.time_range.t_test_duration_ms / 1000).toFixed(3)} s`);
  if (audit) bits.push(`PASSIVE AUDIT ${audit.status}`);
  if (state.duplicateOf) bits.push(`DUPLICATE of ${state.duplicateOf.session_id}`);
  el.rwlogName.textContent = file.name; el.rwlogDetails.textContent = bits.join(' · '); updatePairing(); updateButtons();
}

function updatePairing() {
  const audit = passiveAudit(state.rwlogInfo);
  if (!state.videoBlob) state.pairing = { status: 'NOT READY', reason: 'Record a video first.' };
  else if (!state.rwlogFile) state.pairing = { status: 'NO RWLOG', reason: 'Attach the RWLOG produced by this run.' };
  else if (state.duplicateOf) state.pairing = { status: 'CHECK', reason: `This exact RWLOG was already exported with ${state.duplicateOf.session_id}.` };
  else if (state.rwlogInfo?.crc.available && state.rwlogInfo.crc.ok === false) state.pairing = { status: 'CHECK', reason: 'RWLOG CRC failed. The file may be damaged.' };
  else if (audit && audit.status !== 'PASS') state.pairing = { status: 'CHECK', reason: `Passive-command audit is ${audit.status}; inspect command fields and metadata before pairing.` };
  else if (state.rwlogInfo?.time_range?.pair_duration_ms == null) state.pairing = { status: 'UNVERIFIED', reason: 'RWLOG duration is unavailable. The file is preserved and may be paired manually.' };
  else {
    const videoMs = state.durationMs, logMs = state.rwlogInfo.time_range.pair_duration_ms, delta = videoMs - logMs;
    if (delta >= -1000 && delta <= 10000) state.pairing = { status: 'MATCH', reason: `Video−RWLOG duration ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(3)} s. Extra camera lead/trail is allowed.` };
    else if (delta >= -5000 && delta <= 30000) state.pairing = { status: 'CHECK', reason: `Video−RWLOG duration ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(3)} s; verify the run manually.` };
    else state.pairing = { status: 'MISMATCH', reason: `Video−RWLOG duration ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(3)} s strongly suggests another run or missing video.` };
  }
  renderPairing();
}

function renderPairing() {
  const s = state.pairing.status;
  setStatus(el.pairState, s, s === 'MATCH' ? 'good' : ['MISMATCH', 'NO RWLOG', 'NOT READY'].includes(s) ? 'bad' : 'warn');
  el.pairDetails.textContent = state.pairing.reason; updateButtons();
}

function csvEscape(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function angleCsv() {
  const headers = ['t_session_ms','video_recording_time_ms','video_element_media_time_ms','frame','angle_mode','marker_mode','valid','angle_camera_line_deg','fixed_horizontal_reference_deg','angle_absolute_deg','relative_zero_camera_deg','angle_relative_deg','angle_raw_deg','angle_filtered_deg','marker1_x','marker1_y','marker2_x','marker2_y','marker_distance_px','marker1_area_analysis_px','marker2_area_analysis_px'];
  const lines = [headers.join(',')]; for (const row of state.rows) lines.push(headers.map(h => csvEscape(row[h])).join(',')); return lines.join('\n') + '\n';
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
    const track = state.stream?.getVideoTracks()[0], settings = track?.getSettings?.() || {}, cfg = state.recordingConfig;
    const manifest = {
      schema_version: 1,
      app: { name: 'Marker Angle Session Recorder', version: APP_VERSION },
      session_id: state.sessionId, session_created_iso: state.sessionCreatedIso,
      recording: { start_iso: state.recordingStartIso, end_iso: state.recordingEndIso, duration_ms: state.durationMs, rows: state.rows.length },
      camera: { width: settings.width ?? el.video.videoWidth, height: settings.height ?? el.video.videoHeight, frame_rate: settings.frameRate ?? null, device_label: track?.label || null },
      angle_reference: {
        mode: cfg.angle_mode,
        policy: cfg.angle_mode === 'absolute-fixed-horizontal' ? 'body_line_minus_fixed_horizontal' : 'diagnostic_relative_zero',
        per_run_zero_subtraction: cfg.per_run_zero_subtraction,
        fixed_horizontal_reference_deg: cfg.fixed_horizontal_reference_deg,
        relative_zero_camera_deg: cfg.relative_zero_camera_deg,
        sign_multiplier: cfg.sign_multiplier,
        sign_confirmed: cfg.sign_confirmed,
      },
      marker: { ...cfg.marker, baseline_distance_px: cfg.baseline_distance_px },
      quality: { valid_frames: state.validFrames, total_frames: state.totalFrames, valid_ratio: state.totalFrames ? state.validFrames / state.totalFrames : null },
      video: { mime_type: state.videoMime, bytes: state.videoBlob.size, sha256: videoHash?.sha256 ?? null, hash_status: videoHash?.status ?? null },
      angle_csv: { bytes: csvBlob.size, sha256: csvHash?.sha256 ?? null },
      rwlog: state.rwlogFile ? { original_name: state.rwlogFile.name, bytes: state.rwlogFile.size, sha256: state.rwlogHash, inspection: state.rwlogInfo } : null,
      pairing: { ...state.pairing, override: needsOverride ? el.pairOverride.checked : false, emergency_without_rwlog: !state.rwlogFile },
    };
    const result = await exportSessionZip({ sessionId: state.sessionId, videoBlob: state.videoBlob, videoExtension: 'webm', angleCsv: csv, rwlogFile: state.rwlogFile, manifest });
    if (state.rwlogHash) rememberRwlog(state.rwlogHash); state.exported = true;
    el.exportState.textContent = `Exported ${result.filename} (${(result.bytes / 1024 / 1024).toFixed(1)} MiB)`; el.sessionState.textContent = 'COMPLETE'; el.sessionState.className = 'good';
  } catch (error) { el.exportState.textContent = `Export failed: ${String(error)}`; }
  finally { updateButtons(); }
}

function updateButtons() {
  const locked = state.recording || (!!state.videoBlob && !state.exported);
  el.record.disabled = !state.stream || state.recording || !!state.videoBlob || !referenceReady() || !state.signConfirmed || !state.current?.valid;
  el.stop.disabled = !state.recording; el.newSession.disabled = state.recording || (!!state.videoBlob && !state.exported);
  el.startCamera.disabled = state.recording; el.cameraSelect.disabled = state.recording;
  el.zero.disabled = angleMode() !== 'relative-zero' || !state.stream || state.recording || !state.current?.detected;
  el.invertSign.disabled = locked; el.confirmSign.disabled = locked || !state.current?.detected;
  el.angleMode.disabled = locked; el.fixedHorizontalDeg.disabled = locked || angleMode() !== 'absolute-fixed-horizontal'; el.markerMode.disabled = locked;
  [el.minSat, el.minValue, el.whiteMaxSat, el.whiteMinValue, el.minArea].forEach(input => { input.disabled = locked; });
  const needsOverride = ['MISMATCH', 'CHECK'].includes(state.pairing.status);
  el.exportButton.disabled = state.recording || !state.videoBlob || state.exported || (!state.rwlogFile && !el.emergencyExport.checked) || (needsOverride && !el.pairOverride.checked);
}

el.newSession.addEventListener('click', newSession);
el.startCamera.addEventListener('click', () => startCamera().catch(error => { el.exportState.textContent = String(error); }));
el.zero.addEventListener('click', setRelativeZero);
el.invertSign.addEventListener('click', () => { if (state.recording || state.videoBlob) return; state.sign *= -1; state.signConfirmed = false; state.filteredAngle = null; renderCalibration(); processFrame(); });
el.confirmSign.addEventListener('click', () => { if (!state.current?.detected || state.recording || state.videoBlob) return; state.signConfirmed = true; state.baselineDistance = state.current.distance; renderCalibration(); });
el.record.addEventListener('click', () => { try { startRecording(); } catch (error) { el.exportState.textContent = String(error); } });
el.stop.addEventListener('click', () => stopRecording().catch(error => { el.exportState.textContent = String(error); }));
el.rwlogInput.addEventListener('change', event => attachRwlog(event.target.files?.[0]).catch(error => { el.rwlogDetails.textContent = String(error); }));
el.rwlogDrop.addEventListener('click', () => el.rwlogInput.click());
el.rwlogDrop.addEventListener('dragover', event => { event.preventDefault(); el.rwlogDrop.classList.add('drag'); });
el.rwlogDrop.addEventListener('dragleave', () => el.rwlogDrop.classList.remove('drag'));
el.rwlogDrop.addEventListener('drop', event => { event.preventDefault(); el.rwlogDrop.classList.remove('drag'); attachRwlog(event.dataTransfer.files?.[0]).catch(error => { el.rwlogDetails.textContent = String(error); }); });
el.pairOverride.addEventListener('change', updateButtons); el.emergencyExport.addEventListener('change', updateButtons); el.exportButton.addEventListener('click', doExport);
el.markerMode.addEventListener('change', () => { state.relativeZeroAngle = null; state.baselineDistance = null; state.signConfirmed = false; state.filteredAngle = null; renderCalibration(); });
el.angleMode.addEventListener('change', () => { state.filteredAngle = null; state.signConfirmed = false; state.baselineDistance = null; renderCalibration(); processFrame(); });
el.fixedHorizontalDeg.addEventListener('change', () => { savePersistentReference(); state.filteredAngle = null; state.signConfirmed = false; state.baselineDistance = null; renderCalibration(); processFrame(); });

window.addEventListener('beforeunload', () => stopCamera());
loadPersistentReference(); newSession(); refreshCameraList().catch(() => {}); renderCalibration(); renderPairing();
