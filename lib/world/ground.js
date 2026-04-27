import * as THREE from 'three';
import { WORLD, MOOT } from '../config.js';

export function buildGround(scene, corridorLength) {
  const zCenter = -corridorLength / 2 + MOOT.spacing;

  const road = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD.roadHalfWidth * 2, corridorLength),
    new THREE.MeshBasicMaterial({ color: 0x1a1a1f }),
  );
  road.rotation.x = -Math.PI / 2;
  road.position.z = zCenter;
  scene.add(road);

  for (const side of [-1, 1]) {
    const sidewalk = new THREE.Mesh(
      new THREE.PlaneGeometry(WORLD.sidewalkWidth, corridorLength),
      new THREE.MeshBasicMaterial({ color: 0x3a3a40 }),
    );
    sidewalk.rotation.x = -Math.PI / 2;
    sidewalk.position.set(
      side * (WORLD.roadHalfWidth + WORLD.sidewalkWidth / 2),
      0.01,
      zCenter,
    );
    scene.add(sidewalk);
  }

  const stripeMat = new THREE.MeshBasicMaterial({ color: 0xf2c43a });
  const stripeGeom = new THREE.PlaneGeometry(WORLD.stripeWidth, WORLD.stripeLength);
  const step = WORLD.stripeLength + WORLD.stripeGap;
  for (let z = MOOT.spacing; z > -corridorLength + MOOT.spacing; z -= step) {
    const stripe = new THREE.Mesh(stripeGeom, stripeMat);
    stripe.rotation.x = -Math.PI / 2;
    stripe.position.set(0, 0.02, z);
    scene.add(stripe);
  }
}
