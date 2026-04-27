// Central tunables. Nothing gameplay-relevant should be hardcoded outside this file.
// Grouped by system so lil-gui can fold each group into its own folder later.

export const DEBUG = {
  enabled: new URLSearchParams(location.search).has('debug'),
};

export const WORLD = {
  clearColor: 0x0a0a10,
  fogNear: 60,
  fogFar: 400,
  roadHalfWidth: 10,
  sidewalkWidth: 6,
  stripeLength: 3,
  stripeGap: 3,
  stripeWidth: 0.35,
  // Corridor extent is derived from moot count in main.js; this is the "end padding".
  corridorEndPadding: 80,
};

export const BUILDING = {
  seed: 0xb1d5ca5e,
  minWidth: 8,
  maxWidth: 16,
  minHeight: 14,
  maxHeight: 38,
  minDepth: 8,
  maxDepth: 16,
  stepMin: 9,
  stepMax: 18,
  roofColor: 0x15181d,
};

export const CITY = {
  seed: 0xc1ce05ed,
  // City extent: x in [-width/2, width/2], z in [-length+MOOT.spacing, MOOT.spacing]
  width: 800,
  length: 800,

  // Road tier widths (just the asphalt, not sidewalks).
  // Hierarchy: thoroughfare4 > thoroughfare2 > local > alley.
  tiers: {
    thoroughfare4: 32,   // 4-lane major artery
    thoroughfare2: 20,   // 2-lane thoroughfare
    local:         10,   // local street ("small road")
    alley:          4,   // narrow cut, no sidewalks
  },
  // Tier counts per axis (chosen randomly from grid lines, excluding x=0 anchor).
  // x=0 anchor uses startTier so the moot corridor lands on a real road.
  startTier: 'thoroughfare2',
  thoroughfare4PerAxis: 1,
  thoroughfare2PerAxis: 2,   // not counting the x=0 anchor

  // Sidewalk strip width — uniform across every non-alley road tier (each side).
  sidewalkWidth: 5,

  // Perturbed grid spacing
  streetSpacing: 130,
  streetSpacingJitter: 0.15,

  // Block-internal alleys (separate from grid lines demoted to alley tier)
  alleyMinBlockDim: 60,
  alleyChance: 0.7,

  // BSP plot subdivision
  plotMinArea: 220,
  plotSetback: 0.5,
  plotBSPDepth: 6,

  // Building heights for city plots
  buildingMinHeight: 8,
  buildingMaxHeight: 28,

  // Ground colors
  groundColor: 0x0d0d12,
  roadColor: 0x1a1a1f,
  sidewalkColor: 0x3a3a40,
  alleyColor: 0x202024,
};

export const CAR = {
  startPos: [0, 0, 10],
  startYaw: 0,
  cameraHeight: 1.6,
  // Longitudinal
  accel: 45,              // units/sec^2 when pressing forward
  brake: 90,              // units/sec^2 when reversing input opposes current velocity
  maxSpeed: 55,           // units/sec forward
  reverseMaxSpeed: 18,    // units/sec reverse
  coastFriction: 6,       // passive drag toward 0 when no input
  // Lateral (turning)
  turnRate: 1.9,          // rad/sec at max speed
  // Turning scales with |speed|/maxSpeed, so there's no turn-in-place.
  collisionRadius: 1.8,   // car treated as a circle in XZ for AABB resolution
  wallBounceDamp: 0.8,    // fraction of head-on speed lost on impact (0=none, 1=stop)
};

export const PISTOL = {
  // Anchor position in camera-local space. z negative = in front of camera.
  anchorX: 0.55,
  anchorY: -0.4,
  anchorZ: -1.0,
  bodyColor: 0x2a2a30,
  barrelColor: 0x101013,
  muzzleFlashLifetime: 0.06,
  impactLifetime: 0.18,
  shootNear: 1.5,          // ray skips anything this close (i.e. the pistol itself)
  cooldownSeconds: 0.1,
};

export const MOOT = {
  spacing: 6,
  jitterX: 6,
  spriteScale: 6,
  nameHeightUnits: 1.4,
  loadConcurrency: 16,
  // Behavior
  fleeSpeed: 18,         // units/sec when fleeing the car
  alertRadius: 32,       // only moots within this radius react to the car
  ramRadius: 1.2,        // sprite half-width used for ram collision
  ramMinSpeed: 3,        // car must exceed this absolute speed to splat
  // Armed subset (gun-enemies)
  armedFraction: 0.15,          // ~15% of session moots shoot back
  armedEngageRange: 55,         // gunmoot fires only when car is within this
  armedCooldownSec: 2.2,        // seconds between shots per gunmoot
  projectileSpeed: 28,          // units/sec
  projectileRadius: 0.35,       // mesh size
  projectileHitRadius: 1.6,     // damage circle around the car
  projectileMaxLifetime: 4.0,   // despawn if it doesn't connect
  projectileSpawnHeight: 1.4,   // so bullets emit from moot head height
};

export const GAME = {
  startCharge: 50,
  maxCharge: 100,
  chargePerRam: 10,
  firingCost: 20,
  // Capacitor system: filling past 100% banks one charge (max 2).
  maxCapacitors: 2,
  // Per-session moot count. Districts will eventually override this.
  sessionMoots: 120,
  // Health / crash damage
  maxHealth: 3,
  crashSpeedThreshold: 25,       // absolute speed required for a crash to damage
  crashIntensityThreshold: 0.5,  // head-on-ness required (forward·-normal, [0..1])
  crashDamageCooldownSec: 1.0,
};

export const MIRROR = {
  // How long each reactive face lingers before reverting to neutral.
  happyMs: 600,
  celebratingMs: 1500,
  smugMs: 700,
  angryMs: 400,
};
