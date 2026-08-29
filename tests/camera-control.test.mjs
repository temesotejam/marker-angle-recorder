import assert from 'node:assert/strict';
import {
  applyCameraControls,
  applySavedCameraControls,
  automaticExposureRequest,
  cameraControlSnapshot,
  clearSavedCameraControlProfile,
  loadSavedCameraControlProfile,
  manualExposureFromCurrent,
  saveCameraControlProfile,
} from '../src/camera-control.js';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
}

globalThis.localStorage = new MemoryStorage();

function fakeTrack(label = 'Integrated Camera') {
  const capabilities = {
    exposureMode: ['continuous', 'manual'],
    exposureTime: { min: 1, max: 100, step: 1 },
    iso: { min: 100, max: 800, step: 100 },
    exposureCompensation: { min: -2, max: 2, step: 0.5 },
    whiteBalanceMode: ['continuous', 'manual'],
    colorTemperature: { min: 2500, max: 7500, step: 100 },
    brightness: { min: 0, max: 100, step: 1 },
  };
  const settings = {
    deviceId: 'device-1',
    exposureMode: 'continuous',
    exposureTime: 25,
    iso: 200,
    exposureCompensation: 0,
    whiteBalanceMode: 'continuous',
    colorTemperature: 5000,
    brightness: 50,
  };
  return {
    id: `track-${label}`,
    label,
    readyState: 'live',
    getCapabilities: () => structuredClone(capabilities),
    getSettings: () => structuredClone(settings),
    async applyConstraints(constraints) {
      const item = constraints?.advanced?.[0] || {};
      Object.assign(settings, item);
    },
  };
}

const track = fakeTrack();
const snapshot = cameraControlSnapshot(track);
assert.deepEqual(snapshot.capabilities.exposureMode, ['continuous', 'manual']);
assert.equal(snapshot.settings.exposureTime, 25);

assert.deepEqual(manualExposureFromCurrent(track), { exposureMode: 'manual', exposureTime: 25, iso: 200 });
assert.deepEqual(automaticExposureRequest(track), { exposureMode: 'continuous' });

const direct = await applyCameraControls(track, { exposureMode: 'manual', exposureTime: 37.4, iso: 450 });
assert.equal(direct.status, 'APPLIED');
assert.equal(track.getSettings().exposureMode, 'manual');
assert.equal(track.getSettings().exposureTime, 37);
assert.equal(track.getSettings().iso, 500);

const profile = saveCameraControlProfile(track, { exposureMode: 'manual', exposureTime: 41, iso: 300 });
assert.equal(profile.device_label, 'Integrated Camera');
assert.deepEqual(loadSavedCameraControlProfile().controls, { exposureMode: 'manual', exposureTime: 41, iso: 300 });

await applyCameraControls(track, { exposureMode: 'continuous', exposureTime: 20, iso: 100 });
const savedApply = await applySavedCameraControls(track);
assert.equal(savedApply.status, 'APPLIED');
assert.equal(track.getSettings().exposureMode, 'manual');
assert.equal(track.getSettings().exposureTime, 41);
assert.equal(track.getSettings().iso, 300);

const otherTrack = fakeTrack('USB Camera');
const mismatch = await applySavedCameraControls(otherTrack);
assert.equal(mismatch.status, 'DEVICE_MISMATCH');
assert.equal(otherTrack.getSettings().exposureMode, 'continuous');

clearSavedCameraControlProfile();
assert.equal(loadSavedCameraControlProfile(), null);
const none = await applySavedCameraControls(track);
assert.equal(none.status, 'NO_SAVED_PROFILE');

console.log('camera exposure control persistence/apply: OK');
