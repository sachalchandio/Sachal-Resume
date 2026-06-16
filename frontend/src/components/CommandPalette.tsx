import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

interface Cmd {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

/** ⌘K / Ctrl-K command palette — fuzzy-jump anywhere, open links, copy email. */
export default function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-cmdk", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-cmdk", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement;
      setQ("");
      setActive(0);
      window.setTimeout(() => inputRef.current?.focus(), 10);
    } else {
      triggerRef.current?.focus?.();
    }
  }, [open]);

  const scrollTo = (id: string) => {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: "smooth" });
    else {
      navigate("/");
      window.setTimeout(() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth" }), 350);
    }
  };

  const commands: Cmd[] = useMemo(
    () => [
      { id: "top", label: "Back to top", hint: "page", run: () => scrollTo("top") },
      { id: "about", label: "Go to About", hint: "section", run: () => scrollTo("about") },
      { id: "work", label: "Go to Selected work", hint: "section", run: () => scrollTo("work") },
      { id: "journey", label: "Go to Deployment history", hint: "section", run: () => scrollTo("journey") },
      { id: "stack", label: "Go to Toolbox", hint: "section", run: () => scrollTo("stack") },
      { id: "contact", label: "Go to Contact", hint: "section", run: () => scrollTo("contact") },
      { id: "building", label: "Open Currently Building", hint: "page", run: () => navigate("/projects") },
      { id: "offduty", label: "Open Off-Duty", hint: "page", run: () => navigate("/off-duty") },
      { id: "resume", label: "Download résumé", hint: "PDF", run: () => { window.location.href = "/Sachal_Chandio_Resume.pdf"; } },
      { id: "github", label: "Open GitHub", hint: "link", run: () => window.open("https://github.com/sachalchandio", "_blank") },
      { id: "linkedin", label: "Open LinkedIn", hint: "link", run: () => window.open("https://www.linkedin.com/in/sachal-chandio-749b7528/", "_blank") },
      { id: "youtube", label: "Open YouTube", hint: "link", run: () => window.open("https://www.youtube.com/c/sachalchandio", "_blank") },
      { id: "email", label: "Copy email address", hint: "sachalchandio@gmail.com", run: () => navigator.clipboard?.writeText("sachalchandio@gmail.com") },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  const filtered = useMemo(() => {
    const needle = q.toLowerCase().trim();
    if (!needle) return commands;
    return commands.filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(needle));
  }, [q, commands]);

  useEffect(() => setActive(0), [q]);

  if (!open) return null;

  const choose = (c?: Cmd) => {
    if (!c) return;
    c.run();
    setOpen(false);
  };

  return (
    <div className="cmdk" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={() => setOpen(false)}>
      <div className="cmdk-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="cmdk-input"
          placeholder="Type a command or search…"
          value={q}
          role="combobox"
          aria-expanded="true"
          aria-controls="cmdk-list"
          aria-activedescendant={filtered[active] ? `cmdk-${filtered[active].id}` : undefined}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(a + 1, filtered.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); choose(filtered[active]); }
            else if (e.key === "Tab") { e.preventDefault(); }
          }}
        />
        <ul className="cmdk-list" id="cmdk-list" role="listbox">
          {filtered.length === 0 && <li className="cmdk-empty">No matches</li>}
          {filtered.map((c, i) => (
            <li
              key={c.id}
              id={`cmdk-${c.id}`}
              role="option"
              aria-selected={i === active}
              className={`cmdk-item ${i === active ? "active" : ""}`}
              onMouseEnter={() => setActive(i)}
              onClick={() => choose(c)}
            >
              <span>{c.label}</span>
              {c.hint && <span className="cmdk-hint">{c.hint}</span>}
            </li>
          ))}
        </ul>
        <div className="cmdk-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>
          <span><kbd>↵</kbd> select</span>
          <span><kbd>esc</kbd> close</span>
        </div>
      </div>
    </div>
  );
}
