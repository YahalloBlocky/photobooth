// =========================================================
// Room cleanup helpers.
//
// Firestore doesn't delete subcollections automatically when you
// delete a parent document, so "deleting a room" means manually
// walking down and deleting participants, connections, and their
// nested candidate subcollections first.
// =========================================================

async function deepDeleteRoom(roomCode) {
  const roomRef = db.collection('rooms').doc(roomCode);

  const participantsSnap = await roomRef.collection('participants').get();
  await Promise.all(participantsSnap.docs.map(d => d.ref.delete()));

  const connectionsSnap = await roomRef.collection('connections').get();
  await Promise.all(connectionsSnap.docs.map(async (connDoc) => {
    const offerCandSnap = await connDoc.ref.collection('offerCandidates').get();
    await Promise.all(offerCandSnap.docs.map(c => c.ref.delete()));

    const answerCandSnap = await connDoc.ref.collection('answerCandidates').get();
    await Promise.all(answerCandSnap.docs.map(c => c.ref.delete()));

    await connDoc.ref.delete();
  }));

  await roomRef.delete();
}

// Deletes any room older than 24 hours. Runs at most once per hour
// per browser (tracked in localStorage) so it doesn't hammer Firestore
// on every single page load.
async function sweepOldRooms() {
  const ONE_HOUR = 60 * 60 * 1000;
  const ONE_DAY = 24 * ONE_HOUR;

  const lastSweep = Number(localStorage.getItem('lastRoomSweep') || 0);
  const now = Date.now();
  if (now - lastSweep < ONE_HOUR) return;
  localStorage.setItem('lastRoomSweep', String(now));

  try {
    const cutoff = firebase.firestore.Timestamp.fromMillis(now - ONE_DAY);
    const oldRoomsSnap = await db.collection('rooms').where('createdAt', '<', cutoff).get();

    for (const doc of oldRoomsSnap.docs) {
      await deepDeleteRoom(doc.id);
    }

    if (!oldRoomsSnap.empty) {
      console.log(`Cleaned up ${oldRoomsSnap.size} old room(s).`);
    }
  } catch (err) {
    console.warn('Room cleanup sweep failed:', err);
  }
}
