import GUI from 'lil-gui';
import { CAR, PISTOL, MOOT, GAME, DEBUG } from '../config.js';

// Only constructs a panel when the URL has ?debug. Wire-up is imperative: for
// values whose underlying object is mutated in place (most of them), lil-gui
// reads the latest value on its own. Anchors need onChange because the live
// pistol.group.position is a separate THREE.Vector3 copy.
export function setupDebugPanel({ pistol, moot }) {
  if (!DEBUG.enabled) return null;
  const gui = new GUI({ title: 'VXM tuning' });

  const car = gui.addFolder('Car');
  car.add(CAR, 'accel', 0, 120, 1);
  car.add(CAR, 'brake', 0, 200, 1);
  car.add(CAR, 'maxSpeed', 0, 120, 1);
  car.add(CAR, 'reverseMaxSpeed', 0, 60, 1);
  car.add(CAR, 'coastFriction', 0, 30, 0.5);
  car.add(CAR, 'turnRate', 0, 5, 0.05);
  car.add(CAR, 'wallBounceDamp', 0, 1, 0.05);
  car.add(CAR, 'collisionRadius', 0.5, 5, 0.1);
  car.add(CAR, 'cameraHeight', 0.5, 5, 0.1);

  const p = gui.addFolder('Pistol');
  p.add(PISTOL, 'anchorX', -1.5, 1.5, 0.01).onChange((v) => pistol.group.position.x = v);
  p.add(PISTOL, 'anchorY', -1.0, 1.0, 0.01).onChange((v) => pistol.group.position.y = v);
  p.add(PISTOL, 'anchorZ', -3, -0.2, 0.01).onChange((v) => pistol.group.position.z = v);
  p.add(PISTOL, 'cooldownSeconds', 0.02, 1, 0.01);

  const m = gui.addFolder('Moot');
  m.add(MOOT, 'fleeSpeed', 0, 40, 0.5);
  m.add(MOOT, 'alertRadius', 0, 80, 1);
  m.add(MOOT, 'ramMinSpeed', 0, 30, 0.5);
  m.add(MOOT, 'ramRadius', 0.2, 5, 0.1);

  const armed = gui.addFolder('Armed Moots');
  armed.add(MOOT, 'armedEngageRange', 10, 120, 1);
  armed.add(MOOT, 'armedCooldownSec', 0.5, 8, 0.1);
  armed.add(MOOT, 'projectileSpeed', 5, 80, 1);
  armed.add(MOOT, 'projectileMaxLifetime', 1, 10, 0.1);
  armed.add(MOOT, 'projectileHitRadius', 0.3, 5, 0.1);
  armed.close();

  const g = gui.addFolder('Game');
  g.add(GAME, 'chargePerRam', 0, 50, 1);
  g.add(GAME, 'firingCost', 0, 100, 1);
  g.close();

  return gui;
}
