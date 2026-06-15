/* Sachal Chandio — portfolio interactions
   Counters · scroll reveal · 3D tilt · nav · rotating headline · contact form */
(() => {
  "use strict";
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------- Scroll reveal ---------------------------- */
  const revealEls = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) {
    revealEls.forEach((el) => el.classList.add("in"));
  } else {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    revealEls.forEach((el) => io.observe(el));
  }

  /* ------------------------------ Counters ------------------------------- */
  const counters = document.querySelectorAll(".counter");
  const runCounter = (el) => {
    const target = parseFloat(el.dataset.target);
    if (reduceMotion) { el.textContent = target; return; }
    const dur = 1400;
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min((now - start) / dur, 1);
      const eased = 1 - Math.pow(1 - t, 3);
      el.textContent = Math.round(target * eased);
      if (t < 1) requestAnimationFrame(tick);
      else el.textContent = target;
    };
    requestAnimationFrame(tick);
  };
  if ("IntersectionObserver" in window) {
    const cio = new IntersectionObserver(
      (entries) => entries.forEach((e) => {
        if (e.isIntersecting) { runCounter(e.target); cio.unobserve(e.target); }
      }),
      { threshold: 0.6 }
    );
    counters.forEach((c) => cio.observe(c));
  } else {
    counters.forEach((c) => (c.textContent = c.dataset.target));
  }

  /* ----------------------------- 3D tilt cards --------------------------- */
  if (!reduceMotion && window.matchMedia("(hover: hover)").matches) {
    document.querySelectorAll(".tilt").forEach((card) => {
      const inner = card.querySelector(".cap-card-inner") || card;
      const MAX = 8;
      card.addEventListener("pointermove", (ev) => {
        const r = card.getBoundingClientRect();
        const px = (ev.clientX - r.left) / r.width - 0.5;
        const py = (ev.clientY - r.top) / r.height - 0.5;
        inner.style.transform =
          `perspective(800px) rotateX(${(-py * MAX).toFixed(2)}deg) rotateY(${(px * MAX).toFixed(2)}deg) translateZ(0)`;
      });
      card.addEventListener("pointerleave", () => {
        inner.style.transform = "";
      });
    });
  }

  /* --------------------------- Rotating headline ------------------------- */
  const rotator = document.querySelector(".rotator-word");
  if (rotator) {
    const words = ["fast", "consistent", "observable", "hard to break"];
    let i = 0;
    if (!reduceMotion) {
      setInterval(() => {
        i = (i + 1) % words.length;
        rotator.style.opacity = "0";
        rotator.style.transform = "translateY(8px)";
        setTimeout(() => {
          rotator.textContent = words[i];
          rotator.style.transition = "opacity .35s ease, transform .35s ease";
          rotator.style.opacity = "1";
          rotator.style.transform = "translateY(0)";
        }, 280);
      }, 2600);
    }
  }

  /* ------------------------------- Nav menu ------------------------------ */
  const nav = document.querySelector(".nav");
  const toggle = document.querySelector(".nav-toggle");
  if (toggle) {
    toggle.addEventListener("click", () => {
      const open = nav.classList.toggle("open");
      toggle.setAttribute("aria-expanded", String(open));
    });
    nav.querySelectorAll(".nav-links a").forEach((a) =>
      a.addEventListener("click", () => {
        nav.classList.remove("open");
        toggle.setAttribute("aria-expanded", "false");
      })
    );
  }

  /* ----------------------------- Contact form ---------------------------- */
  const form = document.getElementById("contact-form");
  if (form) {
    const status = form.querySelector(".form-status");
    const clearErrors = () =>
      form.querySelectorAll(".field-error").forEach((s) => (s.textContent = ""));

    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      clearErrors();
      status.textContent = "";
      status.className = "form-status";

      const payload = {
        name: form.name.value,
        email: form.email.value,
        message: form.message.value,
      };
      const btn = form.querySelector("button[type=submit]");
      btn.disabled = true;
      btn.textContent = "Sending…";

      try {
        const res = await fetch("/api/contact", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (res.ok) {
          status.textContent = data.message;
          status.classList.add("ok");
          form.reset();
        } else {
          Object.entries(data.errors || {}).forEach(([k, v]) => {
            const el = form.querySelector(`.field-error[data-for="${k}"]`);
            if (el) el.textContent = v;
          });
          status.textContent = "Please fix the highlighted fields.";
          status.classList.add("err");
        }
      } catch {
        status.textContent = "Network hiccup — email me directly instead.";
        status.classList.add("err");
      } finally {
        btn.disabled = false;
        btn.textContent = "Send message";
      }
    });
  }
})();
