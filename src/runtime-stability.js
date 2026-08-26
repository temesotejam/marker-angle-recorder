// Runtime stability helpers for research acquisition.
//
// This file intentionally does NOT change the legacy white-marker recognition
// algorithm. It only changes the presentation of the measured angle and warms
// the browser video encoder before the actual experiment recording starts.

const NativeMediaRecorder = window.MediaRecorder;
const nativeIsTypeSupported = NativeMediaRecorder?.isTypeSupported?.bind(NativeMediaRecorder);

// The first field run used VP9 and showed a short callback stall immediately
// after recording started. Prefer VP8 when available because it is lighter to
// initialize on typical integrated-camera PCs. Keep MediaRecorder's native
// fallback behavior for every other MIME type.
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

let warmPromise = null;
let warmedTrackId = null;

async function warmEncoderForCurrentCamera() {
  if (!NativeMediaRecorder || !nativeIsTypeSupported) return;
  const video = document.getElementById('cameraVideo');
  const stream = video?.srcObject;
  const track = stream?.getVideoTracks?.()[0];
  if (!stream || !track) return;
  if (warmedTrackId === track.id) return;
  if (warmPromise) return warmPromise;

  warmPromise = new Promise(resolve => {
    let recorder = null;
    let timer = null;
    try {
      const preferred = nativeIsTypeSupported('video/webm;codecs=vp8') ? 'video/webm;codecs=vp8' : 'video/webm';
      recorder = nativeIsTypeSupported(preferred)
        ? new NativeMediaRecorder(stream, { mimeType: preferred })
        : new NativeMediaRecorder(stream);
      recorder.addEventListener('dataavailable', () => {});
      recorder.addEventListener('stop', () => {
        if (timer) clearTimeout(timer);
        warmedTrackId = track.id;
        warmPromise = null;
        resolve();
      }, { once: true });
      recorder.addEventListener('error', () => {
        if (timer) clearTimeout(timer);
        warmPromise = null;
        resolve();
      }, { once: true });
      recorder.start(200);
      timer = setTimeout(() => {
        try {
          if (recorder?.state !== 'inactive') recorder.stop();
          else resolve();
        } catch {
          resolve();
        }
      }, 650);
    } catch {
      warmPromise = null;
      resolve();
    }
  });

  return warmPromise;
}

function installRecordingWarmup() {
  const video = document.getElementById('cameraVideo');
  const recordButton = document.getElementById('recordButton');
  if (!video || !recordButton) return;

  const warm = () => {
    const track = video.srcObject?.getVideoTracks?.()[0];
    if (track && track.id !== warmedTrackId) {
      warmedTrackId = null;
      void warmEncoderForCurrentCamera();
    }
  };
  video.addEventListener('playing', warm);
  video.addEventListener('loadedmetadata', warm);

  // If the user presses REC before automatic warm-up finished, consume that
  // click, finish warm-up, and then replay the click. No measurement samples are
  // fabricated and no angle values are interpolated.
  let replaying = false;
  recordButton.addEventListener('click', async event => {
    if (replaying) return;
    const track = video.srcObject?.getVideoTracks?.()[0];
    if (!track || warmedTrackId === track.id) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    const originalText = recordButton.textContent;
    recordButton.textContent = '録画準備中…';
    await warmEncoderForCurrentCamera();
    recordButton.textContent = originalText;
    replaying = true;
    recordButton.click();
    replaying = false;
  }, true);
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

    // At this point app.js has already written the filtered value into the large
    // display. Preserve it as a small reference value, then replace the large
    // display with the raw measured angle.
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

installRecordingWarmup();
installRawMainDisplay();
