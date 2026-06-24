from playwright.sync_api import sync_playwright
import sys
errs=[]
with sync_playwright() as p:
    b=p.chromium.launch(channel="chrome", headless=True)
    for theme in ("dark","light"):
        pg=b.new_page(viewport={"width":1280,"height":900})
        pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None)
        pg.goto("http://127.0.0.1:5000/", wait_until="networkidle")
        if theme=="light":
            pg.evaluate("localStorage.setItem('theme','light')"); pg.reload(wait_until="networkidle")
        pg.eval_on_selector("#about", "el=>el.scrollIntoView()")
        pg.wait_for_timeout(900)
        img=pg.eval_on_selector(".about-portrait img",
            "el=>({nw:el.naturalWidth, nh:el.naturalHeight, w:Math.round(el.clientWidth), h:Math.round(el.clientHeight), ok:el.complete && el.naturalWidth>0})")
        print(f"[{theme}] portrait -> natural {img['nw']}x{img['nh']}  display {img['w']}x{img['h']}  renders={img['ok']}")
        pg.eval_on_selector(".section-about", "el=>el.scrollIntoView({block:'center'})")
        pg.wait_for_timeout(500)
        pg.locator(".section-about").screenshot(path=f"scripts/_about_{theme}.png")
        pg.close()
    b.close()
print("console errors:", errs if errs else "none")
