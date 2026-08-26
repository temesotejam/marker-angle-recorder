async function sha256Hex(blob) {
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function fileSha256(fileOrBlob, maxBytes = 256 * 1024 * 1024) {
  if (!fileOrBlob) return null;
  if (fileOrBlob.size > maxBytes) return { status: 'skipped-large-file', bytes: fileOrBlob.size, sha256: null };
  return { status: 'ok', bytes: fileOrBlob.size, sha256: await sha256Hex(fileOrBlob) };
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function exportSessionZip({ sessionId, videoBlob, videoExtension, angleCsv, rwlogFile, manifest }) {
  const { default: JSZip } = await import('https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm');
  const zip = new JSZip();
  const videoName = `${sessionId}_video_raw.${videoExtension}`;
  const angleName = `${sessionId}_angle.csv`;
  const logName = rwlogFile ? `${sessionId}_log.rwlog` : null;
  const manifestName = `${sessionId}_manifest.json`;

  if (videoBlob) zip.file(videoName, videoBlob, { compression: 'STORE' });
  zip.file(angleName, angleCsv);
  if (rwlogFile) zip.file(logName, rwlogFile, { compression: 'STORE' });
  zip.file(manifestName, JSON.stringify(manifest, null, 2));

  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  downloadBlob(blob, `${sessionId}.zip`);
  return { filename: `${sessionId}.zip`, bytes: blob.size, files: { videoName, angleName, logName, manifestName } };
}
