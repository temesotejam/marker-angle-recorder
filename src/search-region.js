export const MARKER_SEARCH_REGION_STORAGE_KEY = 'marker-angle-recorder-search-region-v1';

const PREVIEW_KEY = '__markerAngleRecorderSearchRegionPreviewV1';

export function clampMarkerSearchRegion(region, frameWidth = 1280, frameHeight = 720) {
  const src = Array.isArray(region)
    ? region
    : [region?.x, region?.y, region?.w ?? region?.width, region?.h ?? region?.height];
  let [x, y, w, h] = src.map(Number);
  if (![x, y, w, h].every(Number.isFinite)) [x, y, w, h] = [0, 0, frameWidth, frameHeight];
  w = Math.max(1, Math.min(frameWidth, Math.round(w)));
  h = Math.max(1, Math.min(frameHeight, Math.round(h)));
  x = Math.max(0, Math.min(frameWidth - w, Math.round(x)));
  y = Math.max(0, Math.min(frameHeight - h, Math.round(y)));
  return [x, y, w, h];
}

export function loadSavedMarkerSearchRegion(defaultRegion, frameWidth = 1280, frameHeight = 720) {
  const fallback = clampMarkerSearchRegion(defaultRegion, frameWidth, frameHeight);
  if (typeof localStorage === 'undefined') return { region: fallback, source: 'default' };
  try {
    const raw = localStorage.getItem(MARKER_SEARCH_REGION_STORAGE_KEY);
    if (!raw) return { region: fallback, source: 'default' };
    const parsed = JSON.parse(raw);
    return { region: clampMarkerSearchRegion(parsed, frameWidth, frameHeight), source: 'saved' };
  } catch {
    return { region: fallback, source: 'default' };
  }
}

export function getMarkerSearchRegion(defaultRegion, frameWidth = 1280, frameHeight = 720) {
  const preview = globalThis?.[PREVIEW_KEY];
  if (preview) return clampMarkerSearchRegion(preview, frameWidth, frameHeight);
  return loadSavedMarkerSearchRegion(defaultRegion, frameWidth, frameHeight).region;
}

export function setMarkerSearchRegionPreview(region, frameWidth = 1280, frameHeight = 720) {
  const normalized = clampMarkerSearchRegion(region, frameWidth, frameHeight);
  globalThis[PREVIEW_KEY] = normalized;
  return normalized;
}

export function clearMarkerSearchRegionPreview() {
  try { delete globalThis[PREVIEW_KEY]; } catch { globalThis[PREVIEW_KEY] = null; }
}

export function saveMarkerSearchRegion(region, frameWidth = 1280, frameHeight = 720) {
  const normalized = clampMarkerSearchRegion(region, frameWidth, frameHeight);
  if (typeof localStorage !== 'undefined') {
    const [x, y, w, h] = normalized;
    localStorage.setItem(MARKER_SEARCH_REGION_STORAGE_KEY, JSON.stringify({
      x, y, w, h,
      canonical_width: frameWidth,
      canonical_height: frameHeight,
      saved_at: new Date().toISOString(),
    }));
  }
  return normalized;
}

export function clearSavedMarkerSearchRegion() {
  if (typeof localStorage !== 'undefined') localStorage.removeItem(MARKER_SEARCH_REGION_STORAGE_KEY);
}
