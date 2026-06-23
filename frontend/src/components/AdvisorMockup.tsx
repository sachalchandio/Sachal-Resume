/** A representative UI concept of the PoE2 Upgrade Advisor — built in HTML/CSS so
 *  it stays razor-sharp at any resolution and themes cleanly. Frames the product:
 *  paste a build → it simulates the damage and prices every viable item against
 *  the live market → the most DPS per Divine, ranked. */
const UPGRADES = [
  { slot: "Ring", mod: "Added Lightning Damage", gain: 9.8, cost: 1.5, value: 6.5, best: true },
  { slot: "Gloves", mod: "Lightning Penetration", gain: 12.1, cost: 2.0, value: 6.0 },
  { slot: "Boots", mod: "Cast Speed + Movement", gain: 6.2, cost: 1.2, value: 5.2 },
  { slot: "Amulet", mod: "+1 to Lightning Skills", gain: 18.4, cost: 4.0, value: 4.6 },
];
const MAX = 6.5;

export default function AdvisorMockup() {
  return (
    <div className="adv" role="img" aria-label="Concept of the PoE2 Upgrade Advisor interface: a build's current DPS on the left, and a list of recommended item upgrades on the right ranked by damage gain per Divine Orb.">
      <div className="adv-bar" aria-hidden="true">
        <span className="adv-bar-l"><span className="adv-dot" /> PoE2&nbsp;Upgrade&nbsp;Advisor</span>
        <span className="adv-bar-r">
          <span className="adv-pill">⚡ Lightning Sorc · Lvl 92</span>
          <span className="adv-pill ghost">Import build ▾</span>
        </span>
      </div>

      <div className="adv-body" aria-hidden="true">
        <aside className="adv-build">
          <span className="adv-k">Your build</span>
          <div className="adv-dps"><span className="adv-dps-n">2.74M</span><span className="adv-dps-l">current DPS</span></div>
          <ul className="adv-stats">
            <li><span>Skill</span><b>Spark</b></li>
            <li><span>Crit</span><b>71%</b></li>
            <li><span>EHP</span><b>38.2k</b></li>
            <li><span>Budget</span><b>~6 div</b></li>
          </ul>
          <button className="adv-sim" type="button" tabIndex={-1}>Re-simulate ⟳</button>
        </aside>

        <div className="adv-list">
          <div className="adv-list-head">
            <span className="adv-k">Recommended upgrades</span>
            <span className="adv-k-sub">ranked by % DPS per Divine</span>
          </div>
          {UPGRADES.map((u, i) => (
            <div className={`adv-row ${u.best ? "best" : ""}`} key={u.slot}>
              <span className="adv-rank">{i + 1}</span>
              <div className="adv-item"><b>{u.slot}</b><span>{u.mod}</span></div>
              <div className="adv-num"><b className="adv-gain">+{u.gain}%</b><span>DPS</span></div>
              <div className="adv-num"><b>{u.cost} div</b><span>cost</span></div>
              <div className="adv-val">
                <div className="adv-val-track"><div className="adv-val-bar" style={{ width: `${(u.value / MAX) * 100}%` }} /></div>
                <span>{u.value}%/div</span>
              </div>
              {u.best && <span className="adv-best">★ best value</span>}
            </div>
          ))}
          <div className="adv-more">+ 11 more, ranked · simulated against 1.2M live market listings</div>
        </div>
      </div>

      <div className="adv-foot">Interface concept — the advisor runs PoE2's real damage formulas, not estimates</div>
    </div>
  );
}

/** Screen 2 — drill into a recommended item and the live market. */
export function MarketDetail() {
  const listings = [
    { price: "1.4 div", note: "online", best: true },
    { price: "1.5 div", note: "online" },
    { price: "1.6 div", note: "afk 4m" },
  ];
  return (
    <div className="adv adv-sm" role="img" aria-label="Concept: item detail with live market listings and the resulting DPS change.">
      <div className="adv-bar" aria-hidden="true">
        <span className="adv-bar-l"><span className="adv-dot" /> Item · Ring</span>
        <span className="adv-pill ghost">live market</span>
      </div>
      <div className="adv-pad" aria-hidden="true">
        <div className="mkt-item">
          <b className="mkt-name">Storm’s Coil</b>
          <span className="mkt-type">Topaz Ring · rare</span>
          <ul className="mkt-mods">
            <li>+18% to Lightning Damage</li>
            <li>Adds 24–41 Lightning Damage to Spells</li>
            <li>+12% Cast Speed</li>
          </ul>
        </div>
        <span className="adv-k">Cheapest listings</span>
        <div className="mkt-list">
          {listings.map((l, i) => (
            <div className={`mkt-row ${l.best ? "best" : ""}`} key={i}>
              <b>{l.price}</b><span>{l.note}</span>{l.best && <span className="mkt-buy">whisper ▸</span>}
            </div>
          ))}
        </div>
        <div className="mkt-delta">
          <span className="adv-k">DPS after swap</span>
          <b>2.74M → <span className="adv-gain">3.01M</span> <span className="mkt-pct">+9.8%</span></b>
        </div>
      </div>
    </div>
  );
}

/** Screen 3 — the damage-simulation engine behind every number. */
export function DamageSim() {
  const rows = [
    { k: "Base lightning", v: "412 – 1,240" },
    { k: "Increased damage", v: "+186%" },
    { k: "More multipliers", v: "×2.41" },
    { k: "Crit (71% · 3.1×)", v: "+148%" },
    { k: "Lightning penetration", v: "+28%" },
    { k: "Projectiles", v: "9" },
  ];
  return (
    <div className="adv adv-sm" role="img" aria-label="Concept: the damage simulation breakdown that produces the effective DPS figure.">
      <div className="adv-bar" aria-hidden="true">
        <span className="adv-bar-l"><span className="adv-dot" /> Damage simulation</span>
        <span className="adv-pill ghost">Spark</span>
      </div>
      <div className="adv-pad" aria-hidden="true">
        <ul className="sim-rows">
          {rows.map((r) => <li key={r.k}><span>{r.k}</span><b>{r.v}</b></li>)}
        </ul>
        <div className="sim-total"><span className="adv-k">Effective DPS</span><b>2.74M</b></div>
      </div>
    </div>
  );
}
