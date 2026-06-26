import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import Nav, { type NavLink } from "../components/Nav";
import Footer from "../components/Footer";
import Reveal from "../components/Reveal";
import Icon from "../components/Icon";
import { getBlogIndex } from "../api";
import type { BlogIndexData, BlogPostMeta } from "../types";

const CATEGORY_ICON: Record<string, string> = {
  Performance: "speed",
  Databases: "data",
  "Real-time": "bolt",
  Backend: "terminal",
  Frontend: "layers",
  Security: "shield",
  Architecture: "compass",
  DevOps: "refresh",
  "Data Viz": "chart",
  Monthly: "calendar",
};

const catIcon = (c: string) => CATEGORY_ICON[c] ?? "spark";

export default function BlogList() {
  const { tag: routeTag } = useParams();
  const navigate = useNavigate();
  const tag = routeTag ?? null;

  const [data, setData] = useState<BlogIndexData | null>(null);
  const [error, setError] = useState(false);
  const [q, setQ] = useState("");
  const [kind, setKind] = useState<"all" | "deepdive" | "monthly">("all");
  const [cat, setCat] = useState<string | null>(null);

  useEffect(() => {
    window.scrollTo(0, 0);
    let alive = true;
    getBlogIndex()
      .then((d) => alive && setData(d))
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
    };
  }, []);

  // Reset the category facet when arriving on / leaving a tag page.
  useEffect(() => setCat(null), [tag]);

  const posts = data?.posts ?? [];

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return posts.filter((p) => {
      if (kind !== "all" && p.kind !== kind) return false;
      if (cat && p.category !== cat) return false;
      if (tag && !p.tags.includes(tag)) return false;
      if (needle) {
        const hay = `${p.title} ${p.description} ${p.tags.join(" ")} ${p.category}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [posts, q, kind, cat, tag]);

  const groups = useMemo(() => {
    const m = new Map<string, BlogPostMeta[]>();
    for (const p of filtered) {
      const y = p.date.slice(0, 4) || "—";
      (m.get(y) ?? m.set(y, []).get(y)!).push(p);
    }
    return Array.from(m.entries()).sort((a, b) => b[0].localeCompare(a[0]));
  }, [filtered]);

  const pickTag = (t: string) => navigate(`/log/tag/${encodeURIComponent(t)}`);
  const clear = () => {
    setQ("");
    setKind("all");
    setCat(null);
    if (tag) navigate("/log");
  };

  const ctas: NavLink[] = [
    { label: "Building", href: "/projects", route: true },
    { label: "← Portfolio", href: "/", route: true },
  ];

  const s = data?.stats;
  const docTitle = tag ? `#${tag} — Field Notes — Sachal Chandio` : "Field Notes — Sachal Chandio";

  return (
    <div className="bl">
      <Helmet>
        <title>{docTitle}</title>
        <meta
          name="description"
          content={
            tag
              ? `Posts tagged ${tag} — technical field notes from building Telelinkz with NestJS, TypeORM, GraphQL and Angular.`
              : "Technical deep dives and a monthly build log from shipping Telelinkz — a production telecom-sales CRM. Real problems, real code, real fixes."
          }
        />
      </Helmet>
      <a className="skip-link" href="#log">Skip to the log</a>
      <Nav brandTo="/" brandRoute links={[]} ctas={ctas} />

      <main>
        <section className="bl-hero">
          <div className="bl-hero-grid" aria-hidden="true" />
          <div className="bl-hero-inner">
            <Reveal as="p" className="bl-eyebrow">
              <span className="bl-eyebrow-dot" aria-hidden="true" />
              {tag ? "Tagged dispatches" : "Field notes"}
            </Reveal>
            <Reveal as="h1" className="bl-title">
              {tag ? <>Everything tagged <span className="bl-title-accent">{tag}</span></> : <>Field notes from the&nbsp;forge</>}
            </Reveal>
            <Reveal as="p" className="bl-lead">
              Deep dives and a month-by-month log of building <strong>Telelinkz</strong> — a production
              CRM for telecom sales teams. Each post is drawn straight from the commit history of the
              NestJS&nbsp;backend and the Angular&nbsp;frontend: the real problems I hit and how I fixed them.
            </Reveal>
            {s && (
              <Reveal className="bl-stats">
                <span className="bl-stat"><b>{s.total}</b><i>posts</i></span>
                <span className="bl-stat"><b>{s.deepdives}</b><i>deep dives</i></span>
                <span className="bl-stat"><b>{s.commits.toLocaleString()}</b><i>commits mined</i></span>
                <span className="bl-stat"><b>{s.tags}</b><i>topics</i></span>
              </Reveal>
            )}
          </div>
        </section>

        <section className="section bl-section" id="log">
          {error ? (
            <p className="bl-empty">The log didn’t load. <button className="bl-textbtn" onClick={() => location.reload()}>Try again</button>.</p>
          ) : !data ? (
            <p className="bl-empty">Loading the log…</p>
          ) : (
            <>
              <div className="bl-toolbar">
                <label className="bl-search">
                  <Icon name="search" />
                  <input
                    type="search"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search posts, tech, topics…"
                    aria-label="Search the log"
                  />
                </label>
                <div className="bl-kinds" role="tablist" aria-label="Filter by type">
                  {([["all", "All"], ["deepdive", "Deep dives"], ["monthly", "Monthly log"]] as const).map(
                    ([k, label]) => (
                      <button
                        key={k}
                        className={`bl-pill ${kind === k ? "is-on" : ""}`}
                        onClick={() => setKind(k)}
                        role="tab"
                        aria-selected={kind === k}
                      >
                        {label}
                      </button>
                    ),
                  )}
                </div>
              </div>

              <div className="bl-cats">
                <button className={`bl-cat ${!cat ? "is-on" : ""}`} onClick={() => setCat(null)}>All topics</button>
                {data.categories.map((c) => (
                  <button
                    key={c.category}
                    className={`bl-cat ${cat === c.category ? "is-on" : ""}`}
                    onClick={() => setCat(cat === c.category ? null : c.category)}
                  >
                    <Icon name={catIcon(c.category)} /> {c.category}
                    <i className="bl-cat-n">{c.count}</i>
                  </button>
                ))}
              </div>

              {(tag || cat || q || kind !== "all") && (
                <div className="bl-active">
                  <span className="bl-active-count">{filtered.length} {filtered.length === 1 ? "post" : "posts"}</span>
                  {tag && <span className="bl-chip"><Icon name="tag" />{tag}</span>}
                  <button className="bl-tagclear" onClick={clear}><Icon name="close" /> Clear filters</button>
                </div>
              )}

              {groups.length === 0 ? (
                <p className="bl-empty">
                  Nothing matches that. <button className="bl-textbtn" onClick={clear}>Clear the filters</button> to see everything.
                </p>
              ) : (
                <div className="bl-stream">
                  {groups.map(([y, list]) => (
                    <div className="bl-yeargroup" key={y}>
                      <div className="bl-yearmark"><span>{y}</span></div>
                      {list.map((p, i) => (
                        <Reveal as="article" className="bl-dispatch" delay={Math.min(i * 0.03, 0.3)} key={p.slug}>
                          <span className="bl-node" aria-hidden="true" />
                          <div
                            className="bl-card"
                            onClick={() => navigate(`/log/${p.slug}`)}
                            role="link"
                            tabIndex={0}
                            onKeyDown={(e) => e.key === "Enter" && navigate(`/log/${p.slug}`)}
                          >
                            <div className="bl-card-top">
                              <span className={`bl-kindtag ${p.kind}`}>
                                <Icon name={catIcon(p.category)} />
                                {p.kind === "monthly" ? "Build log" : p.category}
                              </span>
                              <span className="bl-period">
                                {p.kind === "monthly" && p.stats?.commits
                                  ? (<><Icon name="git" />{p.stats.commits} commits</>)
                                  : (<><Icon name="clock" />{p.reading_time} min</>)}
                              </span>
                            </div>
                            <Link to={`/log/${p.slug}`} className="bl-card-titlelink" onClick={(e) => e.stopPropagation()}>
                              <h2 className="bl-card-title">{p.title}</h2>
                            </Link>
                            <p className="bl-card-sum">{p.description || p.excerpt}</p>
                            <div className="bl-card-foot">
                              <ul className="bl-tags">
                                {p.tags.slice(0, 4).map((t) => (
                                  <li key={t}>
                                    <button className="bl-tag" onClick={(e) => { e.stopPropagation(); pickTag(t); }}>
                                      {t}
                                    </button>
                                  </li>
                                ))}
                              </ul>
                              <span className="bl-read">Read<Icon name="arrow-right" /></span>
                            </div>
                          </div>
                        </Reveal>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </main>

      <Footer name="Sachal Chandio">
        <a href="/">← back to the portfolio</a>
      </Footer>
    </div>
  );
}
