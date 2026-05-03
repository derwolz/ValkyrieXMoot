/**
 * lib/world/terrain/heightmap.js
 *
 * buildTerrain({ scene, zoneMap, cityLayout? })
 *   → { mesh, getTerrainY, dispose }
 *
 * Creates a single THREE.Mesh PlaneGeometry terrain covering the full 3km×3km
 * world.  Vertex Y values are set from zoneMap.getHeight() × TERRAIN.maxHeight,
 * while zone ground, city roads, sidewalks, and alleys are baked into one surface
 * texture on that same mesh.
 * The beach strip (z near −halfLength) is clamped to near sea level.
 *
 * getTerrainY(x, z)  → world-space Y using bilinear interpolation of vertex grid.
 * dispose()          → geometry.dispose() + material.dispose() + scene.remove()
 *
 * Single scene.add call — caller must not add the mesh a second time.
 */

import * as THREE from 'three';
import { CITY, TERRAIN } from '../../config.js';

/** @type {{ mesh: THREE.Mesh, getTerrainY: (x:number,z:number)=>number, dispose: ()=>void }|null} */
let _current = null;

function colorToRgb(color, fallback = 0x2d4a1e) {
  const c = new THREE.Color(Number.isFinite(color) ? color : fallback);
  return [Math.round(c.r * 255), Math.round(c.g * 255), Math.round(c.b * 255)];
}

function colorToCss(color, fallback = 0x2d4a1e) {
  const value = Number.isFinite(color) ? color : fallback;
  return `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`;
}

function makeSurfaceCanvas(size) {
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    return canvas;
  }
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(size, size);
  }
  return null;
}

function drawWorldRect(ctx, canvasSize, width, length, x, z, rectW, rectD, color) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || rectW <= 0 || rectD <= 0) return;

  const halfW = width / 2;
  const halfL = length / 2;
  const minX = Math.max(-halfW, x - rectW / 2);
  const maxX = Math.min(halfW, x + rectW / 2);
  const minZ = Math.max(-halfL, z - rectD / 2);
  const maxZ = Math.min(halfL, z + rectD / 2);
  if (minX >= maxX || minZ >= maxZ) return;

  const x0 = ((minX + halfW) / width) * canvasSize;
  const x1 = ((maxX + halfW) / width) * canvasSize;
  const y0 = (1 - (maxZ + halfL) / length) * canvasSize;
  const y1 = (1 - (minZ + halfL) / length) * canvasSize;

  ctx.fillStyle = color;
  ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
}

function worldToCanvasPoint(canvasSize, width, length, point) {
  const halfW = width / 2;
  const halfL = length / 2;
  return {
    x: ((point.x + halfW) / width) * canvasSize,
    y: (1 - (point.z + halfL) / length) * canvasSize,
  };
}

function drawWorldSegment(ctx, canvasSize, width, length, a, b, lineWidth, color) {
  if (
    !a ||
    !b ||
    !Number.isFinite(a.x) ||
    !Number.isFinite(a.z) ||
    !Number.isFinite(b.x) ||
    !Number.isFinite(b.z) ||
    lineWidth <= 0
  )
    return;

  const p0 = worldToCanvasPoint(canvasSize, width, length, a);
  const p1 = worldToCanvasPoint(canvasSize, width, length, b);
  const pxWidth = Math.max(1, lineWidth * Math.min(canvasSize / width, canvasSize / length));

  ctx.strokeStyle = color;
  ctx.lineWidth = pxWidth;
  ctx.lineCap = 'butt';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.lineTo(p1.x, p1.y);
  ctx.stroke();
}

function isWaterAt(zoneMap, x, z) {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return false;
  if (typeof zoneMap?.isWater === 'function') return !!zoneMap.isWater(x, z);
  if (typeof zoneMap?.getWaterInfo === 'function') return !!zoneMap.getWaterInfo(x, z)?.isWater;
  return zoneMap?.getZone?.(x, z) === 'water';
}

function segmentTouchesWater(zoneMap, a, b, samples = 8) {
  if (!a || !b || typeof zoneMap !== 'object') return false;
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const x = a.x + (b.x - a.x) * t;
    const z = a.z + (b.z - a.z) * t;
    if (isWaterAt(zoneMap, x, z)) return true;
  }
  return false;
}

function rectTouchesWater(zoneMap, x, z, rectW, rectD) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || rectW <= 0 || rectD <= 0) return false;
  const hx = rectW / 2;
  const hz = rectD / 2;
  return (
    isWaterAt(zoneMap, x, z) ||
    isWaterAt(zoneMap, x - hx, z - hz) ||
    isWaterAt(zoneMap, x + hx, z - hz) ||
    isWaterAt(zoneMap, x - hx, z + hz) ||
    isWaterAt(zoneMap, x + hx, z + hz)
  );
}

function polygonTouchesWater(zoneMap, points) {
  if (!Array.isArray(points) || points.length === 0) return false;
  let cx = 0;
  let cz = 0;
  let count = 0;
  for (const point of points) {
    if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.z)) continue;
    if (isWaterAt(zoneMap, point.x, point.z)) return true;
    cx += point.x;
    cz += point.z;
    count++;
  }
  return count > 0 ? isWaterAt(zoneMap, cx / count, cz / count) : false;
}

function drawWorldPolygon(ctx, canvasSize, width, length, points, color) {
  if (!Array.isArray(points) || points.length < 3) return;

  const first = points[0];
  if (!first || !Number.isFinite(first.x) || !Number.isFinite(first.z)) return;

  const p0 = worldToCanvasPoint(canvasSize, width, length, first);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return;
    const cp = worldToCanvasPoint(canvasSize, width, length, p);
    ctx.lineTo(cp.x, cp.y);
  }
  ctx.closePath();
  ctx.fill();
}

function buildSurfaceTexture({ zoneMap, cityLayout, width, length }) {
  const size = CITY.terrainTextureSize ?? 1024;
  const canvas = makeSurfaceCanvas(size);
  const ctx = canvas?.getContext?.('2d');
  if (!canvas || !ctx) {
    console.warn('[terrain] Canvas unavailable; using fallback solid terrain material.');
    return null;
  }

  const zoneGroundColors = CITY.zoneGroundColors ?? {};
  const defaultGround = CITY.groundColor ?? 0x2d4a1e;
  const colorCache = new Map();
  const colorForZone = (zone) => {
    const key = zone ?? 'urban';
    if (!colorCache.has(key)) {
      colorCache.set(key, colorToRgb(zoneGroundColors[key] ?? defaultGround, defaultGround));
    }
    return colorCache.get(key);
  };

  const halfW = width / 2;
  const halfL = length / 2;
  const image = ctx.createImageData(size, size);
  for (let py = 0; py < size; py++) {
    const z = halfL - ((py + 0.5) / size) * length;
    for (let px = 0; px < size; px++) {
      const x = -halfW + ((px + 0.5) / size) * width;
      const zone = zoneMap?.getZone?.(x, z) ?? 'urban';
      const [r, g, b] = colorForZone(zone);
      const idx = (py * size + px) * 4;
      image.data[idx] = r;
      image.data[idx + 1] = g;
      image.data[idx + 2] = b;
      image.data[idx + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const roadColor = colorToCss(CITY.roadColor ?? 0x3f4650, 0x3f4650);
  const alleyColor = colorToCss(CITY.alleyColor ?? 0x535a62, 0x535a62);
  const sidewalkColor = colorToCss(CITY.sidewalkColor ?? 0x8b8f96, 0x8b8f96);
  const parkGroundColor = colorToCss(zoneGroundColors.park ?? 0x3f8a3c, 0x3f8a3c);
  const bounds = cityLayout?.bounds;

  if (bounds) {
    const roadSegments = Array.isArray(cityLayout?.roadSegments) ? cityLayout.roadSegments : [];
    if (roadSegments.length > 0) {
      for (const seg of roadSegments) {
        if (segmentTouchesWater(zoneMap, seg?.a, seg?.b)) continue;
        const color = seg.kind === 'alley' ? alleyColor : roadColor;
        drawWorldSegment(ctx, size, width, length, seg.a, seg.b, seg.width, color);
      }
    } else {
      for (const xL of cityLayout?.xLines ?? []) {
        const a = { x: xL.x, z: bounds.minZ };
        const b = { x: xL.x, z: bounds.maxZ };
        if (segmentTouchesWater(zoneMap, a, b)) continue;
        drawWorldRect(
          ctx,
          size,
          width,
          length,
          xL.x,
          (bounds.minZ + bounds.maxZ) / 2,
          xL.width,
          bounds.maxZ - bounds.minZ,
          roadColor,
        );
      }
      for (const zL of cityLayout?.zLines ?? []) {
        const a = { x: bounds.minX, z: zL.z };
        const b = { x: bounds.maxX, z: zL.z };
        if (segmentTouchesWater(zoneMap, a, b)) continue;
        drawWorldRect(
          ctx,
          size,
          width,
          length,
          (bounds.minX + bounds.maxX) / 2,
          zL.z,
          bounds.maxX - bounds.minX,
          zL.width,
          roadColor,
        );
      }

      for (const alley of cityLayout?.alleys ?? []) {
        if (segmentTouchesWater(zoneMap, alley.a, alley.b)) continue;
        drawWorldSegment(ctx, size, width, length, alley.a, alley.b, alley.width, alleyColor);
      }
    }

    for (const sw of cityLayout?.sidewalkPolys ?? []) {
      const sample = sw.points?.[0] ?? sw;
      const zone = zoneMap?.getZone?.(sample.x, sample.z) ?? 'urban';
      if (zone === 'water') continue;
      const color = zone === 'park' ? parkGroundColor : sidewalkColor;
      if (Array.isArray(sw.points) && sw.points.length >= 3) {
        if (polygonTouchesWater(zoneMap, sw.points)) continue;
        drawWorldPolygon(ctx, size, width, length, sw.points, color);
      } else if (sw.a && sw.b) {
        if (segmentTouchesWater(zoneMap, sw.a, sw.b)) continue;
        drawWorldSegment(
          ctx,
          size,
          width,
          length,
          sw.a,
          sw.b,
          sw.width ?? CITY.sidewalkWidth,
          color,
        );
      } else {
        if (rectTouchesWater(zoneMap, sw.x, sw.z, sw.width, sw.depth)) continue;
        drawWorldRect(ctx, size, width, length, sw.x, sw.z, sw.width, sw.depth, color);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Build (or rebuild) the terrain mesh.
 *
 * @param {{
 *   scene:   THREE.Scene,
 *   zoneMap: { getHeight: (x:number,z:number)=>number, getZone?: (x:number,z:number)=>string, width:number, length:number },
 *   cityLayout?: {
 *     bounds?: { minX:number, maxX:number, minZ:number, maxZ:number },
 *     xLines?: Array<{ x:number, width:number }>,
 *     zLines?: Array<{ z:number, width:number }>,
 *     alleys?: Array<{ a:{ x:number, z:number }, b:{ x:number, z:number }, width:number }>,
 *     sidewalkPolys?: Array<{ x:number, z:number, width:number, depth:number }>,
 *   },
 *   seed?:   number,
 * }} opts
 * @returns {{ mesh: THREE.Mesh, getTerrainY: (x:number,z:number)=>number, dispose: ()=>void }}
 */
export function buildTerrain({ scene, zoneMap, cityLayout = null }) {
  // Dispose any previous terrain to free GPU memory.
  if (_current) {
    _current.dispose();
    _current = null;
  }

  const width = zoneMap.width ?? CITY.width;
  const length = zoneMap.length ?? CITY.length;
  const segs = TERRAIN.segments; // 256 quads per axis
  const maxH = TERRAIN.maxHeight;

  // PlaneGeometry lies in XZ (we'll rotateX after positioning via vertex Y).
  // THREE PlaneGeometry is in XY by default — rotate so it's in XZ.
  const geo = new THREE.PlaneGeometry(width, length, segs, segs);
  geo.rotateX(-Math.PI / 2);

  // After rotation the vertex layout: x = world X, y = 0 (to be set), z = world Z.
  // Vertices are in row-major order: (segs+1) × (segs+1).
  const pos = geo.attributes.position;
  const verts = segs + 1; // vertices per axis

  // Precompute Y values from zoneMap and write into geometry.
  // Also store a flat Float32Array for getTerrainY bilinear lookup (no THREE overhead).
  const yGrid = new Float32Array(verts * verts);

  for (let row = 0; row < verts; row++) {
    for (let col = 0; col < verts; col++) {
      // THREE PlaneGeometry (after rotateX): vertices scan left→right, back→front.
      // col=0 → x = −width/2;  row=0 → z = −length/2  (before rotateX: y=+length/2)
      // After rotateX(-PI/2): original y → z, original z → y.
      // So actual vertex world coords:
      //   vx = -width/2  + col * (width/segs)
      //   vz = -length/2 + row * (length/segs)
      const vx = -width / 2 + col * (width / segs);
      const vz = -length / 2 + row * (length / segs);

      const h = zoneMap.getHeight(vx, vz); // [0, 1]
      const wy = h * maxH;

      // Vertex index in the position buffer (row-major after rotateX).
      const vi = row * verts + col;
      pos.setY(vi, wy);
      yGrid[vi] = wy;
    }
  }

  pos.needsUpdate = true;
  geo.computeVertexNormals();

  // Baked surface texture: zone ground plus terrain-level city infrastructure.
  // This makes roads, sidewalks, and alleys part of the terrain mesh itself, so
  // they inherit the terrain vertices and cannot z-fight with overlay planes.
  const surfaceTexture = buildSurfaceTexture({ zoneMap, cityLayout, width, length });
  const mat = new THREE.MeshLambertMaterial({
    color: surfaceTexture ? 0xffffff : (CITY.groundColor ?? 0x0d0d12),
    map: surfaceTexture,
    side: THREE.FrontSide,
  });
  mat.name = 'terrain-surface';

  const mesh = new THREE.Mesh(geo, mat);
  mesh.receiveShadow = false;
  mesh.userData.isTerrain = true;

  // Single scene.add call.
  scene.add(mesh);

  // ── getTerrainY ─────────────────────────────────────────────────────────────
  // Bilinear interpolation within the yGrid for arbitrary world (x, z).
  const halfW = width / 2;
  const halfL = length / 2;
  const stepX = width / segs;
  const stepZ = length / segs;

  /**
   * Returns the interpolated terrain Y (world units) at world position (x, z).
   * Clamped to the world boundary.
   * @param {number} x
   * @param {number} z
   * @returns {number}
   */
  function getTerrainY(x, z) {
    // Convert to fractional column/row.
    const fc = (x + halfW) / stepX;
    const fr = (z + halfL) / stepZ;

    const c0 = Math.max(0, Math.min(segs - 1, Math.floor(fc)));
    const r0 = Math.max(0, Math.min(segs - 1, Math.floor(fr)));
    const c1 = c0 + 1;
    const r1 = r0 + 1;
    const u = fc - c0;
    const v = fr - r0;

    const y00 = yGrid[r0 * verts + c0];
    const y10 = yGrid[r0 * verts + c1];
    const y01 = yGrid[r1 * verts + c0];
    const y11 = yGrid[r1 * verts + c1];

    return y00 * (1 - u) * (1 - v) + y10 * u * (1 - v) + y01 * (1 - u) * v + y11 * u * v;
  }

  // ── dispose ──────────────────────────────────────────────────────────────────
  function dispose() {
    scene.remove(mesh);
    geo.dispose();
    mat.map?.dispose?.();
    mat.dispose();
  }

  _current = { mesh, getTerrainY, dispose };
  return _current;
}

/**
 * Convenience accessor — returns getTerrainY from the most recently built terrain.
 * Returns a zero-function if no terrain has been built yet.
 * @returns {(x:number,z:number)=>number}
 */
export function getTerrainY(x, z) {
  if (_current) return _current.getTerrainY(x, z);
  return 0;
}
