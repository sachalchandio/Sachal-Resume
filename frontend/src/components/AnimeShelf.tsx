import { useState, type CSSProperties } from "react";
import type { Anime } from "../types";
import { slugify } from "../util";

/** Cinematic anime selector — pick a title, the section background crossfades to
 *  that poster and the details + quotes animate in. */
export default function AnimeShelf({ anime }: { anime: Anime[] }) {
  const [active, setActive] = useState(0);
  const a = anime[active];

  return (
    <div className="ashelf" style={{ ["--accent" as string]: a.accent } as CSSProperties}>
      {/* crossfading poster backgrounds */}
      <div className="ashelf-bg" aria-hidden="true">
        {anime.map((x, i) => (
          <div
            key={x.title}
            className={`ashelf-bg-layer ${i === active ? "on" : ""}`}
            style={{ backgroundImage: `url(/anime/${slugify(x.title)}.jpg)` }}
          />
        ))}
        <div className="ashelf-bg-veil" />
      </div>

      <div className="ashelf-grid">
        <div className="ashelf-tabs" role="tablist" aria-label="Anime">
          {anime.map((x, i) => (
            <button
              key={x.title}
              role="tab"
              aria-selected={i === active}
              className={`ashelf-tab ${i === active ? "on" : ""}`}
              style={{ ["--accent" as string]: x.accent } as CSSProperties}
              onClick={() => setActive(i)}
              onMouseEnter={() => setActive(i)}
            >
              <span className="ashelf-tab-no">{String(i + 1).padStart(2, "0")}</span>
              <span className="ashelf-tab-title">{x.title}</span>
            </button>
          ))}
        </div>

        <div className="ashelf-stage" key={active}>
          <div className="ashelf-poster">
            <img
              src={`/anime/${slugify(a.title)}.jpg`}
              alt={a.title}
              onError={(e) => { e.currentTarget.style.visibility = "hidden"; }}
            />
            <span className="ashelf-poster-mark" aria-hidden="true">{a.title.charAt(0)}</span>
          </div>
          <div className="ashelf-detail">
            <span className="ashelf-kicker">{a.kicker}</span>
            <h3 className="ashelf-title">{a.title}</h3>
            <ul className="ashelf-quotes">
              {a.quotes.map((q, k) => (
                <li key={k} className="ashelf-quote" style={{ animationDelay: `${0.12 + k * 0.08}s` }}>
                  <span className="quote-mark">“</span>
                  <span>{q}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </div>
  );
}
