/* System-glyph family — one drawing hand: 24×24, 1.6 stroke, rounded joins.
   Monoline glyphs label data across the page; the three social marks are drawn
   solid so they stay recognizable at small sizes. Add a new key here, then
   reference it by name with <Icon name="…" />. */
const paths: Record<string, JSX.Element> = {
  // ── capability glyphs (kept stable — referenced from content.py) ──
  api: (
    <>
      <path d="M8 4 4 8l4 4" />
      <path d="m16 4 4 4-4 4" />
      <path d="M13 3 11 21" />
      <path d="M3 18h6" />
      <path d="M15 18h6" />
    </>
  ),
  data: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
      <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
    </>
  ),
  cloud: (
    <>
      <path d="M12 2 4 6v6c0 4.5 3.4 8.3 8 9.5 4.6-1.2 8-5 8-9.5V6Z" />
      <path d="m9 12 2 2 4-4" />
    </>
  ),
  speed: (
    <>
      <path d="M12 21a9 9 0 1 0-9-9" />
      <path d="M12 12 8 8" />
      <path d="M3 12h2" />
      <path d="M12 3v2" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),

  // ── metric / telemetry glyphs ──
  pulse: (
    <>
      <path d="M2 12h4l2.5-7 4.5 14 2.5-7H22" />
    </>
  ),
  cube: (
    <>
      <path d="M12 2.5 3.5 7v10L12 21.5 20.5 17V7Z" />
      <path d="m3.5 7 8.5 4.6L20.5 7" />
      <path d="M12 11.6v9.9" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 14 4-4" />
      <circle cx="12" cy="18" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V11" />
      <path d="M10 20V4" />
      <path d="M16 20v-6" />
      <path d="M3 20h18" />
    </>
  ),

  // ── stack-category glyphs ──
  braces: (
    <>
      <path d="M8 3c-2 0-2.6 1.2-2.6 3v2.4c0 1.3-.7 2.1-2.4 2.6 1.7.5 2.4 1.3 2.4 2.6V18c0 1.8.6 3 2.6 3" />
      <path d="M16 3c2 0 2.6 1.2 2.6 3v2.4c0 1.3.7 2.1 2.4 2.6-1.7.5-2.4 1.3-2.4 2.6V18c0 1.8-.6 3-2.6 3" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="1.6" />
      <rect x="3" y="13" width="18" height="7" rx="1.6" />
      <path d="M7 7.5h.01M7 16.5h.01" />
      <path d="M16 7.5h3M16 16.5h3" />
    </>
  ),
  cloudnet: (
    <>
      <path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 1 0 6.5 19h11Z" />
    </>
  ),
  browser: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 9h18" />
      <path d="M6.5 6.5h.01M9 6.5h.01" />
    </>
  ),
  terminal: (
    <>
      <rect x="2.5" y="4" width="19" height="16" rx="2" />
      <path d="m6 9 3 3-3 3" />
      <path d="M13 15h5" />
    </>
  ),

  // ── build-log content glyphs ──
  layers: (
    <>
      <path d="m12 2 9 5-9 5-9-5 9-5Z" />
      <path d="m3 12 9 5 9-5" />
      <path d="m3 17 9 5 9-5" />
    </>
  ),
  bolt: <path d="M13 2 3 14h7l-1 8 10-12h-7l1-8Z" />,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21a8 8 0 0 1 16 0" />
    </>
  ),
  git: (
    <>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="9" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 11.5c0 3.2-3 4.2-6 4.6" />
    </>
  ),
  tag: (
    <>
      <path d="M12 2H5a3 3 0 0 0-3 3v7l10 10 10-10Z" />
      <circle cx="7" cy="7" r="1.3" fill="currentColor" stroke="none" />
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
      <path d="M3 9.5h18" />
      <path d="M8 2.5v4" />
      <path d="M16 2.5v4" />
    </>
  ),
  spark: <path d="M12 2l1.9 6.1L20 10l-6.1 1.9L12 18l-1.9-6.1L4 10l6.1-1.9L12 2Z" />,
  message: <path d="M4 5h16v11H9l-5 4V5Z" />,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </>
  ),
  money: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6 9.5v5M18 9.5v5" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 3 3 5-6" />
    </>
  ),
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-2.6-6.3" />
      <path d="M21 4v5h-5" />
    </>
  ),
  link: (
    <>
      <path d="M9 15 15 9" />
      <path d="M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5" />
      <path d="M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5" />
    </>
  ),
  rocket: (
    <>
      <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2" />
      <path d="M9.5 13.5C12 6 17 4 20 4c0 3-2 8-9.5 10.5l-1-1Z" />
      <circle cx="15" cy="9" r="1.4" />
    </>
  ),
  beaker: (
    <>
      <path d="M9 3v6l-5 9a2 2 0 0 0 1.8 3h12.4a2 2 0 0 0 1.8-3l-5-9V3" />
      <path d="M8 3h8" />
      <path d="M6.5 15h11" />
    </>
  ),
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="10" width="16" height="11" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 8.5 4.1-.9 7-4.3 7-8.5V6Z" />
      <path d="m9 11.5 2 2 4-4" />
    </>
  ),

  // ── contact / utility glyphs ──
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3.5 7 8.5 5.6L20.5 7" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8Z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12" />
      <path d="m7 11 5 4.5 5-4.5" />
      <path d="M5 21h14" />
    </>
  ),

  // ── UI glyphs ──
  "arrow-right": (
    <>
      <path d="M5 12h14" />
      <path d="m13 6 6 6-6 6" />
    </>
  ),
  "arrow-left": (
    <>
      <path d="M19 12H5" />
      <path d="m11 6-6 6 6 6" />
    </>
  ),
  "arrow-up": (
    <>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4-2v-4L3 5Z" />,
  close: (
    <>
      <path d="M6 6 18 18" />
      <path d="M18 6 6 18" />
    </>
  ),

  // ── brand marks (solid for legibility) ──
  github: (
    <path
      fill="currentColor"
      stroke="none"
      d="M12 1.6A10.4 10.4 0 0 0 1.6 12c0 4.6 3 8.5 7.1 9.9.52.1.71-.23.71-.5v-1.94c-2.9.63-3.5-1.24-3.5-1.24-.48-1.2-1.16-1.52-1.16-1.52-.95-.65.07-.64.07-.64 1.05.08 1.6 1.08 1.6 1.08.93 1.6 2.45 1.14 3.05.87.1-.68.36-1.14.66-1.4-2.31-.27-4.74-1.16-4.74-5.14 0-1.13.4-2.06 1.07-2.79-.11-.27-.46-1.33.1-2.77 0 0 .87-.28 2.85 1.06a9.8 9.8 0 0 1 5.2 0c1.98-1.34 2.85-1.06 2.85-1.06.56 1.44.21 2.5.1 2.77.67.73 1.07 1.66 1.07 2.79 0 3.99-2.43 4.86-4.75 5.12.38.32.71.95.71 1.92v2.85c0 .28.19.61.72.5A10.4 10.4 0 0 0 22.4 12 10.4 10.4 0 0 0 12 1.6Z"
    />
  ),
  linkedin: (
    <path
      fill="currentColor"
      stroke="none"
      d="M4.98 3.5a2.5 2.5 0 1 1 0 5.001 2.5 2.5 0 0 1 0-5ZM3.2 9.2h3.56V21H3.2V9.2Zm5.86 0h3.41v1.61h.05c.47-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46V21h-3.56v-5.3c0-1.27-.03-2.9-1.77-2.9-1.77 0-2.04 1.38-2.04 2.8V21H9.06V9.2Z"
    />
  ),
  youtube: (
    <path
      fill="currentColor"
      stroke="none"
      d="M22.6 7.3a2.6 2.6 0 0 0-1.83-1.84C19.15 5 12 5 12 5s-7.15 0-8.77.46A2.6 2.6 0 0 0 1.4 7.3C1 8.93 1 12 1 12s0 3.07.4 4.7a2.6 2.6 0 0 0 1.83 1.84C4.85 19 12 19 12 19s7.15 0 8.77-.46a2.6 2.6 0 0 0 1.83-1.84C23 15.07 23 12 23 12s0-3.07-.4-4.7ZM9.75 15.02V8.98L15.5 12l-5.75 3.02Z"
    />
  ),
};

export default function Icon({ name, className }: { name: string; className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths[name] ?? null}
    </svg>
  );
}
