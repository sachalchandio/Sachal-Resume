import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";

export interface NavLink {
  label: ReactNode;
  href: string;
  route?: boolean;
  external?: boolean;
}

interface NavProps {
  brandTo: string;
  brandRoute?: boolean;
  links: NavLink[];
  ctas: NavLink[];
}

function LinkItem({ link, className, onClick }: { link: NavLink; className?: string; onClick?: () => void }) {
  if (link.route) {
    return (
      <Link to={link.href} className={className} onClick={onClick}>
        {link.label}
      </Link>
    );
  }
  return (
    <a
      href={link.href}
      className={className}
      onClick={onClick}
      {...(link.external ? { target: "_blank", rel: "noopener" } : {})}
    >
      {link.label}
    </a>
  );
}

const Brand = (
  <>
    <span className="brand-badge" aria-hidden="true">SC</span>
    <span className="brand-word">Sachal Chandio</span>
  </>
);

export default function Nav({ brandTo, brandRoute, links, ctas }: NavProps) {
  const [open, setOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const close = () => setOpen(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className={`nav ${open ? "open" : ""}`} id="top">
      {brandRoute ? (
        <Link to={brandTo} className="brand" aria-label="Home">
          {Brand}
        </Link>
      ) : (
        <a href={brandTo} className="brand" aria-label="Home">
          {Brand}
        </a>
      )}

      <nav className="nav-links" id="nav-primary" aria-label="Primary">
        {links.map((l, i) => (
          <LinkItem key={i} link={l} onClick={close} />
        ))}
      </nav>

      <div className="nav-cta">
        {ctas.map((c, i) => (
          <LinkItem
            key={i}
            link={c}
            className={`btn ${i === ctas.length - 1 ? "btn-solid" : "btn-ghost"}`}
            onClick={close}
          />
        ))}
      </div>

      <button
        ref={toggleRef}
        className="nav-toggle"
        aria-label="Toggle menu"
        aria-expanded={open}
        aria-controls="nav-primary"
        onClick={() => setOpen((o) => !o)}
      >
        <span></span>
        <span></span>
      </button>
    </header>
  );
}
