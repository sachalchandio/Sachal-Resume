import {
  createElement,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ElementType,
  type ReactNode,
} from "react";

interface RevealProps {
  as?: ElementType;
  className?: string;
  delay?: number;
  id?: string;
  style?: CSSProperties;
  children: ReactNode;
  [key: string]: unknown;
}

/** Wraps content in a `.reveal` element that fades up when scrolled into view. */
export default function Reveal({
  as = "div",
  className = "",
  delay,
  id,
  style,
  children,
  ...rest
}: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
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
  }, []);

  return createElement(
    as,
    {
      ...rest,
      ref,
      id,
      className: `reveal ${className} ${inView ? "in" : ""}`.replace(/\s+/g, " ").trim(),
      style: delay != null ? { ...style, transitionDelay: `${delay}s` } : style,
    },
    children
  );
}
