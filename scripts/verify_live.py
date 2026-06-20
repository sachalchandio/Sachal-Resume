#!/usr/bin/env python
"""Poll the live Space until the NEW build is serving, then verify it.

Waits for the live CSS asset hash to change AND for the new cinematic-selector
classes to appear, then checks every route + API endpoint. Prints a PASS/FAIL
summary. Read-only (no token needed for the HTTP checks).
"""
import re
import sys
import time
import requests

BASE = "https://sachalchandio-sachal-portfolio.hf.space"
OLD_CSS = sys.argv[1] if len(sys.argv) > 1 else "index-C4FzPXEU.css"
MARKERS = ["ashelf", "gbg-layer", "ashelf-bg-layer"]
MAX_MIN = 12
INTERVAL = 20


def css_ref(html: str):
    m = re.search(r"assets/index-[A-Za-z0-9_-]+\.css", html)
    return m.group(0) if m else None


def get(path, **kw):
    return requests.get(BASE + path, timeout=25, **kw)


def main():
    deadline = time.time() + MAX_MIN * 60
    live_css = None
    css_text = ""
    n = 0
    while time.time() < deadline:
        n += 1
        try:
            html = get("/").text
            ref = css_ref(html)
            if ref and OLD_CSS not in ref:
                css_text = get("/" + ref).text
                if all(m in css_text for m in MARKERS):
                    live_css = ref
                    print(f"[{n}] NEW BUILD LIVE: {ref}")
                    break
                else:
                    print(f"[{n}] new css {ref} but markers missing yet")
            else:
                print(f"[{n}] still old build ({ref}); waiting…")
        except Exception as e:
            print(f"[{n}] poll error: {e}")
        time.sleep(INTERVAL)

    print("\n==== VERIFICATION ====")
    if not live_css:
        print("RESULT: TIMEOUT — new build not detected live within %d min." % MAX_MIN)
        return

    print("Live CSS:", live_css)
    print("Markers present:", {m: (m in css_text) for m in MARKERS})

    routes = ["/", "/off-duty", "/projects"]
    apis = ["/api/portfolio", "/api/off-duty", "/api/projects", "/healthz"]
    ok = True
    for p in routes + apis:
        try:
            r = get(p)
            tag = "ok" if r.status_code == 200 else "FAIL"
            if r.status_code != 200:
                ok = False
            print(f"  {tag:4} {r.status_code}  {p}")
        except Exception as e:
            ok = False
            print(f"  FAIL  ---  {p}  ({e})")

    # confirm resume + a sample image still served
    for asset in ["/Sachal_Chandio_Resume.pdf", "/anime/solo-leveling.jpg", "/games/path-of-exile-2.jpg"]:
        try:
            r = get(asset)
            print(f"  {'ok' if r.status_code==200 else 'FAIL':4} {r.status_code}  {asset}")
            if r.status_code != 200:
                ok = False
        except Exception as e:
            ok = False
            print(f"  FAIL  ---  {asset} ({e})")

    print("\nRESULT:", "ALL GREEN — new build live and verified." if ok else "ISSUES FOUND (see above).")


if __name__ == "__main__":
    main()
