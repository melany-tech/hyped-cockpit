/* Cockpit des chefs de projet — Hyped Agency
 * Lecture des calendriers clients ACTIFS via adaptateurs par client
 * (chaque client a sa propre structure Notion). Login par personne (JWT).
 * Sans NOTION_TOKEN → MODE DÉMO (sample-data.json).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const gm = require("./gmail-oauth"); // connexion Gmail par personne (inerte si Google non configuré)

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PROD = process.env.NODE_ENV === "production";
const DEMO = !process.env.NOTION_TOKEN;

function loadUsers() {
  for (const f of ["users.json", "users.example.json"]) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  }
  return [];
}
const USERS = loadUsers();

// === Assignation créateur -> CP (HYBRIDE) ================================
// Manuel : champ "Interlocuteur" dans Notion (prioritaire si renseigné).
// Auto   : on déduit qui gère un créateur d'après QUI échange avec lui par mail.
const ASSIGN_STORE = path.join(process.env.DATA_DIR || __dirname, "assignments.json"); // disque persistant en prod
let ASSIGN = {}; // { creatorNorm: "Prénom CP" }
try { ASSIGN = JSON.parse(fs.readFileSync(ASSIGN_STORE, "utf8")); } catch (e) { ASSIGN = {}; }
function normName(s) {
  return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/^@/, "").trim();
}
function saveAssign() { try { fs.writeFileSync(ASSIGN_STORE, JSON.stringify(ASSIGN)); } catch (e) {} }
function learnAssignments(cpName, analysis) {
  if (!cpName || !analysis) return;
  const creators = new Set();
  (analysis.creatorReplies || []).forEach((m) => { if (m["créateur"]) creators.add(m["créateur"]); });
  Object.values(analysis.byBrand || {}).forEach((arr) => arr.forEach((m) => { if (m["créateur"]) creators.add(m["créateur"]); }));
  let changed = false;
  creators.forEach((c) => { const k = normName(c); if (k && ASSIGN[k] !== cpName) { ASSIGN[k] = cpName; changed = true; } });
  if (changed) saveAssign();
}
let ASSIGN_AT = 0, ASSIGN_ONE = {};
async function refreshOneBox(email, cpName) {
  if (!gm.ENABLED || !email) return;
  if (Date.now() - (ASSIGN_ONE[email] || 0) < 5 * 60000) return;
  ASSIGN_ONE[email] = Date.now();
  const collabs = await fetchRows();
  try { const r = await gm.analyzeFor(email, collabs); learnAssignments(cpName, r); } catch (e) {}
}
async function refreshAssignmentsFromBoxes() {
  if (!gm.ENABLED || typeof gm.connectedEmails !== "function") return;
  if (Date.now() - ASSIGN_AT < 5 * 60000) return;
  ASSIGN_AT = Date.now();
  const collabs = await fetchRows();
  for (const email of gm.connectedEmails()) {
    const u = USERS.find((x) => x.email.toLowerCase() === email.toLowerCase());
    if (!u) continue;
    try { const r = await gm.analyzeFor(email, collabs); learnAssignments(u.name, r); } catch (e) {}
  }
}

let notion = null;
if (!DEMO) {
  const { Client } = require("@notionhq/client");
  notion = new Client({ auth: process.env.NOTION_TOKEN });
}

// === CLIENTS ACTIFS (liste blanche) =====================================
// Pour ajouter/retirer un client : édite ce tableau. databaseId = la base du
// calendrier du client. adapter = sa fonction de lecture (sa structure propre).
const ACTIVE = [
  { brand: "In Haircare", databaseId: "380f8ac3-c3ae-80ce-ba4c-e8e82490edc6", adapter: "inhaircare" },
  // Curls Matter : structure par mois, à traiter séparément
  // Doucéa : calendrier vide pour l'instant
];

// === ALERTE REMPLISSAGE ================================================
// Règle Hyped : du contenu planifié au moins un mois à l'avance.
const MIN_PER_WEEK = 3; // règle Hyped : au moins 3 collabs par semaine
const FILL_CHECK = [
  { brand: "In Haircare", dbId: "380f8ac3-c3ae-80ce-ba4c-e8e82490edc6", dateProp: "Date" },
  { brand: "Doucéa",      dbId: "37bf8ac3-c3ae-81d6-9dbd-d7f4a64165a8", dateProp: "Date" },
  { brand: "Curls Matter", unverifiable: true }, // structure par mois -> non vérifiable auto
];
async function countInMonth(dbId, dateProp, startISO, endISO) {
  let n = 0, cursor;
  do {
    const r = await notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100,
      filter: { property: dateProp, date: { on_or_after: startISO, on_or_before: endISO } } });
    n += r.results.length; cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return n;
}
async function buildAlerts() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  const iso = (d) => d.toISOString().slice(0, 10);
  const monthLabel = start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  const days = Math.round((end - start) / 864e5) + 1;
  const weeks = Math.max(1, Math.round(days / 7));
  const target = MIN_PER_WEEK * weeks; // ex. ~13 pour un mois (3/semaine)
  const fill = [];
  for (const c of FILL_CHECK) {
    if (c.unverifiable) { fill.push({ brand: c.brand, status: "inconnu", target }); continue; }
    let count;
    try { count = await countInMonth(c.dbId, c.dateProp, iso(start), iso(end)); }
    catch (e) { fill.push({ brand: c.brand, status: "erreur", target }); continue; }
    const status = count === 0 ? "vide" : (count < target ? "faible" : "ok");
    fill.push({ brand: c.brand, count, target, status });
  }
  return { monthLabel, minPerWeek: MIN_PER_WEEK, target, fill };
}

// id utilisateur Notion -> prénom (pour les champs "personne")
let USERMAP = {};      // id Notion -> prénom
let EMAIL2ID = {};     // email -> id Notion (mapping fiable)
async function resolveUsers() {
  let cursor;
  do {
    const r = await notion.users.list({ start_cursor: cursor, page_size: 100 });
    r.results.forEach((u) => {
      USERMAP[u.id] = (u.name || "").replace(/ Hyped Agency$/i, "").trim();
      const em = u.person?.email; if (em) EMAIL2ID[em.toLowerCase()] = u.id;
    });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
}
function title(p) { return (p?.title || []).map((t) => t.plain_text).join(""); }
function firstPerson(p) { const a = p?.people || []; return a.length ? (USERMAP[a[0].id] || a[0].name || null) : null; }

// --- Adaptateurs par client --------------------------------------------
const ADAPTERS = {
  inhaircare(page, brand) {
    const p = page.properties || {};
    const statut = p["Statut"]?.select?.name;
    const M = {
      "En validation": { grp: "À valider", label: "Contenu à valider", color: "#C2553B" },
      "En production": { grp: "En production", label: "En cours de production", color: "#7A5AA8" },
      "Non posté":     { grp: "À lancer", label: "À lancer", color: "#C77F2A" },
      // "Posté" -> rien (terminé)
    };
    const m = M[statut];
    if (!m) return null;
    return {
      brand,
      name: title(p["Nom"]) || "(sans nom)",
      cp: firstPerson(p["Interlocuteur"]),
      grp: m.grp, label: m.label, color: m.color, urgent: false,
      date: p["Date"]?.date?.start || null,
      url: page.url,
    };
  },
};

let CACHE = { at: 0, rows: [] };
async function fetchAllReal() {
  if (Date.now() - CACHE.at < 60000 && CACHE.rows.length) return CACHE.rows;
  if (!Object.keys(USERMAP).length) { try { await resolveUsers(); } catch (e) { console.warn("users", e.message); } }
  const rows = [];
  for (const src of ACTIVE) {
    const adapt = ADAPTERS[src.adapter];
    if (!adapt) continue;
    let cursor;
    try {
      do {
        const r = await notion.databases.query({ database_id: src.databaseId, start_cursor: cursor, page_size: 100 });
        r.results.forEach((pg) => { const row = adapt(pg, src.brand); if (row) rows.push(row); });
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
    } catch (e) { console.warn("query", src.brand, e.message); }
  }
  CACHE = { at: Date.now(), rows };
  return rows;
}
async function fetchRows() {
  if (DEMO) return JSON.parse(fs.readFileSync(path.join(__dirname, "sample-data.json"), "utf8"));
  return fetchAllReal();
}

// === App ================================================================
const app = express();
app.use(express.json());
app.use(cookieParser());
function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
  res.cookie("hc_token", token, { httpOnly: true, sameSite: PROD ? "none" : "lax", secure: PROD, maxAge: 30 * 864e5 * 1000 });
}
function auth(req, res, next) {
  try { req.user = jwt.verify(req.cookies.hc_token, JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: "non connecté" }); }
}
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const u = USERS.find((x) => x.email.toLowerCase() === String(email || "").toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ""), u.passwordHash))
    return res.status(401).json({ error: "Email ou mot de passe incorrect." });
  setAuthCookie(res, { email: u.email, name: u.name, role: u.role });
  res.json({ name: u.name, role: u.role });
});
app.post("/api/logout", (req, res) => { res.clearCookie("hc_token"); res.json({ ok: true }); });
app.get("/api/me", auth, (req, res) => res.json({ name: req.user.name, role: req.user.role, demo: DEMO }));
app.get("/api/collabs", auth, async (req, res) => {
  try {
    // apprentissage des assignations via mails (best-effort, caché 5 min)
    try {
      if (req.user.role === "supervisor") await refreshAssignmentsFromBoxes();
      else await refreshOneBox(req.user.email, req.user.name);
    } catch (e) {}
    let rows = await fetchRows();
    // HYBRIDE : l'Interlocuteur Notion (manuel) prime ; sinon rattachement auto par mail.
    rows = rows.map((r) => (r.cp ? r : { ...r, cp: ASSIGN[normName(r.name)] || null }));
    if (req.user.role !== "supervisor") rows = rows.filter((r) => r.cp === req.user.name);
    const team = USERS.filter((u) => u.role === "cp").map((u) => u.name);
    res.json({ rows, demo: DEMO, viewer: { name: req.user.name, role: req.user.role }, team });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Vue par marque + pipeline (agrégats réels) -------------------------
// Alimente les "cartes par marque" et la barre "pipeline profils" du dashboard.
app.get("/api/overview", auth, async (req, res) => {
  if (DEMO || !notion) return res.json({ enabled: false, brands: [], pipeline: [] });
  try {
    const isSup = req.user.role === "supervisor";
    const me = normName(req.user.name);
    const mine = (resp) => isSup || normName(resp) === me;
    // 1) tâches veille (Prise de contact / Relance créateur), non "Fait"
    const tasks = []; let cur;
    do {
      const r = await notion.databases.query({ database_id: TASKS_DB, start_cursor: cur, page_size: 100 });
      r.results.forEach((pg) => tasks.push(mapTask(pg))); cur = r.has_more ? r.next_cursor : null;
    } while (cur);
    const open = tasks.filter((t) => t.statut !== "Fait" && mine(t.responsable));
    const C = {};
    const B = (b) => (C[b] = C[b] || { brand: b, aContacter: 0, relances: 0, contenus: 0, recus: 0 });
    open.forEach((t) => {
      const b = t.projet || "Autres";
      if (t.type === "Prise de contact") B(b).aContacter++;
      else if (t.type === "Relance créateur") B(b).relances++;
    });
    // 2) collabs (contenus) par marque
    let rows = await fetchRows();
    rows = rows.map((r) => (r.cp ? r : { ...r, cp: ASSIGN[normName(r.name)] || null }));
    if (!isSup) rows = rows.filter((r) => r.cp === req.user.name);
    rows.forEach((r) => {
      const b = r.brand || "Autres";
      if (r.grp === "À valider") B(b).recus++; else B(b).contenus++;
    });
    const brands = Object.values(C)
      .filter((x) => x.aContacter || x.relances || x.contenus || x.recus)
      .sort((a, b) => (b.aContacter + b.relances + b.contenus + b.recus) - (a.aContacter + a.relances + a.contenus + a.recus));
    // 3) pipeline global (6 étapes ; réel là où on le trace)
    const contacted = loadContacted().filter((c) => mine(c.cp));
    const aContacter = open.filter((t) => t.type === "Prise de contact").length;
    const contacte = contacted.length;
    const recus = rows.filter((r) => r.grp === "À valider").length;
    const relancesN = open.filter((t) => t.type === "Relance créateur").length;
    const pipeline = [
      { key: "a_contacter", label: "À contacter",   count: aContacter },
      { key: "contacte",    label: "Contacté",      count: contacte },
      { key: "reponse",     label: "Réponse reçue", count: 0, soon: true },
      { key: "brief",       label: "Brief envoyé",  count: 0, soon: true },
      { key: "contenu",     label: "Contenu reçu",  count: recus },
      { key: "publie",      label: "Publié",        count: 0, soon: true },
    ];
    res.json({ enabled: true, brands, pipeline, relances: relancesN });
  } catch (e) { res.json({ enabled: false, error: e.message, brands: [], pipeline: [] }); }
});
app.get("/api/alerts", auth, async (req, res) => {
  // Remplissage des calendriers : visible par TOUTES les CP (plus seulement le pilote).
  if (DEMO) return res.json({ monthLabel: "juillet 2026", minPerWeek: MIN_PER_WEEK, target: 12, fill: [
    { brand: "Doucéa", status: "vide", count: 0, target: 12 },
    { brand: "In Haircare", status: "faible", count: 5, target: 12 },
    { brand: "Curls Matter", status: "inconnu", target: 12 } ] });
  try { res.json(await buildAlerts()); } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Connexion Gmail par personne (réponses créateurs) ------------------
app.get("/api/gmail/status", auth, (req, res) =>
  res.json({ enabled: gm.ENABLED, connected: gm.ENABLED ? gm.isConnected(req.user.email) : false }));
app.get("/api/gmail/connect", auth, (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Connexion Gmail non configurée." });
  res.json({ url: gm.getAuthUrl(req.user.email) });
});
app.get("/api/gmail/callback", async (req, res) => {
  try { await gm.handleCallback(req.query.code, req.query.state); res.redirect("/?gmail=ok"); }
  catch (e) { res.redirect("/?gmail=err"); }
});
app.get("/api/gmail/inbox", auth, async (req, res) => {
  if (!gm.ENABLED) return res.json({ enabled: false });
  try {
    const collabs = await fetchRows(); // marques + créateurs des calendriers
    const r = await gm.analyzeFor(req.user.email, collabs);
    learnAssignments(req.user.name, r); // apprend qui gère quel créateur
    res.json({ enabled: true, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Brouillons mail (le cockpit prépare, la CP relit et envoie) ---------
app.post("/api/gmail/draft", auth, async (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Gmail non configuré" });
  const { to, subject, body } = req.body || {};
  if (!subject && !body) return res.status(400).json({ error: "message vide" });
  try { res.json(await gm.createDraft(req.user.email, { to, subject, body })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/gmail/drafts", auth, async (req, res) => {
  if (!gm.ENABLED) return res.json({ count: 0 });
  try { res.json(await gm.draftsToValidate(req.user.email)); }
  catch (e) { res.json({ count: 0 }); }
});
app.post("/api/gmail/send", auth, async (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Gmail non configuré" });
  const { to, subject, body } = req.body || {};
  if (!to) return res.status(400).json({ error: "destinataire manquant" });
  try { res.json(await gm.sendEmail(req.user.email, { to, subject, body })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Visios du jour (Google Agenda de la personne) ----------------------
app.get("/api/calendar", auth, async (req, res) => {
  if (!gm.ENABLED || typeof gm.calendarToday !== "function") return res.json({ enabled: false });
  try { const r = await gm.calendarToday(req.user.email); res.json({ enabled: true, ...r }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- To-do (base Notion "Tâches Équipe (Live)") -------------------------
const TASKS_DB = "5e993c84-9927-4c20-986b-32c2a14c2cbf";
function mapTask(pg) {
  const p = pg.properties || {};
  const sel = (x) => p[x]?.select?.name || null;
  const ttl = (p["Tâche"]?.title || []).map((t) => t.plain_text).join("");
  const rich = (x) => (p[x]?.rich_text || []).map((t) => t.plain_text).join("");
  return {
    id: pg.id, task: ttl || "(sans titre)", statut: sel("Statut"), responsable: sel("Responsable"),
    priorite: sel("Priorité"), projet: sel("Projet"), type: sel("Type"),
    lien: p["Lien profil"]?.url || null, commentaire: rich("Commentaire veille"),
    echeance: p["Échéance"]?.date?.start || null, url: pg.url,
  };
}
// id Notion d'une personne d'après son prénom (pour le champ Interlocuteur)
async function userIdByName(name) {
  if (!Object.keys(EMAIL2ID).length) { try { await resolveUsers(); } catch (e) {} }
  const n = normName(name);
  if (!n) return null;
  // 1) via les comptes cockpit : nom -> email -> id Notion (fiable)
  const u = USERS.find((x) => normName(x.name) === n);
  if (u && EMAIL2ID[u.email.toLowerCase()]) return EMAIL2ID[u.email.toLowerCase()];
  // 2) fallback : match sur le prénom du nom Notion
  for (const [id, nm] of Object.entries(USERMAP)) {
    const m = normName(nm); if (m && (m === n || m.split(" ")[0] === n)) return id;
  }
  return null;
}
app.get("/api/todos", auth, async (req, res) => {
  if (DEMO || !notion) return res.json({ enabled: false, tasks: [] });
  try {
    const all = []; let cursor;
    do {
      const r = await notion.databases.query({ database_id: TASKS_DB, start_cursor: cursor, page_size: 100 });
      r.results.forEach((pg) => all.push(mapTask(pg))); cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    const isSup = req.user.role === "supervisor";
    const view = String(req.query.view || "");
    let tasks = all.filter((t) => t.statut !== "Fait");
    if (isSup) {
      if (view && view !== "ALL") tasks = tasks.filter((t) => normName(t.responsable) === normName(view));
    } else {
      tasks = tasks.filter((t) => normName(t.responsable) === normName(req.user.name));
    }
    tasks.sort((a, b) => (a.echeance || "9999").localeCompare(b.echeance || "9999"));
    res.json({ enabled: true, tasks, scope: isSup ? (view || "ALL") : "me" });
  } catch (e) { res.json({ enabled: false, error: e.message, tasks: [] }); }
});
app.post("/api/todos", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  const task = String(req.body?.task || "").trim();
  if (!task) return res.status(400).json({ error: "tâche vide" });
  const resp = (req.user.role === "supervisor" && req.body?.responsable) ? String(req.body.responsable) : req.user.name;
  const props = {
    "Tâche": { title: [{ text: { content: task } }] },
    "Statut": { select: { name: "À faire" } },
    "Responsable": { select: { name: resp } },
  };
  if (req.body?.echeance) props["Échéance"] = { date: { start: req.body.echeance } };
  try { const pg = await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); res.json({ ok: true, id: pg.id }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/todos/:id/done", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  try { await notion.pages.update({ page_id: req.params.id, properties: { "Statut": { select: { name: "Fait" } } } }); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Message d'approche auto (brouillon prêt dès l'ajout d'un profil) ----
const BRAND_INFO = {
  "In Haircare": { produits: "la routine complète In Haircare (Milk'In, Curl n'Go et le nouveau Final Touch)", fr: "In Haircare est une marque française spécialisée dans les soins capillaires pensés pour les cheveux texturés — bouclés, frisés, crépus — avec des formules clean, naturelles et efficaces, fabriquées en France et primées (Beauty Shortlist Awards 2025)." },
  "Doucéa": { produits: "les soins Doucéa", fr: "Doucéa est une marque de soins dermo-pédiatriques pensée pour les enfants à peau sensible ou atopique. L'idée : réconcilier le besoin du parent et le plaisir de l'enfant, avec des soins efficaces, sensoriels et concentrés en madécassoside (actif apaisant)." },
  "LIVA": { produits: "the full LIVA range", fr: "LIVA est une marque de soins capillaires cliniquement testée, en lancement national chez Walmart (US) : lors d'une étude de 3 semaines, 85% des participantes ont trouvé leurs cheveux plus denses et plus sains." },
  "Curls Matter": { produits: "les produits Curls Matter", fr: "Curls Matter est une marque dédiée au soin des cheveux bouclés et texturés." },
};
function infFromTitle(t) {
  let raw = String(t || "").replace(/^contacter\s+/i, "").trim();
  if (!raw || /^https?:\/\//i.test(raw)) return "[prénom]";
  raw = raw.replace(/^@/, "").split(/[ \/(]/)[0];
  return raw || "[prénom]";
}
function genOutreachFR(brand, inf, cp) {
  const b = BRAND_INFO[brand] || { produits: "nos produits", fr: brand + " est une marque que nous accompagnons chez Hyped Agency." };
  const disp = "1 Reel + 1 set de stories";
  return `Hello ${inf} ✨\n\nJe suis ${cp}, cheffe de projet chez Hyped Agency, et je représente la marque ${brand}.\n\n${b.fr}\n\nJe te contacte car nous aimons beaucoup ton contenu, que nous trouvons très qualitatif et en parfaite adéquation avec l'univers de la marque. ✨\n\nL'idée serait de te faire découvrir ${b.produits} et de mettre en avant ${disp} dans le cadre d'un partenariat avec ${brand}.\n\nSerais-tu partante ? Je reste bien sûr disponible pour la moindre question et serais ravie d'échanger avec toi. 🤍\n\nAu plaisir de te lire,\n${cp}`;
}
function emailOf(cpName) { const u = USERS.find((x) => normName(x.name) === normName(cpName)); return u ? u.email : null; }

// --- Relances créateurs : on trace les profils contactés pour relancer si pas de réponse ---
const CONTACTED_STORE = path.join(process.env.DATA_DIR || __dirname, "contacted.json");
function loadContacted() { try { return JSON.parse(fs.readFileSync(CONTACTED_STORE, "utf8")); } catch (e) { return []; } }
function saveContacted(a) { try { fs.writeFileSync(CONTACTED_STORE, JSON.stringify(a)); } catch (e) {} }
function recordContacted(rec) { const a = loadContacted(); a.push(rec); saveContacted(a); }

// --- Veille / Sourcing : profils à contacter (board Tâches, Type=Prise de contact) ---
const INHAIRCARE_DB = "380f8ac3-c3ae-80ce-ba4c-e8e82490edc6";
app.get("/api/sourcing", auth, async (req, res) => {
  if (DEMO || !notion) return res.json({ enabled: false, profils: [] });
  try {
    const all = []; let cursor;
    do {
      const r = await notion.databases.query({
        database_id: TASKS_DB, start_cursor: cursor, page_size: 100,
        filter: { property: "Type", select: { equals: "Prise de contact" } },
      });
      r.results.forEach((pg) => all.push(mapTask(pg))); cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    const me = normName(req.user.name);
    const sup = req.user.role === "supervisor";
    const profils = all
      .filter((t) => t.statut !== "Fait" && (sup || !t.responsable || normName(t.responsable) === me))
      .sort((a, b) => (a.echeance || "9999").localeCompare(b.echeance || "9999"));
    res.json({ enabled: true, profils });
  } catch (e) { res.json({ enabled: false, error: e.message, profils: [] }); }
});
app.post("/api/sourcing", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  const profil = String(req.body?.profil || "").trim();
  if (!profil) return res.status(400).json({ error: "profil vide" });
  const props = {
    "Tâche": { title: [{ text: { content: profil } }] },
    "Type": { select: { name: "Prise de contact" } },
    "Statut": { select: { name: "À faire" } },
  };
  if (req.body?.marque) props["Projet"] = { select: { name: String(req.body.marque) } };
  const resp = req.body?.responsable || (req.user.role !== "supervisor" ? req.user.name : null);
  if (resp) props["Responsable"] = { select: { name: String(resp) } };
  const lien = req.body?.lien || (/^https?:\/\//i.test(profil) ? profil : null);
  if (lien) props["Lien profil"] = { url: String(lien) };
  if (req.body?.commentaire) props["Commentaire veille"] = { rich_text: [{ text: { content: String(req.body.commentaire) } }] };
  try {
    const pg = await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props });
    // Message auto-prêt : brouillon d'approche dans le Gmail de la CP assignée (si connectée)
    let draft = false;
    try {
      if (resp && gm.ENABLED && typeof gm.createDraft === "function") {
        const cpEmail = emailOf(resp);
        if (cpEmail && gm.isConnected(cpEmail)) {
          const inf = infFromTitle(profil);
          const subject = "Partenariat " + (req.body?.marque || "") + " — Hyped Agency";
          const r = await gm.createDraft(cpEmail, { to: "", subject, body: genOutreachFR(req.body?.marque || "", inf, resp) });
          draft = !!(r && r.ok);
        }
      }
    } catch (e) { console.warn("auto-draft", e.message); }
    res.json({ ok: true, id: pg.id, draft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/sourcing/:id/contacted", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  try {
    const pg = await notion.pages.retrieve({ page_id: req.params.id });
    const t = mapTask(pg);
    // 1) sort de la liste veille
    await notion.pages.update({ page_id: req.params.id, properties: { "Statut": { select: { name: "Fait" } } } });
    // trace pour la relance auto (si pas de réponse sous 3 jours)
    recordContacted({ creator: t.task, cp: t.responsable || ASSIGN[normName(t.task)] || null, brand: t.projet || null, at: Date.now(), relance: false });
    // 2) bascule en collab "à lancer" dans le calendrier de la marque (In Haircare géré)
    let moved = false;
    if (t.projet === "In Haircare") {
      const props = { "Nom": { title: [{ text: { content: t.task } }] }, "Statut": { select: { name: "Non posté" } } };
      const uid = await userIdByName(t.responsable || req.user.name);
      if (uid) props["Interlocuteur"] = { people: [{ id: uid }] };
      try { await notion.pages.create({ parent: { database_id: INHAIRCARE_DB }, properties: props }); moved = true; CACHE.at = 0; }
      catch (e) { console.warn("create collab", e.message); }
    }
    res.json({ ok: true, moved, brand: t.projet });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Rappel preview J-72h : crée "Valider la preview de X" dans la to-do --
async function ensurePreviewTasks() {
  if (DEMO || !notion) return;
  try {
    if (!Object.keys(USERMAP).length) { try { await resolveUsers(); } catch (e) {} }
    try { await refreshAssignmentsFromBoxes(); } catch (e) {} // rafraîchit l'assignation auto (mails)
    const iso = (d) => d.toISOString().slice(0, 10);
    const now = new Date();
    const start = iso(now);
    const end = iso(new Date(now.getTime() + 4 * 864e5)); // collabs qui sortent dans les 4 jours (~J-72h)
    // 1) collabs en cours dont la mise en ligne est proche (preview à valider sous 72h)
    const due = []; let cursor;
    do {
      const r = await notion.databases.query({
        database_id: INHAIRCARE_DB, start_cursor: cursor, page_size: 100,
        filter: { and: [
          { property: "Date", date: { on_or_after: start, on_or_before: end } },
          { or: [
            { property: "Statut", select: { equals: "En production" } },
            { property: "Statut", select: { equals: "En validation" } },
          ] },
        ] },
      });
      r.results.forEach((pg) => {
        const p = pg.properties || {};
        const nom = title(p["Nom"]) || "(sans nom)";
        const liveD = p["Date"]?.date?.start || null;
        let prev = p["Date preview"]?.date?.start || null;
        if (!prev && liveD) prev = iso(new Date(new Date(liveD).getTime() - 3 * 864e5)); // J-72h calculé
        const cp = firstPerson(p["Interlocuteur"]) || ASSIGN[normName(nom)] || null; // Notion manuel, sinon auto par mail
        due.push({ nom, prev, cp });
      });
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    if (!due.length) return;
    // 2) tâches preview déjà existantes (dédup)
    const existing = new Set(); let c2;
    do {
      const r = await notion.databases.query({
        database_id: TASKS_DB, start_cursor: c2, page_size: 100,
        filter: { property: "Tâche", title: { contains: "Valider la preview" } },
      });
      r.results.forEach((pg) => { const t = mapTask(pg); if (t.statut !== "Fait") existing.add(t.task.trim()); });
      c2 = r.has_more ? r.next_cursor : null;
    } while (c2);
    // 3) création des manquantes
    for (const d of due) {
      const ttl = `Valider la preview de ${d.nom} (In Haircare)`;
      if (existing.has(ttl)) continue;
      const props = {
        "Tâche": { title: [{ text: { content: ttl } }] },
        "Statut": { select: { name: "À faire" } },
        "Projet": { select: { name: "In Haircare" } },
      };
      if (d.cp) props["Responsable"] = { select: { name: d.cp } };
      if (d.prev) props["Échéance"] = { date: { start: d.prev } };
      try { await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); existing.add(ttl); console.log("preview task créée:", ttl); }
      catch (e) { console.warn("preview task", e.message); }
    }
  } catch (e) { console.warn("ensurePreviewTasks", e.message); }
}
ensurePreviewTasks();
setInterval(ensurePreviewTasks, 6 * 3600 * 1000); // re-vérifie ~4x/jour (dédup -> pas de doublon)

// --- Relances créateurs : "Relancer X" si contacté il y a 3j+ et pas de réponse -------
async function ensureRelances() {
  if (DEMO || !notion || !gm.ENABLED) return;
  try {
    const list = loadContacted();
    if (!list.length) return;
    const now = Date.now();
    // créateurs ayant répondu, par boîte CP
    const repliesByEmail = {};
    const collabs = await fetchRows();
    for (const email of (gm.connectedEmails ? gm.connectedEmails() : [])) {
      try {
        const r = await gm.analyzeFor(email, collabs);
        const s = new Set(); (r.creatorReplies || []).forEach((m) => { if (m["créateur"]) s.add(normName(m["créateur"])); });
        repliesByEmail[email] = s;
      } catch (e) {}
    }
    // tâches relance déjà existantes (dédup)
    const existing = new Set(); let c;
    do {
      const r = await notion.databases.query({ database_id: TASKS_DB, start_cursor: c, page_size: 100, filter: { property: "Tâche", title: { contains: "Relancer" } } });
      r.results.forEach((pg) => { const tt = mapTask(pg); if (tt.statut !== "Fait") existing.add(tt.task.trim()); });
      c = r.has_more ? r.next_cursor : null;
    } while (c);
    let changed = false;
    for (const rec of list) {
      if (rec.relance) continue;
      if (now - rec.at < 3 * 864e5) continue; // on laisse 3 jours pour répondre
      const cname = infFromTitle(rec.creator);
      if (cname === "[prénom]") { rec.relance = true; changed = true; continue; } // pas de nom exploitable
      const cpEmail = rec.cp ? emailOf(rec.cp) : null;
      const replied = cpEmail && repliesByEmail[cpEmail] ? repliesByEmail[cpEmail].has(normName(rec.creator)) : false;
      if (replied) { rec.relance = true; changed = true; continue; } // a répondu -> pas de relance
      const ttl = `Relancer ${cname}${rec.brand ? " (" + rec.brand + ")" : ""}`;
      if (existing.has(ttl)) { rec.relance = true; changed = true; continue; }
      const props = { "Tâche": { title: [{ text: { content: ttl } }] }, "Type": { select: { name: "Relance créateur" } }, "Statut": { select: { name: "À faire" } } };
      if (rec.cp) props["Responsable"] = { select: { name: rec.cp } };
      if (rec.brand) props["Projet"] = { select: { name: rec.brand } };
      try { await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); existing.add(ttl); rec.relance = true; changed = true; console.log("relance créée:", ttl); }
      catch (e) { console.warn("relance", e.message); }
    }
    if (changed) saveContacted(list);
  } catch (e) { console.warn("ensureRelances", e.message); }
}
ensureRelances();
setInterval(ensureRelances, 6 * 3600 * 1000);

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Cockpit ${DEMO ? "(DÉMO)" : "(Notion live, clients actifs)"} → http://localhost:${PORT}`));
