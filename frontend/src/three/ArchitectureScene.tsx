import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { useHeat } from "../heat";

/**
 * THE BLUEPRINT — the fortification under load. An interactive model of the
 * Multi-Provider B2B platform: hard-isolated provider silos drawn into one
 * ember-hot unified-search core. Drag to spin · hover/focus a node to read its
 * dispatch · click/Enter to pin · scroll to parallax. The core runs at the
 * site's live temperature. Degrades to a static blueprint + legend.
 */
const KEY = ["core", "silo", "silo", "silo", "silo", "silo", "sync", "analytics", "notif", "commission"] as const;

const DISPATCH: Record<string, { title: string; body: string; meta: string; tags: string[] }> = {
  core: {
    title: "Unified-search core",
    body: "A denormalized index drawn from all five provider silos — one sub-second search across tenants that stay hard-isolated upstream.",
    meta: "p95 −60% · GraphQL Subscriptions",
    tags: ["NestJS", "PostgreSQL", "Redis"],
  },
  silo: {
    title: "Provider silo",
    body: "A hard-isolated, table-per-provider database. No query crosses a tenant boundary — each provider's data stays its own.",
    meta: "5 silos · zero cross-tenant leakage",
    tags: ["PostgreSQL", "Multi-tenant"],
  },
  sync: {
    title: "Sync pipeline",
    body: "Zero-downtime sync and backfill that reconciles every silo into the search index without taking the platform offline.",
    meta: "zero-downtime backfill",
    tags: ["Redis queue", "Idempotent"],
  },
  analytics: {
    title: "Analytics engine",
    body: "Cross-silo analytics and reporting computed over the denormalized index rather than the isolated silos.",
    meta: "cross-silo rollups",
    tags: ["Aggregation"],
  },
  notif: {
    title: "Notifications",
    body: "Real-time updates pushed to clients via GraphQL Subscriptions the moment data changes.",
    meta: "live subscriptions",
    tags: ["GraphQL Subs"],
  },
  commission: {
    title: "Commission engine",
    body: "Commission and payout views rolled up across every provider silo in one place.",
    meta: "unified commission view",
    tags: ["Billing"],
  },
};

interface Hoverable {
  group: THREE.Group;
  mesh: THREE.Object3D;
  wire: THREE.LineSegments;
  line: THREE.Line | null; // supply line to the core
  baseColor: THREE.Color;
  scale: number;
}

export default function ArchitectureScene() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const heat = useHeat();
  const heatRef = useRef(heat);
  heatRef.current = heat;

  const [active, setActive] = useState(0); // index into hoverables (0 = core)
  const pinnedRef = useRef(0);
  const setActiveRef = useRef<(i: number) => void>(() => {});
  setActiveRef.current = setActive;
  const activeRef = useRef(0);
  activeRef.current = active;

  useEffect(() => {
    const canvasEl = canvasRef.current;
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
    scene.fog = new THREE.FogExp2(0x0b0807, 0.08);
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0.6, 8);

    const EMBER = 0xe2611c, OXIDE = 0x9a3f24, STEEL = 0x9a8e7e, WHITE = 0xfff1c9;
    const ZERO = new THREE.Vector3(0, 0, 0);
    const group = new THREE.Group();
    scene.add(group);

    const hoverables: Hoverable[] = [];

    // Unified-search core — the bar at welding heat
    const coreGeo = new THREE.IcosahedronGeometry(0.95, 1);
    const coreSolid = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: EMBER, transparent: true, opacity: 0.14 }));
    const coreWire = new THREE.LineSegments(new THREE.EdgesGeometry(coreGeo), new THREE.LineBasicMaterial({ color: EMBER, transparent: true, opacity: 0.95 }));
    const core = new THREE.Group();
    core.add(coreSolid, coreWire);
    group.add(core);
    hoverables.push({ group: core, mesh: coreSolid, wire: coreWire, line: null, baseColor: new THREE.Color(EMBER), scale: 1 });

    const halo = new THREE.Sprite(new THREE.SpriteMaterial({
      map: radialTexture(EMBER), transparent: true, opacity: 0.5, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    halo.scale.set(4.4, 4.4, 1);
    group.add(halo);

    const NODES = [STEEL, STEEL, STEEL, STEEL, STEEL, OXIDE, OXIDE, OXIDE, EMBER];
    const SILO = 5;
    const R = 3.15;
    const pulses: { mesh: THREE.Mesh; from: THREE.Vector3; t: number; speed: number }[] = [];

    NODES.forEach((color, idx) => {
      const p = fibonacciPoint(idx, NODES.length, R);
      const geo = idx < SILO ? new THREE.BoxGeometry(0.4, 0.4, 0.4) : new THREE.OctahedronGeometry(0.32, 0);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.16 }));
      const wire = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.85 }));
      const node = new THREE.Group();
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({
        map: radialTexture(color), transparent: true, opacity: 0.28, blending: THREE.AdditiveBlending, depthWrite: false,
      }));
      glow.scale.setScalar(1.15);
      node.add(mesh, wire, glow);
      node.position.copy(p);
      group.add(node);

      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([p, ZERO]),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.22 })
      );
      group.add(line);
      hoverables.push({ group: node, mesh, wire, line, baseColor: new THREE.Color(color), scale: 1 });

      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(0.07, 12, 12),
        new THREE.MeshBasicMaterial({ color: EMBER, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false })
      );
      group.add(pulse);
      pulses.push({ mesh: pulse, from: p.clone(), t: (idx * 0.11) % 1, speed: 0.18 + (idx % 4) * 0.05 });
    });

    group.add(starfield(150, 9));

    // --- interaction ---
    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const hoverMeshes = hoverables.map((h) => h.mesh);
    let hoverIdx = -1;
    let dragging = false;
    let moved = false;
    let lastX = 0, lastY = 0, velY = 0;
    let scrollTilt = 0;

    const apply = (idx: number) => setActiveRef.current(idx >= 0 ? idx : pinnedRef.current);

    const onDown = (e: PointerEvent) => { dragging = true; moved = false; lastX = e.clientX; lastY = e.clientY; };
    const onUp = () => {
      if (dragging && !moved && hoverIdx >= 0) { pinnedRef.current = hoverIdx; apply(hoverIdx); }
      dragging = false;
    };
    const onMove = (e: PointerEvent) => {
      if (dragging) {
        if (Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY) > 3) moved = true;
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
      const idx = hit ? hoverables.findIndex((h) => h.mesh === hit.object) : -1;
      if (idx !== hoverIdx) { hoverIdx = idx; apply(idx); canvas.style.cursor = idx >= 0 ? "pointer" : "grab"; }
    };
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    canvas.style.cursor = "grab";

    const onScroll = () => { scrollTilt = Math.min(1, Math.max(0, (window.scrollY - 700) / 1100)); };
    window.addEventListener("scroll", onScroll, { passive: true });

    function resize() {
      const r = canvas.getBoundingClientRect();
      const w = Math.max(1, r.width), h = Math.max(1, r.height);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const clock = new THREE.Clock();
    const tmpColor = new THREE.Color();
    const whiteColor = new THREE.Color(WHITE);
    let raf = 0;
    let coreFlash = 0;

    function frame() {
      const dt = clock.getDelta();
      const t = clock.elapsedTime;
      const sel = activeRef.current;
      // live heat: 840..1280 → 0..1
      const heatNorm = Math.max(0, Math.min(1, (heatRef.current.tempC - 840) / 440));
      const banked = heatRef.current.status !== "operational";

      if (coreFlash > 0) coreFlash = Math.max(0, coreFlash - dt * 2);
      if (!dragging) { group.rotation.y += dt * 0.16 + velY; velY *= 0.94; }

      core.rotation.y += dt * 0.4;
      core.rotation.x += dt * 0.15;
      core.scale.setScalar(1 + Math.sin(t * 1.6) * 0.04 + heatNorm * 0.12);
      (halo.material as THREE.SpriteMaterial).opacity = (banked ? 0.18 : 0.34) + heatNorm * 0.3 + coreFlash;
      (coreWire.material as THREE.LineBasicMaterial).opacity = 0.7 + heatNorm * 0.3 + coreFlash;
      (coreSolid.material as THREE.MeshBasicMaterial).color.copy(hoverables[0].baseColor).lerp(whiteColor, heatNorm * 0.5);

      for (let i = 0; i < hoverables.length; i++) {
        const h = hoverables[i];
        const hot = i === sel;
        const target = hot ? (i === 0 ? 1.12 : 1.45) : 1;
        h.scale += (target - h.scale) * 0.18;
        if (i !== 0) h.group.scale.setScalar(h.scale);
        const wm = h.wire.material as THREE.LineBasicMaterial;
        tmpColor.copy(h.baseColor).lerp(whiteColor, hot ? 0.85 : 0);
        wm.color.copy(tmpColor);
        wm.opacity = hot ? 1 : 0.8;
        if (h.line) {
          const lm = h.line.material as THREE.LineBasicMaterial;
          lm.color.copy(h.baseColor).lerp(whiteColor, hot ? 0.7 : 0);
          lm.opacity = hot ? 0.85 : 0.2;
        }
      }

      pulses.forEach((p) => {
        p.t += dt * p.speed * (banked ? 0.3 : 1);
        if (p.t > 1) { p.t -= 1; coreFlash = Math.min(0.25, coreFlash + 0.07); }
        p.mesh.position.lerpVectors(p.from, ZERO, p.t);
        const fade = Math.sin(p.t * Math.PI);
        (p.mesh.material as THREE.MeshBasicMaterial).opacity = 0.15 + fade * 0.75;
        p.mesh.scale.setScalar(0.6 + fade * 0.9);
      });

      const ty = 0.6 - scrollTilt * 1.2, tz = 8 + scrollTilt * 1.8;
      camera.position.y += (ty - camera.position.y) * 0.08;
      camera.position.z += (tz - camera.position.z) * 0.08;
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
      if (running) raf = requestAnimationFrame(frame);
    }
    let running = false;
    const start = () => { if (!running && !reduce) { running = true; clock.getDelta(); raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    const vio = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0 });
    vio.observe(canvas);
    if (reduce) renderer.render(scene, camera);
    else start();

    return () => {
      stop();
      ro.disconnect();
      vio.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("scroll", onScroll);
      renderer.dispose();
    };
  }, []);

  const d = DISPATCH[KEY[active]];
  // De-duplicate the 5 silos in the node list — one button stands for all silos.
  const nodeButtons = [0, 1, 6, 7, 8, 9];

  return (
    <div className="bp">
      <div className="bp-stage">
        <canvas id="scene" className="bp-canvas" ref={canvasRef} aria-hidden="true" />
        <ul className="bp-nodes" aria-label="System components">
          {nodeButtons.map((i) => (
            <li key={i}>
              <button
                type="button"
                className={`bp-node ${active === i || (KEY[active] === "silo" && KEY[i] === "silo") ? "on" : ""}`}
                onMouseEnter={() => setActive(i)}
                onFocus={() => setActive(i)}
                onClick={() => { pinnedRef.current = i; setActive(i); }}
              >
                <span className="bp-node-dot" data-kind={KEY[i]} aria-hidden="true" />
                {DISPATCH[KEY[i]].title}
              </button>
            </li>
          ))}
        </ul>
      </div>

      <aside className="bp-dispatch" aria-live="polite">
        <span className="bp-dispatch-k">▸ Dispatch</span>
        <h3 className="bp-dispatch-title">{d.title}</h3>
        <p className="bp-dispatch-body">{d.body}</p>
        <p className="bp-dispatch-meta">{d.meta}</p>
        <ul className="bp-dispatch-tags">{d.tags.map((t) => <li key={t}>{t}</li>)}</ul>
      </aside>

      {/* Survives WebGL failure / reduced motion */}
      <p className="bp-legend">
        <span><i className="bp-leg ember" /> core</span>
        <span><i className="bp-leg steel" /> provider silo</span>
        <span><i className="bp-leg oxide" /> service</span>
        <span className="bp-leg-impact">p95 −60% · sub-second cross-silo · GraphQL Subscriptions</span>
      </p>
    </div>
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
  return new THREE.Points(geo, new THREE.PointsMaterial({ color: 0x6b5d4f, size: 0.04, transparent: true, opacity: 0.5 }));
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
