/* Hero signature: an orbitable model of the system Sachal built —
   provider-silo nodes streaming data into a glowing unified-search core.
   Built with Three.js. Degrades gracefully without WebGL / with reduced motion. */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const canvas = document.getElementById("scene");
if (canvas) init(canvas);

function showFallback(canvas) {
  const frame = canvas.parentElement;
  if (frame && !frame.querySelector(".stage-fallback")) {
    const d = document.createElement("div");
    d.className = "stage-fallback";
    d.textContent = "multi-provider → unified-search architecture";
    frame.appendChild(d);
  }
  canvas.style.display = "none";
}

function init(canvas) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch (e) {
    showFallback(canvas);
    return;
  }
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x070a12, 0.085);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
  camera.position.set(0, 0.6, 8);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.06;
  controls.enablePan = false;
  controls.enableZoom = false;
  controls.minPolarAngle = Math.PI * 0.28;
  controls.maxPolarAngle = Math.PI * 0.72;
  controls.autoRotate = !reduceMotion;
  controls.autoRotateSpeed = 0.9;

  const CYAN = 0x4de3d2, VIOLET = 0x7c6cf0, AMBER = 0xffb454;
  const group = new THREE.Group();
  scene.add(group);

  // --- Unified-search core ---
  const coreSolid = new THREE.Mesh(
    new THREE.IcosahedronGeometry(0.95, 1),
    new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.12 })
  );
  const coreWire = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(0.95, 1)),
    new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9 })
  );
  const core = new THREE.Group();
  core.add(coreSolid, coreWire);
  group.add(core);

  // soft halo sprite behind the core
  const halo = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: radialTexture(AMBER),
      transparent: true,
      opacity: 0.45,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
  );
  halo.scale.set(4.2, 4.2, 1);
  group.add(halo);

  // --- Satellite nodes on a fibonacci sphere ---
  const NODES = [
    { type: "silo", color: CYAN }, { type: "silo", color: CYAN },
    { type: "silo", color: CYAN }, { type: "silo", color: CYAN },
    { type: "silo", color: CYAN },
    { type: "out", color: VIOLET }, { type: "out", color: VIOLET },
    { type: "out", color: VIOLET },
    { type: "out", color: AMBER },
  ];
  const R = 3.15;
  const pulses = [];

  NODES.forEach((n, idx) => {
    const p = fibonacciPoint(idx, NODES.length, R);

    const geo = n.type === "silo"
      ? new THREE.BoxGeometry(0.38, 0.38, 0.38)
      : new THREE.OctahedronGeometry(0.3, 0);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: n.color, transparent: true, opacity: 0.18 })
    );
    mesh.position.copy(p);
    const wire = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: n.color, transparent: true, opacity: 0.85 })
    );
    wire.position.copy(p);
    group.add(mesh, wire);

    // connection line node -> core
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([p, new THREE.Vector3(0, 0, 0)]),
      new THREE.LineBasicMaterial({ color: n.color, transparent: true, opacity: 0.22 })
    );
    group.add(line);

    // traveling data pulse
    const pulse = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 12, 12),
      new THREE.MeshBasicMaterial({
        color: n.color, transparent: true, opacity: 0.95,
        blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    group.add(pulse);
    pulses.push({ mesh: pulse, from: p.clone(), t: Math.random(), speed: 0.18 + Math.random() * 0.18 });
  });

  // ambient starfield for depth
  group.add(starfield(160, 9));

  // --- sizing ---
  function resize() {
    const r = canvas.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  resize();
  if ("ResizeObserver" in window) new ResizeObserver(resize).observe(canvas);
  else window.addEventListener("resize", resize);

  // --- render loop ---
  const clock = new THREE.Clock();
  function frame() {
    const dt = clock.getDelta();
    const t = clock.elapsedTime;

    core.rotation.y += dt * 0.4;
    core.rotation.x += dt * 0.15;
    const s = 1 + Math.sin(t * 1.6) * 0.04;
    core.scale.setScalar(s);
    halo.material.opacity = 0.38 + Math.sin(t * 1.6) * 0.08;

    pulses.forEach((p) => {
      p.t += dt * p.speed;
      if (p.t > 1) p.t -= 1;
      p.mesh.position.lerpVectors(p.from, ZERO, p.t);
      const fade = Math.sin(p.t * Math.PI);
      p.mesh.material.opacity = 0.2 + fade * 0.8;
      p.mesh.scale.setScalar(0.6 + fade * 0.9);
    });

    controls.update();
    renderer.render(scene, camera);
    if (!reduceMotion) requestAnimationFrame(frame);
  }

  const ZERO = new THREE.Vector3(0, 0, 0);
  if (reduceMotion) { controls.update(); renderer.render(scene, camera); }
  else requestAnimationFrame(frame);
}

/* ------------------------------- helpers -------------------------------- */
function fibonacciPoint(i, n, radius) {
  const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  return new THREE.Vector3(
    Math.cos(theta) * Math.sin(phi),
    Math.cos(phi),
    Math.sin(theta) * Math.sin(phi)
  ).multiplyScalar(radius);
}

function starfield(count, spread) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3]     = (Math.random() - 0.5) * spread * 2;
    pos[i * 3 + 1] = (Math.random() - 0.5) * spread * 2;
    pos[i * 3 + 2] = (Math.random() - 0.5) * spread * 2;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0x8893ac, size: 0.04, transparent: true, opacity: 0.5 })
  );
}

function radialTexture(hexColor) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  const col = "#" + hexColor.toString(16).padStart(6, "0");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, col + "cc");
  g.addColorStop(0.4, col + "33");
  g.addColorStop(1, col + "00");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}
