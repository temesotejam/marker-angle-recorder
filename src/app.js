import { createLegacyWhiteMarkerTracker, drawMarkerOverlay, LEGACY_WHITE_MARKER_CONFIG } from './marker.js';
import { inspectRwlog } from './rwlog.js';
import { exportSessionZip, fileSha256 } from './zip.js';

const APP_VERSION = '0.3.0-v1';
const MARKER_METHOD = 'legacy_white_roi_tracking';
const $ = id => document.getElementById(id);
const el = {
  sessionId: $('sessionId'), sessionState: $('sessionState'), cameraSelect: $('cameraSelect'), startCamera: $('startCamera'), resetMarker: $('resetMarker'), newSession: $('newSession'),
  video: $('cameraVideo'), overlay: $('overlay'), analysis: $('analysisCanvas'), angle: $('angleValue'), rawAngle: $('rawAngle'), cameraAngle: $('cameraAngle'),
  markerState: $('markerState'), leftState: $('redState'), rightState: $('blueState'), zeroState: $('zeroState'), signState: $('signState'), zero: $('zeroButton'),
  invertSign: $('invertSign'), confirmSign: $('confirmSign'), signDescription: $('signDescription'), record: $('recordButton'), stop: $('stopButton'), timer: $('recordTimer'),
  angleMode: $('angleMode'), fixedHorizontalDeg: $('fixedHorizontalDeg'), fixedHorizontalRow: $('fixedHorizontalRow'),
  rwlogDrop: $('rwlogDrop'), rwlogInput: $('rwlogInput'), rwlogName: $('rwlogName'), rwlogDetails: $('rwlogDetails'), pairState: $('pairState'), pairDetails: $('pairDetails'),
  pairOverride: $('pairOverride'), emergencyExport: $('emergencyExport'), exportButton: $('exportButton'), exportState: $('exportState'), quality: $('quality'),
};

const tracker = createLegacyWhiteMarkerTracker();
const state = {
  sessionId: null, sessionCreatedIso: null, exported: false,
  stream: null, cameraToken: 0, recorder: null, chunks: [], videoBlob: null, videoMime: 'video/webm', recording: false,
  recordingStartPerf: null, recordingStartIso: null, recordingEndIso: null, recordingFirstMediaTime: null, durationMs: null, recordingConfig: null,
  rows: [], frameIndex: 0, relativeZeroAngle: null, sign: 1, signConfirmed: false, filteredAngle: null, current: null,
  validFrames: 0, totalFrames: 0, rwlogFile: null, rwlogInfo: null, rwlogHash: null, duplicateOf: null,
  pairing: { status: 'NOT_READY', reason: '動画を録画したあと、このrunのRWLOGを追加してください。' },
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
function angleMode() { return el.angleMode.value; }
function fixedHorizontal() { return finiteNumber(el.fixedHorizontalDeg.value, 0); }
function referenceReady() { return angleMode() === 'absolute-fixed-horizontal' || Number.isFinite(state.relativeZeroAngle); }
function lockedAfterRecording() { return state.recording || (!!state.videoBlob && !state.exported); }

function clearRunFiles() {
  state.exported = false; state.videoBlob = null; state.durationMs = null; state.rows = []; state.frameIndex = 0; state.validFrames = 0; state.totalFrames = 0;
  state.recordingStartPerf = null; state.recordingStartIso = null; state.recordingEndIso = null; state.recordingFirstMediaTime = null; state.recordingConfig = null;
  state.rwlogFile = null; state.rwlogInfo = null; state.rwlogHash = null; state.duplicateOf = null;
  state.pairing = { status: 'NOT_READY', reason: '動画を録画したあと、このrunのRWLOGを追加してください。' };
  el.rwlogInput.value = ''; el.rwlogName.textContent = 'RWLOG未添付'; el.rwlogDetails.textContent = ''; el.pairOverride.checked = false; el.emergencyExport.checked = false;
  el.exportState.textContent = ''; el.timer.textContent = '0.00 s'; el.quality.textContent = '有効 0/0'; renderPairing();
}

function newSession() {
  if (state.recording || (state.videoBlob && !state.exported)) return;
  state.sessionId = sessionIdNow(); state.sessionCreatedIso = new Date().toISOString(); state.relativeZeroAngle = null; state.sign = 1; state.signConfirmed = false;
  state.filteredAngle = null; state.current = null; tracker.reset();
  el.sessionId.textContent = state.sessionId; el.sessionState.textContent = '準備完了'; el.sessionState.className = 'ready';
  clearRunFiles(); renderCalibration(); renderAngle(); updateButtons();
}

function renderCalibration() {
  if (angleMode() === 'absolute-fixed-horizontal') {
    setStatus(el.zeroState, `固定 ${fmt(fixedHorizontal())}°`, 'good');
    el.fixedHorizontalRow.hidden = false;
    el.signDescription.textContent = '絶対角度 = 機体基準線 − 固定水平基準。runごとのゼロ引きは行いません。';
  } else {
    setStatus(el.zeroState, Number.isFinite(state.relativeZeroAngle) ? 'ZERO設定済み' : 'ZERO未設定', Number.isFinite(state.relativeZeroAngle) ? 'good' : 'bad');
    el.fixedHorizontalRow.hidden = true;
    el.signDescription.textContent = '相対ZEROは確認用です。受動研究の絶対角度データには使用しません。';
  }
  setStatus(el.signState, state.signConfirmed ? '確認済み' : '未確認', state.signConfirmed ? 'good' : 'bad');
  updateButtons();
}

function loadPersistentReference() {
  try {
    const saved = localStorage.getItem('marker-angle-recorder-fixed-horizontal-deg');
    if (saved != null && Number.isFinite(Number(saved))) el.fixedHorizontalDeg.value = Number(saved).toFixed(3);
  } catch { /* 保存は補助機能 */ }
}
function savePersistentReference() {
  const value = Math.max(-180, Math.min(180, fixedHorizontal())); el.fixedHorizontalDeg.value = value.toFixed(3);
  try { localStorage.setItem('marker-angle-recorder-fixed-horizontal-deg', String(value)); } catch { /* 保存できなくても計測は継続 */ }
}

async function refreshCameraList() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const previous = el.cameraSelect.value, devices = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  el.cameraSelect.innerHTML = '';
  devices.forEach((d, i) => { const option = document.createElement('option'); option.value = d.deviceId; option.textContent = d.label || `カメラ ${i + 1}`; el.cameraSelect.appendChild(option); });
  if ([...el.cameraSelect.options].some(o => o.value === previous)) el.cameraSelect.value = previous;
}

function stopCamera() {
  state.cameraToken++; state.stream?.getTracks().forEach(track => track.stop()); state.stream = null; el.video.srcObject = null; state.current = null; tracker.reset();
  renderAngle(); updateButtons();
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('カメラAPIを利用できません。HTTPSの対応ブラウザで開いてください。');
  stopCamera();
  const deviceId = el.cameraSelect.value;
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
  state.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  el.video.srcObject = state.stream; await el.video.play(); await refreshCameraList(); tracker.reset();
  const token = ++state.cameraToken; scheduleFrame(token); updateButtons();
}

function resetMarkerTracking() {
  if (lockedAfterRecording()) return;
  tracker.reset(); state.current = null; state.signConfirmed = false; state.filteredAngle = null;
  renderCalibration(); renderAngle();
}

function processFrame(frameMetadata = null) {
  const vw = el.video.videoWidth, vh = el.video.videoHeight;
  if (!vw || !vh) return;

  // 既存解析器の認識条件を変えないため、認識入力は常に1280x720へ正規化する。
  const aw = LEGACY_WHITE_MARKER_CONFIG.canonicalWidth, ah = LEGACY_WHITE_MARKER_CONFIG.canonicalHeight;
  const ctx = el.analysis.getContext('2d', { willReadFrequently: true, alpha: false });
  if (el.analysis.width !== aw || el.analysis.height !== ah) { el.analysis.width = aw; el.analysis.height = ah; }
  ctx.drawImage(el.video, 0, 0, aw, ah);
  const tracked = tracker.process(ctx, aw, ah);

  let current = {
    detected: false, initialized: tracked.initialized, valid: false,
    leftDetected: !!tracked.left, rightDetected: !!tracked.right,
    angleCamera: null, angleAbsolute: null, angleRelative: null, angleRaw: null, angleFiltered: null,
    distance: null, a: null, b: null, areas: [tracked.left?.area ?? null, tracked.right?.area ?? null], modes: tracked.modes ?? {},
  };

  if (tracked.detected) {
    const left = tracked.left, right = tracked.right;
    const angleCamera = -Math.atan2(right.cy - left.cy, right.cx - left.cx) * 180 / Math.PI;
    const distance = Math.hypot(right.cx - left.cx, right.cy - left.cy);
    const angleAbsolute = state.sign * normalizeDelta(angleCamera - fixedHorizontal());
    const angleRelative = Number.isFinite(state.relativeZeroAngle) ? state.sign * normalizeDelta(angleCamera - state.relativeZeroAngle) : null;
    const angleRaw = angleMode() === 'absolute-fixed-horizontal' ? angleAbsolute : angleRelative;
    let angleFiltered = null;
    if (Number.isFinite(angleRaw)) {
      state.filteredAngle = state.filteredAngle == null ? angleRaw : state.filteredAngle + 0.22 * (angleRaw - state.filteredAngle);
      angleFiltered = state.filteredAngle;
    }
    const sx = vw / aw, sy = vh / ah;
    current = {
      detected: true, initialized: true, valid: true, leftDetected: true, rightDetected: true,
      angleCamera, angleAbsolute, angleRelative, angleRaw, angleFiltered, distance,
      a: { x: left.cx * sx, y: left.cy * sy }, b: { x: right.cx * sx, y: right.cy * sy },
      areas: [left.area, right.area], modes: tracked.modes,
    };
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
      frame: state.frameIndex++, angle_mode: angleMode(), marker_method: MARKER_METHOD, valid: current.valid ? 1 : 0,
      angle_camera_line_deg: current.angleCamera, fixed_horizontal_reference_deg: fixedHorizontal(), angle_absolute_deg: current.angleAbsolute,
      relative_zero_camera_deg: state.relativeZeroAngle, angle_relative_deg: current.angleRelative, angle_raw_deg: current.angleRaw, angle_filtered_deg: current.angleFiltered,
      marker_left_x: current.a?.x ?? null, marker_left_y: current.a?.y ?? null, marker_right_x: current.b?.x ?? null, marker_right_y: current.b?.y ?? null,
      marker_distance_canonical_px: current.distance, marker_left_area_canonical_px: current.areas[0], marker_right_area_canonical_px: current.areas[1],
      marker_left_roi_mode: current.modes?.white_l ?? null, marker_right_roi_mode: current.modes?.white_r ?? null,
    });
    el.timer.textContent = `${(t / 1000).toFixed(2)} s`;
    el.quality.textContent = `有効 ${state.validFrames}/${state.totalFrames} (${state.totalFrames ? (100 * state.validFrames / state.totalFrames).toFixed(1) : '0.0'}%)`;
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
    el.angle.textContent = '---.---°'; el.rawAngle.textContent = '---'; el.cameraAngle.textContent = '---';
    setStatus(el.markerState, c?.initialized ? '追跡中に見失い' : '白丸ペア探索中', c?.initialized ? 'warn' : 'bad');
    setStatus(el.leftState, c?.leftDetected ? '検出' : '未検出', c?.leftDetected ? 'good' : 'bad');
    setStatus(el.rightState, c?.rightDetected ? '検出' : '未検出', c?.rightDetected ? 'good' : 'bad');
    return;
  }
  setStatus(el.leftState, '検出', 'good'); setStatus(el.rightState, '検出', 'good'); setStatus(el.markerState, '追跡中', 'good');
  el.cameraAngle.textContent = `${fmt(c.angleCamera)}°`;
  el.rawAngle.textContent = Number.isFinite(c.angleRaw) ? `${fmt(c.angleRaw)}°` : '基準未設定';
  el.angle.textContent = Number.isFinite(c.angleFiltered) ? `${c.angleFiltered >= 0 ? '+' : ''}${fmt(c.angleFiltered)}°` : '---.---°';
}

function setRelativeZero() {
  if (angleMode() !== 'relative-zero' || !state.current?.detected || state.recording) return;
  state.relativeZeroAngle = state.current.angleCamera; state.filteredAngle = 0; state.signConfirmed = false; renderCalibration();
}

function chooseMime() {
  if (!window.MediaRecorder) throw new Error('このブラウザでは動画録画機能を利用できません。');
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
    marker: { method: MARKER_METHOD, source: 'video-rwlog-angle-analyzer/src/analysis.js', canonical_input: [1280, 720], config: LEGACY_WHITE_MARKER_CONFIG },
  };
  state.recording = true; state.recordingStartPerf = performance.now(); state.recordingStartIso = new Date().toISOString(); state.recordingFirstMediaTime = null;
  state.rows = []; state.frameIndex = 0; state.validFrames = 0; state.totalFrames = 0; state.recorder.start(1000);
  el.sessionState.textContent = '録画中'; el.sessionState.className = 'recording'; updateButtons();
}

async function stopRecording() {
  if (!state.recording || !state.recorder) return;
  const recorder = state.recorder;
  await new Promise(resolve => { recorder.addEventListener('stop', resolve, { once: true }); recorder.stop(); });
  state.durationMs = performance.now() - state.recordingStartPerf; state.recordingEndIso = new Date().toISOString(); state.recording = false;
  state.videoBlob = new Blob(state.chunks, { type: state.videoMime || 'video/webm' });
  el.sessionState.textContent = '録画済み'; el.sessionState.className = 'ready'; el.timer.textContent = `${(state.durationMs / 1000).toFixed(2)} s`;
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
function rwlogLabel(info) {
  if (info?.support === 'version-decoded') return `RWLOG v${info.format_version} 詳細対応`;
  if (info?.support === 'common-header') return `RWLOG v${info.format_version ?? '?'} 共通ヘッダ対応`;
  if (info?.support === 'magic-only') return 'RWLOG01のみ確認';
  return '不明形式（原本保存）';
}

async function attachRwlog(file) {
  if (!file || state.recording) return;
  el.rwlogName.textContent = '確認中…'; el.rwlogDetails.textContent = '';
  const buffer = await file.arrayBuffer(), hashInfo = await fileSha256(file, Number.POSITIVE_INFINITY);
  state.rwlogFile = file; state.rwlogInfo = inspectRwlog(buffer); state.rwlogHash = hashInfo?.sha256 ?? null; state.duplicateOf = duplicateLookup(state.rwlogHash);
  const info = state.rwlogInfo, audit = passiveAudit(info), bits = [`${(file.size / 1024).toFixed(1)} KiB`, rwlogLabel(info)];
  if (info.header?.run_id != null) bits.push(`run ${info.header.run_id}`);
  if (info.header?.sample_count != null) bits.push(`${info.header.sample_count} サンプル`);
  if (state.rwlogHash) bits.push(`SHA-256 ${state.rwlogHash.slice(0, 16)}…`);
  if (info.crc.available) bits.push(info.crc.ok ? 'CRC PASS' : 'CRC FAIL');
  if (info.time_range?.log_duration_ms != null) bits.push(`ログ ${(info.time_range.log_duration_ms / 1000).toFixed(3)} s`);
  if (info.time_range?.t_test_duration_ms != null) bits.push(`t_test ${(info.time_range.t_test_duration_ms / 1000).toFixed(3)} s`);
  if (audit) bits.push(`受動監査 ${audit.status}`);
  if (state.duplicateOf) bits.push(`重複: ${state.duplicateOf.session_id} で使用済み`);
  el.rwlogName.textContent = file.name; el.rwlogDetails.textContent = bits.join(' · '); updatePairing(); updateButtons();
}

function updatePairing() {
  const audit = passiveAudit(state.rwlogInfo);
  if (!state.videoBlob) state.pairing = { status: 'NOT_READY', reason: '先に動画を録画してください。' };
  else if (!state.rwlogFile) state.pairing = { status: 'NO_RWLOG', reason: 'このrunで取得したRWLOGを追加してください。' };
  else if (state.duplicateOf) state.pairing = { status: 'CHECK', reason: `同一RWLOGが ${state.duplicateOf.session_id} ですでに使用されています。` };
  else if (state.rwlogInfo?.crc.available && state.rwlogInfo.crc.ok === false) state.pairing = { status: 'CHECK', reason: 'RWLOGのCRCが一致しません。ファイル破損の可能性があります。' };
  else if (audit && audit.status !== 'PASS') state.pairing = { status: 'CHECK', reason: `受動監査が ${audit.status} です。指令値とメタデータを確認してください。` };
  else if (state.rwlogInfo?.time_range?.pair_duration_ms == null) state.pairing = { status: 'UNVERIFIED', reason: 'RWLOGの記録時間を取得できません。原本は保存できるため、手動で同じrunか確認してください。' };
  else {
    const videoMs = state.durationMs, logMs = state.rwlogInfo.time_range.pair_duration_ms, delta = videoMs - logMs;
    if (delta >= -1000 && delta <= 10000) state.pairing = { status: 'MATCH', reason: `動画−RWLOG記録時間差 ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(3)} s。動画前後の余分な時間を許容しています。` };
    else if (delta >= -5000 && delta <= 30000) state.pairing = { status: 'CHECK', reason: `動画−RWLOG記録時間差 ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(3)} s。runを手動確認してください。` };
    else state.pairing = { status: 'MISMATCH', reason: `動画−RWLOG記録時間差 ${delta >= 0 ? '+' : ''}${(delta / 1000).toFixed(3)} s。別runまたは動画欠落の可能性が高いです。` };
  }
  renderPairing();
}

function renderPairing() {
  const map = { NOT_READY: '未準備', NO_RWLOG: 'ログ未添付', MATCH: '一致', CHECK: '要確認', MISMATCH: '不一致', UNVERIFIED: '未検証' };
  const s = state.pairing.status;
  setStatus(el.pairState, map[s] ?? s, s === 'MATCH' ? 'good' : ['MISMATCH', 'NO_RWLOG', 'NOT_READY'].includes(s) ? 'bad' : 'warn');
  el.pairDetails.textContent = state.pairing.reason; updateButtons();
}

function csvEscape(v) {
  if (v == null || (typeof v === 'number' && !Number.isFinite(v))) return '';
  const s = String(v); return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}
function angleCsv() {
  const headers = ['t_session_ms','video_recording_time_ms','video_element_media_time_ms','frame','angle_mode','marker_method','valid','angle_camera_line_deg','fixed_horizontal_reference_deg','angle_absolute_deg','relative_zero_camera_deg','angle_relative_deg','angle_raw_deg','angle_filtered_deg','marker_left_x','marker_left_y','marker_right_x','marker_right_y','marker_distance_canonical_px','marker_left_area_canonical_px','marker_right_area_canonical_px','marker_left_roi_mode','marker_right_roi_mode'];
  const lines = [headers.join(',')]; for (const row of state.rows) lines.push(headers.map(h => csvEscape(row[h])).join(',')); return lines.join('\n') + '\n';
}

async function doExport() {
  if (!state.videoBlob) return;
  const needsOverride = ['MISMATCH', 'CHECK'].includes(state.pairing.status);
  if (!state.rwlogFile && !el.emergencyExport.checked) return;
  if (needsOverride && !el.pairOverride.checked) return;
  el.exportButton.disabled = true; el.exportState.textContent = 'SHA-256計算とZIP作成中…';
  try {
    const csv = angleCsv(), csvBlob = new Blob([csv], { type: 'text/csv' });
    const [videoHash, csvHash] = await Promise.all([fileSha256(state.videoBlob), fileSha256(csvBlob)]);
    const track = state.stream?.getVideoTracks()[0], settings = track?.getSettings?.() || {}, cfg = state.recordingConfig;
    const manifest = {
      schema_version: 1,
      app: { name: 'Marker Angle Recorder', version: APP_VERSION },
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
      marker: cfg.marker,
      quality: { valid_frames: state.validFrames, total_frames: state.totalFrames, valid_ratio: state.totalFrames ? state.validFrames / state.totalFrames : null },
      video: { mime_type: state.videoMime, bytes: state.videoBlob.size, sha256: videoHash?.sha256 ?? null, hash_status: videoHash?.status ?? null },
      angle_csv: { bytes: csvBlob.size, sha256: csvHash?.sha256 ?? null },
      rwlog: state.rwlogFile ? { original_name: state.rwlogFile.name, bytes: state.rwlogFile.size, sha256: state.rwlogHash, inspection: state.rwlogInfo } : null,
      pairing: { ...state.pairing, override: needsOverride ? el.pairOverride.checked : false, emergency_without_rwlog: !state.rwlogFile },
    };
    const result = await exportSessionZip({ sessionId: state.sessionId, videoBlob: state.videoBlob, videoExtension: 'webm', angleCsv: csv, rwlogFile: state.rwlogFile, manifest });
    if (state.rwlogHash) rememberRwlog(state.rwlogHash); state.exported = true;
    el.exportState.textContent = `${result.filename} を書き出しました (${(result.bytes / 1024 / 1024).toFixed(1)} MiB)`;
    el.sessionState.textContent = '完了'; el.sessionState.className = 'good';
  } catch (error) { el.exportState.textContent = `ZIP出力に失敗しました: ${String(error)}`; }
  finally { updateButtons(); }
}

function updateButtons() {
  const locked = lockedAfterRecording();
  el.record.disabled = !state.stream || state.recording || !!state.videoBlob || !referenceReady() || !state.signConfirmed || !state.current?.valid;
  el.stop.disabled = !state.recording; el.newSession.disabled = state.recording || (!!state.videoBlob && !state.exported);
  el.startCamera.disabled = locked; el.resetMarker.disabled = locked || !state.stream; el.cameraSelect.disabled = locked;
  el.zero.disabled = angleMode() !== 'relative-zero' || !state.stream || state.recording || !state.current?.detected;
  el.invertSign.disabled = locked; el.confirmSign.disabled = locked || !state.current?.detected;
  el.angleMode.disabled = locked; el.fixedHorizontalDeg.disabled = locked || angleMode() !== 'absolute-fixed-horizontal';
  const needsOverride = ['MISMATCH', 'CHECK'].includes(state.pairing.status);
  el.exportButton.disabled = state.recording || !state.videoBlob || state.exported || (!state.rwlogFile && !el.emergencyExport.checked) || (needsOverride && !el.pairOverride.checked);
}

el.newSession.addEventListener('click', newSession);
el.startCamera.addEventListener('click', () => startCamera().catch(error => { el.exportState.textContent = String(error); }));
el.resetMarker.addEventListener('click', resetMarkerTracking);
el.zero.addEventListener('click', setRelativeZero);
el.invertSign.addEventListener('click', () => { if (lockedAfterRecording()) return; state.sign *= -1; state.signConfirmed = false; state.filteredAngle = null; renderCalibration(); });
el.confirmSign.addEventListener('click', () => { if (!state.current?.detected || lockedAfterRecording()) return; state.signConfirmed = true; renderCalibration(); });
el.record.addEventListener('click', () => { try { startRecording(); } catch (error) { el.exportState.textContent = String(error); } });
el.stop.addEventListener('click', () => stopRecording().catch(error => { el.exportState.textContent = String(error); }));
el.rwlogInput.addEventListener('change', event => attachRwlog(event.target.files?.[0]).catch(error => { el.rwlogDetails.textContent = String(error); }));
el.rwlogDrop.addEventListener('click', () => el.rwlogInput.click());
el.rwlogDrop.addEventListener('dragover', event => { event.preventDefault(); el.rwlogDrop.classList.add('drag'); });
el.rwlogDrop.addEventListener('dragleave', () => el.rwlogDrop.classList.remove('drag'));
el.rwlogDrop.addEventListener('drop', event => { event.preventDefault(); el.rwlogDrop.classList.remove('drag'); attachRwlog(event.dataTransfer.files?.[0]).catch(error => { el.rwlogDetails.textContent = String(error); }); });
el.pairOverride.addEventListener('change', updateButtons); el.emergencyExport.addEventListener('change', updateButtons); el.exportButton.addEventListener('click', doExport);
el.angleMode.addEventListener('change', () => { state.filteredAngle = null; state.signConfirmed = false; renderCalibration(); });
el.fixedHorizontalDeg.addEventListener('change', () => { savePersistentReference(); state.filteredAngle = null; state.signConfirmed = false; renderCalibration(); });

window.addEventListener('beforeunload', () => stopCamera());
loadPersistentReference(); newSession(); refreshCameraList().catch(() => {}); renderCalibration(); renderPairing();
