import { useHeat } from "../heat";

/** A one-line echo of the hero's live temperature — bookends the page so the
 *  "still running" feeling closes where it opened. */
export default function HeatEcho() {
  const heat = useHeat();
  const running = heat.status === "operational";
  return (
    <span className={`heat-echo ${running ? "is-running" : "is-banked"}`}>
      <span className="heat-echo-dot" aria-hidden="true" />
      {running ? "still running" : "banked"} · {heat.tempC}°C
    </span>
  );
}
