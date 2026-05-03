/**
 * lib/hud/portrait.js — Boss portrait + HP bar HUD element.
 *
 * Renders a fixed top-right panel showing:
 *   - Boss avatar texture in a square frame
 *   - Boss name label
 *   - HP bar that accurately reflects boss.hp / BOSS.hp
 *
 * Panel is hidden when no boss is active (setBossHandle(null)).
 * HP bar transitions smoothly via CSS.
 *
 * Usage:
 *   const portrait = createBossPortrait();   // call after DOM is ready
 *   portrait.update(bossHandle);             // call every frame (or every 4th)
 *   portrait.destroy();                      // cleanup
 */

import { BOSS } from '../config.js';

const PORTRAIT_SIZE = 64; // px — avatar square
const BAR_WIDTH = 120; // px — HP bar width

/**
 * Create and mount the boss portrait panel.
 * Returns { update(bossHandle|null), destroy() }.
 */
export function createBossPortrait() {
  // ── Inject styles ──────────────────────────────────────────────────────────
  const style = document.createElement('style');
  style.id = 'boss-portrait-style';
  style.textContent = `
    #boss-portrait {
      position: fixed;
      top: 16px;
      right: 16px;
      display: none;
      flex-direction: row;
      align-items: center;
      gap: 10px;
      background: rgba(0, 0, 0, 0.62);
      border: 1.5px solid rgba(255, 80, 80, 0.55);
      border-radius: 4px;
      padding: 8px 12px 8px 8px;
      pointer-events: none;
      z-index: 910;
      font-family: monospace;
    }
    #boss-portrait.active { display: flex; }
    #boss-avatar-frame {
      width: ${PORTRAIT_SIZE}px;
      height: ${PORTRAIT_SIZE}px;
      border: 1.5px solid rgba(255, 80, 80, 0.7);
      border-radius: 3px;
      overflow: hidden;
      flex-shrink: 0;
      background: rgba(30, 10, 10, 0.8);
    }
    #boss-avatar-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    #boss-info {
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-width: ${BAR_WIDTH}px;
    }
    #boss-name {
      font-size: 11px;
      color: #ff6060;
      letter-spacing: 2px;
      text-transform: uppercase;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: ${BAR_WIDTH}px;
      text-shadow: 0 0 6px rgba(255, 60, 60, 0.5);
    }
    #boss-hp-label {
      font-size: 10px;
      color: #aaa;
      letter-spacing: 1px;
    }
    #boss-hp-bar {
      width: ${BAR_WIDTH}px;
      height: 10px;
      background: rgba(255, 255, 255, 0.1);
      border: 1px solid rgba(255, 80, 80, 0.4);
      border-radius: 2px;
      overflow: hidden;
    }
    #boss-hp-fill {
      height: 100%;
      width: 100%;
      background: linear-gradient(90deg, #cc2222, #ff4444 60%, #ff8888);
      transition: width 120ms ease;
      border-radius: 1px;
    }
  `;
  document.head.appendChild(style);

  // ── Build DOM ──────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.id = 'boss-portrait';
  panel.innerHTML = `
    <div id="boss-avatar-frame">
      <img id="boss-avatar-img" src="" alt="boss" />
    </div>
    <div id="boss-info">
      <div id="boss-name">BOSS</div>
      <div id="boss-hp-label">HP</div>
      <div id="boss-hp-bar">
        <div id="boss-hp-fill"></div>
      </div>
    </div>
  `;
  document.body.appendChild(panel);

  const els = {
    panel: panel,
    avatarImg: panel.querySelector('#boss-avatar-img'),
    name: panel.querySelector('#boss-name'),
    hpFill: panel.querySelector('#boss-hp-fill'),
    hpLabel: panel.querySelector('#boss-hp-label'),
  };

  // Track last texture so we don't thrash the src attribute.
  let lastTextureSrc = null;

  /**
   * Update the portrait display.
   * Pass the boss moot handle (or null to hide).
   *
   * @param {object|null} bossHandle
   */
  function update(bossHandle) {
    if (!bossHandle || !bossHandle.alive) {
      els.panel.classList.remove('active');
      return;
    }

    els.panel.classList.add('active');

    // ── HP bar ───────────────────────────────────────────────────────────────
    const maxHp = BOSS.hp; // 100
    const hp = Math.max(0, bossHandle.hp ?? maxHp);
    const pct = (hp / maxHp) * 100;
    els.hpFill.style.width = `${pct}%`;
    els.hpLabel.textContent = `HP  ${hp} / ${maxHp}`;

    // ── Name ─────────────────────────────────────────────────────────────────
    const displayName = bossHandle.mootRow?.display_name ?? 'BOSS';
    els.name.textContent = displayName;

    // ── Avatar texture ───────────────────────────────────────────────────────
    // avatarMat.map is a THREE.Texture whose image may be an HTMLImageElement
    // or HTMLVideoElement. We grab the source URL to populate the <img>.
    const map = bossHandle.avatarMat?.map;
    if (map) {
      const img = map.image;
      let src = null;
      if (img) {
        if (img.src)
          src = img.src; // HTMLImageElement
        else if (img.currentSrc) src = img.currentSrc; // HTMLVideoElement
      }
      if (src && src !== lastTextureSrc) {
        els.avatarImg.src = src;
        lastTextureSrc = src;
      }
    }
  }

  function destroy() {
    if (panel.parentNode) panel.parentNode.removeChild(panel);
    if (style.parentNode) style.parentNode.removeChild(style);
  }

  return { update, destroy };
}

/**
 * Standalone helper: update boss HP bar from outside (e.g. in updateHud).
 * Safe to call before createBossPortrait().
 *
 * @param {number} hp
 * @param {number} [maxHp]
 */
export function updateBossHpBar(hp, maxHp = BOSS.hp) {
  const fill = document.getElementById('boss-hp-fill');
  const label = document.getElementById('boss-hp-label');
  if (!fill) return;
  const pct = Math.max(0, (hp / maxHp) * 100);
  fill.style.width = `${pct}%`;
  if (label) label.textContent = `HP  ${Math.max(0, hp)} / ${maxHp}`;
}
