import { useState, type ReactNode } from "react";

interface PortraitProps {
  src: string;
  alt: string;
  wrapClass: string;
  imgClass: string;
  fallback: ReactNode;
}

/**
 * Shows the photo at `src`; if it isn't there yet (404), swaps to `fallback`.
 * Drop the file into /public to light it up — no code change needed.
 */
export default function Portrait({ src, alt, wrapClass, imgClass, fallback }: PortraitProps) {
  const [failed, setFailed] = useState(false);
  return (
    <div className={`${wrapClass} ${failed ? "no-photo" : ""}`}>
      {!failed && <img className={imgClass} src={src} alt={alt} onError={() => setFailed(true)} />}
      {fallback}
    </div>
  );
}
