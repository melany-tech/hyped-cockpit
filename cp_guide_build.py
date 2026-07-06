#!/usr/bin/env python3
# Guide CP du cockpit Hyped Agency (v2, juillet 2026)
# Reconstruit apres la perte du script d'origine. Genere deploy/guide.pdf (servi sur /guide).
# Charte : Montserrat (base64 dans assets/), navy #1C3A44, teal #2C9087. JAMAIS de tiret quadratin.
# Usage : python3 cp_guide_build.py
import io, os, sys
ROOT = os.path.dirname(os.path.abspath(__file__))
FONT = io.open(os.path.join(ROOT, "assets", "font_montserrat.b64")).read().strip()
LOGO = io.open(os.path.join(ROOT, "assets", "logo.b64")).read().strip()

NAVY = "#1C3A44"; TEAL = "#2C9087"; SAND = "#F5F3EE"; LINE = "#E4E0D5"; GRAY = "#56666D"; GOLD = "#C77F2A"

CSS = """
@font-face { font-family:'Montserrat'; src:url(data:font/woff2;base64,__FONT__) format('woff2'); }
@page { size:A4; margin:2.1cm 1.9cm 2.2cm 1.9cm;
  @bottom-left { content:'HYPED AGENCY'; font-family:Montserrat; font-size:7.5pt; letter-spacing:2px; color:#9aa6a8; }
  @bottom-center { content:'Ton cockpit · mode d\\2019emploi'; font-family:Montserrat; font-size:7.5pt; color:#9aa6a8; }
  @bottom-right { content:counter(page); font-family:Montserrat; font-size:8pt; font-weight:700; color:%(navy)s; } }
@page cover { margin:0; @bottom-left{content:none} @bottom-center{content:none} @bottom-right{content:none} }
* { box-sizing:border-box; }
body { font-family:Montserrat, sans-serif; color:%(navy)s; font-size:9.6pt; line-height:1.55; margin:0; }
.cover { page:cover; position:relative; width:21cm; height:29.7cm; background:%(navy)s; color:#fff; padding:2.6cm 2.2cm; page-break-after:always; }
.cover .logochip { display:inline-block; background:#F5F3EE; border-radius:14px; padding:16px 22px; margin-bottom:6mm; }
.cover .logo { width:118px; display:block; }
.cover .kicker { color:%(gold)s; font-size:9pt; letter-spacing:4px; font-weight:700; margin:16mm 0 4mm; }
.cover h1 { font-size:30pt; line-height:1.15; margin:0 0 8mm; font-weight:800; }
.cover p { color:#cfdada; font-size:10.5pt; max-width:12cm; }
.cover .v { position:absolute; bottom:2.2cm; left:2.2cm; color:#8fa5ab; font-size:8pt; letter-spacing:1px; }
h2.som { font-size:16pt; margin:0 0 8mm; }
table.som { width:100%%; border-collapse:collapse; }
table.som td { padding:3.2mm 2mm; border-bottom:1px solid %(line)s; font-size:9.8pt; }
table.som td.n { width:9mm; color:%(teal)s; font-weight:800; font-size:11pt; }
table.som td.tag { width:34mm; color:#9aa6a8; font-size:8pt; text-align:right; }
.sec { page-break-before:always; }
.snum { display:inline-block; width:9.5mm; height:9.5mm; border-radius:50%%; background:%(teal)s; color:#fff; font-weight:800; font-size:12.5pt; text-align:center; line-height:9.5mm; margin-right:3mm; vertical-align:middle; }
h2.st { display:inline-block; font-size:15.5pt; margin:0; vertical-align:middle; }
p.sub { color:%(gray)s; margin:1.5mm 0 5mm; font-size:9.6pt; }
.box { background:%(sand)s; border:1px solid %(line)s; border-radius:10px; padding:4mm 5mm; margin:4mm 0; page-break-inside:avoid; }
.box .bt { font-size:8pt; font-weight:800; letter-spacing:2.5px; color:%(gold)s; margin-bottom:1.5mm; }
.box.teal .bt { color:%(teal)s; }
.steps { margin:3mm 0; }
.step { margin:2.2mm 0; page-break-inside:avoid; }
.step .k { display:inline-block; width:6.5mm; height:6.5mm; border-radius:50%%; background:%(navy)s; color:#fff; font-weight:700; font-size:9pt; text-align:center; line-height:6.5mm; margin-right:2.5mm; }
table.t { width:100%%; border-collapse:collapse; margin:3mm 0; }
table.t th { text-align:left; font-size:8pt; letter-spacing:1.5px; color:%(gray)s; border-bottom:2px solid %(navy)s; padding:2mm; }
table.t td { border-bottom:1px solid %(line)s; padding:2.6mm 2mm; vertical-align:top; }
table.t td.c1 { font-weight:700; width:34mm; }
.btn { display:inline-block; border:1px solid #CFDADA; border-radius:6px; padding:0.6mm 2.4mm; font-size:8.6pt; font-weight:600; background:#fff; }
.btn.dark { background:%(navy)s; color:#fff; border-color:%(navy)s; }
.btn.teal { background:%(teal)s; color:#fff; border-color:%(teal)s; }
.slack { border:1px solid %(line)s; border-radius:10px; padding:4mm 5mm; margin:3.5mm 0; background:#fff; page-break-inside:avoid; }
.slack .from { font-weight:800; font-size:9pt; } .slack .from .app { background:%(sand)s; border:1px solid %(line)s; border-radius:3px; font-size:6.5pt; padding:0 1.2mm; color:%(gray)s; letter-spacing:1px; }
.slack .men { color:#1264a3; background:#e8f5fa; border-radius:3px; padding:0 1mm; font-weight:700; }
.slack .lnk { color:#1264a3; font-weight:700; }
.slack .q { border-left:3px solid %(line)s; padding-left:3mm; color:%(gray)s; margin:2mm 0; }
.foot { color:%(gray)s; font-style:italic; margin-top:4mm; }
ul { margin:2mm 0; padding-left:5mm; } li { margin:1.2mm 0; }
.new { display:inline-block; background:%(gold)s; color:#fff; border-radius:4px; font-size:7pt; font-weight:800; letter-spacing:1px; padding:0.4mm 2mm; vertical-align:middle; margin-left:2mm; }
""" % dict(navy=NAVY, teal=TEAL, sand=SAND, line=LINE, gray=GRAY, gold=GOLD)


# --- Emojis -> icônes SVG inline (sinon "tofu" carrés vides dans WeasyPrint) ---
def _svg(inner, vb="0 0 12 12"):
    return ('<svg style="width:9pt;height:9pt;vertical-align:-1pt" viewBox="%s" xmlns="http://www.w3.org/2000/svg">%s</svg>' % (vb, inner))
EMOJI_SVG = {
    "\u2705": _svg('<rect width="12" height="12" rx="2.5" fill="#3BA55C"/><path d="M3 6.3l2.1 2.1L9.2 3.9" stroke="#fff" stroke-width="1.7" fill="none" stroke-linecap="round"/>'),
    "\u274c": _svg('<rect width="12" height="12" rx="2.5" fill="#D64541"/><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" stroke="#fff" stroke-width="1.7" stroke-linecap="round"/>'),
    "\u270d\ufe0f": _svg('<path d="M1.6 10.4l1-3.2 5.6-5.6 2.2 2.2-5.6 5.6-3.2 1z" fill="#C77F2A"/>'),
    "\u270d": _svg('<path d="M1.6 10.4l1-3.2 5.6-5.6 2.2 2.2-5.6 5.6-3.2 1z" fill="#C77F2A"/>'),
    "\U0001f4e4": _svg('<path d="M1 6.5L11 2 7.2 11 5.6 7.4 1 6.5z" fill="#2C9087"/>'),
    "\U0001f514": _svg('<path fill="#C77F2A" d="M6 .8a3.6 3.6 0 0 1 3.6 3.6v2.4l1 1.8H1.4l1-1.8V4.4A3.6 3.6 0 0 1 6 .8z"/><circle cx="6" cy="10.4" r="1.2" fill="#C77F2A"/>'),
    "\u23f0": _svg('<circle cx="6" cy="6.4" r="4.6" fill="none" stroke="#D64541" stroke-width="1.4"/><path d="M6 3.9v2.7l1.9 1.2" stroke="#D64541" stroke-width="1.3" fill="none" stroke-linecap="round"/>'),
    "\u23f1": _svg('<circle cx="6" cy="6.6" r="4.4" fill="none" stroke="#56666D" stroke-width="1.3"/><path d="M6 4.2v2.6l1.7 1" stroke="#56666D" stroke-width="1.2" fill="none" stroke-linecap="round"/><path d="M4.6 1h2.8" stroke="#56666D" stroke-width="1.3" stroke-linecap="round"/>'),
    "\U0001f4dc": _svg('<rect x="2" y="1" width="8" height="10" rx="1.4" fill="#F5F3EE" stroke="#C77F2A" stroke-width="1"/><path d="M4 3.8h4M4 6h4M4 8.2h2.6" stroke="#C77F2A" stroke-width="1" stroke-linecap="round"/>'),
    "\uff0b": "+",
    "\u25a6": _svg('<rect x="1" y="1" width="10" height="10" rx="1.6" fill="none" stroke="#1C3A44" stroke-width="1.3"/><path d="M1 4.3h10M1 7.6h10M4.3 1v10M7.6 1v10" stroke="#1C3A44" stroke-width=".8"/>'),
}
def emoize(h):
    for k, v in EMOJI_SVG.items():
        h = h.replace(k, v)
    return h

def sec(n, title, sub, body, new=False):
    badge = '<span class="new">NOUVEAU</span>' if new else ''
    return f'<div class="sec"><span class="snum">{n}</span><h2 class="st">{title}</h2>{badge}<p class="sub">{sub}</p>{body}</div>'

def box(t, body, teal=False):
    return f'<div class="box{" teal" if teal else ""}"><div class="bt">{t}</div>{body}</div>'

def steps(items):
    return '<div class="steps">' + ''.join(f'<div class="step"><span class="k">{i+1}</span>{x}</div>' for i, x in enumerate(items)) + '</div>'

SOMMAIRE = [
    ("1", "En 30 secondes : c'est quoi, et la règle d'or", "+ se connecter"),
    ("2", "La barre de gauche : où trouver quoi", "navigation"),
    ("3", "Ta journée en un coup d'œil", "le Cockpit"),
    ("4", "Sourcer &amp; contacter un créateur", "Profils"),
    ("5", "Tes mails créateurs : réponse IA, PJ, signature", "Messages"),
    ("6", "Faire avancer tes contenus", "Contenus"),
    ("7", "Après la publication : les stats", "auto J+5"),
    ("8", "Suivre &amp; tout retracer", "Rapports · Historique"),
    ("9", "Les fiches marques : la mémoire de l'agence", "Marques · nouveau"),
    ("10", "Le copilote Slack : réponds depuis Slack", "nouveau"),
    ("11", "Tes 3 réflexes", "à retenir"),
    ("12", "Si ça coince", "dépannage"),
]

S = []
S.append(sec(1, "En 30 secondes", "C'est quoi, la règle d'or, et comment te connecter.",
  "<p>Le cockpit, c'est <b>ta journée au même endroit</b> : tes priorités, tes mails créateurs, tes profils à contacter, tes contenus et ton calendrier. Plus besoin de jongler entre Notion, ta boîte mail et Slack.</p>"
  + box("LA RÈGLE D'OR", "<p><b>Le cockpit prépare, tu valides. Aucun mail ne part sans toi.</b> Pour chaque message, tu choisis toujours : <span class='btn'>Brouillon</span> (tu le relis et l'envoies depuis Gmail) ou <span class='btn teal'>Envoyer</span> (en un clic, après une confirmation).</p>")
  + "<p><b>Se connecter (la première fois)</b></p>"
  + steps(["Va sur le lien du cockpit, entre ton email @hyped-agency.fr et ton mot de passe.",
           "Clique <b>« Connecter mon Gmail »</b> dans Messages. C'est ta boîte à toi, personne d'autre ne la voit. <b>Cette étape est indispensable</b> : sans elle, ni tes mails créateurs ni le copilote Slack (§10) ne fonctionnent.",
           "C'est tout. À partir de là, tes réponses créateurs remontent toutes seules."])))
S.append(sec(2, "La barre de gauche", "Dix onglets. Clique, ça change de page.",
  "<table class='t'><tr><th>ONGLET</th><th>CE QUE TU Y TROUVES</th></tr>"
  "<tr><td class='c1'>▦ Cockpit</td><td>Ta page d'accueil : tes 4 indicateurs, tes priorités, ton agenda, le pipeline.</td></tr>"
  "<tr><td class='c1'>Profils</td><td>Les créateurs à contacter (la veille / le sourcing).</td></tr>"
  "<tr><td class='c1'>Campagnes</td><td>Une carte par marque, avec l'avancement.</td></tr>"
  "<tr><td class='c1'>Contenus</td><td>Les contenus de tes collabs en cours (à lancer, en production, à valider).</td></tr>"
  "<tr><td class='c1'>Marques <span class='new'>NOUVEAU</span></td><td>La fiche d'identité de chaque marque : contexte, contacts, docs, réseaux (§9).</td></tr>"
  "<tr><td class='c1'>To-do <span class='new'>NOUVEAU</span></td><td>Tes tâches à faire, regroupées par marque. Une case cochée = « Fait » dans Notion, tout est synchronisé.</td></tr>"
  "<tr><td class='c1'>Contacts</td><td>L'annuaire de tous tes créateurs, avec leur statut.</td></tr>"
  "<tr><td class='c1'>Calendrier</td><td>Le mois avec tes collabs. Nouveau : chaque jour est cliquable et les flèches ‹ › naviguent de mois en mois.</td></tr>"
  "<tr><td class='c1'>Messages</td><td>Tes mails créateurs, classés, avec les réponses déjà prêtes.</td></tr>"
  "<tr><td class='c1'>Rapports</td><td>Remplissage des calendriers + pipeline par marque.</td></tr></table>"
  "<p>Tout en bas : « Filtres actifs ». Le logo Hyped en haut te ramène au Cockpit d'un clic. Dans l'en-tête, à droite : ↻ Actualiser, la recherche, l'historique (§8), le guide (ce document), les notifications et ton avatar.</p>"))
S.append(sec(3, "Ta journée en un coup d'œil", "Le Cockpit, c'est ce que tu regardes en arrivant.",
  "<p><b>Les 4 indicateurs (cliquables).</b> En haut : À traiter aujourd'hui, Profils à contacter, Relances en attente, Contenus validés. Clique sur une carte : elle t'emmène à la bonne section. Le petit « ▴ / ▾ vs hier » te montre si ça monte ou descend.</p>"
  + box("↻ LE BOUTON ACTUALISER (EN HAUT À DROITE)", "<p>Le cockpit se charge vite grâce à une petite mise en cache. Si tu attends un mail qui vient d'arriver, clique « ↻ » : il recharge tout de suite tes mails, ton calendrier et ton pipeline.</p>")
  + "<p><b>Tes priorités du jour.</b> Tes tâches, les urgentes en haut (en retard / aujourd'hui = chip orange « Priorité »). Pour cocher une tâche faite : clique sur l'icône à gauche de la tâche (elle passe au vert).</p>"
  "<p><b>La cloche &amp; le pipeline.</b> La cloche ouvre tes notifications (tâches en retard + brouillons à valider). Le pipeline profils montre où en sont tes créateurs, de « À contacter » à « Publié ». La loupe filtre ta liste en direct.</p>"
  "<p><b>Le bandeau « brouillons à valider ».</b> Tu peux maintenant le masquer avec la croix ✕ à droite ; il reviendra tout seul si le nombre de brouillons change.</p>"))
S.append(sec(4, "Sourcer &amp; contacter un créateur", "Tu ajoutes un profil, le message d'approche est déjà écrit.",
  steps(["Dans Profils, colle un @profil ou un lien, choisis la marque, puis « + Ajouter ».",
         "Dès l'ajout, <b>le message d'approche est déjà rédigé en brouillon dans ton Gmail</b>, dans ta voix et adapté à la marque. Tu n'écris rien.",
         "Sur la ligne du profil, « ✍️ Message » : relis (FR / EN), mets l'email du créateur, puis <span class='btn'>Brouillon</span> ou <span class='btn teal'>Envoyer</span>.",
         "Quand c'est parti, clique « Marquer comme contacté »."])
  + box("RELANCE AUTOMATIQUE", "<p>Si le créateur ne répond pas sous 3 jours, une tâche « Relancer [créateur] » apparaît toute seule dans tes priorités. Tu n'as plus à y penser.</p>", teal=True)))
S.append(sec(5, "Tes mails créateurs", "Le truc qui te décharge vraiment. Onglet Messages.",
  "<p>Toutes les réponses de tes créateurs remontent ici, classées : réponse, preview, logistique, facture, avec la date et l'heure de réception. Les pubs et newsletters sont ignorées, et tout le reste (mails internes, mails où tu es en copie, hors collabs) est rangé dans la section dépliable « 📥 Autres mails reçus » en bas : rien n'est invisible.</p>"
  + box("UNE RÉPONSE RÉDIGÉE SUR-MESURE (IA)", "<p>Quand tu cliques « ✍️ Répondre », le cockpit lit vraiment le message reçu (tout le fil) et rédige une réponse adaptée, dans la voix Hyped, en s'adressant au créateur par son prénom. Le bouton Régénérer te propose une autre version si besoin.</p>", teal=True)
  + "<p><b>Répondre en 2 secondes</b></p>"
  + steps(["Clique « ✍️ Répondre ». Tu vois d'abord le message reçu (et le lien « Ouvrir le fil dans Gmail »).",
           "La réponse s'écrit toute seule. Relis, ajuste si besoin.",
           "<span class='btn'>Brouillon</span> (tu finis dans Gmail), <span class='btn teal'>Envoyer</span> (1 clic, avec confirmation) ou <span class='btn'>⏱ Programmer</span> (choisis la date et l'heure d'envoi)."])
  + box("METTRE QUELQU'UN EN COPIE (CC / CCI)", "<p>Sous le destinataire, le lien « ＋ Ajouter Cc / Cci » ouvre deux champs. Cc = copie visible. Cci = copie cachée. Plusieurs adresses ? Sépare-les par une virgule. Ça marche aussi pour un brouillon ou un envoi programmé.</p>")
  + box("PROGRAMMER UN ENVOI", "<p>Clique ⏱ Programmer, choisis date et heure, confirme. Le cockpit enverra le mail tout seul au bon moment, même si ton ordi est éteint. Tu peux annuler un envoi tant qu'il n'est pas parti.</p>")
  + box("ÉVITER LES DOUBLONS : LE MAIL « TRAITÉ »", "<p>Dès qu'une réponse est envoyée, mise en brouillon ou programmée, le mail se marque « ✓ Traité par [prénom] » et la ligne se grise. Un mail auquel on a déjà répondu (cockpit ou Gmail) disparaît tout seul de la liste. Le bouton Rouvrir le remet à traiter.</p>")
  + box("PIÈCES JOINTES &amp; LIENS DE TRANSFERT", "<p>Vidéos, factures PDF : le nom du fichier s'affiche et se télécharge en un clic. Les liens WeTransfer / Drive / Dropbox sont cliquables directement.</p>")
  + box("COLLAB RÉMUNÉRÉE OU PAS ? LA BONNE FORMULE", "<p>Par défaut, une collab se fait en échange de produits. On n'impose jamais, on ne refuse jamais un budget frontalement : on présente ça comme un avantage, « on t'envoie la gamme pour que tu la testes, et tu donnes ton avis sur tes réseaux ». L'IA applique déjà cette logique.</p>", teal=True)
  + box("TA SIGNATURE GMAIL", "<p>Les mails envoyés depuis le cockpit repartent avec ta vraie signature Gmail (logo, liens). Si un bandeau te propose de « Reconnecter ton Gmail », fais-le une fois pour l'activer.</p>")
  + "<p class='foot'>Fini de retaper 15 fois par jour la même réponse, et elle est enfin personnalisée.</p>"))
S.append(sec(6, "Faire avancer tes contenus", "Sans quitter le cockpit. Onglet Contenus.",
  "<p>Chaque contenu de collab a un statut, dans cet ordre :</p>"
  "<table class='t'><tr><th>ÉTAPE</th><th>LE BOUTON POUR AVANCER</th></tr>"
  "<tr><td class='c1'>Le contenu est planifié</td><td><span class='btn'>→ En cours de production</span></td></tr>"
  "<tr><td class='c1'>En cours de production</td><td><span class='btn'>→ Contenu validé</span> (quand le créateur nous l'envoie)</td></tr>"
  "<tr><td class='c1'>Contenu validé</td><td><span class='btn teal'>Marquer publié</span></td></tr></table>"
  + steps(["Sur une ligne, clique le bouton d'étape : le statut est mis à jour dans Notion automatiquement.",
           "La ligne se rafraîchit ; une fois publiée, elle sort de « Contenus en cours ».",
           "« Ouvrir » t'amène sur la fiche Notion complète du contenu."])
  + "<p><b>Assigner qui s'en occupe.</b> Sur chaque ligne, le menu « non assigné » te laisse choisir ou changer la personne responsable (ça s'écrit dans Notion). Le petit 📜 ouvre l'historique de cette collab (§8).</p>"
  + box("ALERTE « À PUBLIER », VALIDÉ MAIS PAS POSTÉ", "<p>Dès qu'un contenu est validé mais que sa date de mise en ligne est passée, un badge « ⏰ à publier » apparaît et l'alerte remonte dans la cloche, avec la personne responsable. Chacune voit les siens ; le pilote les voit tous.</p>")
  + box("RAPPEL PREVIEW, AUTOMATIQUE (J-72H)", "<p>72 heures avant la mise en ligne, une tâche « Valider la preview de [créateur] » tombe toute seule dans tes priorités (+ une alerte). Tu n'as plus à tenir un compte à rebours dans ta tête.</p>", teal=True)))
S.append(sec(7, "Après la publication : les stats", "Récupérer le bilan, sans y penser.",
  "<p>C'est l'étape qu'on oublie tout le temps, alors le cockpit la fait pour toi.</p>"
  + box("DEMANDE DE STATS, AUTOMATIQUE (J+5)", "<p>5 jours après la publication, une tâche « Récupérer les stats de [créateur] » apparaît dans tes priorités, et un brouillon de demande de stats est déjà prêt dans ton Gmail. Tu relis, tu envoies. Le bilan avec la marque est bouclé.</p>", teal=True)
  + "<p class='foot'>Ce qu'on récupère : vues, portée, likes, partages, enregistrements et captures des stories.</p>"))
S.append(sec(8, "Suivre &amp; tout retracer", "Pour avoir la vue d'ensemble quand tu en as besoin.",
  "<table class='t'><tr><th>OÙ</th><th>POUR QUOI</th></tr>"
  "<tr><td class='c1'>Campagnes</td><td>L'avancement par marque : à contacter, en production, validé, reçus + remplissage.</td></tr>"
  "<tr><td class='c1'>Pipeline</td><td>À contacter → Contacté → Réponse reçue → Brief envoyé → Contenu reçu → Publié.</td></tr>"
  "<tr><td class='c1'>Calendrier</td><td>Le mois avec tes collabs. <b>Clique n'importe quel jour</b> pour voir le détail des collabs prévues, et navigue de mois en mois avec ‹ et › (bouton « aujourd'hui » pour revenir).</td></tr>"
  "<tr><td class='c1'>Rapports</td><td>Remplissage des calendriers + pipeline par marque.</td></tr></table>"
  + box("REMPLISSAGE DES CALENDRIERS, L'OBJECTIF", "<p>Le mois est découpé en 4 semaines. Une semaine est « bien remplie » seulement si elle a ≥ 3 collabs ET ≥ 3 jours différents couverts. Vert = OK, orange = incomplète, gris = vide.</p>")
  + box("HISTORIQUE &amp; TRAÇABILITÉ", "<p>Le bouton 📜 (en-tête, ou sur chaque contenu) ouvre, pour chaque collab, le fil complet : chaque changement d'étape et chaque assignation, avec par qui et quand, plus les liens « Voir les mails ↗ » et « Fiche Notion ↗ ». Une recherche filtre par créateur / marque / CP.</p>", teal=True)))
S.append(sec(9, "Les fiches marques", "Toute la mémoire de l'agence, marque par marque. Onglet Marques.", 
  "<p>Clique une marque à gauche : sa fiche s'affiche. <b>Une nouvelle arrivée comprend la marque en 2 minutes</b> sans poser de questions : histoire de la marque, client depuis quand et jusqu'à quand, objectifs en cours, réunions régulières, KPIs, pôle, interlocutrices côté HA, où trouver les contacts, Instagram / TikTok / site.</p>"
  "<p><b>Qui peut modifier quoi :</b></p>"
  "<ul><li><b>La base de la fiche</b> (histoire, période, objectifs, réunions, KPIs...) : Mélany uniquement.</li>"
  "<li><b>L'interlocuteur principal</b> côté marque : tout le monde (bouton « modifier »).</li>"
  "<li><b>Documents &amp; liens good to know</b> : tout le monde peut ajouter un lien (veille, moodboard) ou une pièce jointe (brief influenceurs, jusqu'à 10 Mo).</li>"
  "<li><b>Contexte ajouté par l'équipe</b> : des notes signées et datées. La première info utile que tu apprends sur une marque, note-la ici pour les copines.</li></ul>"
  "<p><b>🤖 La fiche nourrit l'IA.</b> Le champ « Consignes pour l'IA » (rempli par Mélany) est appliqué à chaque réponse rédigée pour cette marque : ton à adopter, choses à ne jamais dire, code promo, règles de dates... Et le champ « Histoire » sert à l'IA pour présenter la marque quand un créateur pose la question. Plus la fiche est riche, meilleures sont les réponses.</p>"
  + box("LE RÉFLEXE", "<p>Nouvel interlocuteur chez la marque ? Nouvelle info importante ? Mets la fiche à jour tout de suite. C'est ce qui fait que personne ne repart de zéro.</p>", teal=True), new=True))
S.append(sec(10, "Le copilote Slack", "Tes mails te suivent sur Slack, tu décides en un clic.",
  "<p>Le copilote lit ta boîte toutes les 5 minutes. Pour chaque mail qui compte (réponse créateur, mail interne), il te <b>prépare la réponse</b> et t'envoie un message privé Slack (conversation « Make », avec une mention pour te notifier). <b>Rien ne part jamais sans ton clic.</b></p>"
  "<div class='slack'><div class='from'>Make <span class='app'>APPLI</span></div>"
  "<p><span class='men'>@Toi</span> <b>Étape 1/2 · Décision 🔔 Léa veut décaler son post du 9 au 15 juillet, on accepte ?</b><br><i>(un créateur · In Haircare · boîte Kendia)</i></p>"
  "<p><span class='lnk'>✅ Oui</span> · <span class='lnk'>❌ Non</span> · <span class='lnk'>💬 Je donne ma consigne</span> · <span class='lnk'>✍️ Je gère moi-même</span></p>"
  "<p style='color:#56666D'><i>Clique un choix : je rédige la réponse dans ce sens et je te l'envoie à relire. « Consigne » = tu écris quoi répondre (ex. propose 500 €), je rédige.</i></p></div>"
  "<div class='slack'><div class='from'>Make <span class='app'>APPLI</span></div>"
  "<p><span class='men'>@Toi</span> <b>Étape 2/2 · Relis et envoie ✍️</b> (réponse à <b>Léa</b> · In Haircare, rédigée selon ta décision : oui ✅)</p>"
  "<div class='q'>Hello Léa,<br>Trop contente de te lire ! Pas de souci pour décaler la publication au 15 juillet...<br>À très vite,<br>Kendia</div>"
  "<p><span class='lnk'>📤 Envoyer</span> · <span class='lnk'>✍️ Je gère dans le cockpit</span></p></div>"
  "<ul>"
  "<li><b>Mail simple</b> (adresse reçue, merci, logistique) : tu reçois directement la réponse prête + « 📤 Envoyer ».</li>"
  "<li><b>Mail à décision</b> (décaler une date, budget, désaccord) : d'abord la question (étape 1/2), puis la réponse à relire (étape 2/2). Le bouton <b>💬 « Je donne ma consigne »</b> te laisse écrire exactement quoi répondre (ex. « propose 500 € pour 1 Reel + 2 stories ») : l'IA rédige dans ce sens.</li>"
  "<li><b>Mail interne</b> (une vraie question d'une collègue, hors fils créateurs) : tu es notifiée aussi, avec une réponse proposée sur un ton collègue.</li>"
  "</ul>"
  "<p><b>Les mêmes boutons dans le cockpit.</b> Onglet Messages : le panneau « 🤖 Copilote » en haut regroupe les décisions en attente, et les boutons Oui / Non / 💬 Consigne / Envoyer apparaissent aussi directement sur la ligne du mail concerné. Slack et cockpit sont synchronisés : une décision prise d'un côté disparaît de l'autre.</p>"
  "<p><b>Ses garde-fous :</b> l'IA répond dans la <b>langue du mail reçu</b> (anglais si le mail est en anglais), elle ne valide <b>jamais un tarif ou un budget</b> qui n'a pas été explicitement décidé (elle répond « je valide en interne et je reviens vers toi ») et un clic validé ne s'applique qu'à la question posée, rien d'autre. Quand tu envoies, tu reçois un « ✅ C'est fait ! » sur Slack ; si tu réponds directement depuis Gmail, le copilote le détecte et classe tout seul. Et si un créateur relance sur un fil déjà traité, le fil ressort automatiquement.</p>"
  + box("LA RÈGLE SIMPLE", "<p><b>Réponds toujours au message Slack le plus récent.</b> Quand tu envoies, le mail part depuis ta boîte Gmail, avec ta signature, et il est marqué « Traité » dans le cockpit. « ✍️ Je gère » = rien ne part, le mail t'attend dans le cockpit comme d'habitude.</p>", teal=True)
  + box("POUR QUE ÇA MARCHE", "<p>Il faut avoir fait « Connecter mon Gmail » dans le cockpit (§1). Sans ça, le copilote ne peut pas lire ta boîte et tu ne recevras rien sur Slack.</p>"), new=True))
S.append(sec(11, "Tes 3 réflexes", "À garder en tête, c'est tout l'esprit du cockpit.",
  box("1 · TOUT EST DÉJÀ PRÉPARÉ", "<p>Les messages, les relances, les rappels preview, les briefs, les demandes de stats : c'est écrit d'avance. Ton job, c'est relire et valider, pas tout retaper.</p>")
  + box("2 · BROUILLON OU ENVOYER, À CHAQUE FOIS", "<p>Pour chaque mail, tu choisis : Brouillon (tu finis dans Gmail, pratique pour joindre un fichier) ou Envoyer (1 clic, avec confirmation). Sur Slack comme dans le cockpit : rien ne part dans ton dos.</p>")
  + box("3 · TU NE VOIS QUE TES SUJETS", "<p>Chaque cheffe de projet voit uniquement ses créateurs et ses tâches. Moins de bruit, plus de focus. (La vue d'équipe est réservée au pilote, pour les congés.)</p>")))
S.append(sec(12, "Si ça coince", "Les petits trucs qui peuvent arriver.",
  "<table class='t'><tr><th>CE QUE TU VOIS</th><th>QUOI FAIRE</th></tr>"
  "<tr><td>« Réponse auto indisponible »</td><td>Le crédit IA est épuisé. Préviens Mélany, elle s'occupe de faire le nécessaire. En attendant, un template est gardé.</td></tr>"
  "<tr><td>Un mail vient d'arriver, il n'apparaît pas</td><td>Clique le bouton « ↻ » en haut à droite pour rafraîchir tout de suite.</td></tr>"
  "<tr><td>Ta signature n'apparaît pas</td><td>Clique le bandeau « Reconnecter mon Gmail » dans Messages (une fois).</td></tr>"
  "<tr><td>Rien ne m'arrive sur Slack (copilote)</td><td>Vérifie que « Connecter mon Gmail » a bien été fait dans le cockpit, puis attends 5 minutes. Regarde dans la conversation « Make » (section Applications de Slack).</td></tr>"
  "<tr><td>« Bad Gateway » / page blanche</td><td>Recharge la page (le service redémarre parfois quelques secondes).</td></tr></table>"
  + box("UN DOUTE ?", "<p>Tu ne casseras rien : aucun mail ne part sans ta validation. En cas de blocage, recharge, et préviens Mélany.</p>", teal=True)))

som_rows = "".join(f"<tr><td class='n'>{n}</td><td>{t}</td><td class='tag'>{tag}</td></tr>" for n, t, tag in SOMMAIRE)
html = f"""<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>{CSS.replace('__FONT__', FONT)}</style></head><body>
<div class="cover"><div class="logochip"><img class="logo" src="data:image/png;base64,{LOGO}"></div>
<div class="kicker">POUR LES CHEFFES DE PROJET</div>
<h1>Ton cockpit,<br>mode d'emploi</h1>
<p>Toute ta journée au même endroit : tes priorités, tes mails créateurs, tes profils, tes contenus, ton calendrier, et maintenant Slack. Le cockpit prépare le répétitif, toi, tu relis et tu valides.</p>
<div class="v">V2 · JUILLET 2026</div></div>
<h2 class="som">Sommaire</h2><table class="som">{som_rows}</table>
{''.join(S)}
</body></html>"""

html = emoize(html)
assert "\u2014" not in html, "tiret quadratin détecté !"
from weasyprint import HTML
out = os.path.join(ROOT, "deploy", "guide.pdf")
HTML(string=html).write_pdf(out)
print("OK :", out, os.path.getsize(out), "octets")
