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

  // BSP plot subdivision — tuned for dense downtown: smaller plots, more buildings.
  plotMinArea: 120,
  plotSetback: 1.2,
  plotBSPDepth: 7,

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
  // Third-person chase camera
  chaseDistance: 12,      // metres behind the car
  chaseHeight: 6,         // metres above car pivot
  chaseLookAhead: 6,      // metres ahead of car the camera looks at
  chaseLookHeight: 1.2,   // world-Y of the look-at point
  // Player car sprite dimensions
  spriteScale: 6,         // world-unit size of the player car sprite
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
  wallBounceDamp: 0.8,    // fraction of head-on speed lost on building impact (0=none, 1=stop)
  // Map boundary enforcement: the vehicle is clamped to city.bounds (minX/maxX/minZ/maxZ)
  // every frame in main.js after resolveBuildingCollisions(). Speed is dampened by this factor
  // when the boundary is breached (same semantics as wallBounceDamp).
  boundaryBounceDamp: 0.6,  // fraction of speed lost when hitting the map edge
  // E-brake / drift
  eBrakeLateralFriction: 0.18, // lateral drag while e-brake is held (lower = more slide)
  eBrakeLongFriction:    0.55, // longitudinal drag while e-brake is held (slows forward speed)
  driftSteerBoost:       1.6,  // multiplier on turnRate while drifting
  driftMinSpeed:         8,    // minimum |speed| (units/sec) before e-brake has any drift effect
};

export const PISTOL = {
  // 2-D sprite anchor (CSS px from bottom-right corner of viewport).
  anchorBottom: 24,
  anchorRight:  24,
  // Parallax: how many CSS px the sprite shifts per NDC unit (0..1 feels subtle).
  aimParallaxX: 28,   // px shift left/right
  aimParallaxY: 18,   // px shift up/down
  // Barrel tilt: degrees the whole sprite rotates to track cursor elevation.
  aimTiltDeg: 8,
  muzzleFlashLifetime: 0.06,
  impactLifetime: 0.18,
  shootNear: 1.5,          // ray skips anything this close
  cooldownSeconds: 0.1,
  // Laser beam
  laserColor: '#4ae0ff',
  laserGlowColor: 'rgba(74,224,255,0.35)',
  laserWidth: 3,
  laserGlowWidth: 10,
  laserLifetime: 0.12,    // seconds until fully faded
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
  startAmmo: 50,
  maxAmmo: 100,
  ammoPerRam: 10,
  firingCostAmmo: 20,
  // Capacitor system: filling past 100% banks one charge (max 2).
  maxCapacitors: 2,
  // Per-session moot count. Districts will eventually override this.
  sessionMoots: 120,
  // Truck is invincible — no health, no crash damage.
  maxHealth: 0,
};

export const NAV = {
  cellSize: 1.0,          // metres per nav cell (1 m: fine enough for moots, cheap enough for 800 m city)
  mootRadius: 0.4,        // inflated AABB clearance for moots
  // Cost multipliers
  costAlley: 0.7,
  costIntersection: 1.3,
  aStarMaxCells: 50000,   // iteration cap to prevent spike on pathological queries
};

export const AI = {
  // Perception thresholds
  threatDecayRate: 0.4,     // per second
  threatEnterFlee: 0.5,
  threatExitAlarm: 0.15,
  threatExitDistance: 50,   // truck must be this far AND threat < exit threshold
  alarmExitSeconds: 5.0,    // seconds below threat before entering recovering
  recoverySeconds: 8.0,     // seconds in recovering before returning to unaware
  // Ambient (unaware)
  walkSpeed: 1.2,           // m/s
  destMinDist: 30,          // min distance when picking ambient destination
  destMaxDist: 100,
  replanInterval: 0.6,      // seconds between replans while alarmed
  // Flee
  fleeSpeed: 4.5,           // m/s
  fleeSampleRingMin: 30,
  fleeSampleRingMax: 60,
  fleeReplanMin: 0.5,
  fleeReplanMax: 1.0,
  // Armed
  armedDropFleeRadius: 6,   // if truck gets this close, drop to flee
  armedLostLosSeconds: 2.0, // LOS lost for this long → recovering
  // Recovery
  recoveryWalkSpeed: 1.0,
  recoveryGlanceInterval: 1.0,
  recoveryGlanceThreat: 0.2,
};

export const POP = {
  standing: 60,
  despawnRadius: 300,
  spawnRingMin: 150,
  spawnRingMax: 250,
  spawnVisCheck: true,
  tickHz: 2,
};

// BOSS deprecated — truck is invincible, time is the only pressure.

export const AMMO = {
  ramRefund: 1,           // ammo gained per regular moot ram
};

export const BOOST = {
  // Activation
  minAmmo:         10,    // ammo required to start boosting (units)
  // Drain
  costPerSec:      20,    // ammo drained per second while boosting
  // Speed
  speedMult:       1.6,   // multiplier on CAR.maxSpeed while boosting
  // NPC collision while boosting
  ammoOnDestroy:   8,     // ammo recovered when boosting destroys an NPC vehicle
  // Smash (non-boost NPC collision) slow
  smashSpeedMult:  0.4,   // speed multiplied by this on a non-boost NPC hit
  // NPC spin-away on boost destroy
  spinDuration:    0.8,   // seconds the NPC spins before vanishing
  spinSpeed:       12,    // radians/sec of spin
  spinFlySpeed:    18,    // world units/sec the NPC flies outward during spin
};

// LEVEL deprecated — no boss, no level transitions.

export const MIRROR = {
  // How long each reactive face lingers before reverting to neutral.
  happyMs: 600,
  celebratingMs: 1500,
  smugMs: 700,
  angryMs: 400,
  painedMs: 500,
  // Minimum head-on impact intensity (0..1) before a wall hit triggers pained.
  painedMinIntensity: 0.25,
};

export const NPC_VEHICLE = {
  count:          20,       // total NPC vehicles in the world at once
  speed:          14,       // m/s base cruise speed
  turnRate:       2.2,      // rad/s maximum yaw change
  spriteScale:    5,        // Three.js sprite world units
  waypointRadius: 4,        // metres to next waypoint before advancing path
  replanInterval: 12,       // seconds between forced replans
  respawnDelayMs: 4000,     // ms after destruction before respawning
  ramMinSpeed:    10,       // minimum player speed to destroy NPC on ram
  ramRadius:      3.0,      // collision radius for player-vs-NPC ram detection
  scoreRam:       150,      // points awarded for ramming an NPC vehicle
  scoreShot:      200,      // points awarded for shooting an NPC vehicle
};

export const TARGET = {
  // Crazy-Taxi style target system.
  ringColor:         0xffee00,  // ground ring color
  ringRadius:        3.5,       // world units
  ringThickness:     0.5,
  ringSegments:      48,
  ringFlashHz:       2.0,       // flashes per second on the ring
  baseTimeBonus:     15,        // seconds added to session timer per target hit
  comboWindow:       8,         // seconds within which consecutive hits multiply score
  comboMax:          8,         // maximum combo multiplier
  scorePerTarget:    500,       // base score per target hit (× combo)
  startTimeS:        60,        // session timer start (seconds)
  timeWarningS:      10,        // session timer below this flashes red
  targetCountdownS:  15,        // per-target countdown (seconds); picking new target when 0
  targetWarningS:    5,         // per-target countdown goes red below this
};

export const SCORING = {
  jumpMinAirtime:  0.4,         // seconds of airtime required to count as a jump
  jumpScore:       100,         // score per jump (stub for ramp system)
};
