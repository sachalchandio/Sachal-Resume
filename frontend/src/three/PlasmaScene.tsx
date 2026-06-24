import { useEffect, useRef } from "react";
import * as THREE from "three";

/** Hero signature — a drifting field of glowing plasma particles around a faint
 *  wireframe core, with depth fog and mouse parallax. The "3D AAA" layer.
 *  Pauses off-screen, degrades gracefully, respects reduced motion. */
const COLORS = [0x6e5cf6, 0x2e80ff, 0x2bd4e4, 0xff5c7a];

export default function PlasmaScene() {
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
    scene.fog = new THREE.FogExp2(0x07080f, 0.028);
    const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 120);
    camera.position.set(0, 0, 19);

    const group = new THREE.Group();
    scene.add(group);

    const tex = glowTexture();
    const N = 340;
    const parts: { s: THREE.Sprite; sp: number; base: number; phase: number; drift: number }[] = [];
    for (let i = 0; i < N; i++) {
      const color = COLORS[i % COLORS.length];
      const mat = new THREE.SpriteMaterial({ map: tex, color, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const s = new THREE.Sprite(mat);
      const r = 3.5 + Math.random() * 15;
      const a = Math.random() * Math.PI * 2;
      s.position.set(Math.cos(a) * r, (Math.random() - 0.5) * 24, Math.sin(a) * r - 7);
      s.scale.setScalar(0.12 + Math.random() * 0.8);
      group.add(s);
      parts.push({ s, sp: 0.15 + Math.random() * 0.5, base: 0.22 + Math.random() * 0.55, phase: Math.random() * Math.PI * 2, drift: (Math.random() - 0.5) * 0.5 });
    }

    const core = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.IcosahedronGeometry(3.4, 1)),
      new THREE.LineBasicMaterial({ color: 0x2e80ff, transparent: true, opacity: 0.16 })
    );
    group.add(core);
    const coreGlow = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0x6e5cf6, transparent: true, opacity: 0.4, blending: THREE.AdditiveBlending, depthWrite: false }));
    coreGlow.scale.setScalar(9);
    group.add(coreGlow);

    let tx = 0, ty = 0, cx = 0, cy = 0;
    const onMove = (e: PointerEvent) => { tx = e.clientX / window.innerWidth - 0.5; ty = e.clientY / window.innerHeight - 0.5; };
    if (!reduce) window.addEventListener("pointermove", onMove, { passive: true });

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const clock = new THREE.Clock();
    let raf = 0;
    let running = false;
    const frame = () => {
      const dt = Math.min(clock.getDelta(), 0.05);
      group.rotation.y += dt * 0.035;
      core.rotation.x += dt * 0.1;
      core.rotation.y += dt * 0.14;
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        p.phase += dt * p.sp;
        (p.s.material as THREE.SpriteMaterial).opacity = p.base * (0.45 + 0.55 * Math.sin(p.phase + i));
        p.s.position.y += dt * p.drift;
        if (p.s.position.y > 13) p.s.position.y = -13;
        else if (p.s.position.y < -13) p.s.position.y = 13;
      }
      (coreGlow.material as THREE.SpriteMaterial).opacity = 0.32 + Math.sin(clock.elapsedTime * 0.8) * 0.1;
      cx += (tx - cx) * 0.045;
      cy += (ty - cy) * 0.045;
      camera.position.x = cx * 5;
      camera.position.y = -cy * 4;
      camera.lookAt(0, 0, -4);
      renderer.render(scene, camera);
      if (running) raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running && !reduce) { running = true; clock.getDelta(); raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0 });
    io.observe(canvas);
    if (reduce) renderer.render(scene, camera);
    else start();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      window.removeEventListener("pointermove", onMove);
      renderer.dispose();
    };
  }, []);

  return <canvas className="plasma-canvas" ref={canvasRef} aria-hidden="true" />;
}

function glowTexture() {
  const size = 128;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.55)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}
