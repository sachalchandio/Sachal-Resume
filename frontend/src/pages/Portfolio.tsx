import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { getPortfolio } from "../api";
import type { PortfolioData } from "../types";
import Nav, { type NavLink } from "../components/Nav";
import Footer from "../components/Footer";
import Reveal from "../components/Reveal";
import Counter from "../components/Counter";
import Rotator from "../components/Rotator";
import Portrait from "../components/Portrait";
import CapabilityCard from "../components/CapabilityCard";
import ContactForm from "../components/ContactForm";
import ForgeGauge from "../components/ForgeGauge";
import EmberField from "../components/EmberField";
import HeatEcho from "../components/HeatEcho";
import ArchitectureScene from "../three/ArchitectureScene";
import { HeatProvider } from "../heat";

export default function Portfolio() {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    document.title = "Sachal Chandio — Senior Backend Engineer";
    getPortfolio().then(setData).catch(() => setError(true));
  }, []);

  if (error) return <LoadScreen text="Couldn’t reach the API. Is the Flask backend running?" />;
  if (!data) return <LoadScreen text="Loading…" />;

  const { profile, metrics, capabilities, about, projects, experience, stack, education, youtube } = data;

  const links: NavLink[] = [
    { label: "Work", href: "#work" },
    { label: "About", href: "#about" },
    { label: "Building", href: "/projects", route: true },
    { label: "Off-duty", href: "/off-duty", route: true },
    { label: "Contact", href: "#contact" },
  ];
  const ctas: NavLink[] = [
    { label: "GitHub", href: profile.links.github, external: true },
    { label: "Résumé ↓", href: "/Sachal_Chandio_Resume.pdf" },
  ];

  return (
    <HeatProvider>
      <a className="skip-link" href="#work">Skip to work</a>
      <Nav brandTo="#top" links={links} ctas={ctas} />

      <main>
        {/* 00 · THE FIRE — thesis-led forge hero */}
        <section className="hero" id="hero">
          <div className="hero-amb" aria-hidden="true"><EmberField colors={["#E2611C", "#D9A441"]} /></div>
          <div className="hero-amb-veil" aria-hidden="true" />

          <Reveal className="hero-inner hero-forge">
            <ForgeGauge />
            <h1 className="hero-thesis-xl">
              {profile.headline_lead}{" "}
              <span className="hl-rot"><Rotator words={profile.headline_rotate} /></span>.
            </h1>
            <p className="hero-roleline">
              <span>{profile.role}</span><i aria-hidden="true" />
              <span>{profile.focus}</span><i aria-hidden="true" />
              <span>{profile.location}</span>
            </p>
            <p className="hero-summary">{profile.summary}</p>
            <div className="hero-cta">
              <a className="btn btn-solid btn-lg" href="#blueprint">Enter the forge →</a>
              <a className="btn btn-ghost btn-lg" href="/Sachal_Chandio_Resume.pdf" download>Résumé ↓</a>
              <a className="hero-link" href={profile.links.github} target="_blank" rel="noopener">GitHub ↗</a>
            </div>
          </Reveal>

          <Reveal className="hero-ingots" aria-label="Forged in production">
            {metrics.map((m) => (
              <div className="ingot" key={m.label}>
                <span className="ingot-num">
                  <span className="ingot-prefix">{m.prefix}</span>
                  <Counter target={m.value} />
                  <span className="ingot-suffix">{m.suffix}</span>
                </span>
                <span className="ingot-label">{m.label}</span>
                <span className="ingot-note">{m.note}</span>
              </div>
            ))}
          </Reveal>
        </section>

        {/* 01 · THE CREED */}
        <section className="section-creed" aria-label="Creed">
          <Reveal className="creed-inner">
            <p className="creed-line">“I am a struggler. I have never been anything else.”</p>
            <span className="creed-attrib">Berserk · the struggler’s creed</span>
          </Reveal>
        </section>

        {/* 02 · THE BLUEPRINT — interactive architecture */}
        <section className="section section-blueprint" id="blueprint">
          <Reveal className="section-head">
            <span className="section-index">01</span>
            <h2>The fortification under load</h2>
            <p>Five provider silos, hard-isolated, drawn into one sub-second search. Hover the iron to read its dispatch.</p>
          </Reveal>
          <Reveal className="bp-frame">
            <ArchitectureScene />
          </Reveal>
        </section>

        {/* ABOUT */}
        <section className="section section-about" id="about">
          <div className="about-grid">
            <Reveal className="about-copy">
              <span className="section-index">02</span>
              <h2>Backend by trade, system-thinker by habit.</h2>
              {about.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
            </Reveal>
            <Reveal as="aside" className="about-facts">
              <Portrait
                src="/profile.jpg"
                alt="Sachal Chandio"
                wrapClass="about-portrait"
                imgClass="portrait-img"
                fallback={<div className="about-monogram" aria-hidden="true"><span className="mono-line"><span>[</span>SC<span>]</span></span></div>}
              />
              <dl>
                {about.facts.map((f) => (
                  <div className="fact" key={f.k}><dt>{f.k}</dt><dd>{f.v}</dd></div>
                ))}
              </dl>
            </Reveal>
          </div>
        </section>

        {/* CAPABILITIES */}
        <section className="section" id="capabilities">
          <Reveal className="section-head">
            <span className="section-index">03</span>
            <h2>What I forge well</h2>
            <p>Four things I get asked to own — and the tools I reach for.</p>
          </Reveal>
          <div className="cap-grid">
            {capabilities.map((c, i) => <CapabilityCard key={c.title} c={c} index={i} />)}
          </div>
        </section>

        {/* 03 · THE WORK — forged blades */}
        <section className="section" id="work">
          <Reveal className="section-head">
            <span className="section-index">04</span>
            <h2>Pieces that left the forge</h2>
            <p>The problem, the strike of the hammer, and what held under load.</p>
          </Reveal>
          <div className="work-list">
            {projects.map((p) => (
              <Reveal as="article" className={`work-card accent-${p.accent}`} id={p.id} key={p.id}>
                <div className="work-main">
                  <header className="work-header">
                    <h3>{p.name}</h3>
                    <p className="work-org">{p.org}</p>
                    <p className="work-tagline">{p.tagline}</p>
                  </header>
                  <div className="work-detail">
                    <div className="work-block"><span className="work-k">Problem</span><p>{p.problem}</p></div>
                    <div className="work-block"><span className="work-k">The strike</span><p>{p.approach}</p></div>
                  </div>
                  <ul className="chip-row">{p.stack.map((s) => <li className="chip" key={s}>{s}</li>)}</ul>
                </div>
                <aside className="work-impact">
                  <span className="work-k">Held</span>
                  <ul>{p.impact.map((i, k) => <li key={k}>{i}</li>)}</ul>
                </aside>
              </Reveal>
            ))}
          </div>
        </section>

        {/* 04 · THE TEMPER LINE — experience that cools as it descends */}
        <section className="section section-temper" id="journey">
          <Reveal className="section-head">
            <span className="section-index">05</span>
            <h2>The temper line</h2>
            <p>Quenched and tempered over six years. The bar runs hottest where I’m working now.</p>
          </Reveal>
          <ol className="timeline">
            {experience.map((e, i) => (
              <Reveal as="li" className={`tl-item ${e.current ? "tl-current" : ""}`} key={i}>
                <span className="tl-node"></span>
                <div className="tl-body">
                  <div className="tl-top"><h3>{e.role}</h3><span className="tl-period">{e.period}</span></div>
                  <p className="tl-company">{e.company} <span className="sep">·</span> {e.location}</p>
                  <p className="tl-summary">{e.summary}</p>
                  <ul className="chip-row chip-row-sm">{e.stack.map((s) => <li className="chip chip-sm" key={s}>{s}</li>)}</ul>
                </div>
              </Reveal>
            ))}
          </ol>
        </section>

        {/* STACK */}
        <section className="section" id="stack">
          <Reveal className="section-head">
            <span className="section-index">06</span>
            <h2>The rack</h2>
            <p>The tools on the wall, grouped by where they live.</p>
          </Reveal>
          <div className="stack-grid">
            {Object.entries(stack).map(([group, items]) => (
              <Reveal className="stack-group" key={group}>
                <h3 className="stack-group-title">{group}</h3>
                <ul className="chip-row">{items.map((it) => <li className="chip" key={it}>{it}</li>)}</ul>
              </Reveal>
            ))}
          </div>
          <Reveal className="edu">
            {education.map((ed, i) => (
              <div className="edu-row" key={i}>
                <span className="edu-degree">{ed.degree}</span>
                <span className="edu-school">{ed.school}</span>
              </div>
            ))}
          </Reveal>
        </section>

        {/* OFF THE CLOCK */}
        <section className="section" id="offclock">
          <Reveal className="offclock-card">
            <Portrait
              src="/profile.jpg"
              alt="Sachal Chandio off the clock"
              wrapClass="offclock-media"
              imgClass="offclock-img"
              fallback={<div className="offclock-badge" aria-hidden="true"><span className="mono-line"><span>[</span>SC<span>]</span></span></div>}
            />
            <div className="offclock-copy">
              <span className="section-index">05</span>
              <h2>There’s a human behind the commits.</h2>
              <p>
                Off the clock I’m grinding Counter-Strike 2 retakes, riding across the plains in
                Red Dead Redemption 2, re-reading Berserk for the hundredth time, and posting on
                YouTube. I keep a whole page of the games and stories that stuck with me.
              </p>
              <ul className="chip-row">
                <li className="chip">Counter-Strike 2</li>
                <li className="chip">Red Dead Redemption 2</li>
                <li className="chip">Anime &amp; manga</li>
                <li className="chip">YouTube</li>
              </ul>
              <div className="offclock-actions">
                <Link className="btn btn-solid" to="/off-duty">Meet the off-duty me →</Link>
                <a className="btn btn-ghost" href={youtube} target="_blank" rel="noopener">YouTube channel</a>
              </div>
            </div>
          </Reveal>
        </section>

        {/* CONTACT */}
        <section className="section section-contact" id="contact">
          <Reveal className="contact-card">
            <div className="contact-copy">
              <span className="section-index">06</span>
              <h2>Let’s build something durable.</h2>
              <p>{profile.availability}. The fastest way to reach me is below.</p>
              <div className="contact-links">
                <a href={`mailto:${profile.email}`}>{profile.email}</a>
                <a href={profile.links.linkedin} target="_blank" rel="noopener">LinkedIn</a>
                <a href={profile.links.github} target="_blank" rel="noopener">GitHub</a>
                <a href={youtube} target="_blank" rel="noopener">YouTube</a>
                <a href="/Sachal_Chandio_Resume.pdf" download>Résumé (PDF)</a>
              </div>
            </div>
            <ContactForm />
          </Reveal>
        </section>
      </main>

      <Footer name={profile.name}>
        <HeatEcho /> · forged with Flask · React · Three.js · Docker · Kubernetes —{" "}
        <a href={profile.links.github} target="_blank" rel="noopener">source</a>
      </Footer>
    </HeatProvider>
  );
}

function LoadScreen({ text }: { text: string }) {
  return (
    <div style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "var(--mono)", color: "var(--muted)" }}>
      {text}
    </div>
  );
}
