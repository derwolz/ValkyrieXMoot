/**
 * lib/world/highway/spline.js
 *
 * buildHighwaySpline({ seed?, width?, length? })
 *   → elevated circuit/beltway layout
 *
 * Generates a deterministic, closed elevated highway circuit instead of an open
 * through-city ribbon.  The layout includes:
 *   • points                 — dense closed main deck centreline samples
 *   • rampIndices            — mainline attachment sample indices
 *   • ramps                  — 3–4 seeded on/off ramp connector centrelines
 *   • reservationPolylines   — main/ramp corridors for zone/city exclusion
 *
 * No THREE.js imports — pure geometry math.
 */

import { CITY, HIGHWAY } from '../../config.js';

/**
 * Simple xorshift32 PRNG — returns a function () → float [0, 1).
 * @param {number} seed
 */
function makeRand(seed) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) & 0x7fffffff) / 0x7fffffff;
  };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Catmull-Rom interpolation between four points.
 * Returns {x, z, y?} at parameter t ∈ [0,1] for segment [p1, p2].
 */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  const point = {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    z:
      0.5 *
      (2 * p1.z +
        (-p0.z + p2.z) * t +
        (2 * p0.z - 5 * p1.z + 4 * p2.z - p3.z) * t2 +
        (-p0.z + 3 * p1.z - 3 * p2.z + p3.z) * t3),
  };

  if ('y' in p0 || 'y' in p1 || 'y' in p2 || 'y' in p3) {
    const y0 = Number.isFinite(p0.y) ? p0.y : 0;
    const y1 = Number.isFinite(p1.y) ? p1.y : 0;
    const y2 = Number.isFinite(p2.y) ? p2.y : 0;
    const y3 = Number.isFinite(p3.y) ? p3.y : 0;
    point.y =
      0.5 *
      (2 * y1 +
        (-y0 + y2) * t +
        (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
        (-y0 + 3 * y1 - 3 * y2 + y3) * t3);
  }

  return point;
}

function normalise2(x, z) {
  const len = Math.hypot(x, z) || 1;
  return { x: x / len, z: z / len };
}

function sampleOpenSpline(controlPts, steps) {
  const points = [];
  if (controlPts.length < 2) return controlPts.slice();

  for (let i = 0; i < controlPts.length - 1; i++) {
    const p0 = controlPts[Math.max(0, i - 1)];
    const p1 = controlPts[i];
    const p2 = controlPts[i + 1];
    const p3 = controlPts[Math.min(controlPts.length - 1, i + 2)];

    for (let s = 0; s < steps; s++) {
      points.push(catmullRom(p0, p1, p2, p3, s / steps));
    }
  }

  points.push({ ...controlPts[controlPts.length - 1] });
  return points;
}

function sampleClosedSpline(controlPts, steps) {
  const points = [];
  const count = controlPts.length;
  if (count < 3) return sampleOpenSpline(controlPts, steps);

  for (let i = 0; i < count; i++) {
    const p0 = controlPts[(i - 1 + count) % count];
    const p1 = controlPts[i];
    const p2 = controlPts[(i + 1) % count];
    const p3 = controlPts[(i + 2) % count];

    for (let s = 0; s < steps; s++) {
      points.push(catmullRom(p0, p1, p2, p3, s / steps));
    }
  }

  // Duplicate the first point at the end so existing ribbon/reservation code that
  // walks point pairs as an open polyline still emits the final closing segment.
  points.push({ ...points[0] });
  return points;
}

function pointAtFraction(points, fraction) {
  const lastUniqueIndex = Math.max(0, points.length - 2);
  const index = clamp(Math.round(fraction * lastUniqueIndex), 0, lastUniqueIndex);
  return { index, point: points[index] };
}

function tangentAt(points, index) {
  const lastUniqueIndex = Math.max(0, points.length - 2);
  const prevIndex = (index - 2 + lastUniqueIndex + 1) % (lastUniqueIndex + 1);
  const nextIndex = (index + 2) % (lastUniqueIndex + 1);
  const prev = points[prevIndex];
  const next = points[nextIndex];
  return normalise2(next.x - prev.x, next.z - prev.z);
}

function makeRampSamples(controlPts, steps) {
  return sampleOpenSpline(controlPts, Math.max(4, Math.floor(steps * 0.75)));
}

function pickInwardNormal(point, tangent, centerZ) {
  const left = normalise2(-tangent.z, tangent.x);
  const right = { x: -left.x, z: -left.z };
  const toCityCenter = normalise2(-point.x, centerZ - point.z);
  const leftDot = left.x * toCityCenter.x + left.z * toCityCenter.z;
  const rightDot = right.x * toCityCenter.x + right.z * toCityCenter.z;
  return leftDot >= rightDot ? left : right;
}

function buildCircuitControlPoints({ rand, width, length, deckHeight }) {
  const halfW = width / 2;
  const halfL = length / 2;
  const baseInset = Math.max(120, HIGHWAY.circuitInset ?? HIGHWAY.loopInset ?? 300);
  const waterInset = Math.max(baseInset, HIGHWAY.circuitWaterInset ?? baseInset);
  const jitter = Math.max(0, HIGHWAY.circuitJitter ?? HIGHWAY.centerlineJitter ?? 80);
  const count = Math.max(8, Math.min(16, HIGHWAY.circuitControlPoints ?? 12));

  const left = -halfW + baseInset;
  const right = halfW - baseInset;
  const south = -halfL + waterInset;
  const north = halfL - baseInset;
  const centerZ = (south + north) * 0.5;
  const radiusX = Math.max(300, (right - left) * 0.5);
  const radiusZ = Math.max(300, (north - south) * 0.5);
  const phase = rand() * Math.PI * 2;
  const points = [];

  for (let i = 0; i < count; i++) {
    const angle = -Math.PI * 0.5 + (i / count) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const organicBend =
      Math.sin(angle * 3 + phase) * 0.035 + Math.sin(angle * 2 - phase * 0.7) * 0.025;
    const radialScale = 1 + organicBend;
    const tangentJitter = (rand() - 0.5) * jitter;
    const radialJitter = (rand() - 0.5) * jitter * 0.45;
    const tangent = normalise2(-sin / Math.max(radiusX, 1), cos / Math.max(radiusZ, 1));
    const outward = normalise2(cos / Math.max(radiusX, 1), sin / Math.max(radiusZ, 1));

    const x = cos * (radiusX * radialScale + radialJitter) + tangent.x * tangentJitter;
    const z = centerZ + sin * (radiusZ * radialScale + radialJitter) + tangent.z * tangentJitter;

    points.push({
      x: clamp(x, left, right),
      z: clamp(z, south, north),
      y: deckHeight,
      // Keep this local only during construction; stripped before returning.
      _outwardX: outward.x,
      _outwardZ: outward.z,
    });
  }

  return {
    points: points.map(({ x, z, y }) => ({ x, z, y })),
    centerZ,
  };
}

/**
 * @param {{
 *   seed?:   number,
 *   width?:  number,
 *   length?: number,
 * }} [opts]
 * @returns {{
 *   points: { x: number, z: number, y?: number }[],
 *   controlPts: { x: number, z: number, y?: number }[],
 *   rampIndices: number[],
 *   ramps: {
 *     id: string,
 *     type: string,
 *     side: number,
 *     direction: number,
 *     attachIndex: number,
 *     halfWidth: number,
 *     points: { x: number, z: number, y?: number }[],
 *     controlPts: { x: number, z: number, y?: number }[],
 *     touchdown: { x: number, z: number, y?: number },
 *   }[],
 *   reservationPolylines: {
 *     id: string,
 *     kind: string,
 *     halfWidth: number,
 *     points: { x: number, z: number, y?: number }[],
 *   }[],
 * }}
 */
export function buildHighwaySpline({
  seed = CITY.seed,
  width = CITY.width,
  length = CITY.length,
} = {}) {
  const rand = makeRand((seed ^ 0xdeadbeef ^ (HIGHWAY.interchangeSeedOffset ?? 0)) >>> 0);
  const steps = Math.max(4, HIGHWAY.splineSteps || 16);
  const halfW = width / 2;
  const halfL = length / 2;
  const deckHeight = HIGHWAY.deckHeight ?? HIGHWAY.overpassHeight ?? 18;
  const expresswayHalfWidth = HIGHWAY.expresswayHalfWidth ?? HIGHWAY.roadHalfWidth ?? 18;
  const corridorHalfWidth = HIGHWAY.corridorHalfWidth ?? expresswayHalfWidth + 24;

  const { points: controlPts, centerZ } = buildCircuitControlPoints({
    rand,
    width,
    length,
    deckHeight,
  });
  const points = sampleClosedSpline(controlPts, steps);

  // Pick 3–4 interchanges around the circuit.  They are spaced by fraction around
  // the loop, then lightly jittered so the city reads planned rather than gridded.
  const minCount = Math.max(3, HIGHWAY.interchangeCountMin ?? 3);
  const maxCount = Math.max(minCount, HIGHWAY.interchangeCountMax ?? 4);
  const interchangeCount = clamp(minCount + Math.floor(rand() * (maxCount - minCount + 1)), 3, 4);
  const spacingJitter = HIGHWAY.interchangeSpacingJitter ?? 0.08;
  const configuredRampLength = HIGHWAY.rampLength ?? 260;
  const rampMaxGrade = Math.max(0.01, HIGHWAY.rampMaxGrade ?? 0.075);
  // Treat rampLength as a preferred minimum, not a hard-coded grade.  When the
  // deck is raised, automatically lengthen the horizontal run so the street
  // touchdown can climb to the deck without exceeding the configured max grade.
  const minimumGradeRun = deckHeight / rampMaxGrade;
  const rampLength = Math.max(configuredRampLength, minimumGradeRun * 1.12);
  const rampMergeLength = HIGHWAY.rampMergeLength ?? 90;
  const rampSideOffset = HIGHWAY.rampSideOffset ?? 58;
  const rampCurveOffset = HIGHWAY.rampCurveOffset ?? 90;
  const rampHalfWidth = HIGHWAY.rampHalfWidth ?? 8;
  const rampReservationHalfWidth =
    HIGHWAY.rampReservationHalfWidth ?? Math.max(16, rampHalfWidth + 8);
  const rampAttachOffset = expresswayHalfWidth + rampHalfWidth * 0.8;
  const touchdownClearance = HIGHWAY.rampTouchdownClearance ?? 24;
  const ramps = [];
  const rampIndices = [];

  for (let i = 0; i < interchangeCount; i++) {
    const baseFraction = (i + 0.5) / interchangeCount;
    const fraction = (baseFraction + (rand() - 0.5) * spacingJitter + 1) % 1;
    const { index, point } = pointAtFraction(points, fraction);
    const tangent = tangentAt(points, index);
    const inwardNormal = pickInwardNormal(point, tangent, centerZ);
    const direction = i % 2 === 0 ? 1 : -1;
    const rampForward = { x: tangent.x * direction, z: tangent.z * direction };
    const attach = {
      x: point.x + inwardNormal.x * rampAttachOffset,
      z: point.z + inwardNormal.z * rampAttachOffset,
      y: deckHeight,
    };
    const merge = {
      x: attach.x - rampForward.x * rampMergeLength,
      z: attach.z - rampForward.z * rampMergeLength,
      y: deckHeight,
    };
    const curve = {
      x: attach.x + rampForward.x * (rampLength * 0.42) + inwardNormal.x * rampCurveOffset,
      z: attach.z + rampForward.z * (rampLength * 0.42) + inwardNormal.z * rampCurveOffset,
      y: deckHeight * 0.55,
    };
    const unclampedTouchdown = {
      x: attach.x + rampForward.x * rampLength + inwardNormal.x * rampSideOffset,
      z: attach.z + rampForward.z * rampLength + inwardNormal.z * rampSideOffset,
      y: 0,
    };
    const touchdown = {
      x: clamp(unclampedTouchdown.x, -halfW + touchdownClearance, halfW - touchdownClearance),
      z: clamp(unclampedTouchdown.z, -halfL + touchdownClearance, halfL - touchdownClearance),
      y: 0,
    };
    const rampControlPts = [touchdown, curve, attach, merge];
    const rampPoints = makeRampSamples(rampControlPts, steps).map((point) => ({
      ...point,
      y: clamp(Number.isFinite(point.y) ? point.y : 0, 0, deckHeight),
    }));
    const horizontalRun = Math.hypot(attach.x - touchdown.x, attach.z - touchdown.z);

    rampIndices.push(index);
    ramps.push({
      id: `ramp-${i + 1}`,
      type: direction > 0 ? 'off-ramp' : 'on-ramp',
      side: 1,
      direction,
      attachIndex: index,
      halfWidth: rampHalfWidth,
      points: rampPoints,
      controlPts: rampControlPts,
      touchdown,
      effectiveLength: Math.max(horizontalRun, rampLength),
      maxGrade: rampMaxGrade,
    });
  }

  const reservationPolylines = [
    {
      id: 'highway-circuit-main',
      kind: 'circuit',
      halfWidth: corridorHalfWidth,
      points,
    },
    ...ramps.map((ramp) => ({
      id: ramp.id,
      kind: 'ramp',
      halfWidth: rampReservationHalfWidth,
      points: ramp.points,
    })),
  ];

  return { points, controlPts, rampIndices, ramps, reservationPolylines, isCircuit: true };
}
