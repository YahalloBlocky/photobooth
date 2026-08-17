// =========================================================
// TEST-ONLY admin credentials. This check runs entirely in the
// browser, so anyone who inspects this file can read the password.
// Fine for a private test build; do NOT rely on this for anything
// you actually need to keep secure.
// =========================================================
const ADMIN_USERNAME = 'admin';
const ADMIN_PASSWORD = 'changeme123';

const loginView = document.getElementById('loginView');
const dashboardView = document.getElementById('dashboardView');

function showDashboard() {
  loginView.style.display = 'none';
  dashboardView.style.display = 'block';
  loadPhotos();
  loadBorders();
}

if (sessionStorage.getItem('isAdmin') === 'true') {
  showDashboard();
}

document.getElementById('loginBtn').onclick = () => {
  const user = document.getElementById('adminUser').value.trim();
  const pass = document.getElementById('adminPass').value;
  const err = document.getElementById('loginError');

  if (user === ADMIN_USERNAME && pass === ADMIN_PASSWORD) {
    sessionStorage.setItem('isAdmin', 'true');
    err.style.display = 'none';
    showDashboard();
  } else {
    err.style.display = 'block';
  }
};

document.getElementById('logoutBtn').onclick = () => {
  sessionStorage.removeItem('isAdmin');
  dashboardView.style.display = 'none';
  loginView.style.display = 'block';
};

// Same strip layout math used in room.js, so the preview here matches
// what users will actually see.
function stripDims(shotCount) {
  const padding = 24, photoW = 480, photoH = 360, gap = 14;
  const width = photoW + padding * 2;
  const height = padding * 2 + shotCount * photoH + (shotCount - 1) * gap + 40;
  return { width, height, padding, photoW, photoH, gap };
}

// ---------- Photo gallery ----------
async function loadPhotos() {
  const grid = document.getElementById('photoGrid');
  grid.innerHTML = '<p>Loading…</p>';

  try {
    const snap = await db.collection('photos').orderBy('createdAt', 'desc').get();
    grid.innerHTML = '';

    if (snap.empty) {
      grid.innerHTML = '<p>No photos saved yet.</p>';
      return;
    }

    snap.forEach(doc => {
      const data = doc.data();
      const wrap = document.createElement('div');
      const date = data.createdAt ? data.createdAt.toDate().toLocaleString() : '';
      wrap.innerHTML = `
        <img src="${data.imageData}" alt="Photo from room ${data.roomCode}">
        <div class="meta">${data.roomCode} · ${date}${data.editedFrom ? ' · <span style="color:var(--clay);">Edited copy</span>' : ''}</div>
        <div class="button-row" style="margin-top:6px;">
          <button class="btn btn-ghost" style="padding:6px 12px; font-size:0.8rem;" data-action="edit">Edit</button>
          <button class="btn btn-ghost" style="padding:6px 12px; font-size:0.8rem;" data-action="remove">Remove</button>
        </div>
      `;

      wrap.querySelector('[data-action="edit"]').onclick = () => {
        const img = new Image();
        img.onload = () => {
          PhotoEditor.openFlat({
            imageSrc: data.imageData,
            width: img.naturalWidth,
            height: img.naturalHeight,
            onSave: async ({ dataUrl }) => {
              // Save as a new, separate photo rather than overwriting the
              // original -- keeps both the untouched and edited versions.
              await db.collection('photos').add({
                roomCode: data.roomCode,
                imageData: dataUrl,
                editedFrom: doc.id,
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
              });
              loadPhotos();
            }
          });
        };
        img.src = data.imageData;
      };

      wrap.querySelector('[data-action="remove"]').onclick = async () => {
        const ok = await UIDialog.confirm('Remove this photo? This can\'t be undone.');
        if (!ok) return;
        await db.collection('photos').doc(doc.id).delete();
        loadPhotos();
      };

      grid.appendChild(wrap);
    });
  } catch (err) {
    console.error(err);
    grid.innerHTML = '<p>Could not load photos.</p>';
  }
}

// ---------- Border upload (shot-count scoped, with preview) ----------
let uploadShotCount = 4;
let pendingBorderDataUrl = null;

const shotSelectorEl = document.getElementById('borderShotCountSelector');
for (let i = 1; i <= 6; i++) {
  const b = document.createElement('button');
  b.className = 'shot-count-btn' + (i === uploadShotCount ? ' selected' : '');
  b.textContent = i;
  b.onclick = () => {
    uploadShotCount = i;
    [...shotSelectorEl.children].forEach(c => c.classList.remove('selected'));
    b.classList.add('selected');
    renderBorderPreview();
  };
  shotSelectorEl.appendChild(b);
}

document.getElementById('borderFile').addEventListener('change', (e) => {
  const file = e.target.files[0];
  const status = document.getElementById('borderUploadStatus');
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (ev) => {
    pendingBorderDataUrl = ev.target.result;
    if (pendingBorderDataUrl.length > 900000) {
      status.textContent = 'That file is too large (keep it under ~650KB).';
      pendingBorderDataUrl = null;
      return;
    }
    status.textContent = '';
    renderBorderPreview();
  };
  reader.readAsDataURL(file);
});

function renderBorderPreview() {
  const wrap = document.getElementById('borderPreviewWrap');
  if (!pendingBorderDataUrl) { wrap.style.display = 'none'; return; }

  const { width, height, padding, photoW, photoH, gap } = stripDims(uploadShotCount);
  const canvas = document.getElementById('borderPreviewCanvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');

  const borderImg = new Image();
  borderImg.onload = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(borderImg, 0, 0, width, height);
    // Gray placeholder photo slots so the admin can see how it'll actually look
    ctx.fillStyle = 'rgba(120,120,120,0.5)';
    for (let i = 0; i < uploadShotCount; i++) {
      const y = padding + i * (photoH + gap);
      ctx.fillRect(padding, y, photoW, photoH);
    }
    wrap.style.display = 'block';
  };
  borderImg.src = pendingBorderDataUrl;
}

document.getElementById('uploadBorderBtn').onclick = async () => {
  const nameInput = document.getElementById('borderName');
  const status = document.getElementById('borderUploadStatus');
  const btn = document.getElementById('uploadBorderBtn');

  const name = nameInput.value.trim();

  if (!name || !pendingBorderDataUrl) {
    status.textContent = 'Add a name and choose a PNG file first.';
    return;
  }

  btn.disabled = true;
  status.textContent = 'Uploading…';

  try {
    await db.collection('borders').add({
      name,
      dataUrl: pendingBorderDataUrl,
      shotCount: uploadShotCount,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    status.textContent = 'Frame uploaded.';
    nameInput.value = '';
    document.getElementById('borderFile').value = '';
    pendingBorderDataUrl = null;
    document.getElementById('borderPreviewWrap').style.display = 'none';
    loadBorders();
  } catch (err) {
    console.error(err);
    status.textContent = 'Upload failed. Check your connection and try again.';
  } finally {
    btn.disabled = false;
  }
};

// ---------- Border management ----------
async function loadBorders() {
  const grid = document.getElementById('borderGrid');
  grid.innerHTML = '<p>Loading…</p>';

  try {
    const snap = await db.collection('borders').orderBy('shotCount').get();
    grid.innerHTML = '';

    if (snap.empty) {
      grid.innerHTML = '<p>No custom frames uploaded yet.</p>';
      return;
    }

    snap.forEach(doc => {
      const data = doc.data();
      const wrap = document.createElement('div');
      wrap.innerHTML = `
        <img src="${data.dataUrl}" alt="${data.name}">
        <div class="meta">${data.name} · ${data.shotCount} shot${data.shotCount === 1 ? '' : 's'}</div>
        <div class="button-row" style="margin-top:6px;">
          <button class="btn btn-ghost" style="padding:6px 12px; font-size:0.8rem;" data-action="rename">Rename</button>
          <button class="btn btn-ghost" style="padding:6px 12px; font-size:0.8rem;" data-action="remove">Remove</button>
        </div>
      `;

      wrap.querySelector('[data-action="rename"]').onclick = async () => {
        const newName = await UIDialog.prompt('New name for this frame:', data.name);
        if (!newName) return;
        await db.collection('borders').doc(doc.id).set({ name: newName }, { merge: true });
        loadBorders();
      };

      wrap.querySelector('[data-action="remove"]').onclick = async () => {
        const ok = await UIDialog.confirm('Remove this frame? This can\'t be undone.');
        if (!ok) return;
        await db.collection('borders').doc(doc.id).delete();
        loadBorders();
      };

      grid.appendChild(wrap);
    });
  } catch (err) {
    console.error(err);
    grid.innerHTML = '<p>Could not load frames.</p>';
  }
}
