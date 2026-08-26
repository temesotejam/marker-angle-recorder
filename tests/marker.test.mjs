import assert from 'node:assert/strict';
import { LEGACY_WHITE_MARKER_CONFIG as c } from '../src/marker.js';

assert.deepEqual([...c.searchRegion], [300, 380, 700, 140]);
assert.equal(c.canonicalWidth, 1280);
assert.equal(c.canonicalHeight, 720);
assert.equal(c.roiWidth, 96);
assert.equal(c.roiHeight, 90);

assert.deepEqual(c.initial, {
  saturationMax255: 85,
  valueMin255: 120,
  areaMin: 180,
  areaMax: 1600,
  widthMin: 12,
  widthMax: 55,
  heightMin: 12,
  heightMax: 55,
  fillMin: 0.35,
  pairDxMin: 180,
  pairDxMax: 450,
  pairDyMax: 45,
});

assert.deepEqual(c.tracking, {
  saturationMax255: 70,
  valueMin255: 145,
  areaMin: 140,
  areaMax: 2500,
  widthMin: 8,
  widthMax: 90,
  heightMin: 8,
  heightMax: 90,
  fillMin: 0.30,
  morphRadius: 2,
  expandedRoiScale: 1.8,
});

console.log('legacy marker recognition constants: OK');
