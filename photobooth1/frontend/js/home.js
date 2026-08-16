function randomRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Quietly clean up old rooms in the background (throttled to once/hour)
sweepOldRooms();

// ---------- CREATE ROOM ----------
document.getElementById('createBtn').onclick = async () => {
  const btn = document.getElementById('createBtn');
  btn.disabled = true;
  btn.textContent = 'Creating…';

  const roomCode = randomRoomCode();
  const peerId = crypto.randomUUID();

  try {
    await db.collection('rooms').doc(roomCode).set({
      hostId: peerId,
      shotCount: 4,
      status: 'lobby',
      currentShot: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    sessionStorage.setItem('peerId', peerId);
    sessionStorage.setItem('isHost', 'true');
    window.location.href = `room.html?code=${roomCode}`;
  } catch (err) {
    console.error(err);
    btn.disabled = false;
    btn.textContent = 'Create Room';
    await UIDialog.alert('Could not create room. Check your connection and try again.');
  }
};

// ---------- JOIN MODAL ----------
const joinModal = document.getElementById('joinModal');
const joinError = document.getElementById('joinError');

document.getElementById('joinOpenBtn').onclick = () => {
  joinModal.classList.add('open');
  document.getElementById('joinCodeInput').focus();
};

document.getElementById('joinCloseBtn').onclick = () => {
  joinModal.classList.remove('open');
  joinError.style.display = 'none';
};

joinModal.addEventListener('click', (e) => {
  if (e.target === joinModal) {
    joinModal.classList.remove('open');
    joinError.style.display = 'none';
  }
});

document.getElementById('joinSubmitBtn').onclick = async () => {
  const code = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (!code) return;

  const btn = document.getElementById('joinSubmitBtn');
  btn.disabled = true;
  btn.textContent = 'Checking…';
  joinError.style.display = 'none';

  try {
    const roomSnap = await db.collection('rooms').doc(code).get();
    if (!roomSnap.exists) {
      joinError.textContent = 'No room found with that code.';
      joinError.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Join';
      return;
    }

    const peerId = crypto.randomUUID();
    sessionStorage.setItem('peerId', peerId);
    sessionStorage.setItem('isHost', 'false');
    window.location.href = `room.html?code=${code}`;
  } catch (err) {
    console.error(err);
    joinError.textContent = 'Something went wrong. Try again.';
    joinError.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Join';
  }
};

document.getElementById('joinCodeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('joinSubmitBtn').click();
});
