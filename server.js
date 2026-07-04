/* Cockpit des chefs de projet - Hyped Agency
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
const crypto = require("crypto"); // signatures des liens d'action du copilote
const gm = require("./gmail-oauth"); // connexion Gmail par personne (inerte si Google non configuré)

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const PROD = process.env.NODE_ENV === "production";
const DEMO = !process.env.NOTION_TOKEN;

function loadUsers() {
  // Priorité au disque persistant : les mots de passe changés depuis le cockpit y sont enregistrés
  // et survivent aux déploiements. Le users.example.json du repo n'est qu'un DERNIER recours.
  const candidates = [
    "/var/data/users.json",
    process.env.DATA_DIR ? path.join(process.env.DATA_DIR, "users.json") : null,
    "/etc/secrets/users.json",
    path.join(__dirname, "users.json"),
    path.join(__dirname, "users.example.json"),
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        if (p.endsWith("users.example.json")) console.warn("[auth] ATTENTION : comptes chargés depuis users.example.json (fichier public du repo). Change les mots de passe depuis le menu avatar pour basculer sur le disque persistant.");
        return JSON.parse(fs.readFileSync(p, "utf8"));
      }
    } catch (e) {}
  }
  return [];
}
const USERS = loadUsers();

// === Assignation créateur -> CP (HYBRIDE) ================================
// Manuel : champ "Interlocuteur" dans Notion (prioritaire si renseigné).
// Auto   : on déduit qui gère un créateur d'après QUI échange avec lui par mail.
// Dossier de stockage persistant : on préfère le disque monté /var/data (survit aux deploys).
function resolveDataDir() {
  for (const d of ["/var/data", process.env.DATA_DIR, __dirname]) {
    if (!d) continue;
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) {}
  }
  return __dirname;
}
const DATA_DIR = resolveDataDir();
try { console.log("[data] stockage persistant →", DATA_DIR); } catch (e) {}
const ASSIGN_STORE = path.join(DATA_DIR, "assignments.json"); // disque persistant en prod
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
const MIN_DAYS = 3; // règle Hyped : un calendrier est "bien rempli" si ≥3 JOURS différents/semaine
async function datesInMonth(dbId, dateProp, startISO, endISO) {
  const out = []; let cursor;
  do {
    const r = await notion.databases.query({ database_id: dbId, start_cursor: cursor, page_size: 100,
      filter: { property: dateProp, date: { on_or_after: startISO, on_or_before: endISO } } });
    r.results.forEach((pg) => { const dt = pg.properties?.[dateProp]?.date?.start; if (dt) out.push(dt.slice(0, 10)); });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return out;
}
async function buildAlerts() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 2, 0);
  const iso = (d) => d.toISOString().slice(0, 10);
  const monthLabel = start.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  // 4 semaines du mois : Semaine 1 = jours 1-7, S2 = 8-14, S3 = 15-21, S4 = 22 → fin du mois
  const totalWeeks = 4;
  const weekIdx = (dtISO) => { const day = parseInt(dtISO.slice(8, 10), 10); return Math.min(3, Math.floor((day - 1) / 7)); };
  const fill = [];
  // EN PARALLÈLE : on interroge tous les calendriers de marques en même temps
  const fillArr = await Promise.all(FILL_CHECK.map(async (c) => {
    if (c.unverifiable) return { brand: c.brand, status: "inconnu", totalWeeks, minDays: MIN_DAYS };
    let dates;
    try { dates = await datesInMonth(c.dbId, c.dateProp, iso(start), iso(end)); }
    catch (e) { return { brand: c.brand, status: "erreur", totalWeeks, minDays: MIN_DAYS }; }
    const byWeekDays = [0, 1, 2, 3].map(() => new Set());   // jours distincts couverts
    const byWeekCount = [0, 0, 0, 0];                         // nb de collabs
    dates.forEach((dt) => { const idx = weekIdx(dt); byWeekDays[idx].add(dt); byWeekCount[idx]++; });
    const weeks = [0, 1, 2, 3].map((i) => { const days = byWeekDays[i].size, collabs = byWeekCount[i]; return { label: "Semaine " + (i + 1), days, collabs, ok: collabs >= MIN_PER_WEEK && days >= MIN_DAYS }; });
    const weeksOk = weeks.filter((x) => x.ok).length;
    const totalCollabs = dates.length;
    const status = totalCollabs === 0 ? "vide" : (weeksOk === 0 ? "faible" : (weeksOk < totalWeeks ? "partiel" : "ok"));
    return { brand: c.brand, weeks, weeksOk, totalWeeks, totalCollabs, minDays: MIN_DAYS, minCollabs: MIN_PER_WEEK, status };
  }));
  fill.push(...fillArr);
  return { monthLabel, minDays: MIN_DAYS, fill };
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
      "En validation": { grp: "Validé", label: "Contenu validé", color: "#C2553B" },
      "En production": { grp: "En production", label: "En cours de production", color: "#7A5AA8" },
      "Non posté":     { grp: "Planifié", label: "Le contenu est planifié", color: "#C77F2A" },
      // "Posté" -> rien (terminé)
    };
    const m = M[statut];
    if (!m) return null;
    return {
      id: page.id,
      brand,
      name: title(p["Nom"]) || "(sans nom)",
      cp: firstPerson(p["Interlocuteur"]),
      statut,
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
app.use(express.json({ limit: "12mb" })); // 12 Mo : permet l'upload des documents de fiche marque (base64)
app.use(cookieParser());
function setAuthCookie(res, payload) {
  const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "30d" });
  res.cookie("hc_token", token, { httpOnly: true, sameSite: PROD ? "none" : "lax", secure: PROD, maxAge: 30 * 864e5 * 1000 });
}
function auth(req, res, next) {
  try { req.user = jwt.verify(req.cookies.hc_token, JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: "non connecté" }); }
}
// Anti brute force : 8 échecs par IP+email -> pause de 10 minutes
const LOGIN_FAILS = {}; // clé -> { n, until }
function loginKey(req, email) { return String(req.headers["x-forwarded-for"] || req.ip || "?").split(",")[0].trim() + "|" + String(email || "").toLowerCase(); }
app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  const k = loginKey(req, email);
  const f = LOGIN_FAILS[k];
  if (f && f.until && f.until > Date.now()) return res.status(429).json({ error: "Trop de tentatives. Réessaie dans quelques minutes." });
  const u = USERS.find((x) => x.email.toLowerCase() === String(email || "").toLowerCase());
  if (!u || !bcrypt.compareSync(String(password || ""), u.passwordHash)) {
    const e = (LOGIN_FAILS[k] = LOGIN_FAILS[k] || { n: 0, until: 0 });
    e.n += 1;
    if (e.n >= 8) { e.until = Date.now() + 10 * 60 * 1000; e.n = 0; }
    return res.status(401).json({ error: "Email ou mot de passe incorrect." });
  }
  delete LOGIN_FAILS[k];
  setAuthCookie(res, { email: u.email, name: u.name, role: u.role });
  res.json({ name: u.name, role: u.role });
});
// Changement de mot de passe (chacune le sien), enregistré sur le disque persistant :
// permet de sortir des mots de passe du users.example.json public du repo.
app.post("/api/account/password", auth, (req, res) => {
  const { current, next } = req.body || {};
  const u = USERS.find((x) => x.email.toLowerCase() === String(req.user.email || "").toLowerCase());
  if (!u) return res.status(404).json({ error: "compte introuvable" });
  if (!bcrypt.compareSync(String(current || ""), u.passwordHash)) return res.status(401).json({ error: "Mot de passe actuel incorrect." });
  if (String(next || "").length < 8) return res.status(400).json({ error: "Le nouveau mot de passe doit faire au moins 8 caractères." });
  u.passwordHash = bcrypt.hashSync(String(next), 10);
  try { fs.writeFileSync(path.join(DATA_DIR, "users.json"), JSON.stringify(USERS, null, 2)); }
  catch (e) { return res.status(500).json({ error: "impossible d'enregistrer sur le disque" }); }
  res.json({ ok: true });
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
    const teamReq = String(req.query.team || "") === "1" && req.user.role !== "supervisor"; // CP en vue équipe (congés)
    if (req.user.role !== "supervisor" && !teamReq) rows = rows.filter((r) => r.cp === req.user.name);
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
    const teamReq = String(req.query.team || "") === "1" && !isSup; // CP en vue équipe (congés)
    const viewCp = isSup ? String(req.query.view || "").trim() : ""; // pilote qui regarde une CP précise
    const scoped = viewCp && viewCp !== "ALL"; // si oui, on cale TOUT sur cette CP (cohérent avec la liste)
    const mine = (resp) => scoped ? (normName(resp) === normName(viewCp)) : (isSup || teamReq || normName(resp) === me);
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
    if (scoped) rows = rows.filter((r) => normName(r.cp) === normName(viewCp));
    else if (!isSup && !teamReq) rows = rows.filter((r) => r.cp === req.user.name);
    rows.forEach((r) => {
      const b = r.brand || "Autres";
      if (r.grp === "Validé") B(b).recus++; else B(b).contenus++;
    });
    const brands = Object.values(C)
      .filter((x) => x.aContacter || x.relances || x.contenus || x.recus)
      .sort((a, b) => (b.aContacter + b.relances + b.contenus + b.recus) - (a.aContacter + a.relances + a.contenus + a.recus));
    // 3) pipeline global (6 étapes ; réel là où on le trace)
    const contacted = loadContacted().filter((c) => mine(c.cp));
    const aContacter = open.filter((t) => t.type === "Prise de contact").length;
    const contacte = contacted.length;
    const recus = rows.filter((r) => r.grp === "Validé").length;
    const relancesN = open.filter((t) => t.type === "Relance créateur").length;
    const pipeline = [
      { key: "a_contacter", label: "À contacter",   count: aContacter },
      { key: "contacte",    label: "Contacté",      count: contacte },
      { key: "reponse",     label: "Réponse reçue", count: 0, soon: true },
      { key: "brief",       label: "Brief envoyé",  count: loadBriefs().filter((b) => mine(b.cp)).length },
      { key: "contenu",     label: "Contenu reçu",  count: recus },
      { key: "publie",      label: "Publié",        count: 0, soon: true },
    ];
    // 4) indicateurs + deltas « vs hier » (instantané quotidien par CP)
    const stats = { aTraiter: open.length, aContacter, relances: relancesN, aValider: recus };
    const key = isSup ? ("SUP:" + (normName(req.user.name) || "pilote")) : String(req.user.email || "").toLowerCase();
    // en vue équipe (CP), on ne touche pas au snapshot perso : pas de delta faussé
    let deltas = null; if (!teamReq && !scoped) { try { deltas = snapshotAndDelta(key, stats); } catch (e) {} }
    res.json({ enabled: true, brands, pipeline, relances: relancesN, stats, deltas });
  } catch (e) { res.json({ enabled: false, error: e.message, brands: [], pipeline: [] }); }
});
// Footer « Dernières activités » : journal réel des actions (profils, contacts, relances, mails)
app.get("/api/activity", auth, (req, res) => {
  const isSup = req.user.role === "supervisor";
  const me = normName(req.user.name);
  const teamReq = String(req.query.team || "") === "1" && !isSup;
  const mine = (cp) => isSup || teamReq || normName(cp) === me;
  const clean = (s) => String(s || "").replace(/^contacter\s+/i, "").trim();
  const evs = [];
  loadActivity().forEach((a) => { if (mine(a.cp)) evs.push({ ...a, creator: clean(a.creator) }); });
  loadContacted().forEach((c) => { if (mine(c.cp)) evs.push({ type: c.relance ? "relance" : "contacte", creator: clean(c.creator), brand: c.brand, cp: c.cp, at: c.at }); });
  evs.sort((a, b) => (b.at || 0) - (a.at || 0));
  const seen = new Set(); const out = [];
  for (const e of evs) { const k = e.type + "|" + (e.creator || "") + "|" + Math.round((e.at || 0) / 60000); if (seen.has(k)) continue; seen.add(k); out.push(e); if (out.length >= 12) break; }
  res.json({ activity: out });
});
app.get("/api/alerts", auth, async (req, res) => {
  // Remplissage des calendriers : visible par TOUTES les CP (plus seulement le pilote).
  if (DEMO) return res.json({ monthLabel: "juillet 2026", minDays: MIN_DAYS, fill: [
    { brand: "In Haircare", status: "partiel", weeksOk: 2, totalWeeks: 4, totalCollabs: 11, minDays: 3, minCollabs: 3, weeks: [
      { label: "Semaine 1", days: 3, collabs: 4, ok: true }, { label: "Semaine 2", days: 1, collabs: 2, ok: false }, { label: "Semaine 3", days: 3, collabs: 3, ok: true }, { label: "Semaine 4", days: 1, collabs: 2, ok: false } ] },
    { brand: "Doucéa", status: "vide", weeksOk: 0, totalWeeks: 4, totalCollabs: 0, minDays: 3, minCollabs: 3, weeks: [
      { label: "Semaine 1", days: 0, collabs: 0, ok: false }, { label: "Semaine 2", days: 0, collabs: 0, ok: false }, { label: "Semaine 3", days: 0, collabs: 0, ok: false }, { label: "Semaine 4", days: 0, collabs: 0, ok: false } ] },
    { brand: "Curls Matter", status: "inconnu", totalWeeks: 4, minDays: 3 } ] });
  try {
    const fresh = req.query.fresh === "1";
    if (!fresh && ALERTS_CACHE && (Date.now() - ALERTS_CACHE.at) < ALERTS_TTL) return res.json({ cached: true, ...ALERTS_CACHE.data });
    const data = await buildAlerts();
    ALERTS_CACHE = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
let ALERTS_CACHE = null; const ALERTS_TTL = 5 * 60 * 1000; // 5 min (le remplissage bouge lentement)
// --- Connexion Gmail par personne (réponses créateurs) ------------------
// Résout quelle boîte regarder : par défaut la sienne ; le PILOTE peut viser une CP (?as=Prénom).
function inboxTarget(req) {
  const as = String(req.query.as || "").trim();
  if (as && req.user.role === "supervisor") {
    const email = as.includes("@") ? as.toLowerCase() : emailOf(as);
    if (email) return { email, viewing: as };
  }
  return { email: req.user.email, viewing: null };
}
app.get("/api/gmail/status", auth, (req, res) => {
  const t = inboxTarget(req);
  res.json({ enabled: gm.ENABLED, connected: gm.ENABLED ? gm.isConnected(t.email) : false, viewing: t.viewing });
});
app.get("/api/gmail/attachment", auth, async (req, res) => {
  if (!gm.ENABLED) return res.status(400).send("Gmail non configuré");
  const { msgId, attId } = req.query;
  const name = String(req.query.name || "piece-jointe").replace(/[\r\n"]/g, "");
  if (!msgId || !attId) return res.status(400).send("paramètres manquants");
  try {
    const t = inboxTarget(req);
    if (!gm.isConnected(t.email)) return res.status(403).send("Gmail non connecté");
    const buf = await gm.getAttachment(t.email, String(msgId), String(attId));
    if (!buf) return res.status(404).send("pièce jointe introuvable");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Disposition", 'attachment; filename="' + encodeURIComponent(name) + '"');
    res.send(buf);
  } catch (e) { res.status(500).send("erreur"); }
});
app.get("/api/gmail/signature", auth, async (req, res) => {
  if (!gm.ENABLED) return res.json({ enabled: false });
  const t = inboxTarget(req);
  if (!gm.isConnected(t.email)) return res.json({ enabled: true, connected: false });
  try { const html = await gm.getSignature(t.email); res.json({ enabled: true, connected: true, has: !!(html && html.trim()), scopeOk: html !== null }); }
  catch (e) { res.json({ enabled: true, connected: true, has: false, scopeOk: false }); }
});
app.get("/api/gmail/connect", auth, (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Connexion Gmail non configurée." });
  res.json({ url: gm.getAuthUrl(req.user.email) });
});
app.get("/api/gmail/callback", async (req, res) => {
  try { await gm.handleCallback(req.query.code, req.query.state); res.redirect("/?gmail=ok"); }
  catch (e) { res.redirect("/?gmail=err"); }
});
// Cache court de l'analyse Gmail par boîte (évite de tout relire à chaque rechargement)
const INBOX_CACHE = {}; // email -> { at, data }
const INBOX_TTL = 60 * 1000; // 60 s
app.get("/api/gmail/inbox", auth, async (req, res) => {
  if (!gm.ENABLED) return res.json({ enabled: false });
  try {
    const t = inboxTarget(req); // sa boîte, ou celle d'une CP si pilote + ?as=
    if (!gm.isConnected(t.email)) return res.json({ enabled: true, connected: false, viewing: t.viewing });
    const fresh = req.query.fresh === "1";
    const c = INBOX_CACHE[t.email];
    let r, cached = false;
    if (!fresh && c && (Date.now() - c.at) < INBOX_TTL) { r = c.data; cached = true; }
    else {
      const collabs = await fetchRows(); // marques + créateurs des calendriers
      r = await gm.analyzeFor(t.email, collabs);
      INBOX_CACHE[t.email] = { at: Date.now(), data: r };
      if (!t.viewing) learnAssignments(req.user.name, r); // n'apprend que sur sa propre boîte
    }
    // état « traité » (par qui/quand) appliqué à chaque réponse créateur, toujours à jour
    const tt = treatedFor(t.email);
    if (r.creatorReplies) r.creatorReplies.forEach((x) => { x.treated = (x.threadId && tt[x.threadId]) ? tt[x.threadId] : null; });
    res.json({ enabled: true, viewing: t.viewing, cached, ...r });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Mails « traités » (évite les réponses en double) --------------------
const TREATED_STORE = path.join(DATA_DIR, "treated.json");
function loadTreated() { try { return JSON.parse(fs.readFileSync(TREATED_STORE, "utf8")); } catch (e) { return {}; } }
function saveTreated(o) { try { fs.writeFileSync(TREATED_STORE, JSON.stringify(o)); } catch (e) {} }
function markTreated(email, threadId, meta) { if (!email || !threadId) return; const o = loadTreated(); o[email + "|" + threadId] = { by: (meta && meta.by) || "", action: (meta && meta.action) || "répondu", at: Date.now() }; saveTreated(o); }
function unmarkTreated(email, threadId) { if (!email || !threadId) return; const o = loadTreated(); delete o[email + "|" + threadId]; saveTreated(o); }
function treatedFor(email) { const o = loadTreated(); const out = {}; const pre = email + "|"; for (const k in o) { if (k.indexOf(pre) === 0) out[k.slice(pre.length)] = o[k]; } return out; }
app.post("/api/mail/treated", auth, (req, res) => {
  const t = inboxTarget(req);
  const threadId = String(req.body?.threadId || "").trim();
  const treated = req.body?.treated !== false;
  if (!threadId) return res.status(400).json({ error: "threadId manquant" });
  if (treated) markTreated(t.email, threadId, { by: req.user.name, action: "manuel" }); else unmarkTreated(t.email, threadId);
  res.json({ ok: true, treated });
});
// --- Brouillons mail (le cockpit prépare, la CP relit et envoie) ---------
app.post("/api/gmail/draft", auth, async (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Gmail non configuré" });
  const { to, cc, bcc, subject, body } = req.body || {};
  if (!subject && !body) return res.status(400).json({ error: "message vide" });
  try { const r = await gm.createDraft(req.user.email, { to, cc, bcc, subject, body }); if (r && r.ok) { logActivity({ type: "brouillon", creator: to || null, cp: req.user.name }); if (req.body?.threadId) markTreated(inboxTarget(req).email, String(req.body.threadId), { by: req.user.name, action: "brouillon" }); } res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/gmail/drafts", auth, async (req, res) => {
  if (!gm.ENABLED) return res.json({ count: 0 });
  try { res.json(await gm.draftsToValidate(req.user.email)); }
  catch (e) { res.json({ count: 0 }); }
});
app.post("/api/gmail/send", auth, async (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Gmail non configuré" });
  const { to, cc, bcc, subject, body } = req.body || {};
  if (!to) return res.status(400).json({ error: "destinataire manquant" });
  try { const r = await gm.sendEmail(req.user.email, { to, cc, bcc, subject, body }); if (r && r.ok) { logActivity({ type: "email", creator: to, cp: req.user.name }); if (req.body?.threadId) markTreated(inboxTarget(req).email, String(req.body.threadId), { by: req.user.name, action: "répondu" }); } res.json(r); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Envois programmés (le cockpit envoie à l'heure dite, même hors ligne) ---
const SCHEDULED_STORE = path.join(DATA_DIR, "scheduled.json");
function loadScheduled() { try { return JSON.parse(fs.readFileSync(SCHEDULED_STORE, "utf8")); } catch (e) { return []; } }
function saveScheduled(a) { try { fs.writeFileSync(SCHEDULED_STORE, JSON.stringify(a)); } catch (e) {} }
app.post("/api/gmail/schedule", auth, (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Gmail non configuré" });
  const to = String(req.body?.to || "").trim();
  const cc = String(req.body?.cc || "").trim();
  const bcc = String(req.body?.bcc || "").trim();
  const subject = String(req.body?.subject || "");
  const body = String(req.body?.body || "");
  const at = Number(req.body?.at || 0);
  if (!to) return res.status(400).json({ error: "destinataire manquant" });
  if (!at || at < Date.now() + 30000) return res.status(400).json({ error: "choisis une date/heure future" });
  const item = { id: "s_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), email: req.user.email, by: req.user.name, to, cc, bcc, subject, body, at, createdAt: Date.now(), attempts: 0 };
  const a = loadScheduled(); a.push(item); saveScheduled(a);
  logActivity({ type: "programme", creator: to, cp: req.user.name, extra: new Date(at).toISOString() });
  if (req.body?.threadId) markTreated(inboxTarget(req).email, String(req.body.threadId), { by: req.user.name, action: "programmé" });
  res.json({ ok: true, id: item.id, at });
});
app.get("/api/gmail/scheduled", auth, (req, res) => {
  const mine = loadScheduled().filter((x) => x.email === req.user.email).sort((a, b) => a.at - b.at)
    .map((x) => ({ id: x.id, to: x.to, subject: x.subject, at: x.at }));
  res.json({ scheduled: mine });
});
app.post("/api/gmail/scheduled/:id/cancel", auth, (req, res) => {
  const a = loadScheduled();
  const before = a.length;
  const kept = a.filter((x) => !(x.id === req.params.id && x.email === req.user.email));
  saveScheduled(kept);
  res.json({ ok: kept.length < before });
});
// Boucle : envoie les mails dus (toutes les 60 s + un passage au démarrage)
async function runScheduledSends() {
  if (!gm.ENABLED) return;
  let a = loadScheduled();
  if (!a.length) return;
  const now = Date.now();
  const due = a.filter((x) => x.at <= now);
  if (!due.length) return;
  for (const item of due) {
    try {
      const r = await gm.sendEmail(item.email, { to: item.to, cc: item.cc, bcc: item.bcc, subject: item.subject, body: item.body });
      if (r && r.ok) { logActivity({ type: "email", creator: item.to, cp: item.by, extra: "envoi programmé" }); item._done = true; }
      else { item.attempts = (item.attempts || 0) + 1; item.lastError = r && r.error; }
    } catch (e) { item.attempts = (item.attempts || 0) + 1; item.lastError = String(e && e.message || e); }
  }
  // on retire les envoyés et ceux qui échouent depuis trop longtemps (>10 tentatives)
  const remaining = loadScheduled().map((x) => { const d = due.find((y) => y.id === x.id); return d ? d : x; })
    .filter((x) => !x._done && (x.attempts || 0) < 10);
  saveScheduled(remaining);
}
setInterval(() => { runScheduledSends().catch(() => {}); }, 60 * 1000);
setTimeout(() => { runScheduledSends().catch(() => {}); }, 8000); // rattrapage au démarrage
// --- Cerveau IA : rédige une réponse adaptée au mail RÉELLEMENT reçu ------
// Compatible OpenAI (ChatGPT) ET Anthropic (Claude). On utilise la clé présente :
//   - OPENAI_API_KEY  -> ChatGPT  (modèle OPENAI_MODEL, défaut gpt-4o-mini)
//   - ANTHROPIC_API_KEY -> Claude (modèle REPLY_MODEL, défaut claude-3-5-haiku-latest)
const REPLY_MODEL = process.env.REPLY_MODEL || "claude-3-5-haiku-latest";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
async function callOpenAI(sys, ctx) {
  const key = process.env.OPENAI_API_KEY;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + key },
      body: JSON.stringify({ model: OPENAI_MODEL, max_tokens: 700, temperature: 0.7,
        messages: [{ role: "system", content: sys }, { role: "user", content: ctx }] }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { ok: false, reason: "api", detail: (t || "").slice(0, 300), status: r.status }; }
    const d = await r.json();
    const text = (d.choices?.[0]?.message?.content || "").trim();
    return text ? { ok: true, body: text, via: "openai" } : { ok: false, reason: "empty" };
  } catch (e) { return { ok: false, reason: "exc", detail: String(e && e.message || e) }; }
}
async function callAnthropic(sys, ctx) {
  const key = process.env.ANTHROPIC_API_KEY;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: REPLY_MODEL, max_tokens: 700, system: sys, messages: [{ role: "user", content: ctx }] }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { ok: false, reason: "api", detail: (t || "").slice(0, 300), status: r.status }; }
    const d = await r.json();
    const text = (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    return text ? { ok: true, body: text, via: "anthropic" } : { ok: false, reason: "empty" };
  } catch (e) { return { ok: false, reason: "exc", detail: String(e && e.message || e) }; }
}
async function claudeReply({ cp, creator, brand, category, received, subject, transcript, directive }) {
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return { ok: false, reason: "nokey" };
  // On s'adresse aux créateurs par leur PRÉNOM, jamais par leur nom complet / pseudo (« Juliette », pas « Juliette DTR »)
  const prenom = (String(creator || "").trim().replace(/^@/, "").split(/[\s|·@\/(_-]+/).filter(Boolean)[0]) || "";
  const sys = [
    "Tu es " + (cp || "la chef de projet") + ", chef de projet chez Hyped Agency (agence de marketing d'influence).",
    "Tu réponds par mail à un CRÉATEUR / INFLUENCEUR, en français, au nom de la marque concernée.",
    "",
    "Tu écris EXACTEMENT comme Kendia, cheffe de projet chez Hyped. Voici sa voix, à imiter fidèlement :",
    "",
    "PRÉNOM : tu t'adresses TOUJOURS à la personne par son PRÉNOM seul (ex. 'Juliette'), JAMAIS par son nom complet, son pseudo ou son nom d'affichage (ex. 'Juliette DTR', '@juliettedtr'). PRIORITÉ ABSOLUE : si l'historique du fil montre comment l'équipe l'appelle déjà (ex. 'Hello Juliette'), reprends exactement cette façon. Sinon utilise : '" + (prenom || "[prénom]") + "'.",
    "OUVERTURE : 'Hello " + (prenom || "[prénom]") + ",' (ou 'Coucou " + (prenom || "[prénom]") + ",'), souvent suivi de 'J'espère que tu vas bien ! 😊' ou 'Comment vas-tu ? :)'. Sur un fil déjà bien avancé, parfois juste '" + (prenom || "[prénom]") + ",'.",
    "ENTHOUSIASME (formules typiques de Kendia) : 'Trop chouette !', 'Super !', 'Trop contente que tu sois partante, ça me fait super plaisir aussi ! 😍', 'Trop contente de te lire, merci pour ton message 🤍', \"c'est exactement l'énergie qu'on adore !\".",
    "SUGGESTIONS, jamais d'ordres : 'Que dirais-tu de…', 'On pourrait imaginer…', \"L'idée serait de…\", 'on te fait hyper confiance sur le rendu 🫶'.",
    "DEMANDE D'ADRESSE : 'pourrais-tu me transmettre tes informations postales (nom, prénom, adresse complète et numéro de téléphone) afin que je programme l'envoi des produits 🫶✨'.",
    "RÉASSORT PRODUITS : 'Pour les produits, aucun souci, on t'en renvoie un réassort.'",
    "SUIVI COLIS : 'Voici ton numéro de suivi : [lien]. Hésite pas à me dire une fois que tu l'auras récupéré ;)'.",
    "FACTURE REÇUE : 'Merci beaucoup pour l'envoi de la facture ✨ Je te confirme l'avoir bien reçue et l'avoir transmise au service concerné pour traitement. 😊'.",
    "CLÔTURE DE COLLAB : 'Encore merci à toi pour cette collaboration, c'était un vrai plaisir de travailler ensemble 🥰'.",
    "DISPO : 'Je reste bien entendu dispo si besoin', 'N'hésite pas à me dire', 'Hésite pas à me tenir informé(e) ;)'.",
    "SI SOUCI / RETARD (ex. paiement) : empathie sincère, explication honnête, engagement CONCRET et daté, et on réaffirme qu'on tient à la collab. Jamais minimiser, jamais sec.",
    "CLÔTURES possibles (varie, ne mets PAS toujours la même) : 'Bien à toi,', 'Belle journée à toi ✨', 'Belle soirée à toi,', 'À très vite ✨', 'Je te souhaite une très belle soirée 🤍', \"Dans l'attente de ton retour,\". Puis le prénom : '" + (cp || "") + "'.",
    "EMOJIS de Kendia (légers, UNIQUEMENT si positif) : ✨ 🤍 🫶 🫶🏽 😊 😌 😍 🥰 ;) 🎀 🌟. Jamais d'excès, jamais si le ton est délicat.",
    "Ne JAMAIS écrire de signature complète type 'Kendia Koffi / Cheffe de projet / Hyped Agency' : juste le prénom (la signature mail s'ajoute automatiquement).",
    "",
    "STYLE : n'utilise JAMAIS de tiret quadratin, c'est-à-dire le caractère « — », dans tes réponses : préfère une virgule, deux-points ou une nouvelle phrase.",
    "RÈGLE D'OR : tu réponds VRAIMENT au contenu du dernier message : tu reprends ses points, réponds à ses questions, rebondis sur ce qu'il dit. JAMAIS de réponse générique.",
    "RÈGLE BUDGET, déterminer le type : la collab est rémunérée UNIQUEMENT si un budget / tarif / facture / paiement a déjà été ACTÉ par l'agence dans le fil. Sinon c'est un envoi de produits (gifting). N'affirme JAMAIS que c'est payé si ça n'a pas été acté.",
    "RÈGLE BUDGET, comment l'annoncer (FORMULATION OBLIGATOIRE, à respecter à la lettre) :",
    "  - On n'IMPOSE jamais et on ne REFUSE jamais frontalement. INTERDITS ABSOLUS (ne JAMAIS écrire) : 'on ne pourra pas activer le budget', 'on ne peut pas te rémunérer', 'ce n'est pas rémunéré', 'pas de budget', 'non rémunéré', 'collab non payée', 'en échange de ton contenu'.",
    "  - On présente le gifting comme un AVANTAGE, avec des tournures TENTATIVES ('nous pensions', 'on pensait partir sur') : ex. 'Nous pensions partir sur un envoi de nos produits afin que tu puisses tester toute la gamme ✨' (mets en avant l'intérêt de recevoir / tester la gamme).",
    "  - PUIS on suggère le contenu en douceur, jamais en ordre : ex. 'et nous pensions que tu pourrais ensuite donner ton avis dans une vidéo 🫶'. Si tu connais la plateforme (TikTok/Instagram) d'après le fil, précise-la ('dans une vidéo sur TikTok') ; SINON écris 'sur tes réseaux'. N'écris JAMAIS de crochet type '[plateforme]'.",
    "  - Si le créateur a PROPOSÉ un tarif/budget qu'on ne fait pas : ne refuse pas le montant, n'en parle même pas, réoriente positivement vers l'envoi produits (test de la gamme) + la suggestion de contenu.",
    "À l'inverse, si le fil parle clairement de factures/paiements déjà actés, tu es sur une collab rémunérée : agis en conséquence (accuser réception de facture, remboursement de produit acheté, etc.).",
    "N'invente JAMAIS un fait précis (montant, date exacte, condition) absent du fil. Si tu ne sais pas, demande.",
    "Reste concis : 3 à 10 lignes. Réponds UNIQUEMENT par le corps du mail, sans objet, sans guillemets, sans commentaire.",
    "",
    "EXEMPLES RÉELS de réponses de Kendia (imite ce style, pas le contenu) :",
    "[Reçu] 'Je suis partante !' → [Kendia] 'Hello [prénom],\\nTrop contente que tu sois partante, ça me fait super plaisir ! 😍\\nQue dirais-tu de prévoir 2 TikTok ce mois-ci autour de la gamme ? Si c'est bon pour toi, pourrais-tu me transmettre tes infos postales (nom, prénom, adresse complète et numéro de téléphone) afin que je programme l'envoi des produits 🫶✨\\nBien à toi,\\n[prénom CP]'",
    "[Reçu] (le créateur propose un tarif/budget, OU demande 'c'est rémunéré ?', et aucun budget n'a été acté) → [Kendia] 'Hello [prénom],\\nTrop contente que le concept te plaise ! 😊\\nNous pensions partir sur un envoi de toute notre gamme pour que tu puisses la tester tranquillement ✨, et nous pensions que tu pourrais ensuite donner ton avis dans une vidéo sur tes réseaux 🫶\\nSi ça te parle, peux-tu me transmettre tes infos postales (nom, prénom, adresse complète et numéro de téléphone) pour que je lance l'envoi ?\\nHâte de voir ce que tu vas imaginer ✨\\n[prénom CP]'  (NB : on ne parle PAS du budget proposé, on ne refuse rien.)",
    "[Reçu] 'As-tu des nouvelles de l'envoi ?' → [Kendia] 'Hello [prénom],\\nComment vas-tu ? :)\\nVoici ton numéro de suivi : [lien]. Il est dispo en point relais ! Hésite pas à me dire une fois récupéré ;)\\nBelle journée à toi,\\n[prénom CP]'",
    "[Reçu] 'J'ai bien reçu les produits, merci !' → [Kendia] '[prénom],\\nSuper ! Hésite pas à me dire dès que tu auras pu tourner ;)\\nBelle journée,\\n[prénom CP]'",
    "[Reçu] 'Voici la facture pour la vidéo.' → [Kendia] 'Coucou [prénom],\\nMerci beaucoup pour l'envoi de la facture ✨ Je te confirme l'avoir bien reçue et transmise au service concerné pour traitement 😊\\nEncore merci pour cette collaboration, c'était un vrai plaisir de travailler ensemble 🥰\\nÀ très bientôt 🤍\\n[prénom CP]'",
    "[Reçu] preview (vidéo + photos) → [Kendia] 'Hello [prénom],\\nJ'ai bien reçu ta preview, merci beaucoup pour l'envoi ! La vidéo est vraiment très chouette 🥰\\nDeux petits ajustements : pour les photos avant/après, penses-tu pouvoir me les renvoyer avec une meilleure luminosité et en faisant le focus uniquement sur le produit ? Et on essaie d'éviter les formats trop \"unboxing\", on préfère un angle avant/après plus centré sur l'effet 🤍\\nDis-moi ce que tu en penses, je reste dispo 😊\\nTrès belle journée,\\n[prénom CP]'",
    "[Reçu] caption + photo de couverture proposées → [Kendia] 'Hello [prénom] 😊\\nDe notre côté tout est validé pour la vidéo, merciii beaucoup à toi 🫶 Pour la caption c'est OK aussi : peux-tu juste ajouter le hashtag #[marque] et le @[compte agence] à la fin, et identifier la marque au moment où tu en parles ? Ensuite tu peux poster ✨\\nMerci beaucoup et très bonne journée,\\n[prénom CP]'",
    "Note : face à un créateur qui pousse / n'est pas d'accord, reste comme Kendia : 'Je comprends totalement ton point de vue', on valide en interne et on revient avec un retour. Jamais de bras de fer.",
    "",
    "CAS PARTICULIERS :",
    "• CAMPAGNE TikTok + WHITELISTING : après publication, on demande le code pub. Étapes à donner : 'Ouvre TikTok → la vidéo → les trois petits points ••• → \"Activer les autorisations de pub\" → choisis une durée de 3 mois → copie le code whitelisting et envoie-le-moi 🫶'. Quand le créateur envoie le code : 'Merci beaucoup pour le code, bien reçu 😊'. Si l'identification de l'agence apparaît sur la vidéo et n'est pas nécessaire : 'est-ce que tu pourrais enlever l'identification de l'agence sur la vidéo ? Ce n'est pas nécessaire vu le format de la collab :)'.",
    "• INTERLOCUTEUR = AGENT / MANAGER (signature type 'Agente de créateurs', domaine d'agence, parle de 'ses profils/talents') : tu réponds à l'AGENT au sujet de son créateur, ton pro ET chaleureux, tu peux vouvoyer si l'agent vouvoie. Pour toute question de facturation/paiement, oriente vers 'facturation@hyped-agency.fr'.",
    "• RETARD DE PAIEMENT / RELANCE FACTURE : excuse-toi sincèrement, explique avec tact (sans rejeter la faute sur le créateur), engage-toi à relancer le service facturation, et tiens la personne informée, MAIS ne promets JAMAIS une date précise que tu ne connais pas. Ex : 'je comprends totalement, j'ai relancé le service concerné et je reviens vers toi dès que j'ai un retour précis ✨'.",
    "[Reçu] 'Voici le code whitelisting : #abc123' → [Kendia] '[prénom],\\nMerci beaucoup pour le code, bien reçu 😊\\nPetite chose : pourrais-tu enlever l'identification de l'agence sur la vidéo ? Ce n'est pas nécessaire vu le format de la collab :) Merci encore pour ta réactivité 🫶\\nBelle soirée à toi,\\n[prénom CP]'",
  ].join("\n");
  const ctx = [
    "Marque : " + (brand || "-"),
    "Créateur : " + (creator || "-"),
    "Objet du fil : " + (subject || "-"),
    category ? ("Type détecté : " + category) : "",
    "",
    transcript ? "Historique COMPLET du fil (du plus ancien au plus récent, sert à juger si le budget a déjà été évoqué) :" : "Message reçu du créateur :",
    "\"\"\"",
    (transcript || received || "").slice(0, 7000),
    "\"\"\"",
    "",
    "Dernier message reçu (celui auquel tu réponds) :",
    "\"\"\"",
    (received || "").slice(0, 4000),
    "\"\"\"",
    "",
    directive ? ("DIRECTIVE DE LA CHEFFE DE PROJET (décision prise, à appliquer absolument, avec tact et dans la voix Hyped) : " + directive) : "",
    "Rédige la réponse de " + (cp || "la CP") + ".",
  ].filter(Boolean).join("\n");
  // priorité au fournisseur explicite (REPLY_PROVIDER), sinon OpenAI si présent, sinon Anthropic
  const pref = String(process.env.REPLY_PROVIDER || "").toLowerCase();
  if (pref === "openai" && hasOpenAI) return callOpenAI(sys, ctx);
  if (pref === "anthropic" && hasAnthropic) return callAnthropic(sys, ctx);
  if (hasOpenAI) return callOpenAI(sys, ctx);
  return callAnthropic(sys, ctx);
}
app.post("/api/reply/suggest", auth, async (req, res) => {
  const { threadId, creator, brand, category, snippet, subject } = req.body || {};
  let received = String(snippet || "").trim();
  let transcript = "";
  try {
    const t = inboxTarget(req);
    if (gm.ENABLED && threadId && gm.isConnected(t.email)) {
      const full = await gm.fetchThreadText(t.email, threadId);
      if (full && full.ok && full.text) received = full.text;
      if (full && full.ok && full.transcript) transcript = full.transcript;
    }
  } catch (e) {}
  const out = await claudeReply({ cp: req.user.name, creator, brand, category, received, subject, transcript });
  res.json(out);
});
// Marque un brief comme envoyé/préparé pour une collab → allume l'étape pipeline + activité
app.post("/api/brief", auth, (req, res) => {
  const creator = String(req.body?.creator || "").trim();
  const brand = req.body?.brand || null;
  if (!creator) return res.status(400).json({ error: "créateur manquant" });
  recordBrief({ creator, brand, cp: req.user.name, at: Date.now() });
  logActivity({ type: "brief", creator, brand, cp: req.user.name });
  res.json({ ok: true });
});
// Assignation rapide d'une collab à une CP → écrit l'Interlocuteur dans Notion (+ historique)
app.post("/api/collab/:id/assign", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  const to = String(req.body?.to || "").trim();
  const name = String(req.body?.name || "").trim();
  const brand = String(req.body?.brand || "").trim();
  try {
    if (!to) {
      await notion.pages.update({ page_id: req.params.id, properties: { "Interlocuteur": { people: [] } } });
    } else {
      const uid = await userIdByName(to);
      if (!uid) return res.status(400).json({ error: "CP introuvable dans Notion : " + to });
      await notion.pages.update({ page_id: req.params.id, properties: { "Interlocuteur": { people: [{ id: uid }] } } });
    }
    CACHE = { at: 0, rows: [] }; // force le rafraîchissement des collabs
    recordHistory(req.params.id, { name, brand }, { by: req.user.name, action: "assignation", detail: to ? ("assigné à " + to) : "assignation retirée" });
    res.json({ ok: true, to });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Fait avancer une collab à l'étape suivante du pipeline (met à jour le Statut Notion)
const STAGE_ORDER = ["Non posté", "En production", "En validation", "Posté"];
const STAGE_LABEL = { "Non posté": "Le contenu est planifié", "En production": "En cours de production", "En validation": "Contenu validé", "Posté": "Publié / terminé" };
app.post("/api/collab/:id/advance", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  try {
    const pg = await notion.pages.retrieve({ page_id: req.params.id });
    const cur = pg.properties?.["Statut"]?.select?.name || "";
    const i = STAGE_ORDER.indexOf(cur);
    if (i < 0) return res.status(400).json({ error: "statut inconnu : " + cur });
    if (i >= STAGE_ORDER.length - 1) return res.json({ ok: false, done: true, message: "déjà à la dernière étape" });
    const next = STAGE_ORDER[i + 1];
    const nm = title(pg.properties?.["Nom"]) || String(req.body?.name || "") || null;
    await notion.pages.update({ page_id: req.params.id, properties: { "Statut": { select: { name: next } } } });
    CACHE = { at: 0, rows: [] }; // force le rafraîchissement des collabs
    logActivity({ type: "etape", creator: nm, cp: req.user.name, extra: STAGE_LABEL[next] });
    recordHistory(req.params.id, { name: nm, brand: String(req.body?.brand || ""), url: pg.url }, { by: req.user.name, action: "etape", detail: STAGE_LABEL[next] });
    res.json({ ok: true, from: cur, to: next, toLabel: STAGE_LABEL[next], last: (i + 1) >= STAGE_ORDER.length - 1 });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// --- Visios du jour (Google Agenda de la personne) ----------------------
app.get("/api/calendar", auth, async (req, res) => {
  if (!gm.ENABLED || typeof gm.calendarToday !== "function") return res.json({ enabled: false });
  try { const t = inboxTarget(req); const r = await gm.calendarToday(t.email); res.json({ enabled: true, viewing: t.viewing, ...r }); }
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
    const teamReq = String(req.query.team || "") === "1" && !isSup; // CP en vue équipe (congés)
    let tasks = all.filter((t) => t.statut !== "Fait");
    if (isSup) {
      if (view && view !== "ALL") tasks = tasks.filter((t) => normName(t.responsable) === normName(view));
    } else if (!teamReq) {
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
  "In Haircare": { produits: "la routine complète In Haircare (Milk'In, Curl n'Go et le nouveau Final Touch)", fr: "In Haircare est une marque française spécialisée dans les soins capillaires pensés pour les cheveux texturés (bouclés, frisés, crépus) avec des formules clean, naturelles et efficaces, fabriquées en France et primées (Beauty Shortlist Awards 2025)." },
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
// --- Instantané quotidien des indicateurs (pour les deltas « vs hier ») ---
const STATS_STORE = path.join(DATA_DIR, "stats.json");
function loadStatsStore() { try { return JSON.parse(fs.readFileSync(STATS_STORE, "utf8")); } catch (e) { return {}; } }
function saveStatsStore(s) { try { fs.writeFileSync(STATS_STORE, JSON.stringify(s)); } catch (e) {} }
function snapshotAndDelta(key, stats) {
  const store = loadStatsStore();
  const byDay = store[key] = store[key] || {};
  const today = new Date().toISOString().slice(0, 10);
  const prevDays = Object.keys(byDay).filter((d) => d < today).sort();
  const base = prevDays.length ? byDay[prevDays[prevDays.length - 1]] : null;
  byDay[today] = stats;
  const keep = Object.keys(byDay).sort().slice(-10); // ~10 derniers jours
  store[key] = Object.fromEntries(keep.map((d) => [d, byDay[d]]));
  saveStatsStore(store);
  if (!base) return null;
  const deltas = {}; for (const k in stats) deltas[k] = stats[k] - (base[k] || 0);
  return deltas;
}
// --- Journal d'activité (footer « Dernières activités ») ----------------
const ACTIVITY_STORE = path.join(DATA_DIR, "activity.json");
function loadActivity() { try { return JSON.parse(fs.readFileSync(ACTIVITY_STORE, "utf8")); } catch (e) { return []; } }
function saveActivity(a) { try { fs.writeFileSync(ACTIVITY_STORE, JSON.stringify(a)); } catch (e) {} }
function logActivity(ev) {
  try { const a = loadActivity(); a.push({ at: Date.now(), ...ev }); saveActivity(a.slice(-200)); } catch (e) {}
}
const CONTACTED_STORE = path.join(DATA_DIR, "contacted.json");
function loadContacted() { try { return JSON.parse(fs.readFileSync(CONTACTED_STORE, "utf8")); } catch (e) { return []; } }
function saveContacted(a) { try { fs.writeFileSync(CONTACTED_STORE, JSON.stringify(a)); } catch (e) {} }
function recordContacted(rec) { const a = loadContacted(); a.push(rec); saveContacted(a); }
// --- Briefs envoyés (allume l'étape « Brief envoyé » du pipeline) --------
const BRIEF_STORE = path.join(DATA_DIR, "briefs.json");
function loadBriefs() { try { return JSON.parse(fs.readFileSync(BRIEF_STORE, "utf8")); } catch (e) { return []; } }
function saveBriefs(a) { try { fs.writeFileSync(BRIEF_STORE, JSON.stringify(a)); } catch (e) {} }
function recordBrief(rec) { const a = loadBriefs(); a.push(rec); saveBriefs(a.slice(-500)); }
// --- Historique / traçabilité par collab (étapes + assignations) ---------
const HISTORY_STORE = path.join(DATA_DIR, "history.json");
function loadHistory() { try { return JSON.parse(fs.readFileSync(HISTORY_STORE, "utf8")); } catch (e) { return {}; } }
function saveHistory(h) { try { fs.writeFileSync(HISTORY_STORE, JSON.stringify(h)); } catch (e) {} }
function recordHistory(pageId, meta, event) {
  if (!pageId) return;
  try {
    const h = loadHistory();
    const rec = h[pageId] || { events: [] };
    if (meta) { if (meta.name) rec.name = meta.name; if (meta.brand) rec.brand = meta.brand; if (meta.url) rec.url = meta.url; }
    rec.events = (rec.events || []).concat([{ at: Date.now(), ...event }]).slice(-100);
    h[pageId] = rec; saveHistory(h);
  } catch (e) {}
}
app.get("/api/history", auth, (req, res) => {
  const h = loadHistory();
  const out = Object.entries(h).map(([pageId, rec]) => ({
    pageId, name: rec.name || "", brand: rec.brand || "", url: rec.url || "",
    events: (rec.events || []).slice().sort((a, b) => b.at - a.at),
  }));
  out.sort((a, b) => (b.events[0] ? b.events[0].at : 0) - (a.events[0] ? a.events[0].at : 0));
  res.json({ history: out });
});
// --- Fiches marques (mémoire partagée de l'agence) -----------------------
// Fiche d'identité par marque, pensée pour l'onboarding : une nouvelle CP doit
// comprendre la marque en 2 minutes sans poser de questions.
// Base (histoire, période, objectifs, réunions, KPIs, pôle, où trouver les contacts) :
//   modifiable par la responsable (supervisor) uniquement.
// Interlocuteur principal + notes de contexte : modifiables par toutes les CP (signé, horodaté).
const BRANDS_STORE = path.join(DATA_DIR, "brands.json");
const BRAND_BASE_FIELDS = ["histoire", "clientDepuis", "clientJusqua", "objectifs", "reunions", "kpis", "pole", "interlocuteurHA", "contactsOu", "instagram", "tiktok", "siteweb"];
const BRAND_FILES_DIR = path.join(DATA_DIR, "brandfiles");
try { fs.mkdirSync(BRAND_FILES_DIR, { recursive: true }); } catch (e) {}
function loadBrandFiches() { try { return JSON.parse(fs.readFileSync(BRANDS_STORE, "utf8")); } catch (e) { return {}; } }
function saveBrandFiches(o) { try { fs.writeFileSync(BRANDS_STORE, JSON.stringify(o)); } catch (e) {} }
app.get("/api/brands", auth, (req, res) => {
  res.json({ brands: loadBrandFiches(), canEditBase: req.user.role === "supervisor" });
});
app.post("/api/brand/:name", auth, (req, res) => {
  const name = String(req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "marque manquante" });
  const isSup = req.user.role === "supervisor";
  const body = req.body || {};
  const all = loadBrandFiches();
  const rec = all[name] || {};
  const changes = [];
  if (body.base) { // socle de la fiche : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut modifier la base de la fiche" });
    for (const k of BRAND_BASE_FIELDS) {
      if (body.base[k] !== undefined) { rec[k] = String(body.base[k]).slice(0, 4000); changes.push(k); }
    }
  }
  if (body.interlocuteur !== undefined) { // contact principal côté marque : toutes les CP
    const it = body.interlocuteur || {};
    rec.interlocuteur = { nom: String(it.nom || "").slice(0, 120), email: String(it.email || "").slice(0, 200), role: String(it.role || "").slice(0, 120) };
    changes.push("interlocuteur");
  }
  if (body.note) { // note de contexte : toutes les CP, horodatée et signée
    rec.notes = (rec.notes || []).concat([{ at: Date.now(), by: req.user.name, text: String(body.note).slice(0, 2000) }]).slice(-100);
    changes.push("note");
  }
  if (body.deleteNoteAt) { // suppression d'une note : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut supprimer une note" });
    rec.notes = (rec.notes || []).filter((n) => n.at !== Number(body.deleteNoteAt));
    changes.push("suppression note");
  }
  if (body.link) { // lien utile (veille, brief en ligne…) : toutes les CP
    const l = body.link;
    const url = String(l.url || "").trim();
    if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "URL invalide (elle doit commencer par http)" });
    rec.links = (rec.links || []).concat([{ at: Date.now(), by: req.user.name, label: String(l.label || "").slice(0, 200) || url, url: url.slice(0, 1000) }]).slice(-50);
    changes.push("lien");
  }
  if (body.deleteLinkAt) { // suppression d'un lien : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut supprimer un lien" });
    rec.links = (rec.links || []).filter((l) => l.at !== Number(body.deleteLinkAt));
    changes.push("suppression lien");
  }
  if (body.doc) { // document « good to know » (PJ) : toutes les CP
    const d = body.doc;
    const data = String(d.data || "").replace(/^data:[^;]*;base64,/, "");
    const buf = Buffer.from(data, "base64");
    if (!buf.length) return res.status(400).json({ error: "fichier vide" });
    if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: "fichier trop lourd (10 Mo max)" });
    const safe = String(d.filename || "document").replace(/[^\w.\-()À-ſ ]+/g, "_").slice(0, 120);
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 8);
    const dir = path.join(BRAND_FILES_DIR, name.replace(/[^\w\-À-ſ ]+/g, "_"));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
    fs.writeFileSync(path.join(dir, id + "_" + safe), buf);
    rec.docs = (rec.docs || []).concat([{ at: Date.now(), by: req.user.name, label: String(d.label || "").slice(0, 200) || safe, filename: safe, id, size: buf.length }]).slice(-50);
    changes.push("document");
  }
  if (body.deleteDocId) { // suppression d'un document : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut supprimer un document" });
    const doc = (rec.docs || []).find((x) => x.id === String(body.deleteDocId));
    if (doc) {
      const dir = path.join(BRAND_FILES_DIR, name.replace(/[^\w\-À-ſ ]+/g, "_"));
      try { fs.unlinkSync(path.join(dir, doc.id + "_" + doc.filename)); } catch (e) {}
      rec.docs = rec.docs.filter((x) => x.id !== doc.id);
      changes.push("suppression document");
    }
  }
  if (!changes.length) return res.status(400).json({ error: "rien à modifier" });
  rec.updatedAt = Date.now(); rec.updatedBy = req.user.name;
  all[name] = rec; saveBrandFiches(all);
  logActivity({ type: "fiche", creator: name, cp: req.user.name });
  res.json({ ok: true, brand: rec, changes });
});
app.get("/api/brand/:name/doc/:id", auth, (req, res) => {
  const name = String(req.params.name || "").trim();
  const rec = loadBrandFiches()[name];
  const doc = rec && (rec.docs || []).find((x) => x.id === String(req.params.id));
  if (!doc) return res.status(404).json({ error: "document introuvable" });
  const fp = path.join(BRAND_FILES_DIR, name.replace(/[^\w\-À-ſ ]+/g, "_"), doc.id + "_" + doc.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "fichier disparu du disque" });
  res.download(fp, doc.filename);
});
// ===================== Copilote mails (humain dans la boucle) =====================
// L'IA surveille les boîtes des CP activées, classe chaque réponse créateur
// (routine vs décision), prépare une réponse dans la voix Hyped, et ping la
// bonne personne sur Slack (via un webhook Make). RIEN ne part sans un clic :
// les boutons Slack sont des liens signés (HMAC) vers /copilot/act.
// Config (Render) : COPILOT_ENABLED=1, COPILOT_MAKE_WEBHOOK, COPILOT_SECRET,
//   COPILOT_CPS="amena@hyped-agency.fr,kendia@hyped-agency.fr",
//   COPILOT_SLACK_IDS='{"amena@hyped-agency.fr":"U09CHH6N6LX", ...}'  (boîte -> destinataire Slack)
const COPILOT_STORE = path.join(DATA_DIR, "copilot.json");
const COPILOT = {
  enabled: process.env.COPILOT_ENABLED === "1" && !!process.env.COPILOT_MAKE_WEBHOOK && !!process.env.COPILOT_SECRET,
  webhook: process.env.COPILOT_MAKE_WEBHOOK || "",
  secret: process.env.COPILOT_SECRET || "",
  cps: String(process.env.COPILOT_CPS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  slackIds: (() => { try { return JSON.parse(process.env.COPILOT_SLACK_IDS || "{}"); } catch (e) { return {}; } })(),
  publicUrl: (process.env.PUBLIC_URL || "https://hyped-cockpit.onrender.com").replace(/\/$/, ""),
  includeTeam: process.env.COPILOT_INCLUDE_TEAM === "1", // notifier aussi les mails internes @hyped-agency.fr
};
function loadCopilot() { try { return JSON.parse(fs.readFileSync(COPILOT_STORE, "utf8")); } catch (e) { return { proposals: [] }; } }
function saveCopilot(o) { try { fs.writeFileSync(COPILOT_STORE, JSON.stringify(o)); } catch (e) {} }
function copilotSign(id, action) { return crypto.createHmac("sha256", COPILOT.secret).update(id + "|" + action).digest("hex").slice(0, 32); }
function copilotLink(id, action) { return COPILOT.publicUrl + "/copilot/act?id=" + encodeURIComponent(id) + "&action=" + action + "&sig=" + copilotSign(id, action); }
function copilotCpName(email) { const u = USERS.find((x) => String(x.email).toLowerCase() === email); return u ? u.name : email.split("@")[0]; }
function mailAddr(from) { const m = String(from || "").match(/<([^>]+)>/); return m ? m[1].trim() : (String(from || "").includes("@") ? String(from).trim() : ""); }
async function copilotNotify(payload) {
  // Trajet direct cockpit -> Slack (0 crédit Make) si SLACK_BOT_TOKEN est configuré ; sinon via le webhook Make.
  const botToken = process.env.SLACK_BOT_TOKEN || "";
  if (botToken) {
    try {
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "authorization": "Bearer " + botToken },
        body: JSON.stringify({ channel: payload.slackUser, text: payload.text }),
      });
      const d = await r.json().catch(() => ({}));
      try { console.log("[copilot] notif Slack directe →", payload.slackUser, ":", d.ok ? "ok" : ("échec " + (d.error || r.status))); } catch (e2) {}
      if (d.ok) return;
      // en cas d'échec du direct, on retombe sur Make ci-dessous
    } catch (e) { try { console.error("[copilot] Slack direct échoué :", e.message); } catch (e2) {} }
  }
  if (!COPILOT.webhook) return;
  try {
    const r = await fetch(COPILOT.webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    try { console.log("[copilot] notif Slack via Make →", payload.slackUser, ": HTTP", r.status); } catch (e2) {}
  }
  catch (e) { try { console.error("[copilot] notif Make échouée :", e.message); } catch (e2) {} }
}
// Classe le mail : décision (accord CP requis) ou routine. En cas de doute ou d'IA muette : décision.
async function copilotClassify({ creator, subject, received, transcript }) {
  const fallback = { categorie: "decision", resume: "Nouveau message de " + (creator || "un créateur"), question: "Nouveau message de " + (creator || "un créateur") + ", tu veux voir ?" };
  const sys = [
    "Tu tries les réponses des créateurs pour une agence d'influence. Réponds UNIQUEMENT un JSON valide :",
    '{"categorie":"routine"|"decision","resume":"...","question":"..."}',
    "\"decision\" = le créateur demande quelque chose qui nécessite l'accord de la cheffe de projet : décaler une date de publication, budget / tarif / rémunération, refus ou désaccord, retard de paiement, litige, demande inhabituelle.",
    "\"routine\" = le reste : envoi d'adresse postale, remerciement, confirmation simple, question logistique basique.",
    "resume = une phrase factuelle qui dit ce que le créateur demande ou annonce.",
    "question = si decision, la question fermée à poser à la CP (ex. 'Vanina veut décaler son post du 9 au 15 juillet, on accepte ?'), sinon chaîne vide.",
  ].join("\n");
  const ctx = "Créateur : " + (creator || "?") + "\nSujet : " + (subject || "") + "\n\n" + (transcript ? ("Fil :\n" + String(transcript).slice(0, 5000)) : ("Message :\n" + String(received || "").slice(0, 3000)));
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return fallback;
  const out = hasOpenAI ? await callOpenAI(sys, ctx) : await callAnthropic(sys, ctx);
  if (!out.ok) return fallback;
  try {
    const j = JSON.parse(String(out.body).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    if (j && (j.categorie === "routine" || j.categorie === "decision")) return { categorie: j.categorie, resume: String(j.resume || "").slice(0, 300) || fallback.resume, question: String(j.question || "").slice(0, 300) };
  } catch (e) {}
  return fallback;
}
// Réponse proposée pour un mail INTERNE (ton collègue, pas la voix créateurs)
async function copilotInternalReply({ cp, fromName, subject, received, transcript }) {
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return { ok: false, reason: "nokey" };
  const sys = [
    "Tu es " + (cp || "une cheffe de projet") + ", de l'agence Hyped Agency. Tu réponds par mail à " + (fromName || "un collègue de l'agence") + " (mail INTERNE, entre collègues).",
    "Ton : chaleureux, direct, professionnel, tutoiement, français. Court (2 à 6 phrases). Un emoji léger max.",
    "Réponds VRAIMENT au contenu du message : réponds aux questions posées, confirme ce qui doit l'être, dis clairement si quelque chose sera fait.",
    "Ne signe que par le prénom : " + (cp || "") + ". Jamais de tiret quadratin.",
  ].join("\n");
  const ctx = "Sujet : " + (subject || "") + "\n\n" + (transcript ? ("Fil :\n" + String(transcript).slice(0, 5000) + "\n\n") : "") + "Dernier message reçu :\n\"\"\"\n" + String(received || "").slice(0, 3000) + "\n\"\"\"\n\nRédige la réponse.";
  return hasOpenAI ? callOpenAI(sys, ctx) : callAnthropic(sys, ctx);
}
function copilotSlackText(p) {
  const who = p.creator || "un créateur";
  const brand = p.brand ? (" · " + p.brand) : "";
  if (p.categorie === "interne") {
    return "📨 Interne · *" + (p.creator || p.to || "quelqu'un de l'équipe") + "* → boîte " + p.cpName + " : " + (p.subject || "(sans objet)")
      + (p.resume ? ("\n_" + p.resume + "_") : "")
      + (p.reply ? ("\n\n_Réponse proposée :_\n>>> " + String(p.reply).slice(0, 900)) : "")
      + "\n\n" + (p.reply ? ("<" + copilotLink(p.id, "send") + "|📤 Envoyer>  ·  ") : "") + "<" + copilotLink(p.id, "self") + "|✍️ Je gère dans le cockpit>";
  }
  if (p.status === "ready") {
    return "*Étape 2/2 · Relis et envoie* ✍️ (réponse à *" + who + "*" + brand + ", rédigée selon ta décision : " + (p.decision === "accept" ? "oui ✅" : "non ❌") + ")\n\n>>> " + String(p.reply || "").slice(0, 900)
      + "\n\n<" + copilotLink(p.id, "send") + "|📤 Envoyer>  ·  <" + copilotLink(p.id, "self") + "|✍️ Je gère dans le cockpit>";
  }
  if (p.categorie === "decision") {
    return "*Étape 1/2 · Décision* 🔔 *" + (p.question || p.resume) + "*\n_(" + who + brand + " · boîte " + p.cpName + ")_\n\n"
      + "<" + copilotLink(p.id, "accept") + "|✅ Oui>  ·  <" + copilotLink(p.id, "refuse") + "|❌ Non>  ·  <" + copilotLink(p.id, "self") + "|✍️ Je gère moi-même>"
      + "\n_Clique un choix : je rédige la réponse dans ce sens et je te l'envoie à relire._";
  }
  return "✉️ *" + who + "*" + brand + " : " + (p.resume || p.subject || "nouveau message") + "\n\n_Réponse prête (voix Hyped) :_\n>>> " + String(p.reply || "(IA indisponible, ouvre le cockpit)").slice(0, 900)
    + "\n\n<" + copilotLink(p.id, "send") + "|📤 Envoyer>  ·  <" + copilotLink(p.id, "self") + "|✍️ Je gère dans le cockpit>";
}
let COPILOT_RUNNING = false;
async function copilotTick() {
  if (!COPILOT.enabled || !gm.ENABLED || COPILOT_RUNNING) return;
  COPILOT_RUNNING = true;
  try {
    const store = loadCopilot();
    store.proposals = store.proposals || [];
    const seen = new Set(store.proposals.map((p) => p.cpEmail + "|" + p.msgId));
    let collabs = []; try { collabs = await fetchRows(); } catch (e) {}
    for (const email of COPILOT.cps) {
      if (!gm.isConnected(email)) { try { console.log("[copilot]", email, ": Gmail NON connecté, boîte sautée"); } catch (e) {} continue; }
      let r; try { r = await gm.analyzeFor(email, collabs); } catch (e) { try { console.error("[copilot]", email, ": analyse échouée :", e.message); } catch (e2) {} continue; }
      try { console.log("[copilot]", email, ":", ((r && r.creatorReplies) || []).length, "réponse(s) créateur,", ((r && r.teamMails) || []).length, "interne(s), total", (r && r.total) || 0, "mails"); } catch (e) {}
      const tt = treatedFor(email);
      // Balayage des propositions en attente : si le mail a été géré AILLEURS (réponse directe
      // depuis Gmail, ou traité dans le cockpit), on classe et on prévient sur Slack. Pas traité
      // dans le cockpit ne veut pas dire pas fait.
      const waiting = store.proposals.filter((x) => x.cpEmail === email && (x.status === "pending" || x.status === "ready") && (Date.now() - x.at) < 7 * 24 * 3600 * 1000);
      for (const w of waiting.slice(0, 20)) {
        try {
          if (tt[w.threadId]) { w.status = "handled"; w.decidedAt = Date.now(); continue; } // traité dans le cockpit : on classe sans bruit
          const own = await gm.lastReplyFromMe(email, w.threadId);
          if (own && own > w.at) {
            w.status = "handled"; w.decidedAt = Date.now();
            try { markTreated(email, w.threadId, { by: w.cpName + " (Gmail direct)", action: "répondu" }); } catch (e) {}
            const su = COPILOT.slackIds[email] || "";
            if (su) await copilotNotify({ slackUser: su, text: "✅ C'est fait ! Tu as répondu à *" + (w.creator || w.to || "ce contact") + "* directement depuis Gmail : je classe, mail marqué traité dans le cockpit. Rien d'autre à faire." });
            try { console.log("[copilot]", email, ": réponse directe Gmail détectée, proposition classée (", w.creator || w.to, ")"); } catch (e) {}
          }
        } catch (e) {}
      }
      for (const m of (r && r.creatorReplies) || []) {
        if (!m.threadId || tt[m.threadId]) continue;               // déjà traité
        if (seen.has(email + "|" + (m.id || m.threadId))) continue; // déjà proposé
        let transcript = "";
        try { const full = await gm.fetchThreadText(email, m.threadId); if (full && full.ok) transcript = full.transcript || full.text || ""; } catch (e) {}
        const creator = m["créateur"] || "";
        const cls = await copilotClassify({ creator, subject: m.subject, received: m.snippet, transcript });
        const rep = await claudeReply({ cp: copilotCpName(email), creator, brand: m.brand, category: m.category, received: m.snippet, subject: m.subject, transcript });
        const p = {
          id: crypto.randomBytes(8).toString("hex"),
          cpEmail: email, cpName: copilotCpName(email),
          msgId: m.id || m.threadId, threadId: m.threadId,
          to: mailAddr(m.from), creator, brand: m.brand || "", subject: m.subject || "",
          categorie: cls.categorie, resume: cls.resume, question: cls.question,
          reply: rep && rep.ok ? rep.body : "",
          status: "pending", at: Date.now(),
        };
        store.proposals.push(p);
        seen.add(email + "|" + p.msgId);
        const slackUser = COPILOT.slackIds[email] || "";
        if (slackUser) await copilotNotify({ slackUser, text: "<@" + slackUser + "> " + copilotSlackText(p) }); // mention = vraie notification
      }
      // Mails internes (si COPILOT_INCLUDE_TEAM=1) : on voit tout, on peut répondre en un clic
      if (COPILOT.includeTeam) {
        for (const m of (r && r.teamMails) || []) {
          if (!m.threadId || tt[m.threadId]) continue;
          if (seen.has(email + "|" + (m.id || m.threadId))) continue;
          const fromAddr = mailAddr(m.from);
          if (fromAddr.toLowerCase() === email) continue; // ses propres mails, non merci
          let transcript = "";
          try { const full = await gm.fetchThreadText(email, m.threadId); if (full && full.ok) transcript = full.transcript || full.text || ""; } catch (e) {}
          const fromName = String(m.from || "").replace(/<[^>]*>/, "").trim() || fromAddr;
          const rep = await copilotInternalReply({ cp: copilotCpName(email), fromName, subject: m.subject, received: m.snippet, transcript });
          const p = {
            id: crypto.randomBytes(8).toString("hex"),
            cpEmail: email, cpName: copilotCpName(email),
            msgId: m.id || m.threadId, threadId: m.threadId,
            to: fromAddr, creator: fromName, brand: m.brand || "", subject: m.subject || "",
            categorie: "interne", resume: String(m.snippet || "").slice(0, 200), question: "",
            reply: rep && rep.ok ? rep.body : "",
            status: "pending", at: Date.now(),
          };
          store.proposals.push(p);
          seen.add(email + "|" + p.msgId);
          const slackUser = COPILOT.slackIds[email] || "";
          if (slackUser) await copilotNotify({ slackUser, text: "<@" + slackUser + "> " + copilotSlackText(p) });
        }
      }
    }
    // 1000 (et pas 300) : sinon, à l'échelle de toutes les CP, la mémoire des mails déjà proposés
    // déborde en quelques jours et les mêmes mails reviennent (double appel IA + double notif Slack)
    store.proposals = store.proposals.slice(-1000);
    saveCopilot(store);
  } catch (e) { try { console.error("[copilot] tick :", e.message); } catch (e2) {} }
  finally { COPILOT_RUNNING = false; }
}
if (COPILOT.enabled) {
  setInterval(copilotTick, 5 * 60 * 1000);
  setTimeout(copilotTick, 20 * 1000);
  try { console.log("[copilot] actif pour :", COPILOT.cps.join(", ") || "(aucune boîte)"); } catch (e) {}
}
// Page de confirmation minimaliste (Montserrat, charte cockpit)
function copilotPage(title, msg) {
  // Échappement systématique : title/msg contiennent des données externes (nom d'expéditeur,
  // message d'erreur), qui ne doivent jamais devenir du HTML exécutable (anti-XSS).
  const escp = (s) => String(s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  title = escp(title); msg = escp(msg);
  return "<!doctype html><html lang=\"fr\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + title + " · Cockpit</title><style>body{font-family:Montserrat,system-ui,sans-serif;background:#F5F3EE;color:#1C3A44;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}div{background:#fff;border:1px solid #E4E0D5;border-radius:16px;padding:34px 38px;max-width:460px;text-align:center;box-shadow:0 8px 30px rgba(28,58,68,.06)}h1{font-size:20px;margin:0 0 10px}p{font-size:14px;color:#56666D;margin:0}</style></head><body><div><h1>" + title + "</h1><p>" + msg + "</p></div></body></html>";
}
// Déclenche un passage du copilote à la demande (debug), protégé par le secret
app.get("/copilot/tick", async (req, res) => {
  if (!COPILOT.enabled) return res.status(400).json({ error: "copilote désactivé" });
  if (String(req.query.s || "") !== COPILOT.secret) return res.status(403).json({ error: "secret invalide" });
  await copilotTick();
  const s = loadCopilot();
  res.json({ ok: true, dernieres: (s.proposals || []).slice(-10).map((p) => ({ cp: p.cpEmail, de: p.creator, categorie: p.categorie, statut: p.status, quand: new Date(p.at).toLocaleString("fr-FR") })) });
});
app.get("/copilot/act", async (req, res) => {
  const { id, action, sig } = req.query || {};
  // Comparaison timing-safe : même durée que la signature soit bonne ou pas (anti-attaque par chronométrage)
  let ok = false;
  try {
    const expected = Buffer.from(copilotSign(String(id || ""), String(action || "")));
    const given = Buffer.from(String(sig || ""));
    ok = !!(id && action && sig && COPILOT.secret) && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  } catch (e) { ok = false; }
  if (!ok) return res.status(403).send(copilotPage("Lien invalide 🤔", "Ce lien n'est pas valide ou a été modifié. Repasse par le message Slack."));
  const store = loadCopilot(); store.proposals = store.proposals || [];
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return res.status(404).send(copilotPage("Introuvable", "Cette proposition n'existe plus (elle a peut-être expiré)."));
  if (p.status === "sent") return res.send(copilotPage("C'est fait ! ✅", "La réponse à " + (p.creator || "ce créateur") + " est bien partie. Rien n'a été envoyé en double, tout est ok. Tu peux fermer cette page."));
  if (p.status === "handled") return res.send(copilotPage("Déjà traité ✅", "Ce mail a déjà été géré (réponse envoyée directement depuis Gmail, ou traité dans le cockpit). Rien n'a été envoyé en double, rien à faire."));
  if (p.status === "self" && action !== "send") return res.send(copilotPage("C'est toi qui gères ✍️", "Ce mail t'attend dans le cockpit, onglet Messages."));
  try {
    if (action === "send") {
      if (!p.reply) return res.send(copilotPage("Pas de réponse prête", "L'IA n'a pas pu rédiger. Ouvre le cockpit pour répondre."));
      if (!p.to) return res.send(copilotPage("Destinataire introuvable", "Impossible d'extraire l'email du créateur. Ouvre le cockpit pour répondre."));
      const r = await gm.sendEmail(p.cpEmail, { to: p.to, subject: p.subject ? (/^re\s*:/i.test(p.subject) ? p.subject : "Re: " + p.subject) : "Re:", body: p.reply });
      if (!r || !r.ok) return res.status(500).send(copilotPage("Échec de l'envoi 😖", "Gmail n'a pas voulu. Réessaie ou passe par le cockpit."));
      markTreated(p.cpEmail, p.threadId, { by: p.cpName + " (copilote)", action: "répondu" });
      logActivity({ type: "email", creator: p.to, cp: p.cpName });
      p.status = "sent"; p.decidedAt = Date.now(); saveCopilot(store);
      // Confirmation aussi sur Slack : le fil se termine par un vrai "c'est fait", pas par "Étape 2/2"
      try {
        const slackUser = COPILOT.slackIds[p.cpEmail] || "";
        if (slackUser) await copilotNotify({ slackUser, text: "✅ C'est fait ! La réponse à *" + (p.creator || p.to) + "* (" + (p.brand || "sans marque") + ") est partie depuis la boîte de " + p.cpName + ", signature comprise. Mail marqué traité dans le cockpit, rien d'autre à faire." });
      } catch (e) {}
      return res.send(copilotPage("C'est fait ! 🎉", "La réponse est partie chez " + (p.creator || p.to) + ", depuis la boîte de " + p.cpName + ", signature comprise. Le mail est marqué traité dans le cockpit. Tu peux fermer cette page."));
    }
    if (action === "accept" || action === "refuse") {
      const directive = action === "accept"
        ? "La CP ACCEPTE la demande du créateur (" + (p.resume || p.question) + "). Confirme-lui gentiment que c'est ok."
        : "La CP REFUSE la demande du créateur (" + (p.resume || p.question) + "). Dis-le avec tact, sans fermer la relation, propose une alternative si pertinent.";
      let transcript = "";
      try { const full = await gm.fetchThreadText(p.cpEmail, p.threadId); if (full && full.ok) transcript = full.transcript || full.text || ""; } catch (e) {}
      const rep = await claudeReply({ cp: p.cpName, creator: p.creator, brand: p.brand, category: "réponse", received: p.resume, subject: p.subject, transcript, directive });
      if (!rep || !rep.ok) return res.status(500).send(copilotPage("IA indisponible 💤", "Impossible de rédiger là tout de suite. Réponds depuis le cockpit."));
      p.reply = rep.body; p.status = "ready"; p.decision = action; p.decidedAt = Date.now(); saveCopilot(store);
      const slackUser = COPILOT.slackIds[p.cpEmail] || "";
      if (slackUser) await copilotNotify({ slackUser, text: "<@" + slackUser + "> " + copilotSlackText(p) }); // mention = vraie notification
      return res.send(copilotPage("C'est noté " + (action === "accept" ? "✅" : "❌"), "L'IA a rédigé la réponse dans ce sens. Regarde Slack pour la relire et l'envoyer en un clic."));
    }
    if (action === "self") {
      p.status = "self"; p.decidedAt = Date.now(); saveCopilot(store);
      try {
        const slackUser = COPILOT.slackIds[p.cpEmail] || "";
        if (slackUser) await copilotNotify({ slackUser, text: "✍️ Noté, tu gères toi-même le mail de *" + (p.creator || p.to || "ce contact") + "*. Rien n'a été envoyé, il t'attend dans le cockpit (onglet Messages)." });
      } catch (e) {}
      return res.send(copilotPage("C'est toi qui gères ✍️", "Rien n'a été envoyé. Le mail t'attend dans le cockpit, onglet Messages."));
    }
  } catch (e) {
    return res.status(500).send(copilotPage("Oups", "Une erreur est survenue : " + String(e && e.message || e).slice(0, 120)));
  }
  return res.status(400).send(copilotPage("Action inconnue", "Ce lien ne correspond à aucune action."));
});
// Mail de demande de stats/bilan (J+5 après publication)
function genStatsFR(brand, name, cp) {
  return `Hello ${name} ✨\n\nMerci encore pour ta superbe collab avec ${brand} ! 🤍\n\nPour clôturer la campagne côté marque, est-ce que tu pourrais m'envoyer les statistiques de tes contenus : vues, portée/impressions, likes, partages, enregistrements, et les captures des stories ?\n\nUn petit screenshot de chaque contenu suffit largement. Ça nous permet de faire le bilan avec ${brand}.\n\nMerci d'avance et à très vite,\n${cp}`;
}

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
          const subject = "Partenariat " + (req.body?.marque || "") + " - Hyped Agency";
          const r = await gm.createDraft(cpEmail, { to: "", subject, body: genOutreachFR(req.body?.marque || "", inf, resp) });
          draft = !!(r && r.ok);
        }
      }
    } catch (e) { console.warn("auto-draft", e.message); }
    logActivity({ type: "profil_ajoute", creator: String(profil).replace(/^contacter\s+/i, "").trim(), brand: req.body?.marque || null, cp: resp || null });
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
    logActivity({ type: "contacte", creator: String(t.task).replace(/^contacter\s+/i, "").trim(), brand: t.projet || null, cp: t.responsable || req.user.name });
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

// --- Demande de stats/bilan : J+5 après publication (repris de l'ancien système) -------
async function ensureStatsTasks() {
  if (DEMO || !notion) return;
  try {
    if (!Object.keys(USERMAP).length) { try { await resolveUsers(); } catch (e) {} }
    const iso = (d) => d.toISOString().slice(0, 10);
    const now = new Date();
    const end = iso(new Date(now.getTime() - 5 * 864e5));   // publié il y a au moins 5 jours
    const start = iso(new Date(now.getTime() - 30 * 864e5)); // …et pas plus de 30 jours (fenêtre)
    const posted = []; let cursor;
    do {
      const r = await notion.databases.query({
        database_id: INHAIRCARE_DB, start_cursor: cursor, page_size: 100,
        filter: { and: [
          { property: "Date", date: { on_or_after: start, on_or_before: end } },
          { property: "Statut", select: { equals: "Posté" } },
        ] },
      });
      r.results.forEach((pg) => {
        const p = pg.properties || {};
        const nom = title(p["Nom"]) || "(sans nom)";
        const cp = firstPerson(p["Interlocuteur"]) || ASSIGN[normName(nom)] || null;
        posted.push({ nom, cp });
      });
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    if (!posted.length) return;
    const existing = new Set(); let c2;
    do {
      const r = await notion.databases.query({ database_id: TASKS_DB, start_cursor: c2, page_size: 100, filter: { property: "Tâche", title: { contains: "Récupérer les stats" } } });
      r.results.forEach((pg) => { const t = mapTask(pg); if (t.statut !== "Fait") existing.add(t.task.trim()); });
      c2 = r.has_more ? r.next_cursor : null;
    } while (c2);
    for (const d of posted) {
      const ttl = `Récupérer les stats de ${d.nom} (In Haircare)`;
      if (existing.has(ttl)) continue;
      const props = { "Tâche": { title: [{ text: { content: ttl } }] }, "Statut": { select: { name: "À faire" } }, "Projet": { select: { name: "In Haircare" } }, "Type": { select: { name: "Bilan" } } };
      if (d.cp) props["Responsable"] = { select: { name: d.cp } };
      try {
        await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); existing.add(ttl); console.log("stats task créée:", ttl);
        // brouillon de demande de stats dans le Gmail de la CP (elle relit puis envoie/édite)
        if (d.cp && gm.ENABLED && typeof gm.createDraft === "function") {
          const e = emailOf(d.cp);
          if (e && gm.isConnected(e)) { await gm.createDraft(e, { to: "", subject: "Stats de ta collab In Haircare 📊", body: genStatsFR("In Haircare", d.nom, d.cp) }); }
        }
      } catch (e) { console.warn("stats task", e.message); }
    }
  } catch (e) { console.warn("ensureStatsTasks", e.message); }
}
ensureStatsTasks();
setInterval(ensureStatsTasks, 6 * 3600 * 1000);

// Guide CP (PDF) accessible depuis le cockpit
app.get(["/guide", "/guide.pdf"], (req, res) => res.sendFile(path.join(__dirname, "guide.pdf")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Cockpit ${DEMO ? "(DÉMO)" : "(Notion live, clients actifs)"} → http://localhost:${PORT}`));
