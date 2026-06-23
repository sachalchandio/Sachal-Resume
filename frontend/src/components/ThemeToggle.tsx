import { useEffect, useState } from "react";

/** Forge-lit (dark) ⇆ cooled (light) theme toggle. Dark is the default; the
 *  choice persists in localStorage and is applied pre-paint by a tiny script in
 *  index.html to avoid a flash. */
export default function ThemeToggle() {
  const [light, setLight] = useState(false);

  useEffect(() => {
    setLight(document.documentElement.getAttribute("data-theme") === "light");
  }, []);

  const toggle = () => {
    const next = !light;
    setLight(next);
    const el = document.documentElement;
    if (next) el.setAttribute("data-theme", "light");
    else el.removeAttribute("data-theme");
    try {
      localStorage.setItem("theme", next ? "light" : "dark");
    } catch {
      /* private mode — ignore */
    }
  };

  return (
    <button
      className="theme-toggle"
      type="button"
      onClick={toggle}
      aria-label={`Switch to ${light ? "dark forge" : "light"} theme`}
      title={light ? "Light the forge" : "Cool it down"}
    >
      {light ? (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2c1 3-1 4-2 6s0 4 2 4 3-2 2-5c2 1 4 4.2 4 7a6 6 0 1 1-12 0c0-4 4-6 6-12z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.2 5.2l1.5 1.5M17.3 17.3l1.5 1.5M18.8 5.2l-1.5 1.5M6.7 17.3l-1.5 1.5" />
        </svg>
      )}
    </button>
  );
}
