import {
  applyCameraControls,
  applySavedCameraControls,
  automaticExposureRequest,
  automaticWhiteBalanceRequest,
  cameraControlSnapshot,
  clearSavedCameraControlProfile,
  loadSavedCameraControlProfile,
  manualExposureFromCurrent,
  manualWhiteBalanceFromCurrent,
  saveCameraControlProfile,
} from './camera-control.js';

const $ = id => document.getElementById(id);
const el = {
  state: $('cameraControlState'), live: $('cameraLiveSettings'), dump: $('cameraCapabilityDump'), message: $('cameraControlMessage'),
  freezeExposure: $('freezeExposure'), autoExposure: $('autoExposure'), freezeWhiteBalance: $('freezeWhiteBalance'), autoWhiteBalance: $('autoWhiteBalance'),
  apply: $('applyCameraControls'), save: $('saveCameraControls'), clear: $('clearCameraControls'),
  exposureModeField: $('exposureModeField'), exposureMode: $('exposureMode'),
  exposureTimeField: $('exposureTimeField'), exposureTimeRange: $('exposureTimeRange'), exposureTime: $('exposureTime'), exposureTimeHuman: $('exposureTimeHuman'),
  isoField: $('isoField'), isoRange: $('isoRange'), iso: $('iso'),
  exposureCompensationField: $('exposureCompensationField'), exposureCompensationRange: $('exposureCompensationRange'), exposureCompensation: $('exposureCompensation'),
  whiteBalanceModeField: $('whiteBalanceModeField'), whiteBalanceMode: $('whiteBalanceMode'),
  colorTemperatureField: $('colorTemperatureField'), colorTemperatureRange: $('colorTemperatureRange'), colorTemperature: $('colorTemperature'),
  brightnessField: $('brightnessField'), brightnessRange: $('brightnessRange'), brightness: $('brightness'),
};

let track = null;
let liveTimer = null;
let exposureHistory = [];

const numericControls = {
  exposureTime: [el.exposureTimeField, el.exposureTimeRange, el.exposureTime],
  iso: [el.isoField, el.isoRange, el.iso],
  exposureCompensation: [el.exposureCompensationField, el.exposureCompensationRange, el.exposureCompensation],
  colorTemperature: [el.colorTemperatureField, el.colorTemperatureRange, el.colorTemperature],
  brightness: [el.brightnessField, el.brightnessRange, el.brightness],
};

function fmt(value, digits = 3) {
  return Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
}

function exposureHuman(value) {
  const raw = Number(value);
  if (!Number.isFinite(raw)) return '';
  const ms = raw * 0.1;
  if (ms >= 1000) return `= ${(ms / 1000).toFixed(3)} s`;
  if (ms >= 1) return `= ${ms.toFixed(2)} ms`;
  return `= ${(ms * 1000).toFixed(0)} µs`;
}

function setState(text, cls = '') {
  el.state.textContent = text;
  el.state.className = `camera-control-state ${cls}`.trim();
}

function setMessage(text) {
  el.message.textContent = text;
}

function setModeField(field, select, capability, setting) {
  const values = Array.isArray(capability) ? capability : [];
  field.hidden = values.length === 0;
  select.innerHTML = '';
  for (const value of values) {
    const option = document.createElement('option');
    option.value = value; option.textContent = value;
    select.appendChild(option);
  }
  if (values.includes(setting)) select.value = setting;
}

function setNumericField(key, capability, setting) {
  const [field, range, number] = numericControls[key];
  const ok = capability && typeof capability === 'object' && Number.isFinite(Number(capability.min)) && Number.isFinite(Number(capability.max));
  field.hidden = !ok;
  if (!ok) return;
  const min = Number(capability.min), max = Number(capability.max);
  const step = Number.isFinite(Number(capability.step)) && Number(capability.step) > 0 ? Number(capability.step) : Math.max((max - min) / 200, 0.001);
  for (const input of [range, number]) {
    input.min = String(min); input.max = String(max); input.step = String(step);
  }
  const value = Number.isFinite(Number(setting)) ? Number(setting) : min;
  range.value = String(value); number.value = String(value);
  if (key === 'exposureTime') el.exposureTimeHuman.textContent = exposureHuman(value);
}

function syncPair(range, number, after = null) {
  range.addEventListener('input', () => { number.value = range.value; after?.(range.value); });
  number.addEventListener('input', () => { range.value = number.value; after?.(number.value); });
}

syncPair(el.exposureTimeRange, el.exposureTime, value => { el.exposureTimeHuman.textContent = exposureHuman(value); });
syncPair(el.isoRange, el.iso);
syncPair(el.exposureCompensationRange, el.exposureCompensation);
syncPair(el.colorTemperatureRange, el.colorTemperature);
syncPair(el.brightnessRange, el.brightness);

function populateFromSnapshot(snapshot, preserveInputs = false) {
  const caps = snapshot.capabilities || {}, settings = snapshot.settings || {};
  if (!preserveInputs) {
    setModeField(el.exposureModeField, el.exposureMode, caps.exposureMode, settings.exposureMode);
    setModeField(el.whiteBalanceModeField, el.whiteBalanceMode, caps.whiteBalanceMode, settings.whiteBalanceMode);
    for (const key of Object.keys(numericControls)) setNumericField(key, caps[key], settings[key]);
  }

  const manualExposure = Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual') && settings.exposureTime != null;
  const autoExposure = Array.isArray(caps.exposureMode) && (caps.exposureMode.includes('continuous') || caps.exposureMode.includes('single-shot'));
  const manualWb = Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('manual') && settings.colorTemperature != null;
  const autoWb = Array.isArray(caps.whiteBalanceMode) && (caps.whiteBalanceMode.includes('continuous') || caps.whiteBalanceMode.includes('single-shot'));
  el.freezeExposure.disabled = !manualExposure;
  el.autoExposure.disabled = !autoExposure;
  el.freezeWhiteBalance.disabled = !manualWb;
  el.autoWhiteBalance.disabled = !autoWb;
  el.apply.disabled = Object.keys(caps).length === 0;
  el.save.disabled = Object.keys(caps).length === 0;

  el.dump.textContent = JSON.stringify(snapshot, null, 2);
}

function liveText(settings) {
  const parts = [];
  if (settings.exposureMode != null) parts.push(`露出=${settings.exposureMode}`);
  if (settings.exposureTime != null) parts.push(`時間=${fmt(settings.exposureTime, 2)} (${exposureHuman(settings.exposureTime).replace('= ', '')})`);
  if (settings.iso != null) parts.push(`ISO=${fmt(settings.iso, 1)}`);
  if (settings.exposureCompensation != null) parts.push(`補正=${fmt(settings.exposureCompensation, 2)} EV`);
  if (settings.whiteBalanceMode != null) parts.push(`WB=${settings.whiteBalanceMode}`);
  if (settings.colorTemperature != null) parts.push(`色温度=${fmt(settings.colorTemperature, 0)} K`);
  if (settings.brightness != null) parts.push(`明るさ=${fmt(settings.brightness, 2)}`);
  return parts.length ? parts.join(' · ') : 'このカメラは露出関連SettingsをWebへ公開していません';
}

function refreshLive() {
  if (!track || track.readyState === 'ended') return;
  const snapshot = cameraControlSnapshot(track);
  const settings = snapshot.settings || {};
  if (settings.exposureTime != null) {
    exposureHistory.push(Number(settings.exposureTime));
    exposureHistory = exposureHistory.slice(-12);
  }
  let suffix = '';
  if (exposureHistory.length >= 4) {
    const min = Math.min(...exposureHistory), max = Math.max(...exposureHistory);
    if (max - min > 1e-9) suffix = ' ⚠ 露出時間が変動中';
  }
  el.live.textContent = `${liveText(settings)}${suffix}`;
  el.dump.textContent = JSON.stringify(snapshot, null, 2);
}

function readForm() {
  const out = {};
  if (!el.exposureModeField.hidden && el.exposureMode.value) out.exposureMode = el.exposureMode.value;
  if (!el.exposureTimeField.hidden && el.exposureTime.value !== '') out.exposureTime = Number(el.exposureTime.value);
  if (!el.isoField.hidden && el.iso.value !== '') out.iso = Number(el.iso.value);
  if (!el.exposureCompensationField.hidden && el.exposureCompensation.value !== '') out.exposureCompensation = Number(el.exposureCompensation.value);
  if (!el.whiteBalanceModeField.hidden && el.whiteBalanceMode.value) out.whiteBalanceMode = el.whiteBalanceMode.value;
  if (!el.colorTemperatureField.hidden && el.colorTemperature.value !== '') out.colorTemperature = Number(el.colorTemperature.value);
  if (!el.brightnessField.hidden && el.brightness.value !== '') out.brightness = Number(el.brightness.value);
  return out;
}

async function applyAndRefresh(request, message) {
  if (!track) return;
  setState('適用中…', 'warn');
  const result = await applyCameraControls(track, request);
  const snapshot = cameraControlSnapshot(track);
  populateFromSnapshot(snapshot, false);
  exposureHistory = [];
  refreshLive();
  setState(result.status === 'APPLIED' ? '適用済み' : result.status, result.status === 'APPLIED' ? 'good' : 'warn');
  setMessage(`${message} / ${result.results.map(r => `${r.key}:${r.status}`).join(', ') || '適用可能項目なし'}`);
}

async function attachTrack(nextTrack) {
  track = nextTrack || null;
  exposureHistory = [];
  if (liveTimer) clearInterval(liveTimer);
  if (!track) {
    setState('カメラ開始待ち');
    el.live.textContent = 'カメラ開始後に表示';
    return;
  }

  setState('Capabilities確認中…', 'warn');
  const initial = cameraControlSnapshot(track);
  populateFromSnapshot(initial, false);

  const saved = loadSavedCameraControlProfile();
  if (saved) {
    const result = await applySavedCameraControls(track);
    populateFromSnapshot(cameraControlSnapshot(track), false);
    if (result.status === 'APPLIED' || result.status === 'PARTIAL') {
      setMessage('保存済みの本番用カメラ設定をこのデバッグカメラにも適用しました。');
    } else if (result.status === 'DEVICE_MISMATCH') {
      setMessage('保存済み設定は別カメラ用だったため自動適用しませんでした。');
    }
  }

  const snapshot = cameraControlSnapshot(track);
  const exposureCaps = snapshot.capabilities.exposureMode || [];
  if (Array.isArray(exposureCaps) && exposureCaps.includes('manual')) setState('手動露出に対応', 'good');
  else if (snapshot.capabilities.exposureCompensation || snapshot.capabilities.brightness) setState('露出固定は不可 / 明るさ調整は可能', 'warn');
  else setState('Webから露出固定不可', 'bad');

  refreshLive();
  liveTimer = setInterval(refreshLive, 350);
}

window.addEventListener('marker-debug-camera-track', event => { void attachTrack(event.detail?.track || null); });

el.freezeExposure.addEventListener('click', async () => {
  const request = manualExposureFromCurrent(track);
  if (!request) return setMessage('このカメラは現在値を使ったmanual露出固定に対応していません。');
  await applyAndRefresh(request, '現在の露出時間をmanualへ固定しました');
});

el.autoExposure.addEventListener('click', async () => {
  const request = automaticExposureRequest(track);
  if (!request) return setMessage('自動露出モードをWebから選択できません。');
  await applyAndRefresh(request, '自動露出へ戻しました');
});

el.freezeWhiteBalance.addEventListener('click', async () => {
  const request = manualWhiteBalanceFromCurrent(track);
  if (!request) return setMessage('このカメラは現在値を使ったWB固定に対応していません。');
  await applyAndRefresh(request, '現在の色温度をmanual WBへ固定しました');
});

el.autoWhiteBalance.addEventListener('click', async () => {
  const request = automaticWhiteBalanceRequest(track);
  if (!request) return setMessage('自動WBモードをWebから選択できません。');
  await applyAndRefresh(request, '自動WBへ戻しました');
});

el.apply.addEventListener('click', async () => { await applyAndRefresh(readForm(), '入力値をカメラへ適用しました'); });

el.save.addEventListener('click', () => {
  if (!track) return;
  const profile = saveCameraControlProfile(track, readForm());
  setMessage(`本番用に保存しました: ${profile.device_label || '現在のカメラ'}。本番ページを再読み込みすると適用されます。`);
  setState('本番用設定を保存済み', 'good');
});

el.clear.addEventListener('click', () => {
  clearSavedCameraControlProfile();
  setMessage('本番用の保存設定を削除しました。現在のカメラ状態自体は変更しません。');
});

window.addEventListener('beforeunload', () => { if (liveTimer) clearInterval(liveTimer); });
