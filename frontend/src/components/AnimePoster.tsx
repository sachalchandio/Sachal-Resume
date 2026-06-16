import { useState, type CSSProperties } from "react";
import { slugify } from "../util";

/** Anime poster with an accent-gradient + initial fallback until art is added
 *  at /public/anime/<slug>.jpg. */
export default function AnimePoster({ title, accent }: { title: string; accent: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <div className="anime-poster" style={{ "--accent": accent } as CSSProperties}>
      {!failed ? (
        <img
          src={`/anime/${slugify(title)}.jpg`}
          alt={`${title} poster`}
          loading="lazy"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="anime-poster-mark" aria-hidden="true">{title.charAt(0)}</span>
      )}
    </div>
  );
}
