export const CAMERA_CONTROL_STORAGE_KEY = 'marker-angle-recorder-camera-control-v1';

export const CAMERA_CONTROL_KEYS = Object.freeze([
  'exposureMode',
  'exposureTime',
  'iso',
  'exposureCompensation',
  'whiteBalanceMode',
  'colorTemperature',
  'brightness',
]);

const MODE_KEYS = new Set(['exposureMode', 'whiteBalanceMode']);
const NUMERIC_KEYS = new Set(CAMERA_CONTROL_KEYS.filter(key => !MODE_KEYS.has(key)));

function safeCapabilities(track) {
  try { return track?.getCapabilities?.() || {}; } catch { return {}; }
}

function safeSettings(track) {
  try { return track?.getSettings?.() || {}; } catch { return {}; }
}

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clampToCapability(value, capability) {
  const n = finite(value);
  if (n == null) return null;
  if (!capability || typeof capability !== 'object') return n;
  const min = finite(capability.min), max = finite(capability.max), step = finite(capability.step);
  let out = n;
  if (min != null) out = Math.max(min, out);
  if (max != null) out = Math.min(max, out);
  if (step != null && step > 0 && min != null) out = min + Math.round((out - min) / step) * step;
  if (min != null) out = Math.max(min, out);
  if (max != null) out = Math.min(max, out);
  return out;
}

function enumSupported(capability, value) {
  return Array.isArray(capability) && capability.includes(value);
}

export function cameraIdentity(track) {
  const settings = safeSettings(track);
  return {
    device_label: track?.label || null,
    device_id: settings.deviceId || null,
  };
}

export function summarizeCameraControlCapabilities(track) {
  const caps = safeCapabilities(track);
  const out = {};
  for (const key of CAMERA_CONTROL_KEYS) {
    const value = caps[key];
    if (Array.isArray(value)) out[key] = [...value];
    else if (value && typeof value === 'object') {
      out[key] = {
        min: finite(value.min),
        max: finite(value.max),
        step: finite(value.step),
      };
    }
  }
  return out;
}

export function cameraControlSnapshot(track) {
  const settings = safeSettings(track);
  const picked = {};
  for (const key of CAMERA_CONTROL_KEYS) if (settings[key] != null) picked[key] = settings[key];
  return {
    identity: cameraIdentity(track),
    settings: picked,
    capabilities: summarizeCameraControlCapabilities(track),
  };
}

export function normalizeCameraControlRequest(track, requested = {}) {
  const caps = safeCapabilities(track);
  const normalized = {};
  const skipped = {};

  for (const key of CAMERA_CONTROL_KEYS) {
    if (requested[key] == null || requested[key] === '') continue;
    const capability = caps[key];
    if (MODE_KEYS.has(key)) {
      const value = String(requested[key]);
      if (enumSupported(capability, value)) normalized[key] = value;
      else skipped[key] = 'unsupported';
      continue;
    }
    if (NUMERIC_KEYS.has(key)) {
      if (!capability || typeof capability !== 'object') {
        skipped[key] = 'unsupported';
        continue;
      }
      const value = clampToCapability(requested[key], capability);
      if (value == null) skipped[key] = 'invalid';
      else normalized[key] = value;
    }
  }
  return { normalized, skipped, capabilities: summarizeCameraControlCapabilities(track) };
}

async function applyOne(track, key, value) {
  try {
    await track.applyConstraints({ advanced: [{ [key]: value }] });
    return { key, requested: value, status: 'applied', actual: safeSettings(track)[key] ?? null };
  } catch (error) {
    return { key, requested: value, status: 'error', error: error?.name || String(error), actual: safeSettings(track)[key] ?? null };
  }
}

export async function applyCameraControls(track, requested = {}) {
  if (!track?.applyConstraints) return { status: 'UNAVAILABLE', requested, results: [], settings_before: {}, settings_after: {}, capabilities: {} };
  const before = cameraControlSnapshot(track);
  const { normalized, skipped, capabilities } = normalizeCameraControlRequest(track, requested);
  const results = [];

  // Modes first, then the values that depend on those modes.
  const order = ['exposureMode', 'exposureTime', 'iso', 'exposureCompensation', 'whiteBalanceMode', 'colorTemperature', 'brightness'];
  for (const key of order) {
    if (!(key in normalized)) continue;
    results.push(await applyOne(track, key, normalized[key]));
  }

  const after = cameraControlSnapshot(track);
  const errors = results.filter(r => r.status === 'error').length;
  const applied = results.filter(r => r.status === 'applied').length;
  let status = 'NO_SUPPORTED_CONTROLS';
  if (applied && !errors) status = 'APPLIED';
  else if (applied && errors) status = 'PARTIAL';
  else if (errors) status = 'FAILED';

  return {
    status,
    requested,
    normalized,
    skipped,
    results,
    settings_before: before.settings,
    settings_after: after.settings,
    capabilities,
    identity: after.identity,
  };
}

export function loadSavedCameraControlProfile() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(CAMERA_CONTROL_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.controls || typeof parsed.controls !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCameraControlProfile(track, controls = {}) {
  const profile = {
    schema_version: 1,
    ...cameraIdentity(track),
    controls: Object.fromEntries(CAMERA_CONTROL_KEYS.filter(key => controls[key] != null && controls[key] !== '').map(key => [key, controls[key]])),
    saved_at: new Date().toISOString(),
  };
  if (typeof localStorage !== 'undefined') localStorage.setItem(CAMERA_CONTROL_STORAGE_KEY, JSON.stringify(profile));
  return profile;
}

export function clearSavedCameraControlProfile() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(CAMERA_CONTROL_STORAGE_KEY);
}

function profileMatchesTrack(profile, track) {
  if (!profile) return false;
  const current = cameraIdentity(track);
  if (profile.device_label && current.device_label && profile.device_label !== current.device_label) return false;
  return true;
}

export async function applySavedCameraControls(track) {
  const profile = loadSavedCameraControlProfile();
  if (!profile) return { status: 'NO_SAVED_PROFILE', identity: cameraIdentity(track), settings_after: cameraControlSnapshot(track).settings };
  if (!profileMatchesTrack(profile, track)) {
    return {
      status: 'DEVICE_MISMATCH',
      saved_identity: { device_label: profile.device_label || null, device_id: profile.device_id || null },
      identity: cameraIdentity(track),
      settings_after: cameraControlSnapshot(track).settings,
    };
  }
  const result = await applyCameraControls(track, profile.controls);
  return { ...result, saved_profile: profile };
}

export function manualExposureFromCurrent(track) {
  const caps = safeCapabilities(track), settings = safeSettings(track);
  if (!enumSupported(caps.exposureMode, 'manual') || finite(settings.exposureTime) == null) return null;
  const request = { exposureMode: 'manual', exposureTime: settings.exposureTime };
  if (caps.iso && finite(settings.iso) != null) request.iso = settings.iso;
  return request;
}

export function automaticExposureRequest(track) {
  const caps = safeCapabilities(track);
  const modes = Array.isArray(caps.exposureMode) ? caps.exposureMode : [];
  if (modes.includes('continuous')) return { exposureMode: 'continuous' };
  if (modes.includes('single-shot')) return { exposureMode: 'single-shot' };
  return null;
}

export function manualWhiteBalanceFromCurrent(track) {
  const caps = safeCapabilities(track), settings = safeSettings(track);
  if (!enumSupported(caps.whiteBalanceMode, 'manual') || finite(settings.colorTemperature) == null) return null;
  return { whiteBalanceMode: 'manual', colorTemperature: settings.colorTemperature };
}

export function automaticWhiteBalanceRequest(track) {
  const caps = safeCapabilities(track);
  const modes = Array.isArray(caps.whiteBalanceMode) ? caps.whiteBalanceMode : [];
  if (modes.includes('continuous')) return { whiteBalanceMode: 'continuous' };
  if (modes.includes('single-shot')) return { whiteBalanceMode: 'single-shot' };
  return null;
}
