import assert from 'node:assert/strict';
import {
  estimateWhiteMarkerV,
  exposureMsToRaw,
  exposureRawToMs,
  nextMarkerExposureTime,
} from '../src/marker-auto-exposure.js';

function syntheticRoi(markerV) {
  const w = 20, h = 20;
  const rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inMarker = x >= 6 && x < 14 && y >= 6 && y < 14;
      const v = inMarker ? markerV : 55;
      rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255;
    }
  }
  return { rgba, w, h };
}

{
  const { rgba, w, h } = syntheticRoi(210);
  const value = estimateWhiteMarkerV(rgba, w, h);
  assert.equal(value, 210, 'central white marker brightness should dominate the high percentile');
}

{
  const { rgba, w, h } = syntheticRoi(145);
  const value = estimateWhiteMarkerV(rgba, w, h);
  assert.equal(value, 145, 'darkened white marker must remain measurable below recognition target');
}

assert.equal(exposureRawToMs(80), 8);
assert.equal(exposureMsToRaw(8), 80);

const capability = { min: 10, max: 200, step: 1 };

{
  const result = nextMarkerExposureTime({
    currentExposureTime: 50,
    measuredV: 150,
    targetV: 200,
    deadbandV: 12,
    maxStepRatio: 0.08,
    maxExposureMs: 10,
    capability,
  });
  assert.equal(result.action, 'increase');
  assert(result.exposureTime > 50 && result.exposureTime <= 54, 'dark marker should increase exposure conservatively');
}

{
  const result = nextMarkerExposureTime({
    currentExposureTime: 50,
    measuredV: 230,
    targetV: 200,
    deadbandV: 12,
    maxStepRatio: 0.08,
    maxExposureMs: 10,
    capability,
  });
  assert.equal(result.action, 'decrease');
  assert(result.exposureTime < 50, 'bright marker should decrease exposure');
}

{
  const result = nextMarkerExposureTime({
    currentExposureTime: 50,
    measuredV: 205,
    targetV: 200,
    deadbandV: 12,
    maxStepRatio: 0.08,
    maxExposureMs: 10,
    capability,
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.reason, 'deadband');
}

{
  const result = nextMarkerExposureTime({
    currentExposureTime: 50,
    measuredV: 100,
    targetV: 200,
    deadbandV: 12,
    maxStepRatio: 0.08,
    maxExposureMs: 5,
    capability,
  });
  assert.equal(result.action, 'hold');
  assert.equal(result.reason, 'max_exposure');
  assert.equal(result.exposureTime, 50);
}

console.log('marker auto exposure tests: PASS');
