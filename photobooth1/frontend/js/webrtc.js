// =========================================================
// Mesh WebRTC manager.
//
// Every participant connects directly to every other participant
// (a "mesh"). For each pair, the participant with the alphabetically
// smaller peerId is the one who creates the offer, so both sides
// agree on who initiates without needing to coordinate first.
//
// Firestore layout used for signaling:
//   rooms/{code}/connections/{smallerId}_{largerId}
//     offer / answer  (session descriptions)
//     offerCandidates / answerCandidates  (subcollections)
// =========================================================

const RTC_SERVERS = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    {
      urls: "turn:openrelay.metered.ca:80",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443",
      username: "openrelayproject",
      credential: "openrelayproject"
    },
    {
      urls: "turn:openrelay.metered.ca:443?transport=tcp",
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ]
};

class MeshRoom {
  constructor(roomCode, myPeerId, { onRemoteStream, onRemoteLeave, onParticipantTransform, onConnectionStateChange } = {}) {
    this.roomCode = roomCode;
    this.myPeerId = myPeerId;
    this.onRemoteStream = onRemoteStream || (() => {});
    this.onRemoteLeave = onRemoteLeave || (() => {});
    this.onParticipantTransform = onParticipantTransform || (() => {});
    this.onConnectionStateChange = onConnectionStateChange || (() => {});
    this.localStream = null;
    this.hasAudio = false;
    this.peerConnections = {}; // otherId -> RTCPeerConnection
    this.knownParticipants = new Set();
    this.roomRef = db.collection('rooms').doc(roomCode);
    this._lastSeenTransform = {};
    this._lastSeenSession = {};
    // Unique per page-load, not per person -- lets other peers tell "this
    // person reloaded/reconnected" apart from "their mirror setting changed",
    // so a refresh can trigger a clean reconnect instead of a stuck black tile.
    this.sessionId = crypto.randomUUID();
  }

  async init() {
    // No aspectRatio hint here on purpose -- some webcam drivers respond to
    // a forced ratio by baking black letterbox bars directly into the video
    // frame instead of just delivering their native feed. We cover-crop
    // into our own fixed per-person shape ourselves (see PERSON_SLOT_W/H in
    // room.js), so it's more reliable to just take whatever native aspect
    // the camera gives us and crop it consistently on our end.
    const videoConstraints = {
      facingMode: 'user',
      width: { ideal: 640 },
      height: { ideal: 480 }
    };

    // Request camera + mic together so the connection carries audio from
    // the very first handshake -- no fragile "add a track mid-call" step
    // needed later. If that combined request fails (mic denied/blocked),
    // fall back to camera-only so people can still join.
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints,
        audio: true
      });
      this.hasAudio = true;
    } catch (err) {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: videoConstraints
      });
      this.hasAudio = false;
    }

    await this.roomRef.collection('participants').doc(this.myPeerId).set({
      joinedAt: firebase.firestore.FieldValue.serverTimestamp(),
      mirrored: true,
      rotation: 0,
      sessionId: this.sessionId
    });

    // Watch for other participants joining/leaving, mirror/rotation changes,
    // and reconnects (a known participant's sessionId changing means their
    // page reloaded -- rebuild the connection instead of leaving it stale).
    this.roomRef.collection('participants').onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const otherId = change.doc.id;
        const data = change.doc.data();

        if (change.type === 'added' && otherId !== this.myPeerId) {
          this._lastSeenSession[otherId] = data.sessionId;
          if (!this.knownParticipants.has(otherId)) {
            this.knownParticipants.add(otherId);
            this.connectTo(otherId);
          }
        }
        if (change.type === 'removed' && otherId !== this.myPeerId) {
          this.knownParticipants.delete(otherId);
          delete this._lastSeenSession[otherId];
          this.disconnectFrom(otherId);
        }
        if (change.type === 'modified' && otherId !== this.myPeerId && this.knownParticipants.has(otherId)) {
          if (data.sessionId && data.sessionId !== this._lastSeenSession[otherId]) {
            this._lastSeenSession[otherId] = data.sessionId;
            this.reconnectTo(otherId);
          }
        }
        if (data) {
          const key = `${data.mirrored}_${data.rotation}`;
          if (this._lastSeenTransform[otherId] !== key) {
            this._lastSeenTransform[otherId] = key;
            this.onParticipantTransform(otherId, {
              mirrored: data.mirrored !== false,
              rotation: data.rotation || 0
            });
          }
        }
      });
    });

    return this.localStream;
  }

  async setMyTransform({ mirrored, rotation }) {
    await this.roomRef.collection('participants').doc(this.myPeerId).set(
      { mirrored, rotation },
      { merge: true }
    );
  }

  pairKey(otherId) {
    return this.myPeerId < otherId
      ? `${this.myPeerId}_${otherId}`
      : `${otherId}_${this.myPeerId}`;
  }

  // Clears any leftover offer/answer/candidates from a previous session
  // before starting a fresh handshake -- without this, a reload could leave
  // stale SDP/candidates in Firestore that poison the next connection
  // attempt (this was the actual cause of "reload breaks the call").
  async clearConnectionDoc(otherId) {
    const connRef = this.roomRef.collection('connections').doc(this.pairKey(otherId));
    try {
      const offerCandSnap = await connRef.collection('offerCandidates').get();
      await Promise.all(offerCandSnap.docs.map(d => d.ref.delete()));
      const answerCandSnap = await connRef.collection('answerCandidates').get();
      await Promise.all(answerCandSnap.docs.map(d => d.ref.delete()));
      await connRef.set({
        offer: firebase.firestore.FieldValue.delete(),
        answer: firebase.firestore.FieldValue.delete()
      }, { merge: true });
    } catch (e) { /* best effort */ }
  }

  async reconnectTo(otherId) {
    this.disconnectFrom(otherId, { silent: true });
    await this.connectTo(otherId);
  }

  async connectTo(otherId) {
    await this.clearConnectionDoc(otherId);

    const iAmInitiator = this.myPeerId < otherId;
    const pc = new RTCPeerConnection(RTC_SERVERS);
    this.peerConnections[otherId] = pc;

    this.localStream.getTracks().forEach(track => pc.addTrack(track, this.localStream));

    const remoteStream = new MediaStream();
    pc.ontrack = (event) => {
      event.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
      this.onRemoteStream(otherId, remoteStream);
    };

    const connRef = this.roomRef.collection('connections').doc(this.pairKey(otherId));
    const offerCandidates = connRef.collection('offerCandidates');
    const answerCandidates = connRef.collection('answerCandidates');

    if (iAmInitiator) {
      pc.onicecandidate = (e) => { if (e.candidate) offerCandidates.add(e.candidate.toJSON()); };

      const offerDescription = await pc.createOffer();
      await pc.setLocalDescription(offerDescription);

      await connRef.set({
        offer: { type: offerDescription.type, sdp: offerDescription.sdp }
      }, { merge: true });

      connRef.onSnapshot(async (snap) => {
        const data = snap.data();
        if (data && data.answer && !pc.currentRemoteDescription) {
          await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        }
      });

      answerCandidates.onSnapshot((snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'added') {
            pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
          }
        });
      });
    } else {
      pc.onicecandidate = (e) => { if (e.candidate) answerCandidates.add(e.candidate.toJSON()); };

      const waitForOfferAndAnswer = async () => {
        const snap = await connRef.get();
        const data = snap.data();
        if (!data || !data.offer) {
          setTimeout(waitForOfferAndAnswer, 500);
          return;
        }
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        const answerDescription = await pc.createAnswer();
        await pc.setLocalDescription(answerDescription);
        await connRef.set({
          answer: { type: answerDescription.type, sdp: answerDescription.sdp }
        }, { merge: true });
      };
      await waitForOfferAndAnswer();

      offerCandidates.onSnapshot((snap) => {
        snap.docChanges().forEach((change) => {
          if (change.type === 'added') {
            pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(() => {});
          }
        });
      });
    }
  }

  disconnectFrom(otherId, { silent } = {}) {
    const pc = this.peerConnections[otherId];
    if (pc) {
      pc.close();
      delete this.peerConnections[otherId];
    }
    if (!silent) this.onRemoteLeave(otherId);
  }

  setMicEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }

  async leave() {
    Object.keys(this.peerConnections).forEach(id => this.disconnectFrom(id));
    try {
      await this.roomRef.collection('participants').doc(this.myPeerId).delete();
    } catch (e) { /* best effort */ }
    if (this.localStream) {
      this.localStream.getTracks().forEach(t => t.stop());
    }
  }
}
