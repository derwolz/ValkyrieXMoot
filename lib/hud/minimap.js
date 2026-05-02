/**
 * lib/hud/minimap.js — City minimap fixed at top-right.
 *
 * createMinimap(scene) → { buildCityLayer(bounds, roadSegments, buildingAABBs, highwayLayout, zoneMap),
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

import { HUD } from '../config.js';

const MAP_SIZE = 180;    // canvas px
const TWO_PI = Math.PI * 2;
const STATE_COLORS = {
  unaware: '#606068',
  'alarmed-flee': '#ffdd00',
  'alarmed-armed': '#ff2222',
  recovering: '#22cc66',
};
const DEFAULT_STATE_COLOR = STATE_COLORS.unaware;
const TARGET_FLASH_HZ = 2.5;
const BOSS_FLASH_HZ = 1;
const MINIMAP_NPC_COLOR = '#22ddcc';
const MINIMAP_PLAYER_COLOR = '#ffffff';
const MINIMAP_HIGHWAY_SHADOW_COLOR = 'rgba(0,0,0,0.72)';
const MINIMAP_HIGHWAY_MAIN_COLOR = '#ffc857';
const MINIMAP_HIGHWAY_RAMP_COLOR = '#ff7a33';
const MINIMAP_WATER_COLOR = '#0a3a6e';
const MINIMAP_BEACH_COLOR = '#b99a68';

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
  const _renderEveryFrames = Math.max(1, HUD.minimapRenderEveryFrames ?? 3);

  function worldToMapX(wx) {
    return (wx - _bounds.minX) * _scaleX;
  }

  function worldToMapY(wz) {
    return (wz - _bounds.minZ) * _scaleZ;
  }

  function getSortedShorelineSamples(zoneMap) {
    const samples = zoneMap?.getShorelineSamples?.();
    if (!Array.isArray(samples) || samples.length < 2) return [];
    return samples
      .filter((point) => point && Number.isFinite(point.x) && Number.isFinite(point.z))
      .sort((a, b) => a.x - b.x);
  }

  function drawWaterBody(zoneMap) {
    const shoreline = getSortedShorelineSamples(zoneMap);
    if (!_bounds || shoreline.length < 2) return;

    backCtx.fillStyle = MINIMAP_WATER_COLOR;
    backCtx.beginPath();
    backCtx.moveTo(worldToMapX(_bounds.minX), worldToMapY(_bounds.minZ));
    backCtx.lineTo(worldToMapX(_bounds.maxX), worldToMapY(_bounds.minZ));
    for (let i = shoreline.length - 1; i >= 0; i--) {
      const p = shoreline[i];
      const x = Math.max(_bounds.minX, Math.min(_bounds.maxX, p.x));
      const z = Math.max(_bounds.minZ, Math.min(_bounds.maxZ, p.z));
      backCtx.lineTo(worldToMapX(x), worldToMapY(z));
    }
    backCtx.closePath();
    backCtx.fill();

    // Thin beach/shoreline trace keeps the water body readable underneath roads.
    backCtx.strokeStyle = MINIMAP_BEACH_COLOR;
    backCtx.lineWidth = 1;
    backCtx.lineCap = 'round';
    backCtx.lineJoin = 'round';
    backCtx.beginPath();
    for (let i = 0; i < shoreline.length; i++) {
      const p = shoreline[i];
      const x = Math.max(_bounds.minX, Math.min(_bounds.maxX, p.x));
      const z = Math.max(_bounds.minZ, Math.min(_bounds.maxZ, p.z));
      if (i === 0) backCtx.moveTo(worldToMapX(x), worldToMapY(z));
      else backCtx.lineTo(worldToMapX(x), worldToMapY(z));
    }
    backCtx.stroke();
  }

  /**
   * Build (or rebuild) the static city layer.
   * Call once after generateCity().
   *
   * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }} bounds
   * @param {{ a:{x:number,z:number}, b:{x:number,z:number}, width:number, kind:string }[]} roadSegments
   * @param {{ minX:number, maxX:number, minZ:number, maxZ:number }[]} buildingAABBs
   * @param {{ points?:{x:number,z:number}[], ramps?:{points:{x:number,z:number}[]}[] } | null} [highwayLayout]
   * @param {{ getShorelineSamples?:()=>Array<{x:number,z:number}> } | null} [zoneMap]
   */
  function buildCityLayer(bounds, roadSegments = [], buildingAABBs = [], highwayLayout = null, zoneMap = null) {
    _bounds = bounds;
    const worldW = bounds.maxX - bounds.minX;
    const worldH = bounds.maxZ - bounds.minZ;
    _scaleX = MAP_SIZE / worldW;
    _scaleZ = MAP_SIZE / worldH;

    backCtx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Background
    backCtx.fillStyle = '#0d0d12';
    backCtx.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    drawWaterBody(zoneMap);

    // Roads — draw every supplied segment as a stroked path so planned
    // hierarchical collectors, locals, and ramp-feeder roads appear alongside
    // the retained grid backbone.
    for (const seg of roadSegments || []) {
      if (!seg?.a || !seg?.b) continue;
      const apx = worldToMapX(seg.a.x);
      const apy = worldToMapY(seg.a.z);
      const bpx = worldToMapX(seg.b.x);
      const bpy = worldToMapY(seg.b.z);
      const mapWidth = Math.max(1, (Number(seg.width) || 1) * Math.min(_scaleX, _scaleZ));
      if (![apx, apy, bpx, bpy, mapWidth].every(Number.isFinite)) continue;

      if (seg.kind === 'alley') {
        backCtx.strokeStyle = '#202024';
      } else if (seg.kind === 'feeder') {
        backCtx.strokeStyle = '#28283a';
      } else {
        backCtx.strokeStyle = '#1e1e28';
      }
      backCtx.lineWidth = mapWidth;
      backCtx.lineCap = seg.organic || seg.kind === 'feeder' ? 'round' : 'square';
      backCtx.lineJoin = 'round';
      backCtx.beginPath();
      backCtx.moveTo(apx, apy);
      backCtx.lineTo(bpx, bpy);
      backCtx.stroke();
    }

    // Buildings (dark rectangles)
    backCtx.fillStyle = '#15181e';
    for (const aabb of buildingAABBs || []) {
      const minPx = worldToMapX(aabb.minX);
      const minPy = worldToMapY(aabb.minZ);
      const maxPx = worldToMapX(aabb.maxX);
      const maxPy = worldToMapY(aabb.maxZ);
      backCtx.fillRect(minPx, minPy, maxPx - minPx, maxPy - minPy);
    }

    // Elevated highway overlay — drawn after buildings because it is physically
    // above street level. This makes the expressway and every ramp easy to find
    // without replacing the existing grid, planned hierarchy, alley, or feeder
    // road layer.
    drawHighwayOverlay(highwayLayout);
  }

  function drawPolyline(points, lineWidth, color) {
    if (!Array.isArray(points) || points.length < 2) return;
    const mapped = [];
    for (const point of points) {
      const px = worldToMapX(point?.x);
      const py = worldToMapY(point?.z);
      if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
      mapped.push({ x: px, y: py });
    }
    if (mapped.length < 2) return;

    backCtx.lineCap = 'round';
    backCtx.lineJoin = 'round';
    backCtx.strokeStyle = MINIMAP_HIGHWAY_SHADOW_COLOR;
    backCtx.lineWidth = lineWidth + 2;
    backCtx.beginPath();
    backCtx.moveTo(mapped[0].x, mapped[0].y);
    for (let i = 1; i < mapped.length; i++) backCtx.lineTo(mapped[i].x, mapped[i].y);
    backCtx.stroke();

    backCtx.strokeStyle = color;
    backCtx.lineWidth = lineWidth;
    backCtx.beginPath();
    backCtx.moveTo(mapped[0].x, mapped[0].y);
    for (let i = 1; i < mapped.length; i++) backCtx.lineTo(mapped[i].x, mapped[i].y);
    backCtx.stroke();
  }

  function drawHighwayOverlay(highwayLayout) {
    if (!highwayLayout || typeof highwayLayout !== 'object') return;
    const mapScale = Math.min(_scaleX, _scaleZ);
    const mainWidth = Math.max(3.5, 22 * mapScale);
    const rampWidth = Math.max(2.5, 12 * mapScale);

    drawPolyline(highwayLayout.points, mainWidth, MINIMAP_HIGHWAY_MAIN_COLOR);

    const ramps = Array.isArray(highwayLayout.ramps) ? highwayLayout.ramps : [];
    for (const ramp of ramps) drawPolyline(ramp?.points, rampWidth, MINIMAP_HIGHWAY_RAMP_COLOR);
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
    if (_frameCount < _renderEveryFrames) return;
    _frameCount = 0;
    if (!_bounds) return;

    // Clear front canvas.
    frontCtx.clearRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Composite the static city layer first.
    frontCtx.drawImage(backCanvas, 0, 0);

    const targetFlash = targetHandle ? Math.sin(_flashTime * TWO_PI * TARGET_FLASH_HZ) > 0 : false;
    const bossFlash = Math.sin(_flashTime * TWO_PI * BOSS_FLASH_HZ) > 0;
    let fillStyle = null;

    // ── Moot dots ───────────────────────────────────────────────────────────
    for (const m of moots) {
      if (!m.alive) continue;
      const pos = m.group ? m.group.position : m.position;
      if (!pos) continue;
      const px = worldToMapX(pos.x);
      const py = worldToMapY(pos.z);
      if (px < 0 || px > MAP_SIZE || py < 0 || py > MAP_SIZE) continue;

      const isTarget = m === targetHandle;
      if (isTarget) {
        // Flashing yellow star for target.
        const color = targetFlash ? '#ffee00' : '#ff8800';
        if (fillStyle !== color) {
          frontCtx.fillStyle = color;
          fillStyle = color;
        }
        frontCtx.beginPath();
        frontCtx.arc(px, py, 5, 0, TWO_PI);
        frontCtx.fill();
      } else if (m.isBoss) {
        const color = bossFlash ? '#ff6666' : '#ff0000';
        if (fillStyle !== color) {
          frontCtx.fillStyle = color;
          fillStyle = color;
        }
        frontCtx.beginPath();
        frontCtx.arc(px, py, 5, 0, TWO_PI);
        frontCtx.fill();
      } else {
        const color = STATE_COLORS[m.state] || DEFAULT_STATE_COLOR;
        if (fillStyle !== color) {
          frontCtx.fillStyle = color;
          fillStyle = color;
        }
        frontCtx.beginPath();
        frontCtx.arc(px, py, 2, 0, TWO_PI);
        frontCtx.fill();
      }
    }

    // ── NPC vehicle dots (cyan) ────────────────────────────────────────────
    if (npcVehicles) {
      for (const v of npcVehicles) {
        if (!v.alive) continue;
        const px = worldToMapX(v.position.x);
        const py = worldToMapY(v.position.z);
        if (px < 0 || px > MAP_SIZE || py < 0 || py > MAP_SIZE) continue;
        if (fillStyle !== MINIMAP_NPC_COLOR) {
          frontCtx.fillStyle = MINIMAP_NPC_COLOR;
          fillStyle = MINIMAP_NPC_COLOR;
        }
        frontCtx.beginPath();
        frontCtx.arc(px, py, 3, 0, TWO_PI);
        frontCtx.fill();
      }
    }

    // ── Player arrow ───────────────────────────────────────────────────────
    const ppx = worldToMapX(playerPos.x);
    const ppy = worldToMapY(playerPos.z);
    frontCtx.save();
    frontCtx.translate(ppx, ppy);
    // Three.js yaw: 0 = faces -Z; minimap Y axis = world Z so rotate accordingly.
    frontCtx.rotate(-playerYaw);
    if (fillStyle !== MINIMAP_PLAYER_COLOR) {
      frontCtx.fillStyle = MINIMAP_PLAYER_COLOR;
      fillStyle = MINIMAP_PLAYER_COLOR;
    }
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
