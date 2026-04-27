import * as THREE from 'three';

const PALETTE = [
  '#3a3f4b', '#4a3a3a', '#5c4e3a', '#3e4a4a', '#554a5c',
  '#2e343d', '#4a4640', '#46504a', '#3d3645', '#5c513e',
];

// `rand` is an injected PRNG (`() => [0,1)`) so building layouts are stable per seed.
export function makeBuildingTexture(rand, widthPx = 256, heightPx = 512) {
  const canvas = document.createElement('canvas');
  canvas.width = widthPx;
  canvas.height = heightPx;
  const ctx = canvas.getContext('2d');

  // Facade base
  ctx.fillStyle = PALETTE[Math.floor(rand() * PALETTE.length)];
  ctx.fillRect(0, 0, widthPx, heightPx);

  // Roof band
  ctx.fillStyle = '#15181d';
  ctx.fillRect(0, 0, widthPx, 18);

  // Entrance strip at bottom
  ctx.fillStyle = '#1c1f25';
  ctx.fillRect(0, heightPx - 28, widthPx, 28);

  // Window grid
  const cols = 3 + Math.floor(rand() * 3);
  const winW = Math.floor((widthPx / cols) * 0.55);
  const winH = 24;
  const gapY = 38;
  const startY = 32;
  const litProb = 0.25 + rand() * 0.35;
  for (let y = startY; y < heightPx - 40; y += gapY) {
    for (let c = 0; c < cols; c++) {
      const x = Math.floor((widthPx / cols) * (c + 0.5) - winW / 2);
      const lit = rand() < litProb;
      ctx.fillStyle = lit ? '#ffd66b' : '#10131a';
      ctx.fillRect(x, y, winW, winH);
      if (lit) {
        // subtle inner glow
        ctx.fillStyle = 'rgba(255, 214, 107, 0.18)';
        ctx.fillRect(x - 2, y - 2, winW + 4, winH + 4);
        ctx.fillStyle = '#ffd66b';
        ctx.fillRect(x, y, winW, winH);
      }
    }
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
}
