// Rolling 5-second state recorder.
// Samples the world at ~10 Hz (every 100 ms) and keeps the last 50 snapshots
// in a fixed-size ring buffer.  Caller drives it by calling recorder.tick(dt)
// every game tick.
//
// Snapshot schema:
//   carPos : { x, z, y }  — vehicle world position
//   carYaw : number        — vehicle yaw in radians
//
// Moot positions and projectiles are intentionally NOT recorded — the moot
// pool recycles handles, so snapshotting handle.group.position would read
// stale (or reused) memory after despawn.  Playback only restores car state;
// moot rewinding (if ever needed) must be handled by a separate moot-owned
// event log rather than sampling live Three.js objects.

const SAMPLE_INTERVAL = 0.1;  // seconds between snapshots
const MAX_SNAPSHOTS   = 50;   // 50 × 0.1 s = 5 s

export function createRecorder() {
  // Ring buffer: fixed-length array, head pointer, fill count.
  const buf   = new Array(MAX_SNAPSHOTS).fill(null);
  let   head  = 0;   // next write index
  let   count = 0;   // how many valid entries (saturates at MAX_SNAPSHOTS)
  let   accum = 0;   // dt accumulator until next sample

  function push(snapshot) {
    buf[head] = snapshot;
    head = (head + 1) % MAX_SNAPSHOTS;
    if (count < MAX_SNAPSHOTS) count++;
  }

  /**
   * Call once per game tick with the elapsed seconds.
   * Only the vehicle's position and yaw are recorded — moot handles are
   * intentionally excluded to avoid reading stale Three.js state after
   * the pool recycles a despawned handle.
   *
   * @param {number} dt
   * @param {object} vehicle  — must expose .position {x,y,z} and .yaw
   */
  function tick(dt, vehicle) {
    accum += dt;
    if (accum < SAMPLE_INTERVAL) return;
    accum -= SAMPLE_INTERVAL;

    push({
      carPos: {
        x: vehicle.position.x,
        y: vehicle.position.y,
        z: vehicle.position.z,
      },
      carYaw: vehicle.yaw,
    });
  }

  /**
   * Returns a chronological array of snapshots (oldest first).
   * Length is 0 until the first sample, then grows up to 50.
   */
  function getHistory() {
    if (count === 0) return [];
    const result = new Array(count);
    // oldest entry sits at head when buffer is full, otherwise at index 0.
    const start = count < MAX_SNAPSHOTS ? 0 : head;
    for (let i = 0; i < count; i++) {
      result[i] = buf[(start + i) % MAX_SNAPSHOTS];
    }
    return result;
  }

  /** Clear the buffer (call on restartGame). */
  function reset() {
    buf.fill(null);
    head  = 0;
    count = 0;
    accum = 0;
  }

  return { tick, getHistory, reset };
}
