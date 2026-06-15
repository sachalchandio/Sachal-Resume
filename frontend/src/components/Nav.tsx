import { useState, type ReactNode } from "react";
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
    <span className="brand-mark">[</span>SC<span className="brand-mark">]</span>
  </>
);

export default function Nav({ brandTo, brandRoute, links, ctas }: NavProps) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

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

      <nav className="nav-links" aria-label="Primary">
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
        className="nav-toggle"
        aria-label="Toggle menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span></span>
        <span></span>
      </button>
    </header>
  );
}
