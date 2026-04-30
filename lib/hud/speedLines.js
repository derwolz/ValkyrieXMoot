/**
 * lib/hud/speedLines.js — anime-style radial speed lines overlay.
 *
 *   createSpeedLines()       — call once after DOM ready
 *   setSpeedLinesActive(on)  — toggle the effect
 */

let el = null;

export function createSpeedLines() {
  if (el) return;

  const style = document.createElement('style');
  style.textContent = `
    #speed-lines {
      position: fixed; inset: 0;
      pointer-events: none;
      z-index: 9;
      opacity: 0;
      transition: opacity 140ms ease;
      background: repeating-conic-gradient(
        from 0deg at 50% 50%,
        rgba(255,255,255,0.95) 0deg 0.7deg,
        transparent 0.7deg 6deg
      );
      -webkit-mask-image: radial-gradient(circle at 50% 50%, transparent 22%, rgba(0,0,0,0.6) 50%, #000 75%);
              mask-image: radial-gradient(circle at 50% 50%, transparent 22%, rgba(0,0,0,0.6) 50%, #000 75%);
      mix-blend-mode: screen;
      will-change: opacity, transform;
      transform-origin: 50% 50%;
    }
    #speed-lines.active {
      opacity: 1;
      animation: speed-lines-flicker 90ms steps(2) infinite;
    }
    @keyframes speed-lines-flicker {
      0%   { transform: rotate(0deg)    scale(1.00); }
      50%  { transform: rotate(2.6deg)  scale(1.04); }
      100% { transform: rotate(-1.8deg) scale(1.00); }
    }
  `;
  document.head.appendChild(style);

  el = document.createElement('div');
  el.id = 'speed-lines';
  document.body.appendChild(el);
}

export function setSpeedLinesActive(on) {
  if (!el) return;
  el.classList.toggle('active', !!on);
}
