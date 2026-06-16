import { useEffect, useState, type CSSProperties } from "react";
import { getProjects } from "../api";
import type { ProjectWIP } from "../types";
import Nav, { type NavLink } from "../components/Nav";
import Footer from "../components/Footer";
import Reveal from "../components/Reveal";
import EmberField from "../components/EmberField";
import ProjectsScene from "../three/ProjectsScene";

export default function Projects() {
  const [data, setData] = useState<ProjectWIP[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    document.title = "Currently Building — Sachal Chandio";
    window.scrollTo(0, 0);
    getProjects().then((d) => setData(d.building)).catch(() => setError(true));
  }, []);

  if (error) return <div className="od-load">Couldn’t reach the API. Is the Flask backend running?</div>;
  if (!data) return <div className="od-load">Loading…</div>;

  const p = data[0];
  const vars = { "--poe": p.accent, "--poe-gold": p.accentGold } as CSSProperties;

  const links: NavLink[] = [
    { label: "Overview", href: "#overview" },
    { label: "Under the hood", href: "#tech" },
    { label: "Approach", href: "#approach" },
  ];
  const ctas: NavLink[] = [
    { label: "Off-duty", href: "/off-duty", route: true },
    { label: "← Portfolio", href: "/", route: true },
  ];

  return (
    <div className="poe" style={vars}>
      <a className="skip-link" href="#overview">Skip to overview</a>
      <Nav brandTo="/" brandRoute links={links} ctas={ctas} />

      <main>
        {/* HERO */}
        <section className="poe-hero">
          <div className="poe-hero-bg" />
          <ProjectsScene />
          <div className="poe-hero-veil" />
          <EmberField colors={["#FF6A2B", "#E8B23A"]} />
          <div className="poe-hero-inner">
            <Reveal as="p" className="poe-status">
              <span className="poe-status-dot" aria-hidden="true" />{p.status} · Path of Exile 2
            </Reveal>
            <Reveal as="h1" className="poe-title">{p.name}</Reveal>
            <Reveal as="p" className="poe-tagline">{p.tagline}</Reveal>
            <Reveal className="poe-hero-actions">
              <a className="btn btn-lg poe-btn" href="#overview">Read the build ↓</a>
              <a className="btn btn-ghost btn-lg" href="https://github.com/sachalchandio" target="_blank" rel="noopener">GitHub</a>
            </Reveal>
          </div>
        </section>

        {/* OVERVIEW + PROBLEM */}
        <section className="section poe-section" id="overview">
          <Reveal className="section-head">
            <span className="section-index poe-ix">01</span>
            <h2>The pitch</h2>
          </Reveal>
          <Reveal className="poe-lead">{p.pitch}</Reveal>

          <Reveal className="poe-problem">
            <span className="poe-eyebrow">The problem it solves</span>
            <p>{p.problem}</p>
          </Reveal>
        </section>

        {/* WHAT IT DOES */}
        <section className="section poe-section">
          <Reveal className="section-head">
            <span className="section-index poe-ix">02</span>
            <h2>What it does</h2>
            <p>import → simulate → search the market → rank by value → buy, on one screen.</p>
          </Reveal>
          <div className="poe-does">
            {p.does.map((d, i) => (
              <Reveal as="article" className="poe-does-card" delay={i * 0.05} key={d.k}>
                <span className="poe-does-no">{String(i + 1).padStart(2, "0")}</span>
                <h3>{d.k}</h3>
                <p>{d.v}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* TECHNICAL HIGHLIGHT */}
        <section className="section poe-section" id="tech">
          <Reveal className="poe-tech">
            <span className="poe-eyebrow poe-eyebrow-gold">⚙ Under the hood — the hard part</span>
            <h2 className="poe-tech-title">{p.technical.title}</h2>
            <p className="poe-tech-body">{p.technical.body}</p>
            <p className="poe-tech-foot">…and it's invisible to the user, which is exactly the point.</p>
          </Reveal>
        </section>

        {/* FEATURES — bento */}
        <section className="section poe-section">
          <Reveal className="section-head">
            <span className="section-index poe-ix">03</span>
            <h2>Feature highlights</h2>
          </Reveal>
          <div className="poe-bento">
            {p.features.map((f, i) => (
              <Reveal as="article" className={`poe-feat ${i === 0 ? "poe-feat-wide" : ""}`} delay={i * 0.04} key={i}>
                <span className="poe-feat-icon">{f.icon}</span>
                <p>{f.text}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* TECH STACK */}
        <section className="section poe-section">
          <Reveal className="section-head">
            <span className="section-index poe-ix">04</span>
            <h2>Tech stack</h2>
          </Reveal>
          <div className="poe-stack">
            {Object.entries(p.stack).map(([group, items]) => (
              <Reveal className="poe-stack-group" key={group}>
                <h3>{group}</h3>
                <ul className="chip-row">
                  {items.map((it) => <li className="chip poe-chip" key={it}>{it}</li>)}
                </ul>
              </Reveal>
            ))}
          </div>
        </section>

        {/* METHODOLOGY */}
        <section className="section poe-section" id="approach">
          <Reveal className="section-head">
            <span className="section-index poe-ix">05</span>
            <h2>Engineering methodology</h2>
            <p>Treated as a systems-design problem, not just an app.</p>
          </Reveal>
          <div className="poe-method">
            {p.methodology.map((m, i) => (
              <Reveal as="article" className="poe-method-card" delay={i * 0.04} key={m.k}>
                <h3>{m.k}</h3>
                <p>{m.v}</p>
              </Reveal>
            ))}
          </div>
        </section>

        {/* AMBITION */}
        <section className="section poe-section">
          <Reveal className="poe-ambition">
            <span className="poe-eyebrow poe-eyebrow-gold">Ambition</span>
            <p>{p.ambition}</p>
          </Reveal>
        </section>
      </main>

      <Footer name="Sachal Chandio">
        <a href="/">← back to the portfolio</a>
      </Footer>
    </div>
  );
}
