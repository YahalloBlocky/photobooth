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
        <div class="meta">${data.roomCode} · ${date}</div>
      `;
      grid.appendChild(wrap);
    });
  } catch (err) {
    console.error(err);
    grid.innerHTML = '<p>Could not load photos.</p>';
  }
}

// ---------- Border upload ----------
// Stored directly in Firestore as base64 (not Firebase Storage, which
// now requires the paid Blaze plan). Firestore documents cap at 1MB,
// so the uploaded file is re-encoded as a compressed JPEG-quality PNG
// and rejected if still too large.
document.getElementById('uploadBorderBtn').onclick = async () => {
  const nameInput = document.getElementById('borderName');
  const fileInput = document.getElementById('borderFile');
  const status = document.getElementById('borderUploadStatus');
  const btn = document.getElementById('uploadBorderBtn');

  const name = nameInput.value.trim();
  const file = fileInput.files[0];

  if (!name || !file) {
    status.textContent = 'Add a name and choose a PNG file first.';
    return;
  }

  btn.disabled = true;
  status.textContent = 'Processing…';

  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

    if (dataUrl.length > 900000) {
      status.textContent = 'That file is too large (keep it under ~650KB). Try a smaller or more compressed PNG.';
      btn.disabled = false;
      return;
    }

    await db.collection('borders').add({
      name,
      dataUrl,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    status.textContent = 'Border uploaded.';
    nameInput.value = '';
    fileInput.value = '';
  } catch (err) {
    console.error(err);
    status.textContent = 'Upload failed. Check your connection and try again.';
  } finally {
    btn.disabled = false;
  }
};
