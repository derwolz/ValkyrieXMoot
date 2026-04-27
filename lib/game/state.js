/**
 * lib/game/state.js — game state machine and all gameplay logic.
 *
 * createGameState(deps) → game state object + action functions.
 *
 * Owns: game object, splatMoot, damagePlayer, triggerRewind,
 *       handleGameOver, restartGame, ramMoots, tryShoot,
 *       crashCooldown, rewindSavedHealth, currentPlayer, SESSION_ID.
 */

import { GAME, MOOT, MIRROR } from '../config.js';
import { detectRams, initArmed, clearMootProjectiles } from '../entities/moots.js';
import { setFace } from '../hud/mirror.js';
import { setGameOverVisible, showRewindFlash, showLoginPrompt, showQueueSuccess } from '../hud/overlays.js';
import { postKill, postQueue } from '../api.js';
import { applySort } from './sorter.js';

/**
 * @typedef {{
 *   state: 'playing'|'gameover'|'rewinding',
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
    handle.alive = false;
    impactSystem.spawnImpact(handle.group.position, 0xd04040, 2.2);
    scene.remove(handle.group);
    game.mootsAlive--;
    if (currentPlayer && handle.mootRow) {
      postKill(
        handle.mootRow,
        weapon,
        { x: handle.group.position.x, z: handle.group.position.z },
        SESSION_ID,
      );
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
        setGameOverVisible(true, restartGame);
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
    showQueueSuccess(currentPlayer.handle);
  }

  function restartGame() {
    const mootHandles  = getMootHandles();
    const sessionMoots = getSessionMoots();

    for (const h of mootHandles) {
      if (!h.alive) {
        scene.add(h.group);
        h.alive = true;
      }
    }
    game.mootsAlive  = game.mootsTotal;
    game.charge      = GAME.startCharge;
    game.capacitors  = 0;
    game.health      = GAME.maxHealth;
    game.state       = 'playing';
    crashCooldown    = 0;
    recorder.reset();
    impactSystem.clearImpacts();
    clearMootProjectiles(scene);
    initArmed(mootHandles, MOOT.armedFraction);
    const sortEl = document.getElementById('sort');
    applySort(sortEl?.value || 'rank', sessionMoots, mootHandles);
    vehicle.reset();
    setFace('neutral');
    setGameOverVisible(false);
    updateHud(game);
  }

  function ramMoots() {
    const handles = getMootHandles();
    const rammed  = detectRams(vehicle, handles);
    if (rammed.length === 0) return;
    for (const h of rammed) {
      splatMoot(h, 'ram');
      if (game.charge >= GAME.maxCharge) {
        if (game.capacitors < GAME.maxCapacitors) {
          game.capacitors++;
          game.charge = 0;
        }
      } else {
        game.charge = Math.min(GAME.maxCharge, game.charge + GAME.chargePerRam);
      }
    }
    vehicle.speed *= 0.95;
    if (rammed.length > 1) setFace('celebrating', MIRROR.celebratingMs);
    else setFace('happy', MIRROR.happyMs);
  }

  function tryShoot(aim) {
    if (game.charge < GAME.firingCost) {
      setFace('angry', MIRROR.angryMs);
      return;
    }
    if (!pistol.tryFire()) return;
    game.charge -= GAME.firingCost;
    impactSystem.spawnImpact(aim.point, 0xffaa55, 1.4);
    let o = aim.object, hitMoot = false;
    while (o) {
      if (o.userData && o.userData.mootHandle) {
        splatMoot(o.userData.mootHandle, 'shot');
        hitMoot = true;
        break;
      }
      o = o.parent;
    }
    if (hitMoot) setFace('smug', MIRROR.smugMs);
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
  };
}
