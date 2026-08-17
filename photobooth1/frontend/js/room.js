const params = new URLSearchParams(window.location.search);
const roomCode = params.get('code');
const peerId = sessionStorage.getItem('peerId');
const isHost = sessionStorage.getItem('isHost') === 'true';

if (!roomCode || !peerId) {
  window.location.href = 'index.html';
}

const roomRef = db.collection('rooms').doc(roomCode);
document.getElementById('roomCodeText').textContent = roomCode;
document.getElementById('hostHint').textContent = isHost
  ? 'You\'re the host — you control shot count and start.'
  : 'Only the host can choose shot count and start the countdown.';

const roleBadge = document.getElementById('roleBadge');
roleBadge.textContent = isHost ? 'Host' : 'Guest';
roleBadge.classList.toggle('host', isHost);

let shotCount = 4;
// Each shot = { layers: [{ src }, ...] } -- one layer per participant tile,
// captured separately so each person can be cropped/repositioned on their own.
let capturedShots = [];
let lastHandledShotIndex = -1;
let selectedBorder = { type: 'builtin', id: 'flower' };

// Persists across preview re-renders and editor sessions. Purely local to
// this browser -- host and guest each edit their own independent copy.
let editState = { shotPositions: null, shotCrops: null, actions: [], objects: [], customFrameSrc: null };

function resetEditState() {
  editState = { shotPositions: null, shotCrops: null, actions: [], objects: [], customFrameSrc: null };
}

// ---------- Shot selector ----------
const shotSelector = document.getElementById('shotSelector');
for (let i = 1; i <= 6; i++) {
  const b = document.createElement('button');
  b.className = 'shot-count-btn' + (i === shotCount ? ' selected' : '');
  b.textContent = i;
  b.disabled = !isHost;
  b.onclick = () => {
    if (!isHost) return;
    roomRef.set({ shotCount: i }, { merge: true });
  };
  b.dataset.count = i;
  shotSelector.appendChild(b);
}

function updateShotSelectorUI() {
  [...shotSelector.children].forEach(btn => {
    btn.classList.toggle('selected', Number(btn.dataset.count) === shotCount);
  });
}

// ---------- Mic ----------
let micState = 'not-requested'; // 'not-requested' | 'on' | 'off'
const micBtn = document.getElementById('micBtn');
micBtn.classList.remove('active');

micBtn.onclick = async () => {
  if (micState === 'not-requested') {
    micBtn.disabled = true;
    document.getElementById('micStatus').textContent = 'Requesting mic…';

    // If the browser can tell us the mic is already hard-blocked for this
    // site, say so clearly -- calling getUserMedia again won't re-show the
    // permission prompt once a person has explicitly denied it; only
    // changing it in the browser's site settings will.
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const status = await navigator.permissions.query({ name: 'microphone' });
        if (status.state === 'denied') {
          document.getElementById('micStatus').textContent = 'Mic blocked — enable it in your browser\'s site settings, then reload.';
          micBtn.disabled = false;
          return;
        }
      }
    } catch (e) { /* permissions API not supported here, fall through and just try */ }

    try {
      await mesh.enableMic();
      micState = 'on';
      micBtn.classList.add('active');
      micBtn.textContent = '🎤';
      document.getElementById('micStatus').textContent = 'Mic on';
    } catch (err) {
      console.error(err);
      document.getElementById('micStatus').textContent = 'Mic permission denied — tap again to retry, or check site settings.';
    } finally {
      micBtn.disabled = false;
    }
    return;
  }

  const turningOn = micState === 'off';
  mesh.setMicEnabled(turningOn);
  micState = turningOn ? 'on' : 'off';
  micBtn.classList.toggle('active', turningOn);
  micBtn.classList.toggle('muted', !turningOn);
  micBtn.textContent = turningOn ? '🎤' : '🔇';
  document.getElementById('micStatus').textContent = turningOn ? 'Mic on' : 'Mic off';
};

// ---------- Manual mirror / rotate (your own camera only) ----------
// Some devices deliver an already-mirrored camera feed at the hardware
// level, which shows up as "my partner looks flipped" and can't be
// reliably auto-detected from code. These give each person manual control
// over their OWN camera's mirror/rotation, both for their live preview and
// for what gets baked into their captured shots.
let mirrorLocal = true;
let localRotation = 0; // 0, 90, 180, 270

function applyLocalVideoTransform() {
  const el = document.getElementById('localVideo');
  el.style.transform = `rotate(${localRotation}deg) scaleX(${mirrorLocal ? -1 : 1})`;
}
applyLocalVideoTransform();

document.getElementById('mirrorBtn').onclick = () => {
  mirrorLocal = !mirrorLocal;
  applyLocalVideoTransform();
};
document.getElementById('rotateBtn').onclick = () => {
  localRotation = (localRotation + 90) % 360;
  applyLocalVideoTransform();
};

// ---------- Mesh setup ----------
const videoGrid = document.getElementById('videoGrid');
const statusLine = document.getElementById('statusLine');

const mesh = new MeshRoom(roomCode, peerId, {
  onRemoteStream: (otherId, stream) => {
    let tile = document.getElementById('tile-' + otherId);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'video-tile';
      tile.id = 'tile-' + otherId;
      tile.innerHTML = `<video autoplay playsinline></video><span class="tag">Partner</span>`;
      videoGrid.appendChild(tile);
    }
    tile.querySelector('video').srcObject = stream;
    statusLine.textContent = 'Connected';
  },
  onRemoteLeave: (otherId) => {
    const tile = document.getElementById('tile-' + otherId);
    if (tile) tile.remove();
    statusLine.textContent = 'Partner left the room';
  }
});

(async () => {
  try {
    const localStream = await mesh.init();
    document.getElementById('localVideo').srcObject = localStream;
    statusLine.textContent = 'Waiting for others to join…';
  } catch (err) {
    console.error(err);
    statusLine.textContent = `Camera error: ${err.name || 'Unknown'} — ${err.message || err}`;
  }
})();

// ---------- Room state sync ----------
roomRef.onSnapshot((snap) => {
  const data = snap.data();
  if (!data) return;

  shotCount = data.shotCount || 4;
  updateShotSelectorUI();

  if (data.status === 'countdown' && data.currentShot !== lastHandledShotIndex) {
    lastHandledShotIndex = data.currentShot;
    runCountdownAndCapture(data.currentShot);
  }

  if (data.status === 'results') {
    showResults();
  }

  if (data.status === 'lobby') {
    lastHandledShotIndex = -1;
    capturedShots = [];
    resetEditState();
    document.getElementById('roomView').style.display = 'block';
    document.getElementById('resultsView').style.display = 'none';
  }
});

// ---------- Start button (host only) ----------
const startBtn = document.getElementById('startBtn');
startBtn.disabled = !isHost;
if (!isHost) startBtn.style.opacity = '0.5';

startBtn.onclick = async () => {
  if (!isHost) return;
  startBtn.disabled = true;
  await roomRef.set({ status: 'countdown', currentShot: 1 }, { merge: true });

  const SHOT_DURATION_MS = 4200;
  let shot = 1;
  const interval = setInterval(async () => {
    shot++;
    if (shot > shotCount) {
      clearInterval(interval);
      await roomRef.set({ status: 'results' }, { merge: true });
      startBtn.disabled = false;
      return;
    }
    await roomRef.set({ currentShot: shot }, { merge: true });
  }, SHOT_DURATION_MS);
};

// ---------- Countdown + capture ----------
const countdownOverlay = document.getElementById('countdownOverlay');
const countdownNumber = document.getElementById('countdownNumber');
const flashOverlay = document.getElementById('flashOverlay');

function runCountdownAndCapture(shotIndex) {
  countdownOverlay.classList.add('active');
  let n = 3;
  countdownNumber.textContent = n;
  const tick = setInterval(() => {
    n--;
    if (n > 0) {
      countdownNumber.textContent = n;
      countdownNumber.style.animation = 'none';
      void countdownNumber.offsetWidth;
      countdownNumber.style.animation = '';
    } else {
      clearInterval(tick);
      countdownOverlay.classList.remove('active');
      flashOverlay.classList.add('flash');
      captureFrame();
      setTimeout(() => flashOverlay.classList.remove('flash'), 400);
    }
  }, 1000);
}

function getCoverCropDims(srcW, srcH, destW, destH) {
  if (!srcW || !srcH) return null;
  const srcAspect = srcW / srcH;
  const destAspect = destW / destH;
  let sx, sy, sw, sh;
  if (srcAspect > destAspect) {
    sh = srcH; sw = srcH * destAspect; sx = (srcW - sw) / 2; sy = 0;
  } else {
    sw = srcW; sh = srcW / destAspect; sx = 0; sy = (srcH - sh) / 2;
  }
  return { sx, sy, sw, sh };
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.src = src;
  });
}

// Captures each participant's tile as its OWN separate image (a "layer"),
// instead of merging everyone into one flat picture. This is what lets
// each person be cropped/repositioned independently afterward.
function captureShotLayers() {
  const tiles = [...videoGrid.querySelectorAll('.video-tile')];
  const layers = [];

  tiles.forEach((tile) => {
    const video = tile.querySelector('video');
    if (!video || video.readyState < 2) return;

    const isLocal = tile.classList.contains('local');
    // Capture closer to the source's natural shape (portrait vs landscape)
    // instead of always forcing 4:3 -- keeps more of the original frame
    // instead of over-cropping right away.
    const portrait = video.videoWidth < video.videoHeight;
    const bufW = portrait ? 240 : 320;
    const bufH = portrait ? 320 : 240;

    const canvas = document.createElement('canvas');
    const rotated90 = isLocal && (localRotation === 90 || localRotation === 270);
    canvas.width = rotated90 ? bufH : bufW;
    canvas.height = rotated90 ? bufW : bufH;
    const ctx = canvas.getContext('2d');

    const crop = getCoverCropDims(video.videoWidth, video.videoHeight, bufW, bufH);
    if (!crop) return;

    ctx.save();
    if (isLocal) {
      ctx.translate(canvas.width / 2, canvas.height / 2);
      ctx.rotate((localRotation * Math.PI) / 180);
      if (mirrorLocal) ctx.scale(-1, 1);
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, -bufW / 2, -bufH / 2, bufW, bufH);
    } else {
      ctx.drawImage(video, crop.sx, crop.sy, crop.sw, crop.sh, 0, 0, bufW, bufH);
    }
    ctx.restore();

    layers.push({ src: canvas.toDataURL('image/png') });
  });

  return { layers };
}

function captureFrame() {
  capturedShots.push(captureShotLayers());
}

// ---------- Frames (default themed + admin-uploaded) ----------
const THEMED_BORDERS = [
  { id: 'flower', label: 'Flower', bg: '#FBF0F3', frame: '#C97FA0', caption: '#6B3B52', emojis: ['🌸', '🌷', '🌼'] },
  { id: 'strawberry', label: 'Strawberry', bg: '#FDF1EE', frame: '#C9503E', caption: '#7A2E22', emojis: ['🍓', '🍃', '🍓'] },
  { id: 'space', label: 'Space', bg: '#20203A', frame: '#8C8CC4', caption: '#F2EADC', emojis: ['✨', '🌙', '⭐'] }
];

function drawThemedBorder(theme, ctx, width, height) {
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = theme.frame;
  ctx.lineWidth = 3;
  ctx.strokeRect(9, 9, width - 18, height - 18);

  const topMargin = 34, bottomMargin = 54;
  const usableHeight = height - topMargin - bottomMargin;
  const spacing = 64;
  const count = Math.max(2, Math.floor(usableHeight / spacing));
  ctx.font = '22px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= count; i++) {
    const y = topMargin + (usableHeight * i) / count;
    const emoji = theme.emojis[i % theme.emojis.length];
    ctx.fillText(emoji, 20, y);
    ctx.fillText(emoji, width - 20, y);
  }

  ctx.fillStyle = theme.caption;
  ctx.font = '600 20px "IBM Plex Mono", monospace';
  ctx.fillText('PHOTOGETHER', width / 2, height - 24);
}

async function getFrameRenderer() {
  if (selectedBorder.type === 'builtin') {
    const theme = THEMED_BORDERS.find(x => x.id === selectedBorder.id);
    return (ctx, w, h) => drawThemedBorder(theme, ctx, w, h);
  }
  if (selectedBorder.type === 'image') {
    const img = await loadImage(selectedBorder.dataUrl);
    return (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h);
  }
  return (ctx, w, h) => { ctx.fillStyle = '#FBF7EE'; ctx.fillRect(0, 0, w, h); };
}

function stripLayout(count) {
  const padding = 24, photoW = 480, photoH = 360, gap = 14;
  const width = photoW + padding * 2;
  const height = padding * 2 + count * photoH + (count - 1) * gap + 40;
  const shotRects = [];
  for (let i = 0; i < count; i++) {
    shotRects.push({ x: padding, y: padding + i * (photoH + gap), w: photoW, h: photoH });
  }
  return { width, height, padding, photoW, photoH, gap, shotRects };
}

function layerRectsForShot(shotX, shotY, photoW, photoH, layerCount) {
  const rects = [];
  const w = photoW / Math.max(1, layerCount);
  for (let j = 0; j < layerCount; j++) {
    rects.push({ x: shotX + w * j, y: shotY, w, h: photoH });
  }
  return rects;
}

// ---------- Results ----------
async function showResults() {
  document.getElementById('roomView').style.display = 'none';
  document.getElementById('resultsView').style.display = 'block';

  await loadBorderOptions();
  await updatePreview();
}

async function loadBorderOptions() {
  const container = document.getElementById('borderOptions');
  container.innerHTML = '';

  const makeWrap = (labelText) => {
    const wrap = document.createElement('div');
    wrap.className = 'frame-swatch-wrap';
    const label = document.createElement('span');
    label.className = 'frame-swatch-label';
    label.textContent = labelText;
    return { wrap, label };
  };

  THEMED_BORDERS.forEach(b => {
    const { wrap, label } = makeWrap(b.label);
    const swatch = document.createElement('div');
    swatch.className = 'border-swatch' + (selectedBorder.type === 'builtin' && selectedBorder.id === b.id ? ' selected' : '');

    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 120;
    previewCanvas.height = 160;
    drawThemedBorder(b, previewCanvas.getContext('2d'), 120, 160);
    swatch.style.backgroundImage = `url(${previewCanvas.toDataURL('image/png')})`;

    swatch.onclick = () => {
      selectedBorder = { type: 'builtin', id: b.id };
      [...container.children].forEach(c => c.querySelector('.border-swatch').classList.remove('selected'));
      swatch.classList.add('selected');
      updatePreview();
    };
    wrap.appendChild(swatch);
    wrap.appendChild(label);
    container.appendChild(wrap);
  });

  try {
    const bordersSnap = await db.collection('borders').where('shotCount', '==', shotCount).get();
    bordersSnap.forEach(doc => {
      const data = doc.data();
      const { wrap, label } = makeWrap(data.name || 'Frame');
      const swatch = document.createElement('div');
      swatch.className = 'border-swatch';
      swatch.style.backgroundImage = `url(${data.dataUrl})`;
      swatch.onclick = () => {
        selectedBorder = { type: 'image', dataUrl: data.dataUrl };
        [...container.children].forEach(c => c.querySelector('.border-swatch').classList.remove('selected'));
        swatch.classList.add('selected');
        updatePreview();
      };
      wrap.appendChild(swatch);
      wrap.appendChild(label);
      container.appendChild(wrap);
    });
  } catch (e) {
    console.warn('Could not load frames', e);
  }
}

async function updatePreview() {
  const canvas = await renderFinalStrip();
  document.getElementById('previewImg').src = canvas.toDataURL('image/png');
}

function applyLayerTransform(ctx, img, crop, destRect) {
  const rotation = crop.rotation || 0;
  const flipX = !!crop.flipX;
  ctx.save();
  ctx.translate(destRect.x + destRect.w / 2, destRect.y + destRect.h / 2);
  ctx.rotate((rotation * Math.PI) / 180);
  if (flipX) ctx.scale(-1, 1);
  const swapped = rotation === 90 || rotation === 270;
  const drawW = swapped ? destRect.h : destRect.w;
  const drawH = swapped ? destRect.w : destRect.h;
  ctx.drawImage(img, crop.x, crop.y, crop.w, crop.h, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();
}

async function renderFinalStrip() {
  await document.fonts.ready;

  const layout = stripLayout(capturedShots.length);
  const canvas = document.getElementById('stripCanvas');
  canvas.width = layout.width;
  canvas.height = layout.height;
  const ctx = canvas.getContext('2d');

  if (editState.customFrameSrc) {
    const cf = await loadImage(editState.customFrameSrc);
    ctx.drawImage(cf, 0, 0, layout.width, layout.height);
  } else {
    const renderer = await getFrameRenderer();
    renderer(ctx, layout.width, layout.height);
  }

  for (let i = 0; i < capturedShots.length; i++) {
    const shot = capturedShots[i];
    const pos = (editState.shotPositions && editState.shotPositions[i]) || { x: layout.shotRects[i].x, y: layout.shotRects[i].y };
    const layerRects = layerRectsForShot(pos.x, pos.y, layout.photoW, layout.photoH, shot.layers.length);

    for (let j = 0; j < shot.layers.length; j++) {
      const img = await loadImage(shot.layers[j].src);
      const rect = layerRects[j];
      let crop = editState.shotCrops && editState.shotCrops[i] && editState.shotCrops[i][j];
      if (!crop) {
        const c = getCoverCropDims(img.naturalWidth, img.naturalHeight, rect.w, rect.h);
        crop = { x: c.sx, y: c.sy, w: c.sw, h: c.sh, rotation: 0, flipX: false };
      }
      applyLayerTransform(ctx, img, crop, rect);
    }
  }

  if (editState.actions && editState.actions.length) {
    const inkCanvas = document.createElement('canvas');
    inkCanvas.width = layout.width;
    inkCanvas.height = layout.height;
    const inkCtx = inkCanvas.getContext('2d');
    editState.actions.forEach(a => {
      inkCtx.save();
      inkCtx.globalCompositeOperation = a.type === 'erase' ? 'destination-out' : 'source-over';
      inkCtx.strokeStyle = a.color;
      inkCtx.lineWidth = a.size;
      inkCtx.lineCap = 'round';
      inkCtx.lineJoin = 'round';
      inkCtx.beginPath();
      a.points.forEach((p, idx) => { if (idx === 0) inkCtx.moveTo(p.x, p.y); else inkCtx.lineTo(p.x, p.y); });
      inkCtx.stroke();
      inkCtx.restore();
    });
    ctx.drawImage(inkCanvas, 0, 0);
  }

  if (editState.objects && editState.objects.length) {
    for (const o of editState.objects) {
      if (o.type === 'text') {
        ctx.fillStyle = o.color;
        ctx.font = `600 ${o.h}px ${o.font}`;
        ctx.textBaseline = 'top';
        ctx.fillText(o.text, o.x, o.y);
      } else if (o.type === 'image' && o.imgSrc) {
        const img = await loadImage(o.imgSrc);
        ctx.drawImage(img, o.x, o.y, o.w, o.h);
      }
    }
  }

  return canvas;
}

// ---------- Editor ----------
document.getElementById('openEditorBtn').onclick = async () => {
  const layout = stripLayout(capturedShots.length);
  const frameRenderer = await getFrameRenderer();

  PhotoEditor.openStrip({
    shots: capturedShots,
    defaultShotPositions: layout.shotRects.map(r => ({ x: r.x, y: r.y })),
    shotSize: { w: layout.photoW, h: layout.photoH },
    width: layout.width,
    height: layout.height,
    frameRenderer,
    initialState: editState,
    onSave: (result) => {
      editState = result.state;
      document.getElementById('previewImg').src = result.dataUrl;
    }
  });
};

document.getElementById('downloadBtn').onclick = async () => {
  const btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const resultsStatus = document.getElementById('resultsStatus');

  try {
    const canvas = await renderFinalStrip();

    const pngDataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `photogether-${roomCode}.png`;
    link.href = pngDataUrl;
    link.click();

    const jpegDataUrl = canvas.toDataURL('image/jpeg', 0.6);

    if (jpegDataUrl.length > 700000) {
      resultsStatus.textContent = 'Downloaded. Too large to save to the gallery, though — try fewer shots next time.';
    } else {
      await db.collection('photos').add({
        roomCode,
        imageData: jpegDataUrl,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      resultsStatus.textContent = 'Saved and downloaded.';
    }
  } catch (err) {
    console.error(err);
    resultsStatus.textContent = 'Downloaded, but saving to the gallery failed.';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Download';
  }
};

document.getElementById('retakeBtn').onclick = async () => {
  if (!isHost) return;
  capturedShots = [];
  resetEditState();
  await roomRef.set({ status: 'lobby', currentShot: 0 }, { merge: true });
};

// ---------- Leave room ----------
document.getElementById('leaveBtn').onclick = async () => {
  const btn = document.getElementById('leaveBtn');
  btn.disabled = true;
  btn.textContent = 'Leaving…';

  try {
    await mesh.leave();

    const remaining = await roomRef.collection('participants').get();
    if (remaining.empty) {
      await deepDeleteRoom(roomCode);
    }
  } catch (err) {
    console.warn('Error while leaving room:', err);
  } finally {
    window.location.href = 'index.html';
  }
};
