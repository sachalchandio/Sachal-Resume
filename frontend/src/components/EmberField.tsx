import { useEffect, useRef } from "react";

type Kind = 0 | 1 | 2; // 0 ember · 1 soft cinder · 2 fast spark

interface Ember {
  x: number; y: number;
  r: number;
  sp: number;
  drift: number;
  phase: number;
  flickSp: number;
  stretch: number;
  kind: Kind;
  sprite: HTMLCanvasElement;
  core: boolean;
  life: number; maxLife: number;
}

/** Rising ember field. Performance-first: the glow is rendered ONCE into cached
 *  sprites and drawn per-particle with additive blending — no per-frame
 *  shadowBlur (which previously dragged the page to ~10fps). */
export default function EmberField({ colors }: { colors: [string, string] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const dpr = Math.min(window.devicePixelRatio, 1.5);
    let w = 0, h = 0;

    // Pre-render glow sprites ONCE (the only place shadowBlur runs).
    const makeGlow = (hex: string, baseR: number) => {
      const blur = baseR * 1.7;
      const size = Math.ceil((baseR + blur) * 2);
      const c = document.createElement("canvas");
      c.width = c.height = size;
      const g = c.getContext("2d")!;
      g.shadowBlur = blur;
      g.shadowColor = hex;
      g.fillStyle = hex;
      for (let i = 0; i < 2; i++) {
        g.beginPath();
        g.arc(size / 2, size / 2, baseR, 0, Math.PI * 2);
        g.fill();
      }
      return c;
    };
    const BASE = 7;
    const emberSprite = makeGlow(colors[0], BASE);
    const goldSprite = makeGlow(colors[1], BASE);
    const coreSprite = makeGlow("#FFF2CE", BASE * 0.45);

    const pick = (): Kind => {
      const k = Math.random();
      return k < 0.09 ? 2 : k < 0.3 ? 1 : 0;
    };

    const spawn = (atBottom = false): Ember => {
      const kind = pick();
      const big = kind === 1;
      const spark = kind === 2;
      return {
        x: Math.random() * w,
        y: atBottom ? h + Math.random() * 60 : Math.random() * h,
        r: (spark ? 0.5 + Math.random() * 0.7 : big ? 1.6 + Math.random() * 2.2 : 0.7 + Math.random() * 1.6) * dpr,
        sp: (spark ? 1.7 + Math.random() * 1.6 : big ? 0.16 + Math.random() * 0.4 : 0.4 + Math.random() * 1.0) * dpr,
        drift: (Math.random() - 0.5) * (big ? 0.9 : 0.5) * dpr,
        phase: Math.random() * Math.PI * 2,
        flickSp: 0.05 + Math.random() * 0.12,
        stretch: spark ? 2.4 : 1.25,
        kind,
        sprite: spark ? coreSprite : Math.random() < 0.55 ? emberSprite : goldSprite,
        core: !big,
        life: 0,
        maxLife: 150 + Math.random() * 170,
      };
    };

    let parts: Ember[] = [];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      h = canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const N = Math.max(60, Math.min(120, Math.round((rect.width * rect.height) / 13000)));
      parts = Array.from({ length: N }, () => spawn());
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const draw = (p: Ember, alpha: number) => {
      const s = p.sprite;
      const scale = (p.r / BASE) * 2.2;
      const dw = s.width * scale;
      const dh = s.height * scale * p.stretch;
      ctx.globalAlpha = alpha * (p.kind === 1 ? 0.55 : 0.95);
      ctx.drawImage(s, p.x - dw / 2, p.y - dh / 2, dw, dh);
      if (p.core && p.kind !== 1) {
        const cs = (p.r / BASE) * 2 * coreSprite.width * 0.6;
        ctx.globalAlpha = alpha;
        ctx.drawImage(coreSprite, p.x - cs / 2, p.y - cs / 2, cs, cs);
      }
    };

    const baseGlow = (t: number) => {
      const glowH = h * 0.6;
      const pulse = 0.5 + Math.sin(t * 0.018) * 0.13;
      const g = ctx.createLinearGradient(0, h, 0, h - glowH);
      g.addColorStop(0, `rgba(196, 42, 24, ${0.3 * pulse})`);
      g.addColorStop(0.45, `rgba(150, 30, 18, ${0.12 * pulse})`);
      g.addColorStop(1, "rgba(120, 20, 12, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, h - glowH, w, glowH);
    };

    if (reduce) {
      // static sparse field — no animation loop
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      baseGlow(0);
      for (const p of parts) draw(p, 0.4 + (1 - p.y / h) * 0.4);
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      return () => ro.disconnect();
    }

    let raf = 0;
    let t = 0;
    let running = false;
    const frame = () => {
      t += 1;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";
      baseGlow(t);

      for (const p of parts) {
        p.life += 1;
        p.y -= p.sp;
        p.phase += p.flickSp;
        p.x += Math.sin(p.y * 0.01 + p.phase) * p.drift;
        if (p.y < -24 || p.life > p.maxLife) Object.assign(p, spawn(true));

        const fadeIn = Math.min(1, p.life / 18);
        const fadeOut = 1 - Math.min(1, p.life / p.maxLife);
        const heightK = 0.35 + (1 - p.y / h) * 0.5;
        const flick = 0.72 + Math.sin(p.phase * 2) * 0.28;
        const a = Math.max(0, Math.min(1, fadeIn * fadeOut * heightK * flick));
        draw(p, a);
      }

      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (running) raf = requestAnimationFrame(frame);
    };
    const start = () => { if (!running) { running = true; raf = requestAnimationFrame(frame); } };
    const stop = () => { running = false; cancelAnimationFrame(raf); };
    // Pause when scrolled off-screen so it never competes with the rest of the page.
    const io = new IntersectionObserver(([e]) => (e.isIntersecting ? start() : stop()), { threshold: 0 });
    io.observe(canvas);
    start();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
    };
  }, [colors]);

  return <canvas className="ember-canvas" ref={ref} aria-hidden="true" />;
}
