# ValkyrieXMoot

A browser-based 3D arcade vehicle combat game built with Three.js. You drive a truck through a procedurally-generated 3km × 3km city, running down and shooting AI-controlled "moots" — character entities spawned from real user avatar data pulled from a backend API. Think Crazy Taxi crossed with a top-down shooter, rendered in WebGL with a sprite-over-3D aesthetic.

No build step. Pure ES modules, runs directly in the browser.

---

## Running It

```bash
# Docker (production)
docker compose up

# Local dev — just open index.html in a browser with a local HTTP server
npx serve .
# or
python3 -m http.server
```

Three.js and lil-gui load via CDN (unpkg). No npm install needed.

---

## What It Is

The player spawns in a procedurally generated city and is given a series of target moots to hunt down within a time limit. Hit targets to extend the timer. Ram moots at speed to splat them. Shoot them with the pistol. Build combos. The game tracks kills against a live backend and awards scores.

**Core loop:**
1. A target moot is highlighted with a ring marker (Crazy Taxi style)
2. Chase it down — the timer counts up to 15s extra per hit
3. Ram or shoot it; combo multiplier stacks up to 8×
4. New target assigned; repeat until time runs out

**Controls (rebindable):**

| Action | Default |
|--------|---------|
| Accelerate | W / Up |
| Brake / Reverse | S / Down |
| Steer Left | A / Left |
| Steer Right | D / Right |
| E-Brake (drift) | Space |
| Boost | Shift |
| Shoot | Mouse click |
| Rewind | Q |
| Restart | R |
| Menu | Esc |

Keybindings persist in `localStorage`. Rebind via Esc → Keybindings tab.

---

## Architecture

```
main.js                   ← game loop, scene setup, orchestration
lib/
  config.js               ← all tunables in one place (750+ lines)
  car/                    ← vehicle physics, sprites, collision
  world/                  ← procedural world generation
    city/                 ← road grid, blocks, buildings, sidewalks
    terrain/              ← heightmap mesh, surface texture baking
    zones/                ← noise-based zone classification
    highway/              ← elevated circuit spline + ramps
    park/                 ← trees, benches, footpaths
    chunks/               ← visibility culling / chunk manager
    noise.js              ← seeded Perlin noise (Mulberry32 RNG)
    population.js         ← moot spawn ring management
    spatialGrid.js        ← fast AABB spatial queries
  entities/               ← moots, NPC vehicles, target markers
  ai/                     ← moot behavior state machine
  nav/                    ← A* pathfinding, nav grid, collision grid
  hud/                    ← overlays, minimap, rearview mirror, radio
  game/                   ← game state machine, impact system
  weapons/                ← pistol (laser beam, gun sprite)
  input/                  ← keyboard bindings, touch
  rewind/                 ← 5s ring-buffer recorder/playback
  data/                   ← moot/user loader
  api.js                  ← backend API calls (fire-and-forget)
tools/                    ← smoke test + dev utilities
```

### main.js

The orchestrator. Bootstraps Three.js (scene, camera, renderer), triggers world generation, initializes all game systems, and runs the main `requestAnimationFrame` loop. Each frame it:

1. Advances vehicle physics and terrain collision
2. Ticks AI (ambient wander / flee / armed / recovery states)
3. Resolves moot–vehicle collisions (ram detection + fling physics)
4. Updates HUD (overlays, minimap, speedlines, mirror)
5. Dispatches game state events (combo, timer, target reassignment)
6. Renders scene + secondary mirror pass

### lib/config.js

Single source of truth for every magic number in the game. Sections: `DEBUG`, `WORLD`, `SKYBOX`, `BUILDING`, `CITY`, `CAR`, `PISTOL`, `MOOT`, `GAME`, `HUD`, `NAV`, `AI`, `POP`, `BOOST`, `NPC_VEHICLE`, `TARGET`, `TERRAIN`, `ZONES`, `HIGHWAY`, `OCEAN`, `PARK`, `CHUNKS`. Tune here first before touching system code.

---

## World Generation

The world is **deterministic** — same seed produces the same city every time. World data is cached in IndexedDB after first generation (keyed by schema version), so subsequent loads are instant.

### Zone Map (`lib/world/zones/`)

A 3km × 3km grid is classified into 7 zone types using layered Perlin noise:

| Zone | Description |
|------|-------------|
| URBAN | Dense city core, tall buildings, tight street grid |
| SUBURBAN | Mid-density, wider blocks |
| RURAL | Sparse, large lots |
| PARK | Open green space, trees |
| BEACH | Thin coastal strip, low elevation |
| WATER | Ocean surface |
| HIGHWAY | Elevated beltway corridor |

A separate noise layer drives terrain elevation (max 30 units). Beach strips are clamped near sea level. The shoreline runs along the negative-Z edge with seeded cove/bay variation.

### City Generator (`lib/world/city/`)

Road network is generated first, then blocks are extracted, then buildings fill the blocks.

**Road tiers:**

| Tier | Width |
|------|-------|
| Thoroughfare 4-lane | 32m |
| Thoroughfare 2-lane | 20m |
| Local street | 10m |
| Alley | 4m |

Roads use a perturbed axis-aligned grid with zone-aware spacing (tighter in urban, wider in rural). An anchor road at x=0 ensures the moot corridor always lands on a real street. Block extraction uses BSP subdivision with per-zone setback profiles. All surface geometry (ground, roads, sidewalks, alleys) is baked into a single 1024² terrain texture.

### Terrain (`lib/world/terrain/`)

A single `PlaneGeometry` mesh covers the full world. Vertex Y values are set from the zone height sample at each point. Height queries use bilinear interpolation for smooth in-between values. The surface texture carries both zone color and the baked road/sidewalk overlay.

### Highway (`lib/world/highway/`)

An elevated closed-loop beltway running inside the playable area. Deck height: 26m above terrain. 3–4 grade-safe ramps connect to feeder roads. The centerline is spline-based for smooth curves. Surface queries account for whether the player is on the deck or ground level.

### Chunks (`lib/world/chunks/`)

The world is subdivided into 64m chunks. Only chunks within a 750m radius of the player are active. Chunks outside that radius are culled from the scene, reducing draw calls in the far field.

---

## Vehicle Physics (`lib/car/vehicle.js`)

Arcade physics — no rigid body sim, no wheels, all feel-first.

**Movement model:**
- World-space velocity vector with separate forward/lateral decay (lateral decays faster = natural grip)
- Acceleration: 45 m/s², top speed: 55 m/s
- Turn rate scales with speed (can't pivot in place)
- E-brake activates lateral kick + slow lateral decay (preserves forward momentum → drift)

**Terrain:**
- Surface normals sampled at 1.5m offsets to detect slope
- Vehicle glued to terrain with 0.75m max drop (suspension)
- Crest detection: slope flattens → vehicle launches ballistically
- Gravity: 28 m/s² downward
- Hard landing (>18 m/s vertical) bleeds horizontal momentum

**Collision** (`lib/car/collision.js`):
- Vehicle is a 1.8m radius circle in XZ
- Building contact: bounce with 0.8 damping, height-aware clearance
- NPC vehicle body: impulse push + restitution
- Moot ram: splat triggered at >3 m/s with fling physics (launch direction, arc, tumble)

**Sprite** (`lib/car/playerSprite.js`):
- Third-person chase camera: 12m behind, 6m above, 6m ahead look-at offset
- 8-frame directional sprite updates based on steering input + lateral velocity
- Sprite size: 6 world units

---

## AI (`lib/ai/`)

Moot AI is a 4-state machine per entity. States tick independently each frame.

```
UNAWARE ──(threat ≥ threshold)──→ ALARMED_FLEE
                                  ALARMED_ARMED (15% of moots)
ALARMED_* ──(threat decays + distance > threshold)──→ RECOVERING
RECOVERING ──(cooldown elapsed)──→ UNAWARE
```

**Perception** (`lib/ai/perception.js`):
- Threat accumulates from proximity, line-of-sight, and event sensing (gunshots, kills nearby)
- LOS uses 2D segment vs AABB raycasts, cached and refreshed every 0.15s
- Threat decays over time when conditions clear

**Behaviors:**
- `UNAWARE` (`ambient.js`): A* path to random interest point 30–100m away; idles briefly, picks new point
- `ALARMED_FLEE` (`flee.js`): A* path away from truck, replans every 0.5–1.0s
- `ALARMED_ARMED` (`armed.js`): Shoots projectiles at truck on 2.2s cooldown while maintaining distance
- `RECOVERING` (`recovery.js`): Slow walk, periodic glance toward truck

**NPC Vehicles** (`lib/entities/npcVehicle.js`):
- Separate from moots; scripted waypoint A* following, replan every 12s
- 8-directional billboard sprites (view angle relative to camera)
- Physics: spin/slide on impact

---

## Pathfinding (`lib/nav/`)

**NavGrid** (`grid.js`):
- 2m cell resolution across the full 3km world (~1.2M cells)
- Generated from the city road/sidewalk layout
- Walkability per zone (urban/suburban/rural/park = walkable; highway/beach/water = not)
- Interest points sampled at intersection centers and park landmarks

**A\*** (`pathfind.js`):
- Octile heuristic, 8-neighbor diagonal movement
- Scratch buffers allocated once and reused; generation counter for O(1) "untouched" detection
- Path smoothing: collinear waypoint removal (string-pull)
- Cost multipliers: alleys (×0.7 — shortcuts), intersections (×1.3 — slight penalty)
- Iteration cap: 50k cells to prevent pathological spikes

---

## HUD (`lib/hud/`)

All HUD is Canvas 2D or DOM overlays on top of the WebGL canvas.

| Component | File | Description |
|-----------|------|-------------|
| Main HUD | `overlays.js` | Moot count, score, timer, combo, ammo bar, target arrow + distance |
| Minimap | `minimap.js` | Canvas world overview, player position, moot dots |
| Rearview Mirror | `mirror.js` | Separate Three.js renderer; face reactions (happy/smug/angry/pained) |
| Speed Lines | `speedLines.js` | Radial motion blur during boost |
| Radio | `radio.js` | 3-channel music selector |

---

## Game State (`lib/game/state.js`)

Owns: score, ammo (capacitor charge), moot counts, combo, active target, session timer.

**Scoring:**
- Ram kill: 500 base × combo multiplier (1–8×)
- Combo window: 8s; resets on miss
- Target hit: +15s on session timer + new target spawns
- Target countdown: distance/speed scaled (min 20s, max ~60s)

**Timer warnings:** session timer < 10s → red flash; target countdown < 5s → alert

---

## Data & Backend (`lib/api.js`, `lib/data/`)

Moots are loaded from `data/moots.json` — an array of:
```json
{ "id": "...", "username": "...", "display_name": "...", "pfp_file": "...", "chibi_file": "...", "animated_file": "...", "rank": 0 }
```

Avatar textures are either static chibi sprites or MP4 video textures (animated). The backend API (kills, queue, auth) is called fire-and-forget — errors are swallowed so network failures never crash the game loop.

---

## Rewind (`lib/rewind/`)

5-second rewind system. Records vehicle state at 10Hz into a fixed-size ring buffer. Trigger with Q. Playback replays position/rotation/velocity. Does not rewind moot state.

---

## Deployment

```dockerfile
# Dockerfile: nginx:alpine, serves static files
docker compose up
```

`docker-compose.yml` maps port 80 to the nginx container. `.dockerignore` strips source data (Python scripts, CSVs, archives) from the image.

---

## Key Numbers at a Glance

| Thing | Value |
|-------|-------|
| World size | 3000m × 3000m |
| Max vehicle speed | 55 m/s (~198 km/h) |
| Terrain elevation max | 30 units |
| Highway deck height | 26m |
| Nav grid resolution | 2m cells |
| A* iteration cap | 50,000 cells |
| Active chunk radius | 750m |
| Chunk size | 64m |
| Rewind buffer | 5s @ 10Hz |
| Combo max | 8× |
| Combo window | 8s |
| Armed moot fraction | ~15% |
| LOS cache interval | 0.15s |
