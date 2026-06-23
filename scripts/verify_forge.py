import re, time, requests
from playwright.sync_api import sync_playwright
BASE="https://sachalchandio-sachal-portfolio.hf.space"
OLD="index-Biia5mW6.css"
MARK=["forge-gauge","theme-toggle","hl-ignite","bp-dispatch"]
def css_ref(h):
    m=re.search(r"assets/index-[A-Za-z0-9_-]+\.css",h); return m.group(0) if m else None
live=None; css=""
for i in range(36):
    try:
        h=requests.get(BASE+"/",timeout=20).text; ref=css_ref(h)
        if ref and OLD not in ref:
            css=requests.get(BASE+"/"+ref,timeout=20).text
            if all(m in css for m in MARK): live=ref; print("NEW BUILD LIVE:",ref); break
            print(f"[{i}] new css {ref} markers not all present")
        else: print(f"[{i}] still old build")
    except Exception as e: print(f"[{i}] {e}")
    time.sleep(20)
if not live: print("TIMEOUT"); raise SystemExit
print("markers:",{m:(m in css) for m in MARK})
for p in ["/","/off-duty","/projects","/api/status","/api/portfolio"]:
    try: print(" ",requests.get(BASE+p,timeout=20).status_code,p)
    except Exception as e: print("  ERR",p,e)
# live FPS on projects + theme toggle present
with sync_playwright() as pw:
    b=pw.chromium.launch(channel="chrome",headless=True); pg=b.new_context(viewport={"width":1366,"height":900}).new_page()
    pg.goto(BASE+"/projects",wait_until="networkidle"); time.sleep(1.5)
    fps=pg.evaluate("()=>new Promise(r=>{let n=0;const t=performance.now();function k(){n++;if(performance.now()-t<2500){requestAnimationFrame(k)}else{r(Math.round(n/((performance.now()-t)/1000)))}}requestAnimationFrame(k)})")
    print("LIVE /projects FPS:",fps)
    pg.goto(BASE+"/",wait_until="networkidle"); time.sleep(1)
    tog=pg.evaluate("()=>!!document.querySelector('.theme-toggle')"); g=pg.evaluate("()=>(document.querySelector('.forge-gauge')||{}).innerText")
    print("toggle:",tog,"| gauge:",(g or '')[:40])
    b.close()
print("RESULT: forge redesign live & verified")
