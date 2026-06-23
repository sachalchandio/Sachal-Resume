import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getStatus } from "./api";

/** The forge's shared heat signal. One live reading — born in the hero gauge,
 *  echoed by the blueprint core and the footer — so the whole page runs at the
 *  same temperature. "Temperature = liveness = craft." */
export interface Heat {
  status: "operational" | "banked";
  tempC: number; // forge temperature mapped from real p95 latency
  p95: number | null;
  last: number | null;
  uptimeSeconds: number;
  requests: number;
  region: string;
  version: string;
  runtime: string;
  sparkline: number[]; // recent real latencies, for the bellows trace
  live: boolean; // have we ever reached the backend?
}

const FALLBACK: Heat = {
  status: "banked",
  tempC: 960,
  p95: null,
  last: null,
  uptimeSeconds: 0,
  requests: 0,
  region: "—",
  version: "—",
  runtime: "—",
  sparkline: [],
  live: false,
};

/** Low latency = hotter working heat; spikes cool the metal. */
export function tempFromLatency(p95: number | null): number {
  if (p95 == null) return 960;
  return Math.round(Math.max(840, Math.min(1280, 1280 - p95 * 2.4)));
}

const HeatContext = createContext<Heat>(FALLBACK);
export const useHeat = () => useContext(HeatContext);

export function HeatProvider({ children }: { children: ReactNode }) {
  const [heat, setHeat] = useState<Heat>(FALLBACK);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const s = await getStatus();
        if (!alive) return;
        setHeat({
          status: s.status === "operational" ? "operational" : "banked",
          tempC: tempFromLatency(s.latency_ms.p95 ?? s.latency_ms.last),
          p95: s.latency_ms.p95,
          last: s.latency_ms.last,
          uptimeSeconds: s.uptime_seconds,
          requests: s.requests_served,
          region: s.region,
          version: s.version,
          runtime: s.runtime,
          sparkline: s.samples && s.samples.length ? s.samples : [],
          live: true,
        });
      } catch {
        if (!alive) return;
        // The fire is banked, not dead — honest graceful degrade.
        setHeat((h) => ({ ...h, status: "banked" }));
      }
    };
    poll();
    const id = window.setInterval(poll, 2500);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  return <HeatContext.Provider value={heat}>{children}</HeatContext.Provider>;
}
