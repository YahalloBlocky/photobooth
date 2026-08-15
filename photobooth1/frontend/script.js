// Free public STUN server (helps two computers find each other)
const servers = {
  iceServers: [{ urls: ["stun:stun.l.google.com:19302"] }]
};

let pc = new RTCPeerConnection(servers);
let localStream;
let remoteStream = new MediaStream();

const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const statusEl = document.getElementById('status');
const videosDiv = document.getElementById('videos');
const canvasWrap = document.getElementById('canvasWrap');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

async function setupMedia() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  localVideo.srcObject = localStream;
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  pc.ontrack = (event) => {
    event.streams[0].getTracks().forEach(track => remoteStream.addTrack(track));
    remoteVideo.srcObject = remoteStream;
  };

  videosDiv.classList.remove('hidden');
  canvasWrap.classList.remove('hidden');
}

function randomRoomCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ---------- CREATE ROOM ----------
document.getElementById('createBtn').onclick = async () => {
  await setupMedia();
  const roomCode = randomRoomCode();
  const roomRef = db.collection('rooms').doc(roomCode);
  const callerCandidates = roomRef.collection('callerCandidates');
  const calleeCandidates = roomRef.collection('calleeCandidates');

  pc.onicecandidate = (event) => {
    if (event.candidate) callerCandidates.add(event.candidate.toJSON());
  };

  const offerDescription = await pc.createOffer();
  await pc.setLocalDescription(offerDescription);

  await roomRef.set({
    offer: { type: offerDescription.type, sdp: offerDescription.sdp }
  });

  statusEl.textContent = `Room created! Send this code to your partner: ${roomCode}`;

  // Listen for the answer
  roomRef.onSnapshot(async (snapshot) => {
    const data = snapshot.data();
    if (!pc.currentRemoteDescription && data && data.answer) {
      const answerDescription = new RTCSessionDescription(data.answer);
      await pc.setRemoteDescription(answerDescription);
      statusEl.textContent = `Connected! Room code: ${roomCode}`;
    }
  });

  calleeCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });
};

// ---------- JOIN ROOM ----------
document.getElementById('joinBtn').onclick = async () => {
  const roomCode = document.getElementById('joinCodeInput').value.trim().toUpperCase();
  if (!roomCode) return alert('Enter a room code first.');

  await setupMedia();
  const roomRef = db.collection('rooms').doc(roomCode);
  const roomSnapshot = await roomRef.get();

  if (!roomSnapshot.exists) {
    statusEl.textContent = 'Room not found. Check the code.';
    return;
  }

  const callerCandidates = roomRef.collection('callerCandidates');
  const calleeCandidates = roomRef.collection('calleeCandidates');

  pc.onicecandidate = (event) => {
    if (event.candidate) calleeCandidates.add(event.candidate.toJSON());
  };

  const offer = roomSnapshot.data().offer;
  await pc.setRemoteDescription(new RTCSessionDescription(offer));

  const answerDescription = await pc.createAnswer();
  await pc.setLocalDescription(answerDescription);

  await roomRef.update({
    answer: { type: answerDescription.type, sdp: answerDescription.sdp }
  });

  callerCandidates.onSnapshot((snapshot) => {
    snapshot.docChanges().forEach((change) => {
      if (change.type === 'added') {
        pc.addIceCandidate(new RTCIceCandidate(change.doc.data()));
      }
    });
  });

  statusEl.textContent = `Joined room: ${roomCode}`;
};

// ---------- CAPTURE BOTH VIDEOS SIDE BY SIDE ----------
document.getElementById('captureBtn').onclick = () => {
  ctx.drawImage(localVideo, 0, 0, 320, 240);
  ctx.drawImage(remoteVideo, 320, 0, 320, 240);
  document.getElementById('downloadBtn').classList.remove('hidden');
};

document.getElementById('downloadBtn').onclick = () => {
  const link = document.createElement('a');
  link.download = 'photobooth.png';
  link.href = canvas.toDataURL('image/png');
  link.click();
};
