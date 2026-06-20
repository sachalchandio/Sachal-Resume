import { useEffect, useRef } from "react";

type Kind = 0 | 1 | 2; // 0 ember · 1 soft cinder · 2 fast spark

interface Ember {
  x: number; y: number;
  r: number;        // radius
  sp: number;       // upward speed
  drift: number;    // horizontal sway amount
  phase: number;    // sway + flicker phase
  flickSp: number;  // flicker speed
  len: number;      // vertical-trail elongation
  kind: Kind;
  col: string;
  life: number; maxLife: number;
}

/** Rising ember field — layered embers, drifting cinders and fast sparks over a
 *  breathing crimson heat-glow. Additive blending makes overlaps bloom like real fire. */
export default function EmberField({ colors }: { colors: [string, string] }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = Math.min(window.devicePixelRatio, 2);
    let w = 0, h = 0;

    const pick = (): Kind => {
      const k = Math.random();
      return k < 0.09 ? 2 : k < 0.32 ? 1 : 0; // 9% sparks · 23% cinders · 68% embers
    };

    const spawn = (atBottom = false, forced?: Kind): Ember => {
      const kind = forced ?? pick();
      const big = kind === 1;
      const spark = kind === 2;
      return {
        x: Math.random() * w,
        y: atBottom ? h + Math.random() * 60 : Math.random() * h,
        r: (spark ? 0.5 + Math.random() * 0.8 : big ? 1.8 + Math.random() * 2.6 : 0.7 + Math.random() * 1.8) * dpr,
        sp: (spark ? 1.7 + Math.random() * 1.7 : big ? 0.16 + Math.random() * 0.4 : 0.4 + Math.random() * 1.0) * dpr,
        drift: (Math.random() - 0.5) * (big ? 0.9 : 0.5) * dpr,
        phase: Math.random() * Math.PI * 2,
        flickSp: 0.05 + Math.random() * 0.12,
        len: spark ? 5 + Math.random() * 7 : big ? 1.4 : 2.4 + Math.random() * 2,
        kind,
        col: spark ? "#FFE6A6" : Math.random() < 0.6 ? colors[0] : colors[1],
        life: 0,
        maxLife: 150 + Math.random() * 170,
      };
    };

    let parts: Ember[] = [];

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      w = canvas.width = Math.max(1, Math.floor(rect.width * dpr));
      h = canvas.height = Math.max(1, Math.floor(rect.height * dpr));
      const N = Math.max(70, Math.min(150, Math.round((rect.width * rect.height) / 11000)));
      parts = Array.from({ length: N }, () => spawn());
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    let t = 0;
    const frame = () => {
      t += 1;
      ctx.clearRect(0, 0, w, h);
      ctx.globalCompositeOperation = "lighter";

      // breathing heat-glow rising from the base
      const glowH = h * 0.6;
      const pulse = 0.5 + Math.sin(t * 0.018) * 0.13;
      const g = ctx.createLinearGradient(0, h, 0, h - glowH);
      g.addColorStop(0, `rgba(196, 42, 24, ${0.34 * pulse})`);
      g.addColorStop(0.45, `rgba(150, 30, 18, ${0.13 * pulse})`);
      g.addColorStop(1, "rgba(120, 20, 12, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, h - glowH, w, glowH);

      for (const p of parts) {
        p.life += 1;
        p.y -= p.sp;
        p.phase += p.flickSp;
        p.x += Math.sin(p.y * 0.01 + p.phase) * p.drift;
        if (p.y < -24 || p.life > p.maxLife) Object.assign(p, spawn(true));

        const fadeIn = Math.min(1, p.life / 18);
        const fadeOut = 1 - Math.min(1, p.life / p.maxLife);
        const heightK = 0.35 + (1 - p.y / h) * 0.5;
        const flick = 0.7 + Math.sin(p.phase * 2) * 0.3;
        const a = Math.max(0, Math.min(1, fadeIn * fadeOut * heightK * flick));

        // glowing body — elongated vertically for a rising-trail feel
        ctx.globalAlpha = a * (p.kind === 1 ? 0.5 : 0.9);
        ctx.fillStyle = p.col;
        ctx.shadowBlur = (p.kind === 1 ? 18 : 9) * dpr;
        ctx.shadowColor = p.col;
        ctx.beginPath();
        if (p.kind === 2) ctx.ellipse(p.x, p.y, p.r * 0.7, p.r * p.len, 0, 0, Math.PI * 2);
        else ctx.ellipse(p.x, p.y, p.r, p.r * p.len * 0.7, 0, 0, Math.PI * 2);
        ctx.fill();

        // white-hot core for embers + sparks
        if (p.kind !== 1) {
          ctx.globalAlpha = a;
          ctx.fillStyle = "#FFF2CE";
          ctx.shadowBlur = 3 * dpr;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 0.45, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
      ctx.globalCompositeOperation = "source-over";
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [colors]);

  return <canvas className="ember-canvas" ref={ref} aria-hidden="true" />;
}
