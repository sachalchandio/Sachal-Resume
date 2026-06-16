import { useEffect, useState } from "react";

/** Pings the real Flask /healthz endpoint — live proof the backend is up. */
export default function StatusPill() {
  const [state, setState] = useState<{ ok: boolean; uptime?: number }>({ ok: false });

  useEffect(() => {
    let alive = true;
    const ping = async () => {
      try {
        const r = await fetch("/healthz");
        const d = await r.json();
        if (alive) setState({ ok: r.ok, uptime: d.uptime_seconds });
      } catch {
        if (alive) setState({ ok: false });
      }
    };
    ping();
    const id = window.setInterval(ping, 15000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const fmt = (s?: number) => {
    if (s == null) return "";
    if (s < 60) return `${Math.round(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  };

  return (
    <span
      className={`status-pill ${state.ok ? "ok" : "down"}`}
      title={state.ok ? `API healthy · uptime ${fmt(state.uptime)}` : "API unreachable"}
    >
      <i className="status-pill-dot" />
      {state.ok ? `API live · ${fmt(state.uptime)}` : "API offline"}
    </span>
  );
}
