function rgbHue(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * (((b - r) / d) + 2);
  else h = 60 * (((r - g) / d) + 4);
  return h < 0 ? h + 360 : h;
}

function components(mask, w, h, minArea) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length), out = [];
  const dx = [-1, 1, 0, 0], dy = [0, 0, -1, 1];
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p] || visited[p]) continue;
    let head = 0, tail = 0, area = 0, sx = 0, sy = 0, minx = w, maxx = -1, miny = h, maxy = -1;
    queue[tail++] = p; visited[p] = 1;
    while (head < tail) {
      const q = queue[head++], y = Math.floor(q / w), x = q - y * w;
      area++; sx += x; sy += y; if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      for (let k = 0; k < 4; k++) {
        const nx = x + dx[k], ny = y + dy[k];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const np = ny * w + nx;
        if (mask[np] && !visited[np]) { visited[np] = 1; queue[tail++] = np; }
      }
    }
    if (area >= minArea) {
      const bw = maxx - minx + 1, bh = maxy - miny + 1;
      out.push({ area, cx: sx / area, cy: sy / area, x: minx, y: miny, w: bw, h: bh, fill: area / (bw * bh) });
    }
  }
  return out;
}

export function detectMarkerPair(imageData, w, h, settings) {
  const rgba = imageData.data;
  const minArea = Math.max(3, Number(settings.minArea) || 12);

  if (settings.mode === 'white-pair') {
    const mask = new Uint8Array(w * h), maxS = (Number(settings.whiteMaxSat) || 25) / 100, minV = (Number(settings.whiteMinValue) || 65) / 100;
    for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b);
      const s = max === 0 ? 0 : (max - min) / max, v = max / 255;
      if (s <= maxS && v >= minV) mask[p] = 1;
    }
    const cands = components(mask, w, h, minArea).filter(c => c.fill >= 0.2).sort((a, b) => b.area - a.area).slice(0, 12);
    let best = null;
    for (let i = 0; i < cands.length; i++) for (let j = i + 1; j < cands.length; j++) {
      let a = cands[i], b = cands[j]; if (a.cx > b.cx) [a, b] = [b, a];
      const dx = b.cx - a.cx, dy = Math.abs(b.cy - a.cy), sim = Math.min(a.area, b.area) / Math.max(a.area, b.area);
      if (dx < w * 0.08 || dy > h * 0.35 || sim < 0.25) continue;
      const score = Math.min(a.area, b.area) * sim - dy * 2;
      if (!best || score > best.score) best = { score, first: a, second: b };
    }
    return best ? { first: best.first, second: best.second, labels: ['LEFT', 'RIGHT'] } : null;
  }

  const red = new Uint8Array(w * h), blue = new Uint8Array(w * h);
  const minS = (Number(settings.minSat) || 45) / 100, minV = (Number(settings.minValue) || 30) / 100;
  for (let p = 0, i = 0; p < red.length; p++, i += 4) {
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2], max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    const s = max === 0 ? 0 : d / max, v = max / 255;
    if (s < minS || v < minV) continue;
    const hue = rgbHue(r, g, b);
    if (hue <= 25 || hue >= 335) red[p] = 1;
    else if (hue >= 175 && hue <= 265) blue[p] = 1;
  }
  const reds = components(red, w, h, minArea).filter(c => c.fill >= 0.18).sort((a, b) => b.area - a.area);
  const blues = components(blue, w, h, minArea).filter(c => c.fill >= 0.18).sort((a, b) => b.area - a.area);
  return reds.length && blues.length ? { first: reds[0], second: blues[0], labels: ['RED', 'BLUE'] } : null;
}

export function drawMarkerOverlay(canvas, videoWidth, videoHeight, result) {
  const ctx = canvas.getContext('2d');
  if (canvas.width !== videoWidth || canvas.height !== videoHeight) { canvas.width = videoWidth; canvas.height = videoHeight; }
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!result?.detected) return;
  const a = result.a, b = result.b;
  ctx.lineWidth = Math.max(2, videoWidth / 500); ctx.strokeStyle = '#f8fafc';
  ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
  for (const [point, label, color] of [[a, result.labels[0], '#fb7185'], [b, result.labels[1], '#60a5fa']]) {
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(3, videoWidth / 400); ctx.beginPath(); ctx.arc(point.x, point.y, Math.max(8, videoWidth / 90), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = color; ctx.font = `${Math.max(16, videoWidth / 45)}px system-ui`; ctx.fillText(label, point.x + 12, point.y - 12);
  }
}
