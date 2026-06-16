import { useEffect, useRef } from "react";
import * as THREE from "three";

/** Muted crimson/gold ash-mote field for the Projects (PoE2) hero — sits behind
 *  the veil so it reads as depth, and parallaxes the warrior image into a diorama. */
export default function ProjectsScene() {
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
    scene.fog = new THREE.FogExp2(0x0a0607, 0.05);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 14);

    const COLORS = [0xc0392b, 0xd9a441];
    const motes = new THREE.Group();
    scene.add(motes);
    const geos = [new THREE.OctahedronGeometry(1, 0), new THREE.TetrahedronGeometry(1, 0)];

    const N = 26;
    const items: { node: THREE.Group; spin: number; drift: number }[] = [];
    for (let i = 0; i < N; i++) {
      const color = COLORS[i % COLORS.length];
      const geo = geos[i % geos.length];
      const node = new THREE.Group();
      node.add(
        new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.05 })),
        new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.3 }))
      );
      node.scale.setScalar(0.25 + (((i * 17) % 10) / 10) * 0.7);
      const a = i * 2.39996, r = 3 + ((i * 5) % 9);
      node.position.set(Math.cos(a) * r, ((i % 7) - 3) * 2.2, Math.sin(a) * r - 4);
      node.rotation.set(i * 0.4, i * 0.7, i * 0.2);
      motes.add(node);
      items.push({ node, spin: 0.08 + (i % 5) * 0.04, drift: ((i % 3) - 1) * 0.1 });
    }

    let tx = 0, ty = 0, cx = 0, cy = 0;
    const bg = document.querySelector(".poe-hero-bg") as HTMLElement | null;
    const onMove = (e: PointerEvent) => {
      tx = e.clientX / window.innerWidth - 0.5;
      ty = e.clientY / window.innerHeight - 0.5;
    };
    if (!reduce) window.addEventListener("pointermove", onMove, { passive: true });

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(Math.max(1, r.width), Math.max(1, r.height), false);
      camera.aspect = Math.max(1, r.width) / Math.max(1, r.height);
      camera.updateProjectionMatrix();
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const clock = new THREE.Clock();
    let raf = 0;
    const frame = () => {
      const dt = clock.getDelta();
      items.forEach((it) => {
        it.node.rotation.x += dt * it.spin * 0.5;
        it.node.rotation.y += dt * it.spin;
        it.node.position.y += dt * it.drift;
        if (it.node.position.y > 9) it.node.position.y = -9;
        if (it.node.position.y < -9) it.node.position.y = 9;
      });
      cx += (tx - cx) * 0.04;
      cy += (ty - cy) * 0.04;
      camera.position.x = cx * 3.5;
      camera.position.y = -cy * 2.5;
      camera.lookAt(0, 0, 0);
      motes.rotation.y += dt * 0.025;
      if (bg) bg.style.transform = `scale(1.07) translate3d(${(-cx * 16).toFixed(1)}px, ${(-cy * 12).toFixed(1)}px, 0)`;
      renderer.render(scene, camera);
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    if (reduce) renderer.render(scene, camera);
    else raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      if (bg) bg.style.transform = "";
      renderer.dispose();
    };
  }, []);

  return <canvas id="scene3" ref={canvasRef} aria-hidden="true" />;
}
