// Rewind playback system.
//
// Two-phase sequence triggered by spending one capacitor:
//
//   Phase 1 — SCRUB (1 second):
//     The car drives backward along the recorded history (reverse order).
//     Moots are unaffected — they keep their current live positions.
//     The one-second window scrubs over however many frames are in history.
//
//   Phase 2 — PLAYER DRIVES:
//     The car is dropped at the oldest recorded position; normal gameplay
//     resumes immediately.  The caller receives `isDone() === true` so it
//     can call onRewindDone() and restore health.
//
// Moot handles are deliberately NOT stored here.  The pool recycles handles
// so reading h.group.position after despawn gives stale/reused data.
// If moot-position rewind is ever needed it should use a separate event log,
// not a snapshot of live Three.js objects.

const SCRUB_DURATION = 1.0; // seconds for Phase 1

export function createPlayback(_scene, vehicle) {
  let phase = 'idle'; // 'idle' | 'scrub'
  let elapsed = 0;
  let history = []; // snapshot array, oldest-first

  /**
   * Begin a rewind sequence.
   * @param {Array} snapshotHistory  — result of recorder.getHistory(), oldest first
   */
  function start(snapshotHistory) {
    history = snapshotHistory.slice(); // defensive copy
    elapsed = 0;
    phase = history.length === 0 ? 'idle' : 'scrub';

    if (history.length === 0) return;

    // Snap car to the most-recent recorded position to start the scrub from there.
    const latest = history[history.length - 1];
    vehicle.setPositionYaw(latest.carPos.x, latest.carPos.z, latest.carYaw);
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

      if (elapsed >= SCRUB_DURATION) {
        // Drop the car at the oldest recorded position; player now drives.
        if (history.length > 0) {
          const oldest = history[0];
          vehicle.setPositionYaw(oldest.carPos.x, oldest.carPos.z, oldest.carYaw);
        }
        phase = 'idle';
        return true; // Done — caller restores normal play
      }
      return false;
    }

    return true;
  }

  function isActive() {
    return phase !== 'idle';
  }

  /** Returns true when the sequence is in Phase 1 (cinematic scrub). */
  function isScrubbing() {
    return phase === 'scrub';
  }

  return { start, update, isActive, isScrubbing };
}
