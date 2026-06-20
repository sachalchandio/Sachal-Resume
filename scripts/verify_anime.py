#!/usr/bin/env python
"""Wait for the rebuild, confirm the 5 fixed anime covers serve real JPEG bytes
(not LFS pointers), then render-check all 8 posters on the live page."""
import time, requests
from playwright.sync_api import sync_playwright

BASE = "https://sachalchandio-sachal-portfolio.hf.space"
FIXED = ["lord-of-mysteries", "vinland-saga", "solo-leveling", "naruto", "sakamoto-days"]


def is_jpeg(slug):
    try:
        r = requests.get(f"{BASE}/anime/{slug}.jpg", timeout=20)
        return r.content[:3] == b"\xff\xd8\xff", len(r.content)
    except Exception as e:
        return False, str(e)


def main():
    deadline = time.time() + 12 * 60
    n = 0
    while time.time() < deadline:
        n += 1
        states = {s: is_jpeg(s) for s in FIXED}
        good = [s for s, (ok, _) in states.items() if ok]
        print(f"[{n}] real-jpeg: {len(good)}/5  " + " ".join(f"{s}:{'J' if ok else 'P'}({sz})" for s,(ok,sz) in states.items()))
        if len(good) == 5:
            break
        time.sleep(20)

    print("\n==== RENDER CHECK (all 8 posters) ====")
    with sync_playwright() as p:
        b = p.chromium.launch(channel="chrome", headless=True)
        pg = b.new_context(viewport={"width": 1366, "height": 900}).new_page()
        pg.goto(BASE + "/off-duty", wait_until="networkidle"); time.sleep(2)
        tabs = pg.query_selector_all(".ashelf-tab")
        allok = True
        for i in range(len(tabs)):
            pg.query_selector_all(".ashelf-tab")[i].click()
            w = 0; title = ""
            for _ in range(24):
                d = pg.evaluate("()=>{const im=document.querySelector('.ashelf-poster img');return {t:document.querySelector('.ashelf-title')?.textContent,w:im?.naturalWidth,vis:im?.style.visibility};}")
                title = d["t"]; w = d["w"] or 0
                if w > 0 and d["vis"] != "hidden":
                    break
                time.sleep(0.25)
            ok = w > 0
            allok = allok and ok
            print(f"  {'OK ' if ok else 'BAD'}  {('%dx'%w):>6}  {title}")
        b.close()
    print("\nRESULT:", "ALL 8 POSTERS RENDER." if allok else "SOME STILL BROKEN.")


if __name__ == "__main__":
    main()
