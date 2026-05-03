# City Kit GLB Assets

Four Kenney 3D kits checked in as raw assets — **no loader code, no city-layout integration**. Use them when you build the city renderer.

## Contents

| Kit          | Building variants | Other                                                        |
| ------------ | ----------------- | ------------------------------------------------------------ |
| `commercial` | 14 + 5 skyscrapers | `detail-awning`, `detail-overhang`, `detail-overhang-wide` |
| `suburban`   | 14                | `tree-large`, `tree-small`, `fence-1x3`, `fence-2x2`, `planter` |
| `industrial` | 20                | `chimney-{small,medium,large}`, `detail-tank`              |
| `cars`       | 19 vehicles       | `cone`, `cone-flat`, `box`                                  |

Each kit has a single `Textures/colormap.png` that **every** GLB in that kit references — load the texture once and rebind it across all the GLBs to save GPU memory.

License: CC0 (Kenney Game Assets, Public Domain).

## Loading

Mirror the pattern in `crazy-cabbie/src/assets.js`. You need the `GLTFLoader` from `three/addons/loaders/GLTFLoader.js` (already in `index.html`'s importmap as `three/addons/`).

```js
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const loader = new GLTFLoader();
const sharedTex = await new THREE.TextureLoader()
  .loadAsync('./data/city-kits/commercial/Textures/colormap.png');
sharedTex.colorSpace = THREE.SRGBColorSpace;
sharedTex.flipY = false;        // GLTF UV convention

const gltf = await loader.loadAsync('./data/city-kits/commercial/building-a.glb');
rebindMaterials(gltf.scene, sharedTex);
scene.add(gltf.scene);
```

## ⚠ Rendering gotchas (read before you spend an afternoon debugging)

These kits **don't just work** with a stock `gltf.scene` add. Two real problems we hit:

### 1. Some submeshes render black

Authored materials are `MeshStandardMaterial` with vertex-colour and metalness data that interacts badly with valkyrie's renderer setup — even with full ambient + directional sun, large parts of buildings come out solid black.

**Two ways out:**

**(A) Convert to `MeshBasicMaterial`** — the colormap is already a baked palette so unlit rendering looks correct, and matches valkyrie's existing flat-shaded ground/road aesthetic:

```js
function rebindMaterials(scene, sharedTex) {
  const flat = new THREE.MeshBasicMaterial({ map: sharedTex });
  scene.traverse((n) => {
    if (n.isMesh) {
      n.material = Array.isArray(n.material)
        ? n.material.map(() => flat)
        : flat;
    }
  });
}
```

**(B) Keep `MeshStandardMaterial`** but add a `RoomEnvironment` cubemap (so metallic surfaces have something to reflect) and force `metalness=0` on materials that don't have a metalness map. Heavier setup; only worth it if you specifically want PBR shading on buildings.

### 2. Color-only materials don't pick up the texture

Many Kenney meshes ship with a `null` or solid-color material — they have UVs, they just never had `.map` set. `if (m.map) m.map = sharedTex` skips those and they render as flat grey. **Force-assign on every material** regardless:

```js
for (const m of mats) {
  if (!m) continue;
  m.map = sharedTex;
  if (m.color) m.color.setHex(0xffffff);
  m.needsUpdate = true;
}
```

### 3. Cached scene + level rebuilds = disposed materials

If you cache `gltf.scene` and hand out clones (cheap, recommended), and your scene-clearing code disposes materials on traversal, the next clone will reference disposed resources and crash. Tag clones so the cleanup pass skips them:

```js
clone.traverse((n) => { if (n.isMesh) n.userData.sharedAsset = true; });
```

…and in your scene-clearing code:

```js
if (child.isMesh && !child.userData?.sharedAsset) {
  child.geometry?.dispose();
  child.material?.dispose();
}
```

## Scale and orientation

Kenney natural scale is roughly **1 unit ≈ 1 metre** but cars are ~2 m and buildings are 2–6 m — undersized for valkyrie's road widths (10 m+). Practical scales:

- Buildings: `8–14×` (then aspect-fit to plot, capped)
- Vehicles: `1.5–2×`
- Trees: `12×`

Forward direction varies per asset — orient by hand with a small visual check, not by assumption.

## Reference implementations

- `crazy-cabbie/src/assets.js` (loader, shared texture per kit)
- `crazy-cabbie/src/city.js` (district zoning, instanced trees, parked cars)

## Bundled utility: `lib/world/city/roadMarkings.js`

This PR also drops in **`lib/world/city/roadMarkings.js`** — a standalone helper that paints yellow centre-dashes along every street and white crosswalk stripes at every intersection. **Nothing imports it yet** — it's opt-in. Wire it up in `generator.js` after the ground / road planes are added:

```js
import { buildRoadMarkings } from './roadMarkings.js';
// ...inside generateCity, after buildCityGround:
buildRoadMarkings(scene, xLines, zLines, intersections, bounds);
```

It works against develop's `generateCityLayout` output unchanged — the data shapes (`xLines`, `zLines`, `intersections {pos, widthX, widthZ}`, `bounds`) match. Caveat: it only paints the orthogonal grid streets. Develop's organic / planned / ramp-feeder roads and the highway mesh are not handled — extending coverage would mean teaching `roadMarkings.js` to walk arbitrary segment lists.

The geometry is fully instanced (one `InstancedMesh` for all dashes, one for all crosswalks), so total cost is two extra draw calls regardless of city size.

## History note

The earlier version of this PR included a full per-plot GLB prefab placement system in `lib/world/city/{prefabs,buildings,district,props}.js`. It was retired because develop's clankie sync rearchitected the city around InstancedMesh + zone-aware terrain-bound generation, which is incompatible with per-plot Group clones. If you want to revive it, plan a fresh integration against `generateCityLayout` / `generateCity` rather than rebasing.
