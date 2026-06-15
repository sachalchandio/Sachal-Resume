import type { ReactNode } from "react";

export default function Footer({ name, children }: { name: string; children: ReactNode }) {
  const year = new Date().getFullYear();
  return (
    <footer className="footer">
      <span>
        © {year} {name}
      </span>
      <span className="footer-built">{children}</span>
    </footer>
  );
}
