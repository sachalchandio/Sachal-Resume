import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import type { Game } from "../types";
import { slugify } from "../util";

/** Slidable, cover-image game carousel. Each game gets its own cinematic slide.
 *  Drop covers at /public/games/<slug>.jpg; an accent gradient stands in until then. */
export default function GameCarousel({ games, onActive }: { games: Game[]; onActive?: (i: number) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [idx, setIdx] = useState(0);

  const setActive = (n: number) => { setIdx(n); onActive?.(n); };

  const go = (i: number) => {
    const n = (i + games.length) % games.length;
    const el = track.current?.children[n] as HTMLElement | undefined;
    el?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    setActive(n);
  };

  const onScroll = () => {
    const t = track.current;
    if (!t) return;
    const center = t.scrollLeft + t.clientWidth / 2;
    let best = 0, bestD = Infinity;
    Array.from(t.children).forEach((c, i) => {
      const el = c as HTMLElement;
      const cc = el.offsetLeft + el.clientWidth / 2;
      const d = Math.abs(cc - center);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best !== idx) setActive(best);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowRight") { e.preventDefault(); go(idx + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); go(idx - 1); }
  };

  return (
    <div className="gc">
      <button className="gc-nav gc-prev" onClick={() => go(idx - 1)} aria-label="Previous game">‹</button>

      <div className="gc-track" ref={track} onScroll={onScroll} onKeyDown={onKey} tabIndex={0} role="group" aria-label="Games carousel">
        {games.map((g) => (
          <article className="gc-slide" key={g.title} style={{ "--accent": g.accent } as CSSProperties}>
            <div className="gc-cover">
              <img
                className="gc-img"
                src={`/games/${slugify(g.title)}.jpg`}
                alt={g.title}
                loading="lazy"
                onError={(e) => { e.currentTarget.style.display = "none"; }}
              />
              <span className="gc-fallmark" aria-hidden="true">{g.title.charAt(0)}</span>
              <div className="gc-veil" />
            </div>
            <div className="gc-body">
              <span className="gc-kind">{g.kind}</span>
              <h3 className="gc-title">{g.title}</h3>
              <p className="gc-note">{g.note}</p>
            </div>
          </article>
        ))}
      </div>

      <button className="gc-nav gc-next" onClick={() => go(idx + 1)} aria-label="Next game">›</button>

      <div className="gc-dots" role="tablist" aria-label="Game slides">
        {games.map((g, i) => (
          <button
            key={g.title}
            className={`gc-dot ${i === idx ? "active" : ""}`}
            onClick={() => go(i)}
            aria-label={`Show ${g.title}`}
            aria-selected={i === idx}
            role="tab"
          />
        ))}
      </div>
    </div>
  );
}
