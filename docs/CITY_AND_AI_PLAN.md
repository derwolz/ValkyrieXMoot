# City Generator + Moot AI Plan

Replaces the straight-corridor world in `lib/world/ground.js` and `lib/world/buildings.js`
with a procedurally generated small city, gives moots ambient pedestrian behavior, and
adds an alert/flee/armed/recovery state machine so they don't run forever.

## Three pillars

1. **City** — non-grid streets + alleys + sidewalks + building footprints
2. **Navigation** — one shared nav grid. Truck CAN drive alleys but may wedge itself
   on tight turns; moots are guaranteed reachable space everywhere they spawn. Asymmetric
   meshes (truck-mesh ≠ moot-mesh) were considered and rejected — they make moots flee
   into pockets the truck can't follow but might also have edge-case orphaned cells.
3. **AI** — `unaware → alarmed-(flee|armed) → recovering → unaware`

## Non-goals (this pass)

- Traffic (cars on the streets)
- Day/night
- Multiple districts with distinct visual styles
- Recast/Detour. Uniform grid + A* is plenty at this scale.

## Module layout

```
lib/
  world/
    city/
      generator.js      ← orchestrator
      roads.js          ← perturbed grid + alley pass
      blocks.js         ← BSP subdivide block polygons into plots
      buildings.js      ← place footprints (replaces lib/world/buildings.js)
      sidewalks.js      ← sidewalk strip geometry
      intersections.js  ← intersection / crossing nodes
    ground.js           ← scale to city bounds
  nav/
    grid.js             ← uniform-cell walkable + cost grid
    pathfind.js         ← A* (octile heuristic, pooled open/closed sets)
  ai/
    perception.js       ← per-moot threat sensing (LOS, distance, events)
    states.js           ← state enum + transition table
    ambient.js          ← unaware behavior
    flee.js             ← alarmed-flee
    armed.js            ← alarmed-armed
    recovery.js         ← decay back to unaware
  hud/
    radar.js            ← top-down minimap overlay
  entities/
    moots.js            ← +state, +path, +perception, +collision radius
```

## Phase 0 — Generator skeleton (non-breaking)

Add `lib/world/city/generator.js` that returns the same shape `main.js` already needs,
but for a single-block "city". Swap-in without touching `main.js`.

Output bundle:
```js
{
  roadSegments,   // [{ a:{x,z}, b:{x,z}, width, kind: 'street'|'alley' }]
  intersections,  // [{ pos:{x,z}, segmentIds:[…] }]
  sidewalkPolys,  // [{ contour:[{x,z}, …] }]
  buildingAABBs,  // existing shape — main.js consumes today
  interestPoints, // [{ x, z, kind: 'corner'|'crossing'|'doorway' }]
  bounds,         // { minX, minZ, maxX, maxZ }
}
```

`buildBuildings()` becomes a thin adapter that calls `generateCity()` and returns
just `buildingAABBs` until Phase 1 lands.

## Phase 1 — Real city layout

### Algorithm: perturbed grid + alley pass

1. **Primary streets** — 4–7 × 4–7 arterial grid. Each grid line jittered ±15% in
   position and ±10° in heading. Width 8–12 m.
2. **Alley pass** — for every block longer than ~30 m, insert one alley parallel
   to the long side at a 35–65% offset. Width 3–4 m.
3. **Block extraction** — find closed polygons formed by the segment graph; each
   polygon is a "block".
4. **Plots** — BSP-split each block: pick the longest edge, split perpendicular
   at 40–60%, recurse until area < threshold. One footprint per leaf, inset
   0.5 m from plot edges. Random height 4–25 m.
5. **Sidewalks** — 2 m strip along every road, snapped between road edge and
   building setback line.

**Why not Voronoi for streets**: produces wedge intersections, hard to tag
alleys vs streets cleanly. Keep Voronoi as a Phase 7 option for *district*
partitioning (different block-size / alley-density per district).

**Why not full Citygen agent-based road growth yet**: 5× the code. Defer to
Phase 7 if perturbed grid feels too regular.

### Why alleys are truck-drivable

Per the "moots never get stuck due to nav asymmetry" decision: nav grid is
shared. Alley tightness becomes a *physics* punishment (turning radius +
collision wedges the truck) rather than a *navigation* prohibition. Moots
prefer alleys when fleeing because cost is lower (see Phase 2), not because
the truck can't enter them.

## Phase 2 — Single nav grid

One uniform grid over the city bounds.

- Cell size: 0.5 m (tunable; 200×200 m city → 400×400 = 160k cells).
- **Walkable**: cell center on road, alley, sidewalk, or intersection AND not
  inside any building AABB inflated by `mootRadius`.
- **Cost multiplier** per cell:
  - sidewalk: 1.0
  - road (along): 1.0
  - road crossing (intersection cell flagged crossing): 1.3
  - alley: **0.7** ← makes flee paths prefer alleys
- A* in `lib/nav/pathfind.js` with octile heuristic; preallocate open/closed
  arrays, reuse across plans. Cap to N replans per frame (round-robin) so a
  burst of state changes doesn't spike frame time.

The truck does **not** pathfind. It still uses `resolveBuildingCollisions`
against `buildingAABBs` exactly as today. The grid is for moot AI only.

### Moot ↔ wall collision

Today only the truck collides. Add a small movement helper used by every state:
circle-vs-AABB resolution against `buildingAABBs` with `moot.collisionRadius`
(≈ 0.4 m). All states (`ambient`, `flee`, `armed`) call it after computing
desired velocity.

## Phase 3 — Unaware state (ambient pedestrians)

Each moot starts `unaware`:
- Picks a destination from `interestPoints` 30–100 m away on the nav grid
- Pathfinds, walks the path at 1.2 m/s
- On arrival, picks another destination
- Crossing intersections: just walks the path; intersection cells already have
  the elevated cost so paths naturally prefer along-sidewalk routes.

No truck-awareness yet — perception comes online in Phase 4.

`lib/ai/ambient.js` exports `tickUnaware(dt, moot, ctx)` where `ctx` carries
the nav grid, AABBs, interest points.

## Phase 4 — Perception + transitions

`lib/ai/perception.js` runs per moot per frame (or every other frame,
round-robin to amortize raycasts).

Threat score (0..1, decays −0.4/s when no input):

| Signal                                              | Add  |
|-----------------------------------------------------|------|
| Truck within 25 m AND has LOS                       | +0.6 |
| Truck within 8 m regardless of LOS                  | +0.8 |
| Truck velocity toward moot > 6 m/s                  | +0.3 |
| A moot was killed within 15 m in last 4 s           | +0.5 |
| Heard gunshot within 30 m                           | +0.3 |

LOS = single raycast against `buildingAABBs` (cheap, top-down 2D segment vs
AABB list).

Transitions:
- `unaware` + threat ≥ 0.5 → `alarmed-flee` (or `alarmed-armed` if `moot.armed`)
- `alarmed-*` + threat < 0.15 for 5 s + truck dist > 50 m → `recovering`
- `recovering` + 8 s elapsed without re-alarm → `unaware`
- `recovering` + threat ≥ 0.5 → back to `alarmed-*` immediately

The "they flee forever" bug = recovering state never existed. This phase
adds it.

**Boss exception**: the boss skips this perception system entirely. Once the
player enters its detect radius once, aggro is permanent — see Phase 9.

## Phase 5 — Flee + armed + recovery behaviors

### `alarmed-flee`
- Goal node = nav cell that maximizes `(distance from truck) − 0.5×(distance from moot)`,
  sampled from a ring 30–60 m from the moot, prefer cells whose path crosses
  alley-cost cells.
- Replan every 0.5–1.0 s while truck is in sight.
- Run speed 4.5 m/s.
- Existing `updateMootFlee` is the seed for this — port its math into `flee.js`.

### `alarmed-armed`
- Stop, face truck, fire — `updateMootGunfire` already does this; just gate
  it on state.
- If truck closes within 6 m: drop to `alarmed-flee`.
- If truck loses LOS for 2 s: hold position 1 s then `recovering`.

### `recovering`
- Walk (not run) to nearest interest point.
- Glance back: every 1 s, if truck has LOS, threat += 0.2 (so it'll re-alarm).
- After 8 s clean → `unaware`, pick a new ambient destination.

**Boss exception**: boss never enters `recovering`. See Phase 9.

## Phase 6 — Radar HUD

`lib/hud/radar.js` — canvas2D overlay, ~140×140 px, bottom-right corner.

- Truck = center, points up
- Moot dot per state:
  - gray   = unaware
  - yellow = alarmed-flee
  - red    = alarmed-armed
  - green  = recovering (fading)
- Range 40 m, fade dots near edge
- Render every 4–5 frames

## Phase 7 — Optional polish

- Voronoi over the city seed → district regions, varied block size /
  alley density / building height range per district.
- Citygen-style agent road growth if the perturbed grid feels too regular.
- Crowd density variation by district.
- Per-state animation hooks on `mootHandles[i]` (idle bob vs run vs cower).

## Phase 8 — Standing population manager

Replaces the corridor-era "spawn N moots once and forget" model. The city has
a *steady-state* population around the player; far moots despawn, fresh ones
spawn nearby. Death triggers an immediate respawn elsewhere — net population
is constant.

### Constants (`lib/config.js → POP`)

```js
POP = {
  standing: 60,            // active moot count
  despawnRadius: 300,      // m — moots beyond this are removed
  spawnRingMin: 150,       // m — new moots appear in [min, max] from player
  spawnRingMax: 250,
  spawnVisCheck: true,     // skip cells visible to camera (avoid pop-in)
  tickHz: 2,               // run despawn/spawn pass twice per second
};
```

### Spawn

- Pick random sidewalk `interestPoint` within `[spawnRingMin, spawnRingMax]`
  of the player.
- If `spawnVisCheck`: rejection-sample if the point is in camera frustum AND
  not occluded by buildings (keeps spawn out of view).
- Pick a moot row from `db.regulars` (db partitioned at level start, see
  Phase 9). Cycle through the pool so the same row doesn't reappear in
  rapid succession.

### Despawn

- Tick at `POP.tickHz`, not every frame.
- Remove any non-boss moot beyond `despawnRadius` from the player.
- Return its `mootHandle` to the resource pool.

### Death respawn

- HP → 0 ⇒ despawn at next tick AND queue a respawn at a fresh location.
- Boss is exempt — boss death = victory, not respawn.

### Resource pool

- Pre-allocate `POP.standing + 8` `mootHandle` records (geometry, materials).
- On despawn: reset transform, hide, return to pool.
- On spawn: pull from pool, swap avatar texture, place at world coords,
  insert into active set.

### Bootstrap order (replaces Phase 1's "place all moots in a corridor")

1. Generate city
2. Pick player spawn (random sidewalk node near a map edge)
3. Pick boss spawn (Phase 9 rule — halfway to opposite edge)
4. Initialize pool, spawn `POP.standing` regulars in the spawn ring
5. Spawn the boss at its computed point
6. Begin loop

## Phase 9 — Boss target + level loop

### Boss as a tuned moot

Same code path as regulars, with overrides:

| Field            | Boss value                                |
|------------------|-------------------------------------------|
| `hp`             | `BOSS.hp = 100`                           |
| `scale`          | `1.5×` regular                            |
| `tint`           | red multiplier on avatar material         |
| `armed`          | always true                               |
| `state`          | locked: never `unaware`, never `recovering` |
| `respawn`        | never (death = victory)                   |
| `pool`           | excluded from `db.regulars`               |

### Aggro model — distance only, never breaks

User intent: "lose sight is determined by distance, not by line of sight",
"the boss will try to give chase until they lose sight, but they will never
lose agro".

- Once the player enters `BOSS.detectRadius` (suggest 80 m): aggro = true,
  permanent. Aggro is a one-way latch.
- Two sub-modes while aggroed (no LOS check anywhere):
  - **Engage** — player within `BOSS.engageRadius` (60 m): kite + fire.
    Maintain `BOSS.kiteDistance` ≈ 25 m (back away if too close, hold if at
    range, advance if too far). Replan every 0.5 s. Fire on existing gunfire
    cadence.
  - **Pursue** — player beyond `engageRadius`: path along nav grid toward
    last known player position. Replan every 1.0 s. No firing.
- The "lost sight" the user described is just `dist > engageRadius` — boss
  pursues, doesn't disengage.

### Spawn placement

- At generator time, after picking player spawn:
  - Find nearest map edge from player spawn → unit vector
  - Boss spawn = player spawn + 0.5 × (edge − player spawn), snapped to
    nearest sidewalk nav cell
  - Reject if not on a valid walkable cell — search outward for nearest valid
    cell.

### Damage rules

- Pistol: `PISTOL.damage = 10` (boss takes 10 hits)
- Ram: `RAM.damage = clamp(speed * k, 0, 50)` (tune later, never one-shots)
- Damage applies to boss the same as regulars, except:
  - **Ramming the boss does not refund ammo** (special case in the ram refund path)

### Ammo economy (codified)

The whole-joke rule from the user:

| Action            | Ammo effect                |
|-------------------|----------------------------|
| Shoot (any)       | `ammo -= 1` always         |
| Ram regular       | `ammo += AMMO.ramRefund`   |
| Ram boss          | no change                  |
| Anything else     | no change                  |

No pickups, no regen, no other source. Out-of-ammo is fine — player can still
ram. (Out-of-ammo + boss = the player must eat ram damage to refill on
regulars, then come back.)

### Health & capacitors (clarifying existing mechanic)

User: "no health recovery. They have to fill a capacitor and that only gives
them one health back after they are killed."

This matches the existing rewind: `game.capacitors > 0` + death → rewind to
before the kill = effectively 1 HP back. Treat the existing
`recorder`/`playback` system as the implementation. Filling a capacitor
should be tied to kills (current rule presumably already does this — verify
in `lib/game/state.js` during Phase 9 work).

### Identification

- HUD portrait: top-right boss avatar + HP bar (`lib/hud/portrait.js`,
  styling TBD)
- Radar: distinct dot — flashing red, larger
- In-world: 1.5× scale and red tint already make the boss visibly distinct
  in a crowd at close-to-medium range
- (Optional later: directional arrow on the radar edge when boss is off-radar)

### Level transitions

- `boss.hp <= 0` → `game.state = 'victory'`
- Play victory animation (camera pull-back / slow-mo / TBD art pass)
- After delay → `nextLevel()`:
  - Dispose city geometry, nav grid, mesh pool
  - Increment seed
  - Generate new city, pick spawns, spawn population, place new boss
  - **Carry forward**: ammo count, capacitor count, collection list
  - **Reset**: HP to full, boss-related state

### Boss row selection

- DB partition at level start: `{ boss: rowX, regulars: db \ rowX }`
- (Optional) eligibility filter: e.g. only rows with `has_chibi`, or a
  curated `boss_eligible` flag
- Track recent boss rows in localStorage so the same moot isn't boss two
  levels in a row.

### City sizing — note on the 2-mile target

User target: ~2 miles (3.2 km). Memory + perf caveats:

| Cell size | Cells (2 mi)    | walkable (bytes) | costMul (Float32) | Verdict   |
|-----------|-----------------|------------------|-------------------|-----------|
| 0.5 m     | 41 M            | 41 MB            | 164 MB            | infeasible|
| 1.0 m     | 10 M            | 10 MB            | 41 MB             | borderline|
| 1.5 m     | 4.6 M           | 4.6 MB           | 18 MB             | OK        |
| 2.0 m     | 2.6 M           | 2.6 MB           | 10 MB             | comfortable|

Recommendation: at 2-mile scale, nav cells must be ≥ 1.5 m. Building meshes
must be instanced and frustum-culled or drawcalls explode.

**Suggested rollout**: prototype at **1 km × 1 km** (boss ~500 m from
player — already feels big in a Three.js game). Validate AI, despawn loop,
nav grid perf there. Scale toward 2 miles once perf is proven; that scale-up
becomes a Phase 7 polish item.

## Extended moot record

```js
{
  // existing
  group, avatarMat, position, armed, …
  // new
  state: 'unaware' | 'alarmed-flee' | 'alarmed-armed' | 'recovering',
  threat: 0,                 // 0..1
  path: [],                  // [{x,z}, …] in world coords
  pathIndex: 0,
  destination: null,         // {x,z} or null
  lastReplanAt: 0,
  lastSeenTruckAt: 0,        // ms
  stateEnteredAt: 0,
  collisionRadius: 0.4,
}
```

## Nav grid record

```js
{
  cellSize: 0.5,
  cols, rows,
  origin: { x, z },          // world-space position of cell (0,0) center
  walkable: Uint8Array,      // cols*rows, 0 = blocked
  costMul: Float32Array,     // 1.0 default, 0.7 alley, 1.3 crossing
  interestPoints: [{ x, z, kind }],
}
```

## Decisions (resolved)

1. **City size.** Prototype at **1 km × 1 km**, scale toward 2 miles in Phase 7
   once perf is validated. See Phase 9 sizing table.
2. **Moot count.** Flat **`POP.standing = 60`** active moots. Despawn beyond
   300 m, respawn in 150–250 m ring. `GAME.sessionMoots` (corridor-era) goes
   away — it's superseded by Phase 8.
3. **Truck spawn.** Random sidewalk node near a map edge (chosen at level
   generation time).
4. **Boss spawn.** Halfway from player spawn toward the nearest opposite
   edge, snapped to nearest sidewalk cell.
5. **Loading.** Generator + nav grid bake + initial 60-moot spawn must finish
   before play. Profile after Phase 8 (1 km scale should be fine).
6. **Seed.** `?seed=` URL param at minimum; level system manages seeds across
   levels (`seed += 1` on `nextLevel`).

## Files this plan creates / modifies

**Create:**
- `lib/world/city/{generator,roads,blocks,buildings,sidewalks,intersections}.js`
- `lib/nav/{grid,pathfind}.js`
- `lib/ai/{perception,states,ambient,flee,armed,recovery,boss}.js`
- `lib/world/population.js` — Phase 8 standing population manager
- `lib/game/levels.js` — Phase 9 level seed + transition logic
- `lib/hud/radar.js`
- `lib/hud/portrait.js` — Phase 9 boss portrait + HP bar

**Modify:**
- `main.js` — call generator instead of `buildBuildings`; install nav grid;
  AI dispatch replaces direct `updateMootFlee` / `updateMootGunfire` calls;
  population manager tick; level transition wiring
- `lib/entities/moots.js` — extended record (state, path, perception, hp,
  scale, tint, isBoss)
- `lib/game/state.js` — `victory` state, ammo refund rule (no refund on boss
  ram), `nextLevel` action
- `lib/config.js` — `CITY`, `NAV`, `AI`, `POP`, `BOSS`, `AMMO`, `RAM` blocks

**Delete after Phase 1 lands:**
- `lib/world/buildings.js` (replaced by `lib/world/city/buildings.js`)

## Suggested commit cadence

- Phase 0: 1 commit (generator skeleton + adapter)
- Phase 1: 2–3 commits (roads, then blocks/buildings, then sidewalks)
- Phase 2: 1 commit (nav grid + A* + moot collision)
- Phase 3: 1 commit (ambient state)
- Phase 4: 1 commit (perception + transitions)
- Phase 5: 1 commit (flee/armed/recovery behaviors)
- Phase 6: 1 commit (radar)
- Phase 7: as-needed (polish)
- Phase 8: 1 commit (population manager + spawn ring + death respawn)
- Phase 9: 2–3 commits (boss state + ammo rules; level transition;
  HUD portrait)

Each phase should leave the game runnable. Phase 0 in particular must produce
a world that's visually identical to today.
