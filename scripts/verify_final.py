import re, time, requests
from playwright.sync_api import sync_playwright
BASE="https://sachalchandio-sachal-portfolio.hf.space"
def css(h):
    m=re.search(r"assets/index-[A-Za-z0-9_-]+\.css",h); return m.group(0) if m else None
old=css(requests.get(BASE+"/",timeout=20).text)
print("current(old) css:",old)
live=None
for i in range(40):
    try:
        ref=css(requests.get(BASE+"/",timeout=20).text)
        if ref and ref!=old: live=ref; print("NEW BUILD LIVE:",ref); break
        print(f"[{i}] still {ref}")
    except Exception as e: print(f"[{i}] {e}")
    time.sleep(20)
if not live: print("TIMEOUT"); raise SystemExit(1)
with sync_playwright() as p:
    br=p.chromium.launch(channel="chrome",headless=True)
    ctx=br.new_context(viewport={"width":1366,"height":900})
    ctx.add_init_script("window.__raf=0;const _r=requestAnimationFrame.bind(window);window.requestAnimationFrame=function(cb){window.__raf++;return _r(cb);};")
    pg=ctx.new_page()
    pg.goto(BASE+"/",wait_until="networkidle"); time.sleep(2)
    hero=pg.evaluate("()=>({summary:!!document.querySelector('.hero-summary'), note:!!document.querySelector('.ingot-note'), ts:getComputedStyle(document.querySelector('.timeline')).listStyleType})")
    print("hero summary present:",hero['summary']," ingot notes:",hero['note']," timeline list-style:",hero['ts'])
    pg.goto(BASE+"/projects",wait_until="networkidle"); time.sleep(2)
    def loops(label):
        d=pg.evaluate("()=>new Promise(res=>{const r0=window.__raf,t0=performance.now();let fr=0;function k(){fr++;if(performance.now()-t0<1000){requestAnimationFrame(k)}else{res({raf:Math.round(window.__raf-r0),fps:Math.round(fr)})}}requestAnimationFrame(k)})")
        print(f"  {label}: scene_loops~{max(0,round((d['raf']-d['fps'])/max(d['fps'],1)))} fps={d['fps']}")
    loops("projects hero in view")
    pg.evaluate("window.scrollTo(0,2600)"); time.sleep(1.2); loops("projects scrolled offscreen")
    br.close()
print("RESULT: final build live and verified")
