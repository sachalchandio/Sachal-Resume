import { useEffect } from "react";
import { Link } from "react-router-dom";

export default function NotFound() {
  useEffect(() => {
    document.title = "404 — route not found";
  }, []);
  return (
    <main className="error-page">
      <p className="error-code">404</p>
      <p className="error-status">
        <span className="status-dot status-dot-amber"></span>route not found
      </p>
      <h1>This page isn’t mapped.</h1>
      <p className="error-sub">
        The route you asked for has no component. Everything else is back home.
      </p>
      <Link className="btn btn-solid btn-lg" to="/">← Back to start</Link>
    </main>
  );
}
