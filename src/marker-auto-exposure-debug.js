import { applyCameraControls, cameraControlSnapshot, manualExposureFromCurrent } from './camera-control.js';
import {
  DEFAULT_MARKER_AUTO_EXPOSURE as DEFAULTS,
  estimateWhiteMarkerV,
  exposureRawToMs,
  nextMarkerExposureTime,
} from './marker-auto-exposure.js';

const $ = id => document.getElementById(id);
const el = {
  state: $('markerAeState'),
  live: $('markerAeLive'),
  message: $('markerAeMessage'),
  start: $('startMarkerAe'),
  stop: $('stopMarkerAe'),
  targetV: $('markerAeTargetV'),
  deadbandV: $('markerAeDeadbandV'),
  intervalMs: $('markerAeIntervalMs'),
  maxStepPercent: $('markerAeMaxStepPercent'),
  maxExposureMs: $('markerAeMaxExposureMs'),
  leftRoi: $('leftRoiCanvas'),
  rightRoi: $('rightRoiCanvas'),
  markerStatus: $('statusText'),
};

let track = null;
let enabled = false;
let busy = false;
let loopTimer = null;
let lastApplyAt = 0;
let lastTrackingAt = 0;
let lastMeasurement = null;
let maxExposureTouched = false;

function finite(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function setState(text, cls = '') {
  el.state.textContent = text;
  el.state.className = `marker-ae-state ${cls}`.trim();
}

function setMessage(text) {
  el.message.textContent = text;
}

function getConfig() {
  return {
    targetV: Math.max(1, Math.min(255, finite(el.targetV.value, DEFAULTS.targetV))),
    deadbandV: Math.max(0, Math.min(100, finite(el.deadbandV.value, DEFAULTS.deadbandV))),
    intervalMs: Math.max(100, Math.min(2000, finite(el.intervalMs.value, DEFAULTS.intervalMs))),
    maxStepRatio: Math.max(0.005, Math.min(0.5, finite(el.maxStepPercent.value, DEFAULTS.maxStepRatio * 100) / 100)),
    maxExposureMs: Math.max(0.1, finite(el.maxExposureMs.value, DEFAULTS.maxExposureMs)),
    lostHoldMs: DEFAULTS.lostHoldMs,
  };
}

function roiValue(canvas) {
  if (!canvas?.width || !canvas?.height) return null;
  try {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return estimateWhiteMarkerV(image.data, image.width, image.height);
  } catch {
    return null;
  }
}

function measureMarkerBrightness(now) {
  const markerState = el.markerStatus?.textContent || '';
  if (markerState === '追跡中') lastTrackingAt = now;
  const recentlyTracked = markerState === '追跡中' || (lastTrackingAt > 0 && now - lastTrackingAt <= getConfig().lostHoldMs);
  if (!recentlyTracked) return { valid: false, reason: 'marker_not_available', markerState };

  const leftV = roiValue(el.leftRoi);
  const rightV = roiValue(el.rightRoi);
  if (!Number.isFinite(leftV) || !Number.isFinite(rightV)) {
    return { valid: false, reason: 'roi_measurement_failed', markerState, leftV, rightV };
  }

  // The darker marker is the limiting one for a two-marker detector.
  return {
    valid: true,
    markerState,
    source: markerState === '追跡中' ? 'tracking' : 'recent_last_roi',
    leftV,
    rightV,
    markerV: Math.min(leftV, rightV),
  };
}

function updateLive(measurement, settings = {}) {
  lastMeasurement = measurement;
  if (!measurement?.valid) {
    el.live.textContent = `マーカー明るさ: 測定保留 (${measurement?.reason || '未取得'})`;
    return;
  }
  const exposureRaw = Number(settings.exposureTime);
  const exposureMs = exposureRawToMs(exposureRaw);
  const exposureText = Number.isFinite(exposureMs) ? `${exposureMs.toFixed(2)} ms` : '—';
  el.live.textContent = `左V=${measurement.leftV.toFixed(0)} · 右V=${measurement.rightV.toFixed(0)} · 制御V=${measurement.markerV.toFixed(0)} · exposure=${exposureText} · ${measurement.source}`;
}

function supportsTrialMode(nextTrack) {
  if (!nextTrack) return false;
  const snapshot = cameraControlSnapshot(nextTrack);
  const modes = snapshot.capabilities?.exposureMode;
  const cap = snapshot.capabilities?.exposureTime;
  return Array.isArray(modes) && modes.includes('manual') && cap && Number.isFinite(Number(cap.min)) && Number.isFinite(Number(cap.max));
}

function stopTrial(reason = '停止しました。現在のmanual露出値は保持します。') {
  enabled = false;
  busy = false;
  el.start.disabled = !supportsTrialMode(track);
  el.stop.disabled = true;
  if (track) setState('停止', 'warn');
  else setState('カメラ開始待ち');
  setMessage(reason);
}

async function startTrial() {
  if (!track || !supportsTrialMode(track)) {
    return setMessage('このカメラはWebからmanual露出時間を操作できないため、この試験モードは使えません。');
  }
  if ((el.markerStatus?.textContent || '') !== '追跡中') {
    return setMessage('左右マーカーが「追跡中」になってから開始してください。最初の位置を取得してから局所AEを開始します。');
  }

  const request = manualExposureFromCurrent(track);
  if (!request) return setMessage('現在の露出値をmanualへ引き継げませんでした。');
  setState('開始準備中…', 'warn');
  const result = await applyCameraControls(track, request);
  if (!['APPLIED', 'PARTIAL'].includes(result.status)) {
    setState('開始失敗', 'bad');
    return setMessage(`manual露出への切替に失敗しました: ${result.status}`);
  }

  enabled = true;
  busy = false;
  lastApplyAt = 0;
  lastTrackingAt = performance.now();
  el.start.disabled = true;
  el.stop.disabled = false;
  setState('試験中', 'good');
  setMessage('左右マーカーROIのうち暗い方を基準に、露出時間だけを小さく調整しています。本番設定には保存されません。');
}

async function controlTick() {
  if (!track) return;
  const now = performance.now();
  const snapshot = cameraControlSnapshot(track);
  const settings = snapshot.settings || {};
  const measurement = measureMarkerBrightness(now);
  updateLive(measurement, settings);
  if (!enabled || busy) return;

  if (settings.exposureMode != null && settings.exposureMode !== 'manual') {
    return stopTrial('露出モードがmanual以外へ変更されたため、マーカー基準AEを停止しました。');
  }

  const cfg = getConfig();
  if (now - lastApplyAt < cfg.intervalMs) return;
  if (!measurement.valid) return;
  if (!Number.isFinite(Number(settings.exposureTime))) return;

  const step = nextMarkerExposureTime({
    currentExposureTime: settings.exposureTime,
    measuredV: measurement.markerV,
    targetV: cfg.targetV,
    deadbandV: cfg.deadbandV,
    maxStepRatio: cfg.maxStepRatio,
    maxExposureMs: cfg.maxExposureMs,
    capability: snapshot.capabilities?.exposureTime || {},
  });

  if (step.action === 'hold') {
    if (step.reason === 'max_exposure') {
      setState('試験中 / 露出上限', 'warn');
      setMessage('マーカーが目標より暗いですが、モーションブラー防止用の最大露出時間に達しています。');
    } else {
      setState('試験中', 'good');
    }
    lastApplyAt = now;
    return;
  }

  busy = true;
  lastApplyAt = now;
  try {
    const result = await applyCameraControls(track, { exposureTime: step.exposureTime });
    if (!['APPLIED', 'PARTIAL'].includes(result.status)) {
      stopTrial(`露出時間の更新に失敗したため停止しました: ${result.status}`);
      return;
    }
    const after = cameraControlSnapshot(track).settings || {};
    updateLive(measurement, after);
    setState(step.action === 'increase' ? '試験中 / 明るく調整' : '試験中 / 暗く調整', 'good');
  } finally {
    busy = false;
  }
}

function attachTrack(nextTrack) {
  track = nextTrack || null;
  enabled = false;
  busy = false;
  lastApplyAt = 0;
  lastTrackingAt = 0;
  lastMeasurement = null;
  el.stop.disabled = true;

  if (!track) {
    el.start.disabled = true;
    setState('カメラ開始待ち');
    el.live.textContent = 'カメラ開始後に表示';
    return;
  }

  const supported = supportsTrialMode(track);
  el.start.disabled = !supported;
  const snapshot = cameraControlSnapshot(track);
  const currentMs = exposureRawToMs(snapshot.settings?.exposureTime);
  const capMaxMs = exposureRawToMs(snapshot.capabilities?.exposureTime?.max);
  if (!maxExposureTouched && Number.isFinite(currentMs)) {
    const candidate = Math.max(DEFAULTS.maxExposureMs, currentMs);
    el.maxExposureMs.value = Number.isFinite(capMaxMs) ? Math.min(candidate, capMaxMs).toFixed(1) : candidate.toFixed(1);
  }

  if (supported) {
    setState('試験可能', 'good');
    setMessage('左右マーカーが追跡中になったら開始できます。開始しても本番用設定には保存しません。');
  } else {
    setState('このカメラでは試験不可', 'bad');
    setMessage('manual露出時間がWebへ公開されていないため、マーカー基準AEは使えません。');
  }
}

el.targetV.value = String(DEFAULTS.targetV);
el.deadbandV.value = String(DEFAULTS.deadbandV);
el.intervalMs.value = String(DEFAULTS.intervalMs);
el.maxStepPercent.value = String(DEFAULTS.maxStepRatio * 100);
el.maxExposureMs.value = String(DEFAULTS.maxExposureMs);
el.maxExposureMs.addEventListener('input', () => { maxExposureTouched = true; });
el.start.addEventListener('click', () => { void startTrial(); });
el.stop.addEventListener('click', () => { stopTrial(); });
window.addEventListener('marker-debug-camera-track', event => attachTrack(event.detail?.track || null));

loopTimer = setInterval(() => { void controlTick(); }, 80);
window.addEventListener('beforeunload', () => { if (loopTimer) clearInterval(loopTimer); });
