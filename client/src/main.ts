import * as THREE from 'three';
import './style.css';

// Placeholder render-pipeline check: a rotating cube on a dark background.
// Will be replaced by the actual game client.

const app = document.querySelector<HTMLDivElement>('#app');
if (!app) throw new Error('missing #app element');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0e14);

const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(0, 0.8, 3);
camera.lookAt(0, 0, 0);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x4cc2ff, metalness: 0.2, roughness: 0.4 }),
);
scene.add(cube);

const keyLight = new THREE.DirectionalLight(0xffffff, 1.2);
keyLight.position.set(3, 5, 4);
scene.add(keyLight);
scene.add(new THREE.AmbientLight(0x8899ff, 0.4));

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

renderer.setAnimationLoop((time) => {
  cube.rotation.set(time * 0.0006, time * 0.0009, 0);
  renderer.render(scene, camera);
});
