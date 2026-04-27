// Rewind playback system.
//
// Two-phase sequence triggered by spending one capacitor:
//
//   Phase 1 — SCRUB (1 second):
//     The car drives backward along the recorded history (reverse order).
//     Moots stay frozen in place.  The one-second window scrubs over
//     however many frames are in SCRUB_DURATION seconds of history.
//
//   Phase 2 — REPLAY (up to 5 seconds):
//     Car and moots follow the recorded snapshots forward, oldest → newest.
//     Moots that were alive in the recording are made visible and moved.
//     Moots that were already dead BEFORE the recording window stay removed.
//     The player can still shoot during Phase 2 — splatMoot is called via the
//     onSplat callback so health bookkeeping stays in main.js.
//     After all frames are played the caller receives `isDone() === true`.

const SCRUB_DURATION  = 1.0;   // seconds for Phase 1
const REPLAY_DURATION = 5.0;   // seconds for Phase 2 (≈ full history)

export function createPlayback(scene, vehicle, mootHandles) {
  let phase     = 'idle';   // 'idle' | 'scrub' | 'replay'
  let elapsed   = 0;
  let history   = [];       // snapshot array, oldest-first
  let replayAliveSet = null; // Set of indices alive at start of recording window

  // Baseline alive flags captured when rewind is triggered (current live state).
  // Moots dead BEFORE the 5-second window should stay dead throughout replay.
  let baselineDead = null;  // Set of handle indices that were already dead

  /**
   * Begin a rewind sequence.
   * @param {Array} snapshotHistory  — result of recorder.getHistory(), oldest first
   */
  function start(snapshotHistory) {
    history  = snapshotHistory.slice(); // defensive copy
    elapsed  = 0;
    phase    = history.length === 0 ? 'idle' : 'scrub';

    // Record which moots are dead RIGHT NOW (before we touch anything).
    // These stay invisible / dead throughout the whole replay.
    baselineDead = new Set();
    for (let i = 0; i < mootHandles.length; i++) {
      if (!mootHandles[i].alive) baselineDead.add(i);
    }

    if (history.length === 0) return;

    // Determine which moots were alive at ANY point during the recorded window.
    // We use the first snapshot as the "world state at window start".
    replayAliveSet = new Set();
    const firstSnap = history[0];
    for (let i = 0; i < firstSnap.mootStates.length; i++) {
      if (firstSnap.mootStates[i].alive && !baselineDead.has(i)) {
        replayAliveSet.add(i);
      }
    }
    // Also include any moot that was alive in any snapshot (handles moots killed
    // mid-recording — we restore them so the replay is accurate).
    for (const snap of history) {
      for (let i = 0; i < snap.mootStates.length; i++) {
        if (snap.mootStates[i].alive && !baselineDead.has(i)) {
          replayAliveSet.add(i);
        }
      }
    }

    // Restore all replay-eligible moots to visible so Phase 1 scrub looks right.
    for (const idx of replayAliveSet) {
      const h = mootHandles[idx];
      if (!h.alive) {
        h.alive = true;
        scene.add(h.group);
      }
    }

    // Snap car to the most-recent recorded position to start the scrub from there.
    if (history.length > 0) {
      const latest = history[history.length - 1];
      vehicle.setPositionYaw(latest.carPos.x, latest.carPos.z, latest.carYaw);
    }
  }

  /**
   * Advance the rewind sequence.  Call every game tick during 'rewinding' state.
   * @param {number} dt
   * @returns {boolean} true when the sequence finishes and normal play can resume
   */
  function update(dt) {
    if (phase === 'idle') return true;

    elapsed += dt;

    if (phase === 'scrub') {
      // Map elapsed [0..SCRUB_DURATION] → snapshot index from newest to oldest.
      const t = Math.min(elapsed / SCRUB_DURATION, 1);
      // Scrub backward: t=0 → latest snapshot, t=1 → oldest snapshot.
      const snapIdx = Math.floor((1 - t) * (history.length - 1));
      const snap = history[Math.max(0, snapIdx)];
      vehicle.setPositionYaw(snap.carPos.x, snap.carPos.z, snap.carYaw);
      // Moots stay frozen during scrub (no position update).

      if (elapsed >= SCRUB_DURATION) {
        // Transition to replay — reset elapsed for Phase 2 timing.
        // Drop the car at the oldest recorded position so it doesn't jump;
        // after this point the PLAYER drives, not the recorder.
        if (history.length > 0) {
          const oldest = history[0];
          vehicle.setPositionYaw(oldest.carPos.x, oldest.carPos.z, oldest.carYaw);
        }
        elapsed = 0;
        phase   = 'replay';
      }
      return false;
    }

    if (phase === 'replay') {
      // Map elapsed [0..REPLAY_DURATION] → snapshot index oldest→newest.
      const t = Math.min(elapsed / REPLAY_DURATION, 1);
      const snapIdx = Math.floor(t * (history.length - 1));
      const snap = history[Math.min(snapIdx, history.length - 1)];

      // The car is now driven by the player — do NOT move it here.
      // Only moots replay their recorded positions.

      // Move moots to their recorded positions.
      for (let i = 0; i < mootHandles.length; i++) {
        if (!replayAliveSet.has(i)) continue;
        const ms = snap.mootStates[i];
        if (!ms) continue;

        const h = mootHandles[i];
        if (ms.alive) {
          // Moot was alive at this snapshot — show & position it.
          if (!h.alive) {
            h.alive = true;
            scene.add(h.group);
          }
          h.group.position.x = ms.x;
          h.group.position.z = ms.z;
        } else {
          // Moot was dead at this snapshot — hide it.
          if (h.alive) {
            h.alive = false;
            scene.remove(h.group);
          }
        }
      }

      if (elapsed >= REPLAY_DURATION) {
        phase = 'idle';
        return true;  // Done — caller restores normal play
      }
      return false;
    }

    return true;
  }

  function isActive() {
    return phase !== 'idle';
  }

  /** Returns true when the sequence is in Phase 1 (cinematic scrub).
   *  During Phase 2 (replay) the player drives freely. */
  function isScrubbing() {
    return phase === 'scrub';
  }

  return { start, update, isActive, isScrubbing };
}
