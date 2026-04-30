/**
 * lib/game/state.js — game state machine and all gameplay logic.
 *
 * createGameState(deps) → game state object + action functions.
 *
 * Owns: game object, splatMoot, damagePlayer, triggerRewind,
 *       handleGameOver, restartGame, ramMoots, tryShoot,
 *       currentPlayer, SESSION_ID.
 */

import * as THREE from 'three';
import { CAR, GAME, MIRROR, TARGET } from '../config.js';
import { detectRams } from '../entities/moots.js';
import { setFace } from '../hud/mirror.js';
import { setGameOverVisible, showLoginPrompt, showQueueSuccess } from '../hud/overlays.js';
import { postKill, postQueue } from '../api.js';

/**
 * @typedef {{
 *   state: 'playing'|'gameover'|'rewinding'|'victory',
 *   charge: number,
 *   capacitors: number,
 *   health: number,
 *   mootsAlive: number,
 *   mootsTotal: number,
 *   score: number,
 *   timeRemaining: number,
 *   targetCountdown: number,
 *   combo: number,
 *   targetHandle: object|null,
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
    vehicle, camera,
    getMootHandles,
    impactSystem, pistol, updateHud,
  } = deps;
  // Reused buffer for muzzle world position (avoids per-shot allocation).
  const _muzzleWorld = new THREE.Vector3();
  // deps is kept in scope so splatMoot can call deps.onSplatMoot if present.

  /** @type {GameState} */
  const game = {
    state: 'playing',
    charge: GAME.startAmmo,
    capacitors: 0,
    health: 0,            // truck is invincible — health unused
    mootsAlive: 0,
    mootsTotal: 0,
    score: 0,
    timeRemaining: TARGET.startTimeS,
    targetCountdown: TARGET.targetCountdownS,
    combo: 1,
    targetHandle: null,
    boosting: false,
  };

  // Unique session ID for this page load, used to group kills into one run.
  const SESSION_ID = Math.random().toString(36).slice(2);

  // Resolved on startup via GET /auth/me; null = not logged in.
  let currentPlayer = null;

  // Combo tracking
  let _lastTargetHitAt  = 0;  // performance.now() ms

  // ── Target system ────────────────────────────────────────────────────────────

  /**
   * Designate a new random moot from the active population as the target.
   * If no valid candidates, leaves target as null.
   * Always resets the per-target countdown.
   */
  function designateNewTarget() {
    const handles = deps.getMootHandles();
    const candidates = handles.filter(h => h.alive);
    game.targetCountdown = TARGET.targetCountdownS;
    if (candidates.length === 0) {
      game.targetHandle = null;
      if (deps.onTargetChanged) deps.onTargetChanged(null);
      return;
    }
    const chosen = candidates[Math.floor(Math.random() * candidates.length)];
    game.targetHandle = chosen;
    if (deps.onTargetChanged) deps.onTargetChanged(chosen);
  }

  /**
   * Handle a target being rammed (or shot) by the player.
   * Awards score + time, updates combo, designates next target.
   */
  function onTargetHit() {
    const now = performance.now();
    const elapsed = (now - _lastTargetHitAt) / 1000;
    // Combo: consecutive hits within comboWindow multiply score.
    if (_lastTargetHitAt > 0 && elapsed < TARGET.comboWindow) {
      game.combo = Math.min(game.combo + 1, TARGET.comboMax);
    } else {
      game.combo = 1;
    }
    _lastTargetHitAt = now;

    const earned = TARGET.scorePerTarget * game.combo;
    game.score += earned;
    game.timeRemaining = Math.min(
      game.timeRemaining + TARGET.baseTimeBonus,
      TARGET.startTimeS * 2,  // cap at 2× start time
    );

    if (deps.onScoreChange) deps.onScoreChange(game.score, earned, game.combo);
    designateNewTarget();
    updateHud(game);
  }

  /**
   * Tick session timer + per-target countdown each frame.
   * Session reaching 0 → TIME'S UP.
   * Per-target reaching 0 → silently pick a new target, no game over.
   * @param {number} dt
   */
  function tickTimer(dt) {
    if (game.state !== 'playing') return;

    // Per-target countdown
    game.targetCountdown -= dt;
    if (game.targetCountdown <= 0) {
      game.targetCountdown = 0;
      designateNewTarget();
    }

    // Session timer
    game.timeRemaining -= dt;
    if (game.timeRemaining <= 0) {
      game.timeRemaining = 0;
      _timeUp();
    }
  }

  function _timeUp() {
    game.state = 'gameover';
    setFace('panicked');
    const restartCb = deps.onRestart || restartGame;
    const title = `TIME'S UP  ${game.score}`;
    setGameOverVisible(true, restartCb, { title, sub: 'Press R or click below to restart' });
    handleGameOver();
  }

  // ── Core actions ────────────────────────────────────────────────────────────

  function splatMoot(handle, weapon = 'ram') {
    if (!handle.alive) return;

    handle.alive = false;
    impactSystem.spawnImpact(handle.group.position, 0xd04040, 2.2);
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
  }

  function triggerRewind() {
    // Rewind deprecated — truck is invincible. No-op.
  }

  function damagePlayer() {
    // Truck is invincible — damage is a no-op.
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
    const rammed = detectRams(vehicle, handles);
    if (rammed.length === 0) return;
    for (const h of rammed) {
      const wasTarget = h === game.targetHandle;
      splatMoot(h, 'ram');
      if (!h.alive) {
        // Ammo refund on any moot ram.
        game.charge = Math.min(GAME.maxAmmo, game.charge + GAME.ammoPerRam);
        // Award score and time if this was the designated target.
        if (wasTarget) {
          onTargetHit();
        }
      }
    }
    vehicle.speed *= 0.95;
    if (rammed.length > 1) setFace('celebrating', MIRROR.celebratingMs);
    else setFace('happy', MIRROR.happyMs);
  }

  function tryShoot(aim) {
    if (game.charge < GAME.firingCostAmmo) {
      setFace('angry', MIRROR.angryMs);
      return false;
    }
    // Beam origin = front of the vehicle in world space; pistol projects it.
    _muzzleWorld.copy(vehicle.position).addScaledVector(vehicle.forward, CAR.spriteScale * 0.5);
    if (!pistol.tryFire(_muzzleWorld, camera)) return false;
    game.charge -= GAME.firingCostAmmo;
    impactSystem.spawnImpact(aim.point, 0xffaa55, 1.4);
    let o = aim.object, hitMoot = false;
    while (o) {
      if (o.userData && o.userData.mootHandle) {
        const target = o.userData.mootHandle;
        const wasTarget = target === game.targetHandle;
        splatMoot(target, 'shot');
        hitMoot = true;
        if (wasTarget && !target.alive) {
          onTargetHit();
        }
        break;
      }
      // NPC vehicle hit via raycast.
      if (o.userData && o.userData.isNpcVehicle) {
        const npcHandle = o.userData.npcHandle;
        if (npcHandle && npcHandle.alive && deps.onNpcVehicleShot) {
          deps.onNpcVehicleShot(npcHandle);
          hitMoot = true;
        }
        break;
      }
      o = o.parent;
    }
    if (hitMoot) setFace('smug', MIRROR.smugMs);
    return true;
  }

  function tickCrashCooldown(_dt, hit, _preSpeed) {
    // Truck is invincible — but a solid head-on wall hit shows pained reaction.
    if (hit && (hit.intensity ?? 0) >= MIRROR.painedMinIntensity) {
      setFace('pained', MIRROR.painedMs);
    }
  }

  function onRewindDone() {
    game.state = 'playing';
    vehicle.speed = 0;
    updateHud(game);
  }

  function onMootBulletHit() {
    // Truck is invincible — bullet hits are no-ops.
  }

  function setCurrentPlayer(player) {
    currentPlayer = player;
  }

  // triggerVictory deprecated — no boss, no victory state.

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
    tickTimer,
    designateNewTarget,
    onRewindDone,
    onMootBulletHit,
    setCurrentPlayer,
    getCurrentPlayer: () => currentPlayer,
  };
}
