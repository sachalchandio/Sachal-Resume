import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * Off-Duty hero background: a slow-drifting field of crystal shards.
 * A different scene from the architecture model — same craft, more play.
 */
export default function CrystalScene() {
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
    scene.fog = new THREE.FogExp2(0x070a12, 0.045);
    const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
    camera.position.set(0, 0, 14);

    const COLORS = [0x4de3d2, 0x7c6cf0, 0xffb454];
    const shards = new THREE.Group();
    scene.add(shards);

    const geos = [
      new THREE.OctahedronGeometry(1, 0),
      new THREE.IcosahedronGeometry(1, 0),
      new THREE.TetrahedronGeometry(1, 0),
    ];

    const N = 34;
    const items: { node: THREE.Group; spin: number; drift: number }[] = [];
    for (let i = 0; i < N; i++) {
      const color = COLORS[i % COLORS.length];
      const geo = geos[i % geos.length];
      const scale = 0.3 + (((i * 13) % 10) / 10) * 0.9;
      const node = new THREE.Group();
      node.add(
        new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.07 })),
        new THREE.LineSegments(
          new THREE.EdgesGeometry(geo),
          new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.55 })
        )
      );
      node.scale.setScalar(scale);
      const a = i * 2.39996;
      const r = 3 + ((i * 7) % 9);
      node.position.set(Math.cos(a) * r, ((i % 7) - 3) * 2.1, Math.sin(a) * r - 4);
      node.rotation.set(i * 0.5, i * 0.9, i * 0.3);
      shards.add(node);
      items.push({ node, spin: 0.1 + (i % 5) * 0.05, drift: ((i % 3) - 1) * 0.12 });
    }

    const dustGeo = new THREE.BufferGeometry();
    const dn = 220, dp = new Float32Array(dn * 3);
    for (let i = 0; i < dn; i++) {
      dp[i * 3] = Math.cos(i) * (i % 17) - 8;
      dp[i * 3 + 1] = (i % 23) - 11;
      dp[i * 3 + 2] = Math.sin(i) * (i % 13) - 6;
    }
    dustGeo.setAttribute("position", new THREE.BufferAttribute(dp, 3));
    scene.add(
      new THREE.Points(
        dustGeo,
        new THREE.PointsMaterial({ color: 0x8893ac, size: 0.05, transparent: true, opacity: 0.45 })
      )
    );

    let tx = 0, ty = 0, cx = 0, cy = 0;
    const onMove = (e: PointerEvent) => {
      tx = e.clientX / window.innerWidth - 0.5;
      ty = e.clientY / window.innerHeight - 0.5;
    };
    if (!reduce) window.addEventListener("pointermove", onMove, { passive: true });

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
      items.forEach((it) => {
        it.node.rotation.x += dt * it.spin * 0.5;
        it.node.rotation.y += dt * it.spin;
        it.node.position.y += dt * it.drift;
        if (it.node.position.y > 9) it.node.position.y = -9;
        if (it.node.position.y < -9) it.node.position.y = 9;
      });
      cx += (tx - cx) * 0.04;
      cy += (ty - cy) * 0.04;
      camera.position.x = cx * 4;
      camera.position.y = -cy * 3;
      camera.lookAt(0, 0, 0);
      shards.rotation.y += dt * 0.03;
      renderer.render(scene, camera);
      if (!reduce) raf = requestAnimationFrame(frame);
    };
    if (reduce) renderer.render(scene, camera);
    else raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener("pointermove", onMove);
      renderer.dispose();
    };
  }, []);

  return <canvas id="scene2" ref={canvasRef} aria-hidden="true" />;
}
