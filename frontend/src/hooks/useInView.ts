import { useEffect, useState, type RefObject } from "react";

/** Returns true once `ref` scrolls into view (one-shot). Honors reduced motion. */
export function useInView<T extends HTMLElement>(ref: RefObject<T>): boolean {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce || !("IntersectionObserver" in window)) {
      setInView(true);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            setInView(true);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}
