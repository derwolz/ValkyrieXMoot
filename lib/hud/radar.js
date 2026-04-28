/**
 * lib/hud/radar.js — Canvas2D minimap radar overlay.
 *
 * Creates a 140×140 px canvas fixed at the bottom-right corner of the viewport.
 * The truck is always at the center, pointing "up" (north = forward).
 * Moot dots are colored by AI state:
 *   gray    = unaware
 *   yellow  = alarmed-flee
 *   red     = alarmed-armed
 *   green   = recovering
 *
 * Boss dot is larger (7 px vs 3 px) and flashes between red and a bright
 * highlight color at ~1 Hz.
 *
 * Render is throttled to every 4–5 game frames (~15–20 fps at 60 fps) to keep
 * CPU cost negligible.
 *
 * Usage:
 *   const radar = createRadar();              // call once after DOM ready
 *   radar.update(truckPos, truckYaw, moots);  // call every game frame
 *   radar.destroy();                          // if you ever need to remove it
 */

const RADAR_SIZE    = 140;   // canvas px
const RADAR_RANGE   = 40;    // world metres shown from center to edge
const DOT_REGULAR   = 3;     // dot radius in px for regular moots
const DOT_BOSS      = 7;     // dot radius in px for boss
const FRAME_SKIP    = 4;     // redraw every N frames
const BOSS_FLASH_HZ = 1.0;   // flashes per second

const STATE_COLOR = {
  'unaware':       '#808080',
  'alarmed-flee':  '#ffdd00',
  'alarmed-armed': '#ff2222',
  'recovering':    '#22cc66',
};

/**
 * Create and mount the radar canvas. Returns an object with { update, destroy }.
 */
export function createRadar() {
  const canvas  = document.createElement('canvas');
  canvas.width  = RADAR_SIZE;
  canvas.height = RADAR_SIZE;
  canvas.style.cssText = [
    'position:fixed',
    'bottom:16px',
    'right:16px',
    'width:140px',
    'height:140px',
    'border-radius:50%',
    'background:rgba(0,0,0,0.55)',
    'border:1.5px solid rgba(255,255,255,0.18)',
    'pointer-events:none',
    'z-index:900',
    'image-rendering:pixelated',
  ].join(';');
  document.body.appendChild(canvas);

  const ctx        = canvas.getContext('2d');
  const cx         = RADAR_SIZE / 2;   // canvas centre x
  const cy         = RADAR_SIZE / 2;   // canvas centre y
  const scale      = cx / RADAR_RANGE; // world metres → px

  let frameCount = 0;

  /**
   * Convert a world-space offset (dx, dz) from the truck into radar canvas px,
   * accounting for the truck's yaw so "forward" is always up on the radar.
   *
   * @param {number} dx   world dx (target.x - truck.x)
   * @param {number} dz   world dz (target.z - truck.z)
   * @param {number} yaw  truck yaw in radians (rotation around Y)
   * @returns {{ px: number, py: number }}
   */
  function worldToRadar(dx, dz, yaw) {
    // Rotate offset so truck forward → screen up.
    const cosY = Math.cos(-yaw);
    const sinY = Math.sin(-yaw);
    const rx = dx * cosY - dz * sinY;
    const rz = dx * sinY + dz * cosY;
    return {
      px: cx + rx * scale,
      py: cy + rz * scale,   // z forward = up on screen
    };
  }

  /**
   * Render one frame of the radar.
   *
   * @param {{ x: number, z: number }} truckPos
   * @param {number}                   truckYaw  radians
   * @param {Array}                    moots      moot handle array
   */
  function render(truckPos, truckYaw, moots) {
    const now = performance.now();

    // Clear — transparent (background is set by CSS).
    ctx.clearRect(0, 0, RADAR_SIZE, RADAR_SIZE);

    // ── Draw faint range ring ────────────────────────────────────────────────
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, cx - 1, 0, Math.PI * 2);
    ctx.stroke();

    // ── Truck icon: filled triangle pointing up ──────────────────────────────
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.moveTo(cx,      cy - 6);   // tip
    ctx.lineTo(cx - 4,  cy + 4);   // bottom-left
    ctx.lineTo(cx + 4,  cy + 4);   // bottom-right
    ctx.closePath();
    ctx.fill();

    // ── Moot dots ────────────────────────────────────────────────────────────
    for (const m of moots) {
      if (!m.alive) continue;

      const pos = m.group ? m.group.position : m.position;
      if (!pos) continue;

      const dx = pos.x - truckPos.x;
      const dz = pos.z - truckPos.z;

      // Skip moots outside radar range.
      if (dx * dx + dz * dz > RADAR_RANGE * RADAR_RANGE) continue;

      const { px, py } = worldToRadar(dx, dz, truckYaw);

      if (m.isBoss) {
        // Flashing boss dot.
        const flash = Math.sin(now * 0.001 * Math.PI * 2 * BOSS_FLASH_HZ) > 0;
        ctx.fillStyle = flash ? '#ff6666' : '#ff0000';
        ctx.beginPath();
        ctx.arc(px, py, DOT_BOSS, 0, Math.PI * 2);
        ctx.fill();
      } else {
        const state = m.state || 'unaware';
        ctx.fillStyle = STATE_COLOR[state] || STATE_COLOR['unaware'];

        // Fade dot near edge of radar.
        const distFraction = Math.sqrt(dx * dx + dz * dz) / RADAR_RANGE;
        ctx.globalAlpha = Math.max(0.2, 1 - distFraction * 0.8);

        ctx.beginPath();
        ctx.arc(px, py, DOT_REGULAR, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
  }

  /**
   * Call this every game frame. Internally throttles to FRAME_SKIP.
   *
   * @param {{ x: number, z: number }} truckPos
   * @param {number}                   truckYaw
   * @param {Array}                    moots
   */
  function update(truckPos, truckYaw, moots) {
    frameCount++;
    if (frameCount % FRAME_SKIP !== 0) return;
    render(truckPos, truckYaw, moots);
  }

  function destroy() {
    if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
  }

  return { update, destroy };
}
