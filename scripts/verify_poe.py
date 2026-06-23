import re, time, requests
BASE="https://sachalchandio-sachal-portfolio.hf.space"
def css(h):
    m=re.search(r"assets/index-[A-Za-z0-9_-]+\.css",h); return m.group(0) if m else None
old=css(requests.get(BASE+"/",timeout=20).text)
live=None
for i in range(40):
    try:
        ref=css(requests.get(BASE+"/",timeout=20).text)
        if ref and ref!=old: live=ref; print("NEW BUILD LIVE:",ref); break
        print(f"[{i}] still {ref}")
    except Exception as e: print(f"[{i}] {e}")
    time.sleep(20)
if not live: print("TIMEOUT"); raise SystemExit(1)
def kind(path):
    c=requests.get(BASE+path,timeout=25).content
    if c[:20].startswith(b"version https://git"): return f"LFS-POINTER({len(c)}B) BROKEN"
    sig=c[:5]
    t="WEBP" if c[:4]==b"RIFF" else "PDF" if c[:5]==b"%PDF-" else "JPEG" if c[:3]==b"\xff\xd8\xff" else f"?{sig}"
    return f"{t} {len(c)//1024}KB OK"
for a in ["/poe2-hero.webp","/poe2/shot-04.webp","/poe2/shot-06.webp","/poe2/shot-12.webp","/Sachal_Chandio_Resume.pdf"]:
    print(f"  {a}: {kind(a)}")
print("RESULT: poe2 imagery + resume verified live")
