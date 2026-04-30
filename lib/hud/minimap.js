/**
 * lib/hud/minimap.js — City minimap fixed at top-right.
 *
 * createMinimap(scene) → { buildCityLayer(bounds, roadSegments, buildingAABBs),
 *                          update(playerPos, playerYaw, moots, npcVehicles, targetHandle),
 *                          destroy() }
 *
 * buildCityLayer() is called once per city build and draws roads + buildings
 * onto a backing canvas. Per-frame update() composites the backing canvas
 * then draws moving dots on top.
 *
 * Layout (top-right corner):
 *   - 180×180 px canvas
 *   - Square (not circular like the old radar)
 *   - Player: white arrow
 *   - Moots: gray/yellow/red/green dots
 *   - NPC vehicles: cyan dots
 *   - Target moot: flashing yellow star
 */

const MAP_SIZE   = 180;    // canvas px
const FRAME_SKIP = 3;      // redraw dynamic layer every N frames

/**
 * Create and mount the minimap canvas.
 * @returns {{ buildCityLayer: Function, update: Function, destroy: Function }}
 */
export function createMinimap() {
  // Backing canvas: city roads & buildings — drawn once per city build.
  const backCanvas  = document.createElement('canvas');
  backCanvas.width  = MAP_SIZE;
  backCanvas.height = MAP_SIZE;
  const backCtx = backCanvas.getContext('2d');

  // Front canvas: dynamic dots, player arrow — redrawn every FRAME_SKIP frames.
  const frontCanvas  = document.createElement('canvas');
  frontCanvas.width  = MAP_SIZE;
  frontCanvas.height = MAP_SIZE;
  frontCanvas.style.cssText = [
    'position:fixed',
    'top:14px',
    'left:14px',
    'width:180px',
    'height:180px',
    'border:1.5px solid rgba(255,255,255,0.22)',
    'background:rgba(0,0,0,0.0)',   // transparent — shows backCanvas painted below
    'pointer-events:none',
    'z-index:900',
    'image-rendering:pixelated',
  ].join(';');
  document.body.appendChild(frontCanvas);
  const frontCtx = frontCanvas.getContext('2d');

  let _bounds = null;
  let _scaleX = 1;
  let _scaleZ = 1;
  let _frameCount = 0;
  let _flashTime = 0;

  /**
   * Convert world XZ to minimap canvas XY.
   * @param {number} wx
   * @param {number} wz
   * @returns {{px:number, py:number}}
   */
  function worldToMap(wx, wz) {
    const px = (wx - _bounds.minX) * _scaleX;
    const py = (wz - _bounds.minZ) * _scaleZ;
    return { px, py };
  }

  /**
   * Build (or rebuild) the static city layer.
   * Call once after generateCity().
   *
   * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }} bounds
   * @param {{ a:{x:number,z:number}, b:{x:number,z:number}, width:number, kind:string }[]} roadSegments
   * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }[]} buildingAABBs
   */
  function buildCityLayer(bounds, roadSegments, buildingAABBs) {
    _bounds = bounds;
    const worldW = bounds.maxX - bounds.minX;
    const worldH = bounds.maxZ - bounds.minZ;
    _scaleX = MAP_SIZE / worldW;
    _scaleZ = MAP_SIZE / worldH;

    backCtx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Background
    backCtx.fillStyle = '#0d0d12';
    backCtx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Roads
    for (const seg of roadSegments) {
      const a = worldToMap(seg.a.x, seg.a.z);
      const b = worldToMap(seg.b.x, seg.b.z);
      const halfW = Math.max(1, seg.width * Math.min(_scaleX, _scaleZ) * 0.5);

      backCtx.strokeStyle = seg.kind === 'alley' ? '#202024' : '#1e1e28';
      backCtx.lineWidth = halfW * 2;
      backCtx.lineCap = 'square';
      backCtx.beginPath();
      backCtx.moveTo(a.px, a.py);
      backCtx.lineTo(b.px, b.py);
      backCtx.stroke();
    }

    // Buildings (dark rectangles)
    backCtx.fillStyle = '#15181e';
    for (const aabb of buildingAABBs) {
      const a = worldToMap(aabb.minX, aabb.minZ);
      const b = worldToMap(aabb.maxX, aabb.maxZ);
      backCtx.fillRect(a.px, a.py, b.px - a.px, b.py - a.py);
    }
  }

  /**
   * Per-frame update — composite backing canvas + dynamic dots.
   * Internally throttled to FRAME_SKIP frames.
   *
   * @param {{ x:number, z:number }} playerPos
   * @param {number} playerYaw
   * @param {object[]} moots        — moot handles (may include boss)
   * @param {object[]} npcVehicles  — NpcVehicleHandle[]
   * @param {object|null} targetHandle — the current target moot handle (or null)
   * @param {number} dt
   */
  function update(playerPos, playerYaw, moots, npcVehicles, targetHandle, dt) {
    _frameCount++;
    _flashTime += dt;
    if (_frameCount % FRAME_SKIP !== 0) return;
    if (!_bounds) return;

    // Clear front canvas.
    frontCtx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Composite the static city layer first.
    frontCtx.drawImage(backCanvas, 0, 0);

    // ── Moot dots ───────────────────────────────────────────────────────────
    for (const m of moots) {
      if (!m.alive) continue;
      const pos = m.group ? m.group.position : m.position;
      if (!pos) continue;
      const { px, py } = worldToMap(pos.x, pos.z);
      if (px < 0 || px > MAP_SIZE || py < 0 || py > MAP_SIZE) continue;

      const isTarget = m === targetHandle;
      if (isTarget) {
        // Flashing yellow star for target.
        const flash = Math.sin(_flashTime * Math.PI * 2 * 2.5) > 0;
        frontCtx.fillStyle = flash ? '#ffee00' : '#ff8800';
        frontCtx.beginPath();
        frontCtx.arc(px, py, 5, 0, Math.PI * 2);
        frontCtx.fill();
      } else if (m.isBoss) {
        const flash = Math.sin(_flashTime * Math.PI * 2) > 0;
        frontCtx.fillStyle = flash ? '#ff6666' : '#ff0000';
        frontCtx.beginPath();
        frontCtx.arc(px, py, 5, 0, Math.PI * 2);
        frontCtx.fill();
      } else {
        const STATE_COLOR = {
          'unaware':       '#606068',
          'alarmed-flee':  '#ffdd00',
          'alarmed-armed': '#ff2222',
          'recovering':    '#22cc66',
        };
        frontCtx.fillStyle = STATE_COLOR[m.state] || STATE_COLOR['unaware'];
        frontCtx.beginPath();
        frontCtx.arc(px, py, 2, 0, Math.PI * 2);
        frontCtx.fill();
      }
    }

    // ── NPC vehicle dots (cyan) ────────────────────────────────────────────
    if (npcVehicles) {
      for (const v of npcVehicles) {
        if (!v.alive) continue;
        const { px, py } = worldToMap(v.position.x, v.position.z);
        if (px < 0 || px > MAP_SIZE || py < 0 || py > MAP_SIZE) continue;
        frontCtx.fillStyle = '#22ddcc';
        frontCtx.beginPath();
        frontCtx.arc(px, py, 3, 0, Math.PI * 2);
        frontCtx.fill();
      }
    }

    // ── Player arrow ───────────────────────────────────────────────────────
    const { px: ppx, py: ppy } = worldToMap(playerPos.x, playerPos.z);
    frontCtx.save();
    frontCtx.translate(ppx, ppy);
    // Three.js yaw: 0 = faces -Z; minimap Y axis = world Z so rotate accordingly.
    frontCtx.rotate(-playerYaw);
    frontCtx.fillStyle = '#ffffff';
    frontCtx.beginPath();
    frontCtx.moveTo(0, -7);     // tip (forward)
    frontCtx.lineTo(-4, 5);
    frontCtx.lineTo(0, 3);
    frontCtx.lineTo(4, 5);
    frontCtx.closePath();
    frontCtx.fill();
    frontCtx.restore();

    // ── Border ──────────────────────────────────────────────────────────────
    frontCtx.strokeStyle = 'rgba(255,255,255,0.18)';
    frontCtx.lineWidth = 1.5;
    frontCtx.strokeRect(0, 0, MAP_SIZE, MAP_SIZE);
  }

  function destroy() {
    if (frontCanvas.parentNode) frontCanvas.parentNode.removeChild(frontCanvas);
  }

  return { buildCityLayer, update, destroy };
}
