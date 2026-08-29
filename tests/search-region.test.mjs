import assert from 'node:assert/strict';
import {
  DEFAULT_MARKER_SEARCH_REGION,
  clampMarkerSearchRegion,
  loadSavedMarkerSearchRegion,
  saveMarkerSearchRegion,
  clearSavedMarkerSearchRegion,
  setMarkerSearchRegionPreview,
  clearMarkerSearchRegionPreview,
} from '../src/search-region.js';
import { LEGACY_WHITE_MARKER_CONFIG } from '../src/marker.js';

const store = new Map();
globalThis.localStorage = {
  getItem: key => store.has(key) ? store.get(key) : null,
  setItem: (key, value) => store.set(key, String(value)),
  removeItem: key => store.delete(key),
};

clearSavedMarkerSearchRegion();
clearMarkerSearchRegionPreview();
assert.deepEqual([...DEFAULT_MARKER_SEARCH_REGION], [300, 380, 700, 140]);
assert.deepEqual(clampMarkerSearchRegion([-10, 710, 2000, 100]), [0, 620, 1280, 100]);
assert.deepEqual(loadSavedMarkerSearchRegion().region, [300, 380, 700, 140]);
assert.deepEqual([...LEGACY_WHITE_MARKER_CONFIG.searchRegion], [300, 380, 700, 140]);

saveMarkerSearchRegion([250, 330, 760, 190]);
assert.deepEqual(loadSavedMarkerSearchRegion().region, [250, 330, 760, 190]);
assert.deepEqual([...LEGACY_WHITE_MARKER_CONFIG.searchRegion], [250, 330, 760, 190]);

setMarkerSearchRegionPreview([100, 200, 600, 220]);
assert.deepEqual([...LEGACY_WHITE_MARKER_CONFIG.searchRegion], [100, 200, 600, 220]);
clearMarkerSearchRegionPreview();
assert.deepEqual([...LEGACY_WHITE_MARKER_CONFIG.searchRegion], [250, 330, 760, 190]);

clearSavedMarkerSearchRegion();
assert.deepEqual([...LEGACY_WHITE_MARKER_CONFIG.searchRegion], [300, 380, 700, 140]);
delete globalThis.localStorage;

console.log('marker search region persistence: OK');
