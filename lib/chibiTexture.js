import * as THREE from 'three';

const TEXTURE_SIZE = 256;
const PLACEHOLDER_COLOR = '#ff6a00';

let _placeholder = null;
function placeholderTexture() {
  if (_placeholder) return _placeholder;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  ctx.fillStyle = PLACEHOLDER_COLOR;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Tag so callers can detect a failed load and avoid caching the fallback.
  tex.isPlaceholder = true;
  _placeholder = tex;
  return tex;
}

// Drop pure chroma-key green, soften edges to avoid a halo, desaturate greenish
// fringe pixels so the cutout looks clean against any background.
export function chromaKeyInPlace(data) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const greenDominance = g - Math.max(r, b);
    if (greenDominance > 60 && g > 110) {
      data[i + 3] = 0;
    } else if (greenDominance > 25) {
      // soft edge: partial alpha, and pull the green channel down so the
      // remaining fringe pixel isn't visibly green against the scene.
      const t = (greenDominance - 25) / 35; // 0..1
      data[i + 3] = Math.round(data[i + 3] * (1 - t));
      data[i + 1] = Math.round(Math.max(r, b));
    }
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('load failed: ' + url));
    img.src = url;
  });
}

// Returns a Promise<THREE.CanvasTexture>. If the chibi is missing or fails to load,
// returns the bright-orange placeholder so the user can eyeball missing rows.
export async function loadChibiTexture(chibiFile) {
  if (!chibiFile) return placeholderTexture();
  const url = 'data/chibi_images/' + chibiFile;
  let img;
  try {
    img = await loadImage(url);
  } catch {
    return placeholderTexture();
  }
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  const imageData = ctx.getImageData(0, 0, TEXTURE_SIZE, TEXTURE_SIZE);
  chromaKeyInPlace(imageData.data);
  ctx.putImageData(imageData, 0, 0);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  return tex;
}
