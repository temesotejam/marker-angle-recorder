const video = document.getElementById('cameraVideo');
let lastTrack = null;

function publishCurrentTrack() {
  const next = video?.srcObject?.getVideoTracks?.()[0] || null;
  if (next === lastTrack) return;
  lastTrack = next;
  window.dispatchEvent(new CustomEvent('marker-debug-camera-track', { detail: { track: next } }));
}

video?.addEventListener('loadedmetadata', publishCurrentTrack);
video?.addEventListener('playing', publishCurrentTrack);
video?.addEventListener('emptied', () => {
  lastTrack = null;
  window.dispatchEvent(new CustomEvent('marker-debug-camera-track', { detail: { track: null } }));
});
