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

let shotCount = 4;
let capturedShots = [];
let lastHandledShotIndex = -1;
let selectedBorder = { type: 'builtin', id: 'classic' };
let customBorderImg = null;

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
let micOn = true;
const micBtn = document.getElementById('micBtn');
micBtn.onclick = () => {
  micOn = !micOn;
  mesh.setMicEnabled(micOn);
  micBtn.classList.toggle('active', micOn);
  micBtn.classList.toggle('muted', !micOn);
  micBtn.textContent = micOn ? '🎤' : '🔇';
  document.getElementById('micStatus').textContent = micOn ? 'Mic on' : 'Mic off';
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
    statusLine.textContent = 'Could not access camera/mic. Check permissions.';
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

  // Host drives advancing between shots. Each shot takes ~4.2s
  // (3s countdown + flash + buffer) before moving to the next one.
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

function captureFrame() {
  const tiles = [...videoGrid.querySelectorAll('.video-tile')];
  const cols = Math.ceil(Math.sqrt(tiles.length));
  const rows = Math.ceil(tiles.length / cols);
  const cellW = 320, cellH = 240;

  const canvas = document.getElementById('captureCanvas');
  canvas.width = cols * cellW;
  canvas.height = rows * cellH;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  tiles.forEach((tile, i) => {
    const video = tile.querySelector('video');
    if (!video || video.readyState < 2) return;
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW, y = row * cellH;

    ctx.save();
    if (tile.classList.contains('local')) {
      // Flip to match the mirrored preview the user actually saw
      ctx.translate(x + cellW, y);
      ctx.scale(-1, 1);
      ctx.drawImage(video, 0, 0, cellW, cellH);
    } else {
      ctx.drawImage(video, x, y, cellW, cellH);
    }
    ctx.restore();
  });

  capturedShots.push(canvas.toDataURL('image/png'));
}

// ---------- Results ----------
const BUILTIN_BORDERS = [
  { id: 'classic', label: 'Classic', bg: '#FBF7EE', frame: '#2B2319' },
  { id: 'clay', label: 'Clay', bg: '#A5502E', frame: '#2B2319' },
  { id: 'olive', label: 'Olive', bg: '#6B7548', frame: '#2B2319' }
];

async function showResults() {
  document.getElementById('roomView').style.display = 'none';
  document.getElementById('resultsView').style.display = 'block';

  const strip = document.getElementById('filmstrip');
  strip.innerHTML = '';
  capturedShots.forEach(src => {
    const img = document.createElement('img');
    img.src = src;
    strip.appendChild(img);
  });

  await loadBorderOptions();
}

async function loadBorderOptions() {
  const container = document.getElementById('borderOptions');
  container.innerHTML = '';

  BUILTIN_BORDERS.forEach(b => {
    const swatch = document.createElement('div');
    swatch.className = 'border-swatch' + (selectedBorder.id === b.id ? ' selected' : '');
    swatch.style.background = b.bg;
    swatch.title = b.label;
    swatch.onclick = () => {
      selectedBorder = { type: 'builtin', id: b.id };
      [...container.children].forEach(c => c.classList.remove('selected'));
      swatch.classList.add('selected');
    };
    container.appendChild(swatch);
  });

  try {
    const bordersSnap = await db.collection('borders').get();
    bordersSnap.forEach(doc => {
      const data = doc.data();
      const swatch = document.createElement('div');
      swatch.className = 'border-swatch';
      swatch.innerHTML = `<img src="${data.dataUrl}" alt="${data.name || 'border'}">`;
      swatch.onclick = () => {
        selectedBorder = { type: 'image', dataUrl: data.dataUrl };
        [...container.children].forEach(c => c.classList.remove('selected'));
        swatch.classList.add('selected');
      };
      container.appendChild(swatch);
    });
  } catch (e) {
    console.warn('Could not load admin borders', e);
  }
}

document.getElementById('customBorderInput').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      customBorderImg = img;
      selectedBorder = { type: 'custom' };
    };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

function renderFinalStrip() {
  return new Promise((resolve) => {
    const canvas = document.getElementById('stripCanvas');
    const ctx = canvas.getContext('2d');
    const padding = 24;
    const photoW = 480, photoH = 360;
    const gap = 14;
    const width = photoW + padding * 2;
    const height = padding * 2 + capturedShots.length * photoH + (capturedShots.length - 1) * gap + 40;

    canvas.width = width;
    canvas.height = height;

    const drawPhotos = () => {
      capturedShots.forEach((src, i) => {
        const img = new Image();
        img.onload = () => {
          const y = padding + i * (photoH + gap);
          ctx.drawImage(img, padding, y, photoW, photoH);
          if (i === capturedShots.length - 1) resolve(canvas);
        };
        img.src = src;
      });
    };

    if (selectedBorder.type === 'builtin') {
      const b = BUILTIN_BORDERS.find(x => x.id === selectedBorder.id);
      ctx.fillStyle = b.bg;
      ctx.fillRect(0, 0, width, height);
      ctx.strokeStyle = b.frame;
      ctx.lineWidth = 6;
      ctx.strokeRect(3, 3, width - 6, height - 6);
      drawPhotos();
    } else if (selectedBorder.type === 'custom' && customBorderImg) {
      ctx.drawImage(customBorderImg, 0, 0, width, height);
      drawPhotos();
    } else if (selectedBorder.type === 'image') {
      const bImg = new Image();
      bImg.onload = () => {
        ctx.drawImage(bImg, 0, 0, width, height);
        drawPhotos();
      };
      bImg.src = selectedBorder.dataUrl;
    } else {
      ctx.fillStyle = '#FBF7EE';
      ctx.fillRect(0, 0, width, height);
      drawPhotos();
    }
  });
}

document.getElementById('downloadBtn').onclick = async () => {
  const btn = document.getElementById('downloadBtn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  const resultsStatus = document.getElementById('resultsStatus');

  try {
    const canvas = await renderFinalStrip();

    // Full-quality PNG for the actual download the user keeps
    const pngDataUrl = canvas.toDataURL('image/png');
    const link = document.createElement('a');
    link.download = `photobooth-${roomCode}.png`;
    link.href = pngDataUrl;
    link.click();

    // Smaller, compressed JPEG for the Firestore gallery copy, since
    // Firestore documents cap out at 1MB and a full-res PNG strip can
    // easily exceed that. Firebase Storage would normally handle this,
    // but it now requires the paid Blaze plan, so we keep this small
    // enough to live directly in a Firestore document instead.
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
