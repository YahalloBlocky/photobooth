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
  constructor(roomCode, myPeerId, { onRemoteStream, onRemoteLeave } = {}) {
    this.roomCode = roomCode;
    this.myPeerId = myPeerId;
    this.onRemoteStream = onRemoteStream || (() => {});
    this.onRemoteLeave = onRemoteLeave || (() => {});
    this.localStream = null;
    this.hasAudio = false;
    this.peerConnections = {}; // otherId -> RTCPeerConnection
    this.knownParticipants = new Set();
    this.roomRef = db.collection('rooms').doc(roomCode);
    this._lastSeenRenegotiate = {};
  }

  async init() {
    // Video only on join -- some people will only ever grant camera access,
    // and requesting audio+video together means a mic denial blocks the
    // whole join. Mic is requested separately later via enableMic().
    this.localStream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 640 },
        height: { ideal: 480 },
        aspectRatio: { ideal: 4 / 3 }
      }
    });

    await this.roomRef.collection('participants').doc(this.myPeerId).set({
      joinedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Watch for other participants joining/leaving/renegotiating
    this.roomRef.collection('participants').onSnapshot((snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const otherId = change.doc.id;
        if (otherId === this.myPeerId) return;

        if (change.type === 'added' && !this.knownParticipants.has(otherId)) {
          this.knownParticipants.add(otherId);
          this.connectTo(otherId);
        }
        if (change.type === 'removed') {
          this.knownParticipants.delete(otherId);
          this.disconnectFrom(otherId);
        }
        if (change.type === 'modified' && this.knownParticipants.has(otherId)) {
          const data = change.doc.data();
          if (data.renegotiateRequest && data.renegotiateRequest !== this._lastSeenRenegotiate[otherId]) {
            this._lastSeenRenegotiate[otherId] = data.renegotiateRequest;
            this.rebuildConnection(otherId);
          }
        }
      });
    });

    window.addEventListener('beforeunload', () => this.leave());

    return this.localStream;
  }

  pairKey(otherId) {
    return this.myPeerId < otherId
      ? `${this.myPeerId}_${otherId}`
      : `${otherId}_${this.myPeerId}`;
  }

  async connectTo(otherId) {
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

  disconnectFrom(otherId) {
    const pc = this.peerConnections[otherId];
    if (pc) {
      pc.close();
      delete this.peerConnections[otherId];
    }
    this.onRemoteLeave(otherId);
  }

  setMicEnabled(enabled) {
    if (!this.localStream) return;
    this.localStream.getAudioTracks().forEach(t => { t.enabled = enabled; });
  }

  // Requests microphone access separately (called when the user taps the
  // mic button). If granted, adds the track locally and tells every
  // connected peer to rebuild the connection so it gets included.
  async enableMic() {
    if (this.hasAudio) {
      this.setMicEnabled(true);
      return true;
    }

    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioTrack = audioStream.getAudioTracks()[0];
    this.localStream.addTrack(audioTrack);
    this.hasAudio = true;

    // Tell other peers (and ourselves, symmetrically) that this connection
    // needs to be rebuilt to carry the new track.
    await this.roomRef.collection('participants').doc(this.myPeerId).set({
      renegotiateRequest: Date.now()
    }, { merge: true });

    const peers = Object.keys(this.peerConnections);
    for (const otherId of peers) {
      await this.rebuildConnection(otherId);
    }
    return true;
  }

  // Tears down and re-does the handshake for one connection. Used when a
  // track gets added mid-call (e.g. mic enabled), since renegotiating an
  // existing WebRTC connection reliably is complex -- redoing the whole
  // handshake is simpler and good enough for a small group call.
  async rebuildConnection(otherId) {
    this.disconnectFrom(otherId);

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

    this.knownParticipants.add(otherId);
    await this.connectTo(otherId);
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
