import { useRef, type PointerEvent } from "react";
import type { Capability } from "../types";
import { useInView } from "../hooks/useInView";
import Icon from "./Icon";

export default function CapabilityCard({ c, index }: { c: Capability; index: number }) {
  const cardRef = useRef<HTMLElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const inView = useInView(cardRef);

  const canTilt = window.matchMedia("(hover: hover)").matches &&
    !window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  const onMove = (e: PointerEvent) => {
    if (!canTilt || !innerRef.current) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    innerRef.current.style.transform = `perspective(800px) rotateX(${(-py * 8).toFixed(2)}deg) rotateY(${(px * 8).toFixed(2)}deg) translateZ(0)`;
  };
  const onLeave = () => {
    if (innerRef.current) innerRef.current.style.transform = "";
  };

  return (
    <article
      ref={cardRef}
      className={`cap-card tilt reveal ${inView ? "in" : ""}`}
      onPointerMove={onMove}
      onPointerLeave={onLeave}
    >
      <div className="cap-card-inner" ref={innerRef}>
        <div className="cap-top">
          <div className="cap-icon" data-icon={c.icon}>
            <Icon name={c.icon} />
          </div>
          <span className="cap-no">0{index + 1}</span>
        </div>
        <h3>{c.title}</h3>
        <p>{c.body}</p>
        <div className="cap-foot">
          <p className="cap-proof">
            <span className="cap-proof-mark">→</span>
            {c.proof}
          </p>
          <ul className="chip-row">
            {c.tags.map((t) => (
              <li className="chip" key={t}>
                {t}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </article>
  );
}
