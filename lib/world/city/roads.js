import { CITY, MOOT } from '../../config.js';

// Generate a perturbed axis-aligned grid of streets.
// One vertical line is anchored at x=0 so the existing moot corridor lands on
// a real street. Each line is then assigned a tier (thoroughfare4 /
// thoroughfare2 / local) which determines its road width. Alleys that split
// blocks come from the alley pass in blocks.js, not from this grid.
//
// Returns { xLines, zLines } where each entry is { x|z, width, tier },
// sorted ascending.
export function generateRoadGrid(rand) {
  const halfW = CITY.width / 2;
  const zTop = MOOT.spacing;
  const zBot = -CITY.length + MOOT.spacing;

  const stepRand = () =>
    CITY.streetSpacing *
    (1 - CITY.streetSpacingJitter + rand() * 2 * CITY.streetSpacingJitter);

  const localW = CITY.tiers.local;

  // Vertical streets — start at x=0 (anchor), walk outward.
  const xLines = [{
    x: 0,
    width: CITY.tiers[CITY.startTier],
    tier: CITY.startTier,
    locked: true,
  }];
  for (let x = stepRand(); x < halfW; x += stepRand()) {
    xLines.push({ x, width: localW, tier: 'local' });
  }
  for (let x = -stepRand(); x > -halfW; x -= stepRand()) {
    xLines.push({ x, width: localW, tier: 'local' });
  }
  xLines.sort((a, b) => a.x - b.x);

  // Horizontal streets.
  const zLines = [{ z: zTop, width: localW, tier: 'local' }];
  let zCur = zTop;
  while (zCur > zBot + CITY.streetSpacing * 0.5) {
    zCur -= stepRand();
    if (zCur > zBot) zLines.push({ z: zCur, width: localW, tier: 'local' });
  }
  zLines.push({ z: zBot, width: localW, tier: 'local' });
  zLines.sort((a, b) => a.z - b.z);

  promoteTiers(xLines, rand);
  promoteTiers(zLines, rand);

  return { xLines, zLines };
}

// Pick `thoroughfare4PerAxis` random non-locked lines and promote them to
// thoroughfare4, then pick `thoroughfare2PerAxis` more for thoroughfare2.
function promoteTiers(lines, rand) {
  const candidates = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => !l.locked);

  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  let idx = 0;
  for (let n = 0; n < CITY.thoroughfare4PerAxis && idx < candidates.length; n++, idx++) {
    candidates[idx].l.tier = 'thoroughfare4';
    candidates[idx].l.width = CITY.tiers.thoroughfare4;
  }
  for (let n = 0; n < CITY.thoroughfare2PerAxis && idx < candidates.length; n++, idx++) {
    candidates[idx].l.tier = 'thoroughfare2';
    candidates[idx].l.width = CITY.tiers.thoroughfare2;
  }
}

// Convert grid lines into the road segment + intersection records the bundle
// expects. Each grid line spans the full opposite extent.
export function gridToSegments(xLines, zLines) {
  const segments = [];
  const intersections = [];
  const zMin = zLines[0].z;
  const zMax = zLines[zLines.length - 1].z;
  const xMin = xLines[0].x;
  const xMax = xLines[xLines.length - 1].x;

  for (const xL of xLines) {
    segments.push({
      a: { x: xL.x, z: zMin },
      b: { x: xL.x, z: zMax },
      width: xL.width,
      kind: xL.tier,
    });
  }
  for (const zL of zLines) {
    segments.push({
      a: { x: xMin, z: zL.z },
      b: { x: xMax, z: zL.z },
      width: zL.width,
      kind: zL.tier,
    });
  }
  for (const xL of xLines) {
    for (const zL of zLines) {
      intersections.push({
        pos: { x: xL.x, z: zL.z },
        widthX: xL.width,
        widthZ: zL.width,
      });
    }
  }
  return { segments, intersections };
}
