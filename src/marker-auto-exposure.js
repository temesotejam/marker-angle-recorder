export const DEFAULT_MARKER_AUTO_EXPOSURE = Object.freeze({
  targetV: 200,
  deadbandV: 12,
  intervalMs: 250,
  maxStepRatio: 0.08,
  maxExposureMs: 10,
  lostHoldMs: 500,
});

function finite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function percentile(sorted, q) {
  if (!sorted.length) return null;
  const index = clamp(Math.round((sorted.length - 1) * q), 0, sorted.length - 1);
  return sorted[index];
}

/**
 * Estimate the brightness of a white marker from a rendered tracking ROI.
 * This is intentionally separate from the recognition threshold logic.
 * It samples a central crop, keeps low-saturation pixels, and takes a high
 * percentile of V=max(R,G,B) so gray background does not dominate the value.
 */
export function estimateWhiteMarkerV(rgba, width, height, options = {}) {
  const w = Math.max(1, Math.floor(finite(width, 1)));
  const h = Math.max(1, Math.floor(finite(height, 1)));
  if (!rgba || rgba.length < w * h * 4) return null;

  const cropScale = clamp(finite(options.cropScale, 0.66), 0.2, 1);
  const satMax = clamp(finite(options.saturationMax255, 115), 0, 255);
  const minLowSatPixels = Math.max(4, Math.floor(finite(options.minLowSatPixels, 24)));
  const q = clamp(finite(options.percentile, 0.85), 0, 1);

  const cropW = Math.max(1, Math.round(w * cropScale));
  const cropH = Math.max(1, Math.round(h * cropScale));
  const x0 = Math.max(0, Math.floor((w - cropW) / 2));
  const y0 = Math.max(0, Math.floor((h - cropH) / 2));
  const x1 = Math.min(w, x0 + cropW);
  const y1 = Math.min(h, y0 + cropH);

  const lowSatValues = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4;
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const sat = max === 0 ? 0 : (max - min) * 255 / max;
      if (sat <= satMax) lowSatValues.push(max);
    }
  }

  if (lowSatValues.length < minLowSatPixels) return null;
  lowSatValues.sort((a, b) => a - b);
  return percentile(lowSatValues, q);
}

export function exposureRawToMs(exposureTime) {
  const raw = finite(exposureTime);
  return raw == null ? null : raw * 0.1;
}

export function exposureMsToRaw(ms) {
  const value = finite(ms);
  return value == null ? null : value * 10;
}

function snapToCapability(value, capability = {}) {
  let out = finite(value, 0);
  const min = finite(capability.min);
  const max = finite(capability.max);
  const step = finite(capability.step);
  if (min != null) out = Math.max(min, out);
  if (max != null) out = Math.min(max, out);
  if (step != null && step > 0 && min != null) {
    out = min + Math.round((out - min) / step) * step;
  }
  if (min != null) out = Math.max(min, out);
  if (max != null) out = Math.min(max, out);
  return out;
}

/**
 * One conservative AE step. exposureTime follows Media Capture Image units
 * (100 microseconds). ISO is deliberately not changed in this trial mode.
 */
export function nextMarkerExposureTime({
  currentExposureTime,
  measuredV,
  targetV = DEFAULT_MARKER_AUTO_EXPOSURE.targetV,
  deadbandV = DEFAULT_MARKER_AUTO_EXPOSURE.deadbandV,
  maxStepRatio = DEFAULT_MARKER_AUTO_EXPOSURE.maxStepRatio,
  maxExposureMs = DEFAULT_MARKER_AUTO_EXPOSURE.maxExposureMs,
  capability = {},
} = {}) {
  const current = finite(currentExposureTime);
  const measured = finite(measuredV);
  const target = clamp(finite(targetV, 200), 1, 255);
  const deadband = clamp(finite(deadbandV, 12), 0, 100);
  const stepLimit = clamp(finite(maxStepRatio, 0.08), 0.005, 0.5);
  if (current == null || measured == null) return { action: 'hold', reason: 'missing_value', exposureTime: current };

  const error = target - measured;
  if (Math.abs(error) <= deadband) {
    return { action: 'hold', reason: 'deadband', exposureTime: snapToCapability(current, capability), errorV: error };
  }

  // Proportional but bounded. At large errors this changes exposure by at most
  // maxStepRatio per control tick to avoid visible pumping.
  const proportional = (error / target) * 0.35;
  const ratio = clamp(proportional, -stepLimit, stepLimit);
  let next = current * (1 + ratio);

  const userMaxRaw = exposureMsToRaw(maxExposureMs);
  const capabilityMax = finite(capability.max);
  const effectiveMax = userMaxRaw == null
    ? capabilityMax
    : capabilityMax == null ? userMaxRaw : Math.min(userMaxRaw, capabilityMax);
  if (effectiveMax != null) next = Math.min(next, effectiveMax);
  next = snapToCapability(next, capability);

  const epsilon = finite(capability.step, 0) > 0 ? finite(capability.step, 0) / 2 : 1e-9;
  if (Math.abs(next - current) <= epsilon) {
    const atUpperLimit = error > 0 && effectiveMax != null && current >= effectiveMax - epsilon;
    return {
      action: 'hold',
      reason: atUpperLimit ? 'max_exposure' : 'quantized',
      exposureTime: current,
      errorV: error,
      effectiveMaxExposureTime: effectiveMax,
    };
  }

  return {
    action: next > current ? 'increase' : 'decrease',
    reason: 'adjust',
    exposureTime: next,
    errorV: error,
    ratio,
    effectiveMaxExposureTime: effectiveMax,
  };
}
