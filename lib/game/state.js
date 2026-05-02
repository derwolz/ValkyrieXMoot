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
import { detectRams, flingMoot } from '../entities/moots.js';
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
 *   sessionTimerEnabled: boolean,
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
 *   spawnObjectiveTarget?: () => object|null,
 *   releaseObjectiveTarget?: (handle: object) => void,
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
  // Reused buffers for hot gameplay actions.
  const _muzzleWorld = new THREE.Vector3();
  const _rightVec    = new THREE.Vector3();
  const _ramHits = [];
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
    sessionTimerEnabled: true,
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
   * Compute the per-target countdown from actual truck → target distance.
   * Uses CAR.maxSpeed only; boost speed is deliberately ignored.
   * @param {object|null} handle
   */
  function computeTargetCountdown(handle) {
    const minimum = TARGET.targetCountdownS ?? 20;
    const multiplier = TARGET.targetTravelTimeMultiplier ?? 1.2;
    const pos = handle?.group?.position;
    if (!pos) return minimum;
    const dx = pos.x - vehicle.position.x;
    const dz = pos.z - vehicle.position.z;
    const distance = Math.sqrt(dx * dx + dz * dz);
    const maxSpeed = Math.max(0.001, CAR.maxSpeed);
    return Math.max(minimum, (distance / maxSpeed) * multiplier);
  }

  /**
   * Designate a new objective moot from a valid map-wide interest point.
   * If no explicit objective spawner exists, falls back to active population.
   * Always resets the per-target countdown from target distance.
   */
  function designateNewTarget() {
    const previous = game.targetHandle;
    if (previous && deps.releaseObjectiveTarget) deps.releaseObjectiveTarget(previous);

    let chosen = deps.spawnObjectiveTarget ? deps.spawnObjectiveTarget() : null;
    if (!chosen) {
      const handles = deps.getMootHandles();
      const candidates = handles.filter(h => h.alive);
      chosen = candidates.length > 0
        ? candidates[Math.floor(Math.random() * candidates.length)]
        : null;
    }

    game.targetCountdown = computeTargetCountdown(chosen);
    game.targetHandle = chosen;
    if (deps.onTargetChanged) deps.onTargetChanged(chosen);
  }

  /**
   * Handle a target being rammed (or shot) by the player.
   * Awards score + time, updates combo, designates next target.
   */
  function onTargetHit() {
    game.charge = GAME.maxAmmo;

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
    if (game.sessionTimerEnabled) {
      game.timeRemaining = Math.min(
        game.timeRemaining + TARGET.baseTimeBonus,
        TARGET.startTimeS * 2,  // cap at 2× start time
      );
    }

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

    // Session timer. Dev builds can disable only this countdown; the target
    // countdown above keeps running so objective flow is unchanged.
    if (!game.sessionTimerEnabled) return;
    game.timeRemaining -= dt;
    if (game.timeRemaining <= 0) {
      game.timeRemaining = 0;
      _timeUp();
    }
  }

  function _timeUp() {
    game.state = 'gameover';
    setFace('panicked', MIRROR.painedMs);
    const restartCb = deps.onRestart || restartGame;
    const title = `TIME'S UP  ${game.score}`;
    setGameOverVisible(true, restartCb, { title, sub: 'Press R or click below to restart' });
    handleGameOver();
  }

  // ── Core actions ────────────────────────────────────────────────────────────

  function _vehicleImpactVelocity() {
    return {
      x: vehicle.forward.x * vehicle.speed,
      z: vehicle.forward.z * vehicle.speed,
    };
  }

  function _normaliseSplatLaunch(weapon, launch, legacyDirZ) {
    if (typeof launch === 'number') {
      return { kind: weapon, dirX: launch, dirZ: legacyDirZ };
    }
    return { kind: weapon, ...(launch || { dirX: 0, dirZ: 1 }) };
  }

  function splatMoot(handle, weapon = 'ram', launch = { dirX: 0, dirZ: 1 }, legacyDirZ) {
    if (!handle.alive) return;

    impactSystem.spawnImpact(handle.group.position, 0xd04040, 2.2);
    flingMoot(handle, _normaliseSplatLaunch(weapon, launch, legacyDirZ)); // sets handle.alive = false
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

  function resetRunState() {
    game.charge     = GAME.startAmmo;
    game.capacitors = 0;
    game.health     = 0;
    game.state      = 'playing';
    game.score      = 0;
    game.timeRemaining   = TARGET.startTimeS;
    game.targetCountdown = TARGET.targetCountdownS;
    game.combo      = 1;
    if (game.targetHandle && deps.releaseObjectiveTarget) deps.releaseObjectiveTarget(game.targetHandle);
    game.targetHandle = null;
    game.boosting   = false;
    game.mootsAlive = 0;
    game.mootsTotal = 0;
    _lastTargetHitAt = 0;
    if (deps.onTargetChanged) deps.onTargetChanged(null);
    updateHud(game);
    return game;
  }

  function restartGame() {
    resetRunState();
  }

  function ramMoots(handles) {
    const rammed = detectRams(vehicle, handles, _ramHits);
    if (rammed.length === 0) return;
    let objectiveRammed = false;
    for (const h of rammed) {
      const wasTarget = h === game.targetHandle;
      // Hit normal: truck → moot (normalized XZ), so moot flies away from truck.
      let dx = h.group.position.x - vehicle.position.x;
      let dz = h.group.position.z - vehicle.position.z;
      const len = Math.sqrt(dx * dx + dz * dz) || 1;
      const impactVelocity = _vehicleImpactVelocity();
      splatMoot(h, 'ram', {
        normalX: dx / len,
        normalZ: dz / len,
        vehicleVelocityX: impactVelocity.x,
        vehicleVelocityZ: impactVelocity.z,
      });
      if (!h.alive) {
        // Ammo refund on any moot ram.
        game.charge = Math.min(GAME.maxAmmo, game.charge + GAME.ammoPerRam);
        // Award score and time if this was the designated target.
        if (wasTarget) {
          objectiveRammed = true;
          onTargetHit();
        }
      }
    }
    vehicle.speed *= 0.95;
    if (objectiveRammed) setFace(game.boosting ? 'turboCelebrating' : 'celebrating', MIRROR.celebratingMs);
    else if (rammed.length > 1) setFace('celebrating', MIRROR.celebratingMs);
    else setFace('happy', MIRROR.happyMs);
  }

  function tryShoot(aim) {
    if (game.charge < GAME.firingCostAmmo) {
      setFace('angry', MIRROR.angryMs);
      return false;
    }
    // Beam origin = driver-side window in world space; pistol projects it.
    // _rightVec = vehicle.forward rotated 90° CW in XZ → world right.
    // Driver-side (US convention) is left of forward, so subtract.
    _rightVec.set(-vehicle.forward.z, 0, vehicle.forward.x);
    _muzzleWorld.copy(vehicle.position)
      .addScaledVector(vehicle.forward, 1.8)   // ahead of cab
      .addScaledVector(_rightVec, -0.7);       // driver-side
    _muzzleWorld.y += 1.6;                     // window height
    if (!pistol.tryFire(_muzzleWorld, camera, aim.point)) return false;
    game.charge -= GAME.firingCostAmmo;
    impactSystem.spawnImpact(aim.point, 0xffaa55, 1.4);
    let o = aim.object, hitMoot = false, objectiveShot = false;
    while (o) {
      if (o.userData && o.userData.mootHandle) {
        const target = o.userData.mootHandle;
        const wasTarget = target === game.targetHandle;
        // Shot launch direction follows the ray/aim direction in XZ.
        let sdx = aim.point.x - vehicle.position.x;
        let sdz = aim.point.z - vehicle.position.z;
        const slen = Math.sqrt(sdx * sdx + sdz * sdz) || 1;
        splatMoot(target, 'shot', { dirX: sdx / slen, dirZ: sdz / slen });
        hitMoot = true;
        if (wasTarget && !target.alive) {
          objectiveShot = true;
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
    if (objectiveShot) setFace('shootCelebrating', MIRROR.celebratingMs);
    else if (hitMoot) setFace('smug', MIRROR.smugMs);
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

  function setSessionTimerEnabled(enabled) {
    const next = !!enabled;
    if (game.sessionTimerEnabled === next) return game.sessionTimerEnabled;
    game.sessionTimerEnabled = next;
    if (next && game.timeRemaining <= 0) {
      game.timeRemaining = TARGET.startTimeS;
    }
    updateHud(game);
    return game.sessionTimerEnabled;
  }

  function toggleSessionTimer() {
    return setSessionTimerEnabled(!game.sessionTimerEnabled);
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
    resetRunState,
    ramMoots,
    tryShoot,
    tickCrashCooldown,
    tickTimer,
    designateNewTarget,
    onRewindDone,
    onMootBulletHit,
    setSessionTimerEnabled,
    toggleSessionTimer,
    setCurrentPlayer,
    getCurrentPlayer: () => currentPlayer,
  };
}
