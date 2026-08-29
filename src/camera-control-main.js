import { applySavedCameraControls } from './camera-control.js';

const video = document.getElementById('cameraVideo');
let appliedTrackId = null;
let applying = null;

async function applyForCurrentTrack() {
  const track = video?.srcObject?.getVideoTracks?.()[0];
  if (!track || track.readyState === 'ended') return;
  if (appliedTrackId === track.id) return;
  if (applying) return applying;

  applying = (async () => {
    const result = await applySavedCameraControls(track);
    appliedTrackId = track.id;
    window.__markerAngleCameraControlAudit = result;
    window.dispatchEvent(new CustomEvent('marker-main-camera-control-applied', { detail: result }));
  })().finally(() => { applying = null; });

  return applying;
}

video?.addEventListener('loadedmetadata', () => { void applyForCurrentTrack(); });
video?.addEventListener('playing', () => { void applyForCurrentTrack(); });
video?.addEventListener('emptied', () => { appliedTrackId = null; });
