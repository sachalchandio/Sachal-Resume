import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Helmet } from "react-helmet-async";
import Nav, { type NavLink } from "../components/Nav";
import Footer from "../components/Footer";
import Reveal from "../components/Reveal";
import Icon from "../components/Icon";
import { getBlogPost } from "../api";
import type { BlogPostFull, BlogRef } from "../types";

const origin = () => (typeof window !== "undefined" ? window.location.origin : "");

export default function BlogPost() {
  const { slug } = useParams();
  const [post, setPost] = useState<BlogPostFull | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "missing">("loading");
  const [progress, setProgress] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Fetch the post.
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setStatus("loading");
    setPost(null);
    window.scrollTo(0, 0);
    getBlogPost(slug)
      .then((p) => {
        if (!alive) return;
        setPost(p);
        setStatus("ready");
      })
      .catch(() => alive && setStatus("missing"));
    return () => {
      alive = false;
    };
  }, [slug]);

  // Strip the server-rendered SEO tags so react-helmet (data-rh) owns the head
  // and we don't emit duplicate description / canonical / JSON-LD on hard loads.
  useEffect(() => {
    const sel =
      'meta[name="description"]:not([data-rh]),link[rel="canonical"]:not([data-rh]),' +
      'meta[property^="og:"]:not([data-rh]),meta[name^="twitter:"]:not([data-rh]),' +
      'meta[property^="article:"]:not([data-rh]),script[type="application/ld+json"]:not([data-rh])';
    document.head.querySelectorAll(sel).forEach((el) => el.remove());
  }, [slug]);

  // Reading-progress bar.
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const max = el.scrollHeight - el.clientHeight;
      setProgress(max > 0 ? Math.min(1, Math.max(0, el.scrollTop / max)) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [post]);

  // After the article HTML mounts: add copy buttons to code blocks + wire scroll-spy.
  useEffect(() => {
    const root = bodyRef.current;
    if (!post || !root) return;

    root.querySelectorAll<HTMLElement>(".codehilite").forEach((block) => {
      if (block.querySelector(".plog-copy")) return;
      const btn = document.createElement("button");
      btn.className = "plog-copy";
      btn.type = "button";
      btn.textContent = "Copy";
      btn.addEventListener("click", () => {
        const text = (block.querySelector("pre") ?? block).textContent ?? "";
        navigator.clipboard?.writeText(text).then(() => {
          btn.textContent = "Copied";
          window.setTimeout(() => (btn.textContent = "Copy"), 1400);
        });
      });
      block.appendChild(btn);
    });

    const headers = (post.toc || [])
      .map((t) => (t.id ? document.getElementById(t.id) : null))
      .filter((h): h is HTMLElement => !!h);
    if (!headers.length) return;
    const io = new IntersectionObserver(
      (entries) => {
        const vis = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (vis[0]) setActiveId(vis[0].target.id);
      },
      { rootMargin: "-12% 0px -70% 0px", threshold: 0 },
    );
    headers.forEach((h) => io.observe(h));
    return () => io.disconnect();
  }, [post]);

  const ctas: NavLink[] = [
    { label: "All field notes", href: "/log", route: true },
    { label: "← Portfolio", href: "/", route: true },
  ];

  useEffect(() => {
    document.title = post ? `${post.title} — Sachal Chandio` : "Field Notes — Sachal Chandio";
  }, [post]);

  if (status === "missing") {
    return (
      <div className="plog">
        <Nav brandTo="/" brandRoute links={[]} ctas={ctas} />
        <main>
          <div className="plog-missing">
            <span className="plog-sec-ic"><Icon name="compass" /></span>
            <h1>That post doesn’t exist</h1>
            <p>It may have been renamed. Head back to the index to find your way.</p>
            <Link to="/log" className="btn btn-solid"><Icon name="arrow-left" /> Field notes</Link>
          </div>
        </main>
        <Footer name="Sachal Chandio"><a href="/log">← all field notes</a></Footer>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="plog">
        <Nav brandTo="/" brandRoute links={[]} ctas={ctas} />
        <main><div className="plog-loading">Loading…</div></main>
        <Footer name="Sachal Chandio"><a href="/log">← all field notes</a></Footer>
      </div>
    );
  }

  const url = `${origin()}/log/${post.slug}`;
  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.updated || post.date,
    author: { "@type": "Person", name: post.author, url: origin() || "/" },
    publisher: { "@type": "Person", name: "Sachal Chandio" },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    keywords: post.tags.join(", "),
    articleSection: post.category,
    wordCount: post.word_count,
    inLanguage: "en",
    url,
  };

  const moreTitle = post.kind === "monthly" ? `Deep dives from ${post.period_label}` : "Related reading";
  const more: BlogRef[] = post.kind === "monthly" && post.month_deepdives.length ? post.month_deepdives : post.related;

  return (
    <div className="plog">
      <Helmet>
        <title>{`${post.title} — Sachal Chandio`}</title>
        <meta name="description" content={post.description} />
        <link rel="canonical" href={url} />
        <meta name="author" content={post.author} />
        <meta property="og:type" content="article" />
        <meta property="og:title" content={post.title} />
        <meta property="og:description" content={post.description} />
        <meta property="og:url" content={url} />
        <meta property="article:published_time" content={post.date} />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content={post.title} />
        <meta name="twitter:description" content={post.description} />
        <script type="application/ld+json">{JSON.stringify(ld)}</script>
      </Helmet>

      <div className="plog-progress" style={{ transform: `scaleX(${progress})` }} aria-hidden="true" />
      <Nav brandTo="/" brandRoute links={[]} ctas={ctas} />

      <main>
        <article className="plog-article">
          <Link to="/log" className="plog-back"><Icon name="arrow-left" /> Field notes</Link>

          <header className="plog-header">
            <Reveal as="p" className="plog-period">
              <Icon name={post.kind === "monthly" ? "calendar" : "spark"} />
              {[post.category, post.period_label, `${post.reading_time} min read`].filter(Boolean).join("  ·  ")}
            </Reveal>
            <Reveal as="h1" className="plog-title">{post.title}</Reveal>
            <Reveal as="p" className="plog-summary">{post.description}</Reveal>

            <Reveal className="plog-byline">
              By <strong>{post.author}</strong>
              <span className="plog-dot">·</span>
              <time dateTime={post.date}>{post.period_label || post.date}</time>
              {post.kind === "monthly" && post.stats?.commits ? (
                <><span className="plog-dot">·</span><span><Icon name="git" />{post.stats.commits} commits</span></>
              ) : null}
            </Reveal>

            {post.month_monthly && (
              <Reveal as="p" className="plog-monthlink">
                <Icon name="layers" /> Part of the{" "}
                <Link to={`/log/${post.month_monthly.slug}`}>{post.month_monthly.period_label} build log</Link>.
              </Reveal>
            )}

            <Reveal className="plog-tags">
              {post.tags.map((t) => (
                <Link className="plog-tag" key={t} to={`/log/tag/${encodeURIComponent(t)}`}>
                  <Icon name="tag" />{t}
                </Link>
              ))}
            </Reveal>
          </header>

          <div className="plog-layout">
            {post.toc.length > 0 && (
              <aside className="plog-toc" aria-label="Contents">
                <p className="plog-toc-title">On this page</p>
                <nav>
                  <ul>
                    {post.toc.map((t) => (
                      <li key={t.id} className={`lvl${t.level}`}>
                        <a
                          href={`#${t.id}`}
                          className={activeId === t.id ? "is-active" : ""}
                          onClick={(e) => {
                            e.preventDefault();
                            const el = document.getElementById(t.id);
                            if (el) {
                              window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 90, behavior: "smooth" });
                              history.replaceState(null, "", `#${t.id}`);
                            }
                          }}
                        >
                          {t.text}
                        </a>
                      </li>
                    ))}
                  </ul>
                </nav>
              </aside>
            )}

            <div className="plog-body" ref={bodyRef} dangerouslySetInnerHTML={{ __html: post.html }} />
          </div>

          {more.length > 0 && (
            <section className="plog-more">
              <h2 className="plog-more-title">{moreTitle}</h2>
              <ul className="plog-more-list">
                {more.slice(0, 6).map((r) => (
                  <li key={r.slug}>
                    <Link to={`/log/${r.slug}`}>
                      <span className="plog-more-cat">{r.kind === "monthly" ? "Build log" : r.category}</span>
                      <span className="plog-more-name">{r.title}</span>
                      <Icon name="arrow-right" />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <nav className="plog-pager" aria-label="More posts">
            {post.older ? (
              <Link to={`/log/${post.older.slug}`} className="plog-pagerlink prev">
                <Icon name="arrow-left" />
                <span><i>Older</i><b>{post.older.title}</b></span>
              </Link>
            ) : (
              <span className="plog-pagerlink is-empty" />
            )}
            {post.newer ? (
              <Link to={`/log/${post.newer.slug}`} className="plog-pagerlink next">
                <span><i>Newer</i><b>{post.newer.title}</b></span>
                <Icon name="arrow-right" />
              </Link>
            ) : (
              <span className="plog-pagerlink is-empty" />
            )}
          </nav>
        </article>
      </main>

      <Footer name="Sachal Chandio"><a href="/log">← all field notes</a></Footer>
    </div>
  );
}
