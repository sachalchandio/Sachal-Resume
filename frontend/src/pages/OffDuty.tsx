import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";
import { getOffDuty } from "../api";
import type { OffDutyData } from "../types";
import Nav, { type NavLink } from "../components/Nav";
import Footer from "../components/Footer";
import Reveal from "../components/Reveal";
import CrystalScene from "../three/CrystalScene";

const accent = (color: string) => ({ ["--accent"]: color } as CSSProperties);

export default function OffDuty() {
  const [data, setData] = useState<OffDutyData | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    document.title = "Off-Duty — Sachal Chandio";
    window.scrollTo(0, 0);
    getOffDuty().then(setData).catch(() => setError(true));
  }, []);

  if (error)
    return <div className="od-load">Couldn’t reach the API. Is the Flask backend running?</div>;
  if (!data) return <div className="od-load">Loading…</div>;

  const { gaming, anime, berserk, youtube, profile } = data;

  const links: NavLink[] = [
    { label: "Playing", href: "#playing" },
    { label: "The shelf", href: "#shelf" },
    { label: "Berserk", href: "#berserk" },
    { label: "Channel", href: "#channel" },
  ];
  const ctas: NavLink[] = [
    { label: "YouTube", href: youtube, external: true },
    { label: "← Portfolio", href: "/", route: true },
  ];

  return (
    <>
      <a className="skip-link" href="#shelf">Skip to the shelf</a>
      <Nav brandTo="/" brandRoute links={links} ctas={ctas} />

      <main>
        {/* HERO */}
        <section className="od-hero">
          <CrystalScene />
          <div className="od-hero-inner">
            <Reveal as="p" className="eyebrow"><span className="status-dot"></span>the human behind the commits</Reveal>
            <Reveal as="h1" className="od-title">
              Off the<br />
              <span className="od-title-accent">terminal.</span>
            </Reveal>
            <Reveal as="p" className="od-lead">
              I love this work — but I’m not just a stack of buzzwords. When the deploy is green
              and the logs are quiet, you’ll find me in a clutch round, lost in an open world, or
              re-reading a panel that hits harder than it has any right to. Here’s the rest of me.
            </Reveal>
            <Reveal as="a" className="btn btn-solid btn-lg" href="#playing">What I’m into ↓</Reveal>
          </div>
        </section>

        {/* PLAYING */}
        <section className="section" id="playing">
          <Reveal className="section-head">
            <span className="section-index">01</span>
            <h2>Games on rotation</h2>
            <p>What’s installed, and the honest reason I keep coming back to each one.</p>
          </Reveal>
          <div className="game-grid">
            {gaming.map((g) => (
              <Reveal as="article" className="game-card" style={accent(g.accent)} key={g.title}>
                <div className="game-spine"></div>
                <div className="game-body">
                  <div className="game-top">
                    <span className="game-kind">{g.kind}</span>
                    <span className="game-dot" aria-hidden="true"></span>
                  </div>
                  <h3>{g.title}</h3>
                  <p>{g.note}</p>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* SHELF */}
        <section className="section" id="shelf">
          <Reveal className="section-head">
            <span className="section-index">02</span>
            <h2>On the shelf</h2>
            <p>The stories I read between deploys — and five lines from each that stuck.</p>
          </Reveal>
          <div className="shelf">
            {anime.map((a, i) => (
              <Reveal as="article" className="anime" style={accent(a.accent)} key={a.title}>
                <div className="anime-head">
                  <span className="anime-no">{String(i + 1).padStart(2, "0")}</span>
                  <div>
                    <h3 className="anime-title">{a.title}</h3>
                    <p className="anime-kicker">{a.kicker}</p>
                  </div>
                </div>
                <ul className="quotes">
                  {a.quotes.map((q, k) => (
                    <Reveal as="li" className="quote" delay={k * 0.07} key={k}>
                      <span className="quote-mark">“</span>
                      <span className="quote-text">{q}</span>
                    </Reveal>
                  ))}
                </ul>
              </Reveal>
            ))}
          </div>
        </section>

        {/* BERSERK */}
        <section className="section section-berserk" id="berserk">
          <Reveal className="section-head">
            <span className="section-index">03</span>
            <h2>Lines I keep around</h2>
            <p>Berserk, mostly. The struggler’s creed — typeset, not screenshotted.</p>
          </Reveal>
          <div className="berserk-grid">
            {berserk.map((line, i) => (
              <Reveal as="figure" className="berserk-card" delay={i * 0.06} key={i}>
                <blockquote>{line}</blockquote>
                <figcaption>— Berserk, Kentaro Miura</figcaption>
              </Reveal>
            ))}
          </div>
        </section>

        {/* CHANNEL */}
        <section className="section" id="channel">
          <Reveal className="channel-card">
            <div className="channel-copy">
              <span className="section-index">04</span>
              <h2>On the channel</h2>
              <p>I post on YouTube too — come say hi.</p>
            </div>
            <a className="btn btn-solid btn-lg" href={youtube} target="_blank" rel="noopener">
              ▶ youtube.com/c/sachalchandio
            </a>
          </Reveal>
        </section>
      </main>

      <Footer name={profile.name}>
        <Link to="/">← back to the engineering side</Link>
      </Footer>
    </>
  );
}
