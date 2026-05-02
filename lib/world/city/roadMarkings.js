import * as THREE from 'three';

// Lane markings + crosswalks. All geometry is instanced so the whole city's
// markings cost a handful of draw calls.
//
// Layering:
//   y = 0.000  base ground
//   y = 0.010  road plane
//   y = 0.012  road markings (this file)
//   y = 0.020  sidewalk plane

const Y_MARKING = 0.012;
const DASH_LEN  = 2.6;
const DASH_GAP  = 4.0;
const DASH_W    = 0.32;

const STRIPE_LEN = 3.6;   // crosswalk bar length (across road)
const STRIPE_W   = 0.5;   // crosswalk bar thickness (along road)
const STRIPE_GAP = 0.8;
const CROSS_OFFSET = 1.4; // distance from intersection edge

/**
 * Add yellow centre-dashes along every street and white crosswalk stripes
 * around every intersection.
 *
 * Skips dashes inside intersection footprints so the centre doesn't double
 * up with the crosswalk bars.
 */
export function buildRoadMarkings(scene, xLines, zLines, intersections, bounds) {
  const dashMatrices = [];
  // Vertical streets (run along z): centre is the xL.x line, dashes step in z.
  for (const xL of xLines) {
    addDashesAlong({
      axis: 'z',
      lineCoord: xL.x,
      from: bounds.minZ + DASH_LEN,
      to:   bounds.maxZ - DASH_LEN,
      crossLines: zLines,
      crossKey: 'z',
      out: dashMatrices,
    });
  }
  // Horizontal streets (run along x): centre is the zL.z line, dashes step in x.
  for (const zL of zLines) {
    addDashesAlong({
      axis: 'x',
      lineCoord: zL.z,
      from: bounds.minX + DASH_LEN,
      to:   bounds.maxX - DASH_LEN,
      crossLines: xLines,
      crossKey: 'x',
      out: dashMatrices,
    });
  }

  if (dashMatrices.length > 0) {
    const dashGeom = new THREE.PlaneGeometry(DASH_W, DASH_LEN).rotateX(-Math.PI / 2);
    const dashMat = new THREE.MeshBasicMaterial({ color: 0xfdd23a });
    const inst = new THREE.InstancedMesh(dashGeom, dashMat, dashMatrices.length);
    for (let i = 0; i < dashMatrices.length; i++) inst.setMatrixAt(i, dashMatrices[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    scene.add(inst);
  }

  // Crosswalk stripes — 4 legs per intersection.
  const stripeMatrices = [];
  for (const it of intersections) {
    addCrosswalk(it, stripeMatrices);
  }
  if (stripeMatrices.length > 0) {
    const stripeGeom = new THREE.PlaneGeometry(STRIPE_W, STRIPE_LEN).rotateX(-Math.PI / 2);
    const stripeMat = new THREE.MeshBasicMaterial({ color: 0xe6e6e6 });
    const inst = new THREE.InstancedMesh(stripeGeom, stripeMat, stripeMatrices.length);
    for (let i = 0; i < stripeMatrices.length; i++) inst.setMatrixAt(i, stripeMatrices[i]);
    inst.instanceMatrix.needsUpdate = true;
    inst.frustumCulled = false;
    scene.add(inst);
  }
}

function addDashesAlong({ axis, lineCoord, from, to, crossLines, crossKey, out }) {
  const m = new THREE.Matrix4();
  // For vertical streets (axis='z'), dash long-axis is already Z (PlaneGeom is XZ
  // post-rotate, length on local Y → world Z after our rotate). For horizontal
  // streets (axis='x'), rotate the dash 90° around Y so its long axis is X.
  const rot = new THREE.Matrix4().makeRotationY(axis === 'x' ? Math.PI / 2 : 0);

  const step = DASH_LEN + DASH_GAP;
  for (let t = from; t < to; t += step) {
    if (insideAnyIntersection(t, crossLines, crossKey)) continue;
    m.copy(rot);
    if (axis === 'z') m.setPosition(lineCoord, Y_MARKING, t);
    else              m.setPosition(t, Y_MARKING, lineCoord);
    out.push(m.clone());
  }
}

// True if `t` falls within (cross.coord ± cross.width/2 + small margin) for any
// crossing line — i.e. inside the intersection footprint.
function insideAnyIntersection(t, crossLines, crossKey) {
  for (const c of crossLines) {
    const co = c[crossKey];
    if (Math.abs(t - co) < c.width / 2 + 2.0) return true;
  }
  return false;
}

// 4 crosswalk legs. Stripes run perpendicular to the road they cross.
function addCrosswalk(it, out) {
  const cx = it.pos.x;
  const cz = it.pos.z;
  const wX = it.widthX;   // width of the vertical (X-line) road
  const wZ = it.widthZ;   // width of the horizontal (Z-line) road
  const m = new THREE.Matrix4();
  const rotZ = new THREE.Matrix4().makeRotationY(Math.PI / 2);

  // North & south legs: cross the vertical road (width wX along X axis).
  // Stripes run east-west (long axis = X), stepping along X.
  for (const sgn of [-1, 1]) {
    const baseZ = cz + sgn * (wZ / 2 + CROSS_OFFSET);
    const nBars = Math.max(3, Math.floor(wX / (STRIPE_W + STRIPE_GAP)));
    const span = nBars * STRIPE_W + (nBars - 1) * STRIPE_GAP;
    const startX = cx - span / 2 + STRIPE_W / 2;
    for (let i = 0; i < nBars; i++) {
      m.copy(rotZ);
      m.setPosition(startX + i * (STRIPE_W + STRIPE_GAP), Y_MARKING, baseZ);
      out.push(m.clone());
    }
  }
  // East & west legs: cross the horizontal road (width wZ along Z axis).
  // Stripes run north-south (long axis = Z, no rotation), stepping along Z.
  for (const sgn of [-1, 1]) {
    const baseX = cx + sgn * (wX / 2 + CROSS_OFFSET);
    const nBars = Math.max(3, Math.floor(wZ / (STRIPE_W + STRIPE_GAP)));
    const span = nBars * STRIPE_W + (nBars - 1) * STRIPE_GAP;
    const startZ = cz - span / 2 + STRIPE_W / 2;
    for (let i = 0; i < nBars; i++) {
      m.identity();
      m.setPosition(baseX, Y_MARKING, startZ + i * (STRIPE_W + STRIPE_GAP));
      out.push(m.clone());
    }
  }
}
