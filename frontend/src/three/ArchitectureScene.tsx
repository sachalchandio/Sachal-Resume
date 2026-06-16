import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Hero signature: an interactive model of the system Sachal built —
 * provider-silo nodes streaming data into a glowing unified-search core.
 * Drag to spin · hover a node to see what it is · scroll to parallax ·
 * (and the Konami code makes the core remember). Degrades gracefully.
 */
const LABELS = [
  "Provider silo", "Provider silo", "Provider silo", "Provider silo", "Provider silo",
  "Sync pipeline", "Analytics engine", "Notifications", "Commission engine",
];

interface Hoverable {
  group: THREE.Group;
  mesh: THREE.Object3D;
  wire: THREE.LineSegments;
  label: string;
  scale: number; // eased current scale
}

export default function ArchitectureScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvasEl = canvasRef.current;
    const tip = tipRef.current;
    if (!canvasEl) return;
    const canvas: HTMLCanvasElement = canvasEl;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch {
      canvas.style.display = "none";
      return;
    }
    renderer.setClearColor(0x000000, 0);

    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x070a12, 0.085);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0.6, 8);

    const CYAN = 0x4de3d2, VIOLET = 0x7c6cf0, AMBER = 0xffb454;
    const ZERO = new THREE.Vector3(0, 0, 0);
    const group = new THREE.Group();
    scene.add(group);

    const hoverables: Hoverable[] = [];

    // Unified-search core
    const coreGeo = new THREE.IcosahedronGeometry(0.95, 1);
    const coreSolid = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.12 }));
    const coreWire = new THREE.LineSegments(new THREE.EdgesGeometry(coreGeo), new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9 }));
    const core = new THREE.Group();
    core.add(coreSolid, coreWire);
    group.add(core);
    hoverables.push({ group: core, mesh: coreSolid, wire: coreWire, label: "Unified-search core", scale: 1 });

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(AMBER), transparent: true, opacity: 0.45, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    halo.scale.set(4.2, 4.2, 1);
    group.add(halo);

    const NODES = [CYAN, CYAN, CYAN, CYAN, CYAN, VIOLET, VIOLET, VIOLET, AMBER];
    const SILO = 5;
    const R = 3.15;
    const pulses: { mesh: THREE.Mesh; from: THREE.Vector3; t: number; speed: number }[] = [];

    NODES.forEach((color, idx) => {
      const p = fibonacciPoint(idx, NODES.length, R);
      const geo = idx < SILO ? new THREE.BoxGeometry(0.38, 0.38, 0.38) : new THREE.OctahedronGeometry(0.3, 0);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }));
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
      const node = new THREE.Group();
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: radialTexture(color), transparent: true, opacity: 0.32,
        blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.setScalar(1.15);
      node.add(mesh, wire, glow);
      node.position.copy(p);
      group.add(node);
      hoverables.push({ group: node, mesh, wire, label: LABELS[idx], scale: 1 });

      group.add(new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([p, ZERO]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 })
      ));

      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 12, 12),
        new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      group.add(pulse);
      pulses.push({ mesh: pulse, from: p.clone(), t: (idx * 0.11) % 1, speed: 0.18 + (idx % 4) * 0.05 });
    });

    group.add(starfield(160, 9));

    // --- interaction state ---
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hoverMeshes = hoverables.map((h) => h.mesh);
    let hovered: Hoverable | null = null;
    let dragging = false;
    let lastX = 0, lastY = 0, velY = 0;
    let scrollTilt = 0;
    let burst = 0;

    const onDown = (e: PointerEvent) => { dragging = true; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => { dragging = false; };
    const onMove = (e: PointerEvent) => {
      if (dragging) {
        velY = (e.clientX - lastX) * 0.005;
        group.rotation.y += velY;
        group.rotation.x = Math.max(-0.6, Math.min(0.6, group.rotation.x + (e.clientY - lastY) * 0.005));
        lastX = e.clientX; lastY = e.clientY;
        return;
      }
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const hit = raycaster.intersectObjects(hoverMeshes, false)[0];
      hovered = hit ? hoverables.find((h) => h.mesh === hit.object) ?? null : null;
      canvas.style.cursor = hovered ? "pointer" : "grab";
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.style.cursor = "grab";

    const onScroll = () => { scrollTilt = Math.min(1, window.scrollY / 900); };
    window.addEventListener("scroll", onScroll, { passive: true });
    const onKonami = () => { burst = 1; };
    window.addEventListener("konami", onKonami);

    function resize() {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const proj = new THREE.Vector3();
    const clock = new THREE.Clock();
    let raf = 0;
    let coreFlash = 0;
    function frame() {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;

      if (burst > 0) burst = Math.max(0, burst - dt * 0.5);
      if (coreFlash > 0) coreFlash = Math.max(0, coreFlash - dt * 2);
      if (!dragging) { group.rotation.y += dt * (0.18 + burst * 5) + velY; velY *= 0.94; }

      core.rotation.y += dt * 0.4;
      core.rotation.x += dt * 0.15;
      core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.04 + burst * 0.5);
      (halo.material as THREE.SpriteMaterial).opacity = 0.38 + Math.sin(t * 1.6) * 0.08 + burst * 0.3 + coreFlash;
      (coreWire.material as THREE.LineBasicMaterial).opacity = 0.9 + coreFlash;

      // ease satellite hover scale + wire glow
      for (let i = 1; i < hoverables.length; i++) {
        const h = hoverables[i];
        const target = h === hovered ? 1.4 : 1;
        h.scale += (target - h.scale) * 0.18;
        h.group.scale.setScalar(h.scale);
        (h.wire.material as THREE.LineBasicMaterial).opacity = h === hovered ? 1 : 0.85;
      }

      pulses.forEach((p) => {
        p.t += dt * p.speed * (1 + burst * 3);
        if (p.t > 1) { p.t -= 1; coreFlash = Math.min(0.25, coreFlash + 0.08); }
        p.mesh.position.lerpVectors(p.from, ZERO, p.t);
        const fade = Math.sin(p.t * Math.PI);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.2 + fade * 0.8;
        p.mesh.scale.setScalar(0.6 + fade * 0.9);
      });

      // scroll parallax (camera dolly)
      const ty = 0.6 - scrollTilt * 1.6, tz = 8 + scrollTilt * 2.6;
      camera.position.y += (ty - camera.position.y) * 0.08;
      camera.position.z += (tz - camera.position.z) * 0.08;
      camera.lookAt(0, 0, 0);

      // tooltip follows the hovered node
      if (tip) {
        if (hovered) {
          hovered.group.getWorldPosition(proj);
          proj.project(camera);
          const rect = canvas.getBoundingClientRect();
          tip.style.left = `${(proj.x * 0.5 + 0.5) * rect.width}px`;
          tip.style.top = `${(-proj.y * 0.5 + 0.5) * rect.height}px`;
          tip.textContent = hovered.label;
          tip.style.opacity = "1";
        } else {
          tip.style.opacity = "0";
        }
      }

      renderer.render(scene, camera);
      if (!reduce) raf = requestAnimationFrame(frame);
    }
    if (reduce) renderer.render(scene, camera);
    else raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("konami", onKonami);
      renderer.dispose();
    };
  }, []);

  return (
    <>
      <canvas id="scene" ref={canvasRef} aria-hidden="true" />
      <div className="scene-tip" ref={tipRef} aria-hidden="true" />
    </>
  );
}

function fibonacciPoint(i: number, n: number, radius: number) {
  const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
  const theta = Math.PI * (1 + Math.sqrt(5)) * i;
  return new THREE.Vector3(
    Math.cos(theta) * Math.sin(phi),
    Math.cos(phi),
    Math.sin(theta) * Math.sin(phi)
  ).multiplyScalar(radius);
}

function starfield(count: number, spread: number) {
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.cos(i * 5) * (i % 13)) / 6 - spread / 2;
    pos[i * 3 + 1] = ((i % 19) - 9) * 0.9;
    pos[i * 3 + 2] = (Math.sin(i * 3) * (i % 11)) / 5 - spread / 2;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x8893ac, size: 0.04, transparent: true, opacity: 0.5 }));
}

function radialTexture(hexColor: number) {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const col = "#" + hexColor.toString(16).padStart(6, "0");
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, col + "cc");
  g.addColorStop(0.4, col + "33");
  g.addColorStop(1, col + "00");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
