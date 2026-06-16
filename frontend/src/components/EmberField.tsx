import { useEffect, useRef } from "react";

interface Ember {
  x: number; y: number; r: number; sp: number; drift: number; flick: number; col: string;
}

/** Rising ember particles — cinematic dark-fantasy atmosphere for the projects hero. */
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
    const N = 80;
    const spawn = (atBottom = false): Ember => ({
      x: Math.random() * w,
      y: atBottom ? h + Math.random() * 40 : Math.random() * h,
      r: (0.6 + Math.random() * 2.2) * dpr,
      sp: (0.25 + Math.random() * 0.9) * dpr,
      drift: (Math.random() - 0.5) * 0.5 * dpr,
      flick: Math.random() * Math.PI * 2,
      col: Math.random() < 0.62 ? colors[0] : colors[1],
    });
    let parts: Ember[] = [];

    const resize = () => {
      const r = canvas.getBoundingClientRect();
      w = canvas.width = Math.max(1, Math.floor(r.width * dpr));
      h = canvas.height = Math.max(1, Math.floor(r.height * dpr));
      if (parts.length === 0) parts = Array.from({ length: N }, () => spawn());
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    let raf = 0;
    const frame = () => {
      ctx.clearRect(0, 0, w, h);
      for (const p of parts) {
        p.y -= p.sp;
        p.x += Math.sin(p.y * 0.01) * p.drift;
        p.flick += 0.08;
        if (p.y < -12) Object.assign(p, spawn(true));
        const alpha = 0.35 + Math.sin(p.flick) * 0.25 + (1 - p.y / h) * 0.3;
        ctx.globalAlpha = Math.max(0, Math.min(0.85, alpha));
        ctx.fillStyle = p.col;
        ctx.shadowBlur = 10 * dpr;
        ctx.shadowColor = p.col;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.shadowBlur = 0;
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
