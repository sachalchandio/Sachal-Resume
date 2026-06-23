import { useEffect, useRef, useState } from "react";

/** Streams PoE2's official trailer from Steam's CDN as an ambient hero backdrop.
 *  Streamed (not hosted) so there's no megabyte file in the repo / LFS issue.
 *  Gated: desktop only, paused off-screen, skipped on reduced-motion / data-saver —
 *  the static fiery poster image stays as the fallback in those cases. */
const VIDEO_SRC = "https://cdn.akamai.steamstatic.com/steam/apps/257075660/movie480.mp4";

export default function HeroVideo() {
  const [show, setShow] = useState(false);
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const small = window.matchMedia("(max-width: 820px)").matches;
    const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
    if (reduce || small || conn?.saveData) return;
    setShow(true);
  }, []);

  useEffect(() => {
    if (!show) return;
    const v = ref.current;
    if (!v) return;
    const io = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) v.play().catch(() => {}); else v.pause(); },
      { threshold: 0 }
    );
    io.observe(v);
    return () => io.disconnect();
  }, [show]);

  if (!show) return null;
  return (
    <video
      ref={ref}
      className="poe-hero-video"
      src={VIDEO_SRC}
      autoPlay
      muted
      loop
      playsInline
      preload="auto"
      aria-hidden="true"
    />
  );
}
