import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Hero signature: an interactive model of the system Sachal built —
 * provider-silo nodes streaming data into a glowing unified-search core.
 * Drag to spin. Degrades gracefully without WebGL / with reduced motion.
 */
export default function ArchitectureScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
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

    // Unified-search core
    const coreGeo = new THREE.IcosahedronGeometry(0.95, 1);
    const core = new THREE.Group();
    core.add(
      new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.12 })),
      new THREE.LineSegments(
        new THREE.EdgesGeometry(coreGeo),
        new THREE.LineBasicMaterial({ color: AMBER, transparent: true, opacity: 0.9 })
      )
    );
    group.add(core);

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

    const NODES = [CYAN, CYAN, CYAN, CYAN, CYAN, VIOLET, VIOLET, VIOLET, AMBER];
    const SILO = 5;
    const R = 3.15;
    const pulses: { mesh: THREE.Mesh; from: THREE.Vector3; t: number; speed: number }[] = [];

    NODES.forEach((color, idx) => {
      const p = fibonacciPoint(idx, NODES.length, R);
      const geo =
        idx < SILO ? new THREE.BoxGeometry(0.38, 0.38, 0.38) : new THREE.OctahedronGeometry(0.3, 0);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18 }));
      mesh.position.copy(p);
      const wire = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 })
      );
      wire.position.copy(p);
      group.add(mesh, wire);

      group.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints([p, ZERO]),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 })
        )
      );

      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 12, 12),
        new THREE.MeshBasicMaterial({
          color,
          transparent: true,
          opacity: 0.95,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        })
      );
      group.add(pulse);
      pulses.push({ mesh: pulse, from: p.clone(), t: (idx * 0.11) % 1, speed: 0.18 + (idx % 4) * 0.05 });
    });

    group.add(starfield(160, 9));

    // Drag-to-spin
    let dragging = false;
    let lastX = 0, lastY = 0;
    let velX = 0, velY = 0;
    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      velY = (e.clientX - lastX) * 0.005;
      velX = (e.clientY - lastY) * 0.005;
      group.rotation.y += velY;
      group.rotation.x = Math.max(-0.6, Math.min(0.6, group.rotation.x + velX));
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = () => {
      dragging = false;
    };
    canvas.addEventListener("pointerdown", onDown);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const clock = new THREE.Clock();
    let raf = 0;
    const frame = () => {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;
      if (!dragging) {
        group.rotation.y += dt * 0.18 + velY;
        velY *= 0.94;
        velX *= 0.94;
      }
      core.rotation.y += dt * 0.4;
      core.rotation.x += dt * 0.15;
      core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.04);
      (halo.material as THREE.SpriteMaterial).opacity = 0.38 + Math.sin(t * 1.6) * 0.08;
      pulses.forEach((p) => {
        p.t += dt * p.speed;
        if (p.t > 1) p.t -= 1;
        p.mesh.position.lerpVectors(p.from, ZERO, p.t);
        const fade = Math.sin(p.t * Math.PI);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.2 + fade * 0.8;
        p.mesh.scale.setScalar(0.6 + fade * 0.9);
      });
      renderer.render(scene, camera);
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    if (reduce) renderer.render(scene, camera);
    else raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      renderer.dispose();
    };
  }, []);

  return <canvas id="scene" ref={canvasRef} aria-hidden="true" />;
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
  return new THREE.Points(
    geo,
    new THREE.PointsMaterial({ color: 0x8893ac, size: 0.04, transparent: true, opacity: 0.5 })
  );
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
