import { useEffect, useState } from "react";

/** Cycles through `words` in the gradient headline accent. */
export default function Rotator({ words }: { words: string[] }) {
  const [i, setI] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || words.length < 2) return;
    const id = window.setInterval(() => {
      setVisible(false);
      window.setTimeout(() => {
        setI((p) => (p + 1) % words.length);
        setVisible(true);
      }, 280);
    }, 2600);
    return () => window.clearInterval(id);
  }, [words.length]);

  return (
    <span className="rotator">
      <span
        key={i}
        className="rotator-word"
        style={{ opacity: visible ? 1 : 0, transform: visible ? "none" : "translateY(8px)" }}
      >
        {words[i]}
      </span>
    </span>
  );
}
