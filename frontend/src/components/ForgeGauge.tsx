import { useHeat } from "../heat";

const fmtMs = (v: number | null) => {
  if (v == null) return "—";
  if (v < 1) return `${v.toFixed(2)}ms`;
  if (v < 10) return `${v.toFixed(1)}ms`;
  return `${Math.round(v)}ms`;
};

const fmtUptime = (s: number) => {
  if (!s) return "0s";
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${Math.floor(s % 60)}s`;
  return `${Math.floor(s)}s`;
};

function Sparkline({ data }: { data: number[] }) {
  const N = 28;
  const slice = data.slice(-N);
  const bars = slice.length ? slice : Array.from({ length: N }, () => 0);
  const max = Math.max(...bars, 0.001);
  const W = 92;
  const H = 16;
  const bw = W / N;
  return (
    <svg className="fg-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {bars.map((v, i) => {
        const h = slice.length ? Math.max(1.5, (v / max) * H) : 1.5;
        const hot = v <= max * 0.5;
        return (
          <rect
            key={i}
            x={i * bw}
            y={H - h}
            width={Math.max(1, bw - 1)}
            height={h}
            fill={hot ? "var(--ember)" : "var(--blood-oxide)"}
            opacity={0.4 + 0.6 * ((i + 1) / N)}
          />
        );
      })}
    </svg>
  );
}

/** The hero pyrometer — a live readout off the real Flask /api/status, dressed
 *  as a forge temperature gauge. The number eases between polls via a DOM ref
 *  (no per-frame React re-render). */
export default function ForgeGauge() {
  const heat = useHeat();
  const running = heat.status === "operational";

  return (
    <div
      className={`forge-gauge ${running ? "is-running" : "is-banked"}`}
      role="status"
      aria-live="polite"
      aria-label={`Forge ${running ? "running" : "banked, reconnecting"} — p95 latency ${fmtMs(
        heat.p95
      )}, uptime ${fmtUptime(heat.uptimeSeconds)}, ${heat.requests} requests served.`}
    >
      <span className="fg-status">
        <span className="fg-dot" aria-hidden="true" />
        {running ? "LIVE API" : "RECONNECTING"}
      </span>
      <span className="fg-cell" aria-hidden="true">
        <span className="fg-k">p95</span>
        <Sparkline data={heat.sparkline} />
        <span className="fg-v">{fmtMs(heat.p95)}</span>
        <span className="fg-badge">↓60%</span>
      </span>
      <span className="fg-cell fg-right" aria-hidden="true">
        <span className="fg-k">uptime</span>
        <span className="fg-v">{fmtUptime(heat.uptimeSeconds)}</span>
        <span className="fg-dotsep">·</span>
        <span className="fg-v">{heat.requests.toLocaleString()}</span>
        <span className="fg-k">served</span>
      </span>
    </div>
  );
}
