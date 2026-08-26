// Runtime stability helpers for research acquisition.
//
// IMPORTANT: this file does not touch the legacy white-marker recognition
// algorithm or open/use the camera stream by itself. The previous automatic
// MediaRecorder warm-up was removed because it could interfere with camera
// acquisition on some browsers/devices.

const NativeMediaRecorder = window.MediaRecorder;
const nativeIsTypeSupported = NativeMediaRecorder?.isTypeSupported?.bind(NativeMediaRecorder);

// Prefer VP8 over VP9 without starting a second recorder on the camera stream.
// app.js asks MediaRecorder.isTypeSupported() in VP9 -> VP8 -> WebM order, so
// reporting VP9 unavailable when VP8 exists preserves the lighter VP8 recording
// path while avoiding any camera-stream warm-up side effects.
if (NativeMediaRecorder && nativeIsTypeSupported) {
  try {
    NativeMediaRecorder.isTypeSupported = type => {
      if (typeof type === 'string' && /codecs\s*=\s*vp9/i.test(type) && nativeIsTypeSupported('video/webm;codecs=vp8')) return false;
      return nativeIsTypeSupported(type);
    };
  } catch {
    // If the browser exposes a non-writable static method, acquisition still works.
  }
}

function installRawMainDisplay() {
  const main = document.getElementById('angleValue');
  const raw = document.getElementById('rawAngle');
  if (!main || !raw) return;

  const metrics = raw.closest('div');
  let filtered = document.getElementById('filteredAngle');
  if (!filtered && metrics) {
    const row = document.createElement('div');
    row.innerHTML = '<dt>表示用平滑角</dt><dd id="filteredAngle">---</dd>';
    metrics.insertAdjacentElement('afterend', row);
    filtered = row.querySelector('#filteredAngle');
  }

  let internalUpdate = false;
  const sync = () => {
    if (internalUpdate) {
      internalUpdate = false;
      return;
    }

    // app.js writes the filtered value into the large display. Preserve that as
    // a small reference value, then replace the large display with the raw angle.
    if (filtered) filtered.textContent = main.textContent;
    const value = Number.parseFloat(raw.textContent);
    const next = Number.isFinite(value) ? `${value >= 0 ? '+' : ''}${value.toFixed(3)}°` : '---.---°';
    if (main.textContent !== next) {
      internalUpdate = true;
      main.textContent = next;
    }
  };

  const observer = new MutationObserver(sync);
  observer.observe(raw, { childList: true, characterData: true, subtree: true });
  observer.observe(main, { childList: true, characterData: true, subtree: true });
  sync();
}

installRawMainDisplay();
