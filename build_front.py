#!/usr/bin/env python3
"""Build du frontend Hyped Cockpit.
Injecte la police Montserrat et le logo dans index.real2.html (SOURCE, a editer)
pour produire index.html (BUILD, le fichier servi en prod).

Usage : python3 build_front.py
Fonctionne dans les deux layouts :
 - dossier local : cockpit-app/ (source dans deploy/, assets/ en base64)
 - repo GitHub : tout a la racine (police/logo extraits de l'index.html existant)
"""
import io, os, re, sys
ROOT = os.path.dirname(os.path.abspath(__file__))

src_path = next((p for p in (os.path.join(ROOT,"deploy","index.real2.html"), os.path.join(ROOT,"index.real2.html")) if os.path.exists(p)), None)
if not src_path: sys.exit("ERREUR : index.real2.html introuvable (ni dans deploy/, ni ici).")
out_path = os.path.join(os.path.dirname(src_path), "index.html")

def asset(name):
    p = os.path.join(ROOT, "assets", name)
    return io.open(p).read().strip() if os.path.exists(p) else None
font, logo = asset("font_montserrat.b64"), asset("logo.b64")
if not (font and logo):
    if not os.path.exists(out_path): sys.exit("ERREUR : pas d'assets/ et pas d'index.html existant pour extraire police+logo.")
    old = io.open(out_path, encoding="utf-8").read()
    fonts = re.findall(r'data:font/woff2;base64,([A-Za-z0-9+/=]+)', old)
    logos = re.findall(r'data:image/png;base64,([A-Za-z0-9+/=]+)', old)
    if not fonts or not logos: sys.exit("ERREUR : police ou logo introuvables dans l'index.html existant.")
    font, logo = fonts[0], logos[0]

s = io.open(src_path, encoding="utf-8").read()
if "—" in s:
    sys.exit("ERREUR : tiret quadratin trouve dans index.real2.html, corrige avant de builder (regle Melany).")
n_font, n_logo = s.count("__FONT_B64__"), s.count("__LOGO_B64__")
if not n_font or not n_logo: sys.exit("ERREUR : placeholders __FONT_B64__/__LOGO_B64__ absents de la source.")
io.open(out_path, "w", encoding="utf-8").write(s.replace("__FONT_B64__", font).replace("__LOGO_B64__", logo))
print(f"OK : {out_path} genere ({n_font} police + {n_logo} logo injectes)")
