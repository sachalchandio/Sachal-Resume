import { useState, type FormEvent } from "react";
import { sendContact } from "../api";

const empty = { name: "", email: "", message: "" };

export default function ContactForm() {
  const [form, setForm] = useState(empty);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<{ text: string; kind: "" | "ok" | "err" }>({ text: "", kind: "" });
  const [sending, setSending] = useState(false);

  const update = (key: keyof typeof empty) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setErrors({});
    setStatus({ text: "", kind: "" });
    setSending(true);
    try {
      const { status: code, data } = await sendContact(form);
      if (code === 200 && data.ok) {
        setStatus({ text: data.message ?? "Thanks — talk soon.", kind: "ok" });
        setForm(empty);
      } else {
        setErrors(data.errors ?? {});
        setStatus({ text: "Please fix the highlighted fields.", kind: "err" });
      }
    } catch {
      setStatus({ text: "Network hiccup — email me directly instead.", kind: "err" });
    } finally {
      setSending(false);
    }
  };

  return (
    <form className="contact-form" onSubmit={onSubmit} noValidate>
      <div className="field">
        <label htmlFor="cf-name">Name</label>
        <input id="cf-name" type="text" autoComplete="name" value={form.name} onChange={update("name")} />
        <span className="field-error">{errors.name}</span>
      </div>
      <div className="field">
        <label htmlFor="cf-email">Email</label>
        <input id="cf-email" type="email" autoComplete="email" value={form.email} onChange={update("email")} />
        <span className="field-error">{errors.email}</span>
      </div>
      <div className="field">
        <label htmlFor="cf-message">Message</label>
        <textarea id="cf-message" rows={4} value={form.message} onChange={update("message")} />
        <span className="field-error">{errors.message}</span>
      </div>
      <button className="btn btn-solid btn-lg" type="submit" disabled={sending}>
        {sending ? "Sending…" : "Send message"}
      </button>
      <p className={`form-status ${status.kind}`} role="status" aria-live="polite">
        {status.text}
      </p>
    </form>
  );
}
