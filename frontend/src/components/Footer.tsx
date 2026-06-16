import type { ReactNode } from "react";
import StatusPill from "./StatusPill";

export default function Footer({ name, children }: { name: string; children: ReactNode }) {
  const year = new Date().getFullYear();
  return (
    <footer className="footer">
      <span>
        © {year} {name}
      </span>
      <span className="footer-mid">
        <StatusPill />
        <button
          className="cmdk-hintbtn"
          onClick={() => window.dispatchEvent(new Event("open-cmdk"))}
          aria-label="Open command palette"
        >
          <kbd>⌘</kbd>
          <kbd>K</kbd> menu
        </button>
      </span>
      <span className="footer-built">{children}</span>
    </footer>
  );
}
