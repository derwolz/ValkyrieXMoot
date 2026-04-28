/**
 * lib/game/state.js — game state machine and all gameplay logic.
 *
 * createGameState(deps) → game state object + action functions.
 *
 * Owns: game object, splatMoot, damagePlayer, triggerRewind,
 *       handleGameOver, restartGame, ramMoots, tryShoot,
 *       crashCooldown, rewindSavedHealth, currentPlayer, SESSION_ID.
 */

import { GAME, MIRROR, BOSS, LEVEL } from '../config.js';
import { detectRams } from '../entities/moots.js';
import { setFace } from '../hud/mirror.js';
import { setGameOverVisible, showRewindFlash, showLoginPrompt, showQueueSuccess, setVictoryVisible } from '../hud/overlays.js';
import { postKill, postQueue } from '../api.js';

/**
 * @typedef {{
 *   state: 'playing'|'gameover'|'rewinding'|'victory',
 *   charge: number,
 *   capacitors: number,
 *   health: number,
 *   mootsAlive: number,
 *   mootsTotal: number,
 * }} GameState
 */

/**
 * @typedef {{
 *   scene: import('three').Scene,
 *   vehicle: import('../car/vehicle.js').Vehicle,
 *   recorder: ReturnType<import('../rewind/recorder.js').createRecorder>,
 *   getPlayback: () => ReturnType<import('../rewind/playback.js').createPlayback>|null,
 *   getMootHandles: () => object[],
 *   getSessionMoots: () => import('../data/mootLoader.js').MootRow[],
 *   impactSystem: ReturnType<import('./impacts.js').createImpactSystem>,
 *   pistol: import('../weapons/pistol.js').Pistol,
 *   updateHud: (game: GameState) => void,
 * }} GameDeps
 */

/**
 * @param {GameDeps} deps
 */
export function createGameState(deps) {
  const {
    scene, vehicle, recorder, getPlayback,
    getMootHandles, getSessionMoots,
    impactSystem, pistol, updateHud,
  } = deps;
  // deps is kept in scope so splatMoot can call deps.onSplatMoot if present.

  /** @type {GameState} */
  const game = {
    state: 'playing',
    charge: GAME.startCharge,
    capacitors: 0,
    health: GAME.maxHealth,
    mootsAlive: 0,
    mootsTotal: 0,
  };

  // Unique session ID for this page load, used to group kills into one run.
  const SESSION_ID = Math.random().toString(36).slice(2);

  // Resolved on startup via GET /auth/me; null = not logged in.
  let currentPlayer = null;

  let crashCooldown     = 0;
  let rewindSavedHealth = 0;

  // ── Core actions ────────────────────────────────────────────────────────────

  function splatMoot(handle, weapon = 'ram') {
    if (!handle.alive) return;

    // ── Damage model for boss ────────────────────────────────────────────────
    if (handle.isBoss) {
      const dmg = weapon === 'shot' ? BOSS.pistolDamage : BOSS.ramDamage;
      handle.hp = (handle.hp || BOSS.hp) - dmg;
      if (handle.hp > 0) {
        // Boss took damage but survives — visual feedback only, no state change.
        impactSystem.spawnImpact(handle.group.position, 0xff4444, 1.2);
        return;
      }
      // Boss dies — fall through to normal death path.
    }

    handle.alive = false;
    impactSystem.spawnImpact(handle.group.position, 0xd04040, 2.2);
    // Only remove the group from the scene here for the boss — regular moots
    // are removed by _despawn() inside population.notifyDeath(), which is
    // called immediately below.  Removing twice is a silent no-op in Three.js
    // but wastes a traversal and signals confused ownership.
    if (handle.isBoss) scene.remove(handle.group);
    game.mootsAlive--;
    if (currentPlayer && handle.mootRow) {
      postKill(
        handle.mootRow,
        weapon,
        { x: handle.group.position.x, z: handle.group.position.z },
        SESSION_ID,
      );
    }
    // Notify population manager of death so it queues a respawn.
    if (deps.onSplatMoot) deps.onSplatMoot(handle, weapon);

    // Boss death triggers victory.
    if (handle.isBoss) {
      const timeoutId = triggerVictory();
      if (deps.onVictoryTimeout) deps.onVictoryTimeout(timeoutId);
    }
  }

  function triggerRewind() {
    if (game.capacitors <= 0) {
      setFace('angry', MIRROR.angryMs);
      return;
    }
    game.capacitors--;
    rewindSavedHealth = Math.max(1, game.health);
    game.state = 'rewinding';
    showRewindFlash();
    const playback = getPlayback();
    if (playback) {
      const history = recorder.getHistory();
      playback.start(history);
    }
    updateHud(game);
  }

  function damagePlayer() {
    if (game.state !== 'playing' || game.health <= 0) return;
    game.health--;
    if (game.health <= 0) {
      if (game.capacitors > 0) {
        triggerRewind();
      } else {
        game.state = 'gameover';
        setFace('panicked');
        // Use deps.onRestart if provided (routes through buildCity in main.js)
        // so restartGame in this module doesn't need to touch scene state.
        const restartCb = deps.onRestart || restartGame;
        setGameOverVisible(true, restartCb);
        handleGameOver();
      }
    } else {
      setFace('pained', 600);
    }
  }

  async function handleGameOver() {
    if (!currentPlayer) {
      showLoginPrompt();
      return;
    }
    await postQueue();
    // Guard: by the time the async chain resolves the player may have already
    // restarted (state transitioned out of 'gameover').  Only show the success
    // banner if we are still in the gameover state.
    if (game.state === 'gameover') {
      showQueueSuccess(currentPlayer.handle);
    }
  }

  function restartGame() {
    // Legacy resurrect loop removed.
    // Main calls buildCity(levelManager.currentSeed) on the keydown handler;
    // this stub is kept so any outstanding references don't throw.
  }

  function ramMoots(handles) {
    const rammed  = detectRams(vehicle, handles);
    if (rammed.length === 0) return;
    for (const h of rammed) {
      const wasBoss = h.isBoss;
      splatMoot(h, 'ram');
      if (!wasBoss && !h.alive) {
        // Only regular moot kills refund charge.
        if (game.charge >= GAME.maxCharge) {
          if (game.capacitors < GAME.maxCapacitors) {
            game.capacitors++;
            game.charge = 0;
          }
        } else {
          game.charge = Math.min(GAME.maxCharge, game.charge + GAME.chargePerRam);
        }
      }
      // Boss ram: deal damage (done in splatMoot) but NO charge refund.
    }
    vehicle.speed *= 0.95;
    if (rammed.length > 1) setFace('celebrating', MIRROR.celebratingMs);
    else setFace('happy', MIRROR.happyMs);
  }

  function tryShoot(aim) {
    if (game.charge < GAME.firingCost) {
      setFace('angry', MIRROR.angryMs);
      return false;
    }
    if (!pistol.tryFire()) return false;
    game.charge -= GAME.firingCost;
    impactSystem.spawnImpact(aim.point, 0xffaa55, 1.4);
    let o = aim.object, hitMoot = false;
    while (o) {
      if (o.userData && o.userData.mootHandle) {
        const target = o.userData.mootHandle;
        splatMoot(target, 'shot');
        hitMoot = true;
        // Boss tanked the shot (still alive) — smug face already set below;
        // no second call here.
        break;
      }
      o = o.parent;
    }
    if (hitMoot) setFace('smug', MIRROR.smugMs);
    return true;
  }

  function tickCrashCooldown(dt, hit, preSpeed) {
    if (
      hit &&
      crashCooldown <= 0 &&
      preSpeed > GAME.crashSpeedThreshold &&
      hit.intensity > GAME.crashIntensityThreshold
    ) {
      damagePlayer();
      crashCooldown = GAME.crashDamageCooldownSec;
    }
    if (crashCooldown > 0) crashCooldown -= dt;
  }

  function onRewindDone() {
    game.health = rewindSavedHealth;
    game.state  = 'playing';
    vehicle.speed = 0;
    updateHud(game);
  }

  function onMootBulletHit() {
    damagePlayer();
  }

  function setCurrentPlayer(player) {
    currentPlayer = player;
  }

  /**
   * Trigger victory state when the boss dies.
   * Carries forward: ammo (charge) and capacitors.
   * Resets: health to maxHealth.
   * After LEVEL.victoryDelayMs, calls deps.onVictory() if provided.
   */
  function triggerVictory() {
    if (game.state === 'victory') return null;
    game.state = 'victory';
    // Health resets; charge + capacitors carry over.
    game.health = GAME.maxHealth;
    setVictoryVisible(true);
    updateHud(game);

    if (deps.onVictory) {
      const id = setTimeout(() => {
        setVictoryVisible(false);
        deps.onVictory({ charge: game.charge, capacitors: game.capacitors });
      }, LEVEL.victoryDelayMs);
      return id;  // caller can clearTimeout(id) if needed
    }
    return null;
  }

  return {
    game,
    SESSION_ID,
    splatMoot,
    damagePlayer,
    triggerRewind,
    handleGameOver,
    restartGame,
    ramMoots,
    tryShoot,
    tickCrashCooldown,
    onRewindDone,
    onMootBulletHit,
    setCurrentPlayer,
    getCurrentPlayer: () => currentPlayer,
    triggerVictory,
  };
}
