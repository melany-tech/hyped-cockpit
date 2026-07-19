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
// Filet de sécurité : par défaut, Node QUITTE sur une promesse rejetée non gérée, donc une
// seule erreur dans une route async faisait redémarrer tout le cockpit (mails « server failure »
// de Render). On loggue et on continue ; la vraie erreur reste visible dans les logs.
process.on("unhandledRejection", (e) => { try { console.error("[unhandledRejection]", (e && e.stack) || e); } catch (e2) {} });
process.on("uncaughtException", (e) => { try { console.error("[uncaughtException]", (e && e.stack) || e); } catch (e2) {} });
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
app.use(express.json({ limit: "25mb", verify: (req, res, buf) => { req.rawBody = buf.toString("utf8"); } })); // 25 Mo (docs) + rawBody pour la signature Slack
app.use(express.urlencoded({ extended: false })); // formulaires simples (consigne copilote depuis Slack)
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
// Création d'un compte par une superviseure (ex. social media manager, rôle « team » :
// espace allégé avec to-do, process et calendrier, sans les outils créateurs des CP).
app.post("/api/account/add", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const email = String(req.body?.email || "").trim().toLowerCase();
  const name = String(req.body?.name || "").trim();
  const role = ["cp", "supervisor", "team"].includes(String(req.body?.role)) ? String(req.body.role) : "team";
  const pass = String(req.body?.password || "");
  if (!/@hyped-agency\.fr$/.test(email)) return res.status(400).json({ error: "email @hyped-agency.fr requis" });
  if (!name) return res.status(400).json({ error: "prénom requis" });
  if (pass.length < 8) return res.status(400).json({ error: "mot de passe d'au moins 8 caractères" });
  if (USERS.find((u) => String(u.email).toLowerCase() === email)) return res.status(400).json({ error: "ce compte existe déjà" });
  USERS.push({ email, name, role, passwordHash: bcrypt.hashSync(pass, 10) });
  try { fs.writeFileSync(path.join(DATA_DIR, "users.json"), JSON.stringify(USERS, null, 2)); }
  catch (e) { return res.status(500).json({ error: "impossible d'enregistrer sur le disque" }); }
  logActivity({ type: "compte", creator: name + " (" + role + ")", cp: req.user.name });
  res.json({ ok: true, email, name, role });
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
    // Toute l'équipe sauf la personne connectée : CP, rôle « team » (Najem) et autres
    // superviseures (Rozenn chez Mélany, et inversement). Les départs restent exclus.
    const team = USERS
      .filter((u) => normName(u.name) !== normName(req.user.name) && normName(u.name) !== "kendia" && !COPILOT.departed.includes(String(u.email).toLowerCase()))
      .map((u) => u.name);
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
    const tasks = await fetchAllTasks();
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
// --- Vue dirigeante : l'état de l'équipe en un coup d'œil ---------------------
// Une ligne par membre : tâches ouvertes, retards, mails créateurs en attente,
// dernière action. Réservé aux superviseures (leur page d'accueil « Moi »).
app.get("/api/dirigeant", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  try {
    const tasks = DEMO ? [] : await fetchAllTasks();
    const today = new Date().toISOString().slice(0, 10);
    const store = loadCopilot();
    const acts = loadActivity();
    const members = USERS
      // tout le monde sauf la personne qui regarde (Rozenn superviseure incluse) et les départs
      .filter((u) => normName(u.name) !== normName(req.user.name) && !COPILOT.departed.includes(String(u.email).toLowerCase()) && normName(u.name) !== "kendia")
      .map((u) => {
        const mine = tasks.filter((t) => t.statut !== "Fait" && normName(t.responsable) === normName(u.name));
        const late = mine.filter((t) => t.echeance && t.echeance < today).length;
        const mails = (store.proposals || []).filter((p) => (p.status === "pending" || p.status === "ready") && String(p.cpEmail || "").toLowerCase() === String(u.email).toLowerCase()).length;
        const last = acts.filter((a) => normName(a.cp) === normName(u.name)).sort((a, b) => (b.at || 0) - (a.at || 0))[0] || null;
        const rhO = loadRh();
        const absNow = (rhO.absences || []).find((x) => x.statut === "validée" && normName(x.who) === normName(u.name) && x.du <= today && today <= x.au) || null;
        return { name: u.name, role: u.role, open: mine.length, late, mails,
          absence: absNow ? { type: absNow.type, au: absNow.au } : null,
          lastAct: last ? { type: last.type, creator: last.creator, at: last.at } : null };
      });
    res.json({ members, today });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// --- Pense-bête weekly : ce que la dirigeante veut dire lundi ------------------
// Une note jetée à chaud (« dire à Prunelle de… ») pour vider la tête ; on coche
// pendant la réunion. Stocké sur le disque persistant, visible des superviseures.
const WEEKLY_STORE = path.join(DATA_DIR, "weekly.json");
function loadWeekly() { try { return JSON.parse(fs.readFileSync(WEEKLY_STORE, "utf8")); } catch (e) { return { notes: [] }; } }
function saveWeekly(w) { try { fs.writeFileSync(WEEKLY_STORE, JSON.stringify(w, null, 2)); } catch (e) {} }
// Les notes barrées s'auto-nettoient au bout de 7 jours (pièces jointes comprises) :
// le pense-bête reste frais d'une weekly à l'autre sans ménage manuel.
function purgeWeekly(w) {
  const cut = Date.now() - 7 * 24 * 3600 * 1000;
  let changed = false; const keep = [];
  (w.notes || []).forEach((n) => {
    if (n.done && !n.doneAt) { n.doneAt = Date.now(); changed = true; keep.push(n); return; } // anciennes notes : le compteur démarre maintenant
    if (n.done && n.doneAt < cut) {
      (n.files || []).forEach((f) => { try { fs.unlinkSync(path.join(WEEKLY_FILES_DIR, String(f.id).replace(/[^a-f0-9]/g, ""))); } catch (e) {} });
      changed = true; return;
    }
    keep.push(n);
  });
  if (changed) { w.notes = keep; saveWeekly(w); }
  return w;
}
app.get("/api/weekly", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const w = purgeWeekly(loadWeekly());
  const notes = (w.notes || []).sort((a, b) => (a.done === b.done ? (b.at || 0) - (a.at || 0) : (a.done ? 1 : -1)));
  res.json({ notes });
});
app.post("/api/weekly", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const text = String(req.body?.text || "").trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: "note vide" });
  const w = loadWeekly(); w.notes = w.notes || [];
  w.notes.push({ id: crypto.randomBytes(6).toString("hex"), text, who: String(req.body?.who || "").trim().slice(0, 40), by: req.user.name, at: Date.now(), done: false });
  saveWeekly(w); res.json({ ok: true });
});
app.post("/api/weekly/:id/done", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const w = loadWeekly(); const n = (w.notes || []).find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: "note introuvable" });
  n.done = !n.done; n.doneAt = n.done ? Date.now() : null; // top départ des 7 jours avant auto-nettoyage
  saveWeekly(w); res.json({ ok: true, done: n.done });
});
app.post("/api/weekly/:id/edit", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const w = loadWeekly(); const n = (w.notes || []).find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: "note introuvable" });
  const text = String(req.body?.text || "").trim().slice(0, 500);
  if (text) n.text = text;
  if (req.body?.who !== undefined) n.who = String(req.body.who || "").trim().slice(0, 40);
  saveWeekly(w); res.json({ ok: true });
});
// Case cochée → la note part dans la to-do : crée la tâche Notion chez la ou les
// personnes du « Pour qui ? » (« Rozenn et Najem » = une tâche chacun), puis marque
// la note comme faite + « tasked » (le kickoff du lundi saura ne pas la recréer).
app.post("/api/weekly/:id/totask", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  if (!notion || DEMO) return res.status(400).json({ error: "Notion non branché" });
  const w = loadWeekly(); const n = (w.notes || []).find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: "note introuvable" });
  const teamNames = USERS.map((u) => u.name);
  const whos = String(n.who || "").split(/,|\+|&| et | and /i).map((s) => s.trim()).filter(Boolean)
    .map((s) => teamNames.find((t) => nrmName(t) === nrmName(s))).filter(Boolean);
  if (!whos.length) return res.status(400).json({ error: "aucun prénom de l'équipe reconnu dans « Pour qui ? »" });
  const brand = quickBrandsList().find((b) => nrmName(n.text).includes(nrmName(b))) || "";
  const made = [];
  for (const resp of [...new Set(whos)]) {
    const props = {
      "Tâche": { title: [{ text: { content: String(n.text).slice(0, 200) } }] },
      "Type": { select: { name: "Autre" } },
      "Statut": { select: { name: "À faire" } },
      "Responsable": { select: { name: resp } },
    };
    if (brand) props["Projet"] = { select: { name: brand } };
    try { await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); made.push(resp); } catch (e) {}
  }
  if (!made.length) return res.status(500).json({ error: "échec de création dans Notion" });
  n.done = true; n.tasked = true; n.doneAt = Date.now(); saveWeekly(w); invalidateTasksCache();
  logActivity({ type: "todo", creator: String(n.text).slice(0, 60), cp: req.user.name });
  res.json({ ok: true, made });
});
app.post("/api/weekly/:id/del", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const w = loadWeekly(); w.notes = (w.notes || []).filter((x) => x.id !== req.params.id);
  saveWeekly(w); res.json({ ok: true });
});
// Pièces jointes des notes weekly : un visuel, un export, un tableau… stocké sur le
// disque privé, ouvrable en un clic pendant la réunion pour être projeté.
const WEEKLY_FILES_DIR = path.join(DATA_DIR, "weekly_files");
try { fs.mkdirSync(WEEKLY_FILES_DIR, { recursive: true }); } catch (e) {}
app.post("/api/weekly/:id/file", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const w = loadWeekly(); const n = (w.notes || []).find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: "note introuvable" });
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(req.body?.data || ""));
  if (!m) return res.status(400).json({ error: "fichier illisible" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: "fichier trop lourd (15 Mo max)" });
  const fid = crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(path.join(WEEKLY_FILES_DIR, fid), buf); }
  catch (e) { return res.status(500).json({ error: "impossible d'enregistrer sur le disque" }); }
  n.files = n.files || [];
  n.files.push({ id: fid, filename: String(req.body?.filename || "fichier").slice(0, 100), mime: m[1], size: buf.length });
  saveWeekly(w); res.json({ ok: true });
});
// Lien attaché à une note weekly (drive, Notion, TikTok… tout ce qui se projette)
app.post("/api/weekly/:id/link", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const w = loadWeekly(); const n = (w.notes || []).find((x) => x.id === req.params.id);
  if (!n) return res.status(404).json({ error: "note introuvable" });
  let url = String(req.body?.url || "").trim();
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  if (!/^https?:\/\/[^\s]+\.[^\s]+/.test(url)) return res.status(400).json({ error: "lien invalide" });
  n.links = n.links || [];
  n.links.push({ id: crypto.randomBytes(6).toString("hex"), url: url.slice(0, 800), label: String(req.body?.label || "").trim().slice(0, 80) });
  saveWeekly(w); res.json({ ok: true });
});
app.get("/api/weekly/file/:fid", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).send("réservé aux superviseures");
  const w = loadWeekly(); let f = null;
  (w.notes || []).forEach((n) => (n.files || []).forEach((x) => { if (x.id === req.params.fid) f = x; }));
  const p = path.join(WEEKLY_FILES_DIR, String(req.params.fid).replace(/[^a-f0-9]/g, ""));
  if (!f || !fs.existsSync(p)) return res.status(404).send("fichier introuvable");
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", (req.query.dl ? "attachment" : "inline") + "; filename=\"" + encodeURIComponent(f.filename) + "\"");
  res.send(fs.readFileSync(p));
});
// --- RH : demandes d'absence + documents (fiches de paie, factures) ----------
// Tout est stocké sur le DISQUE PERSISTANT (rh.json + rh_docs/), JAMAIS sur GitHub.
// Chacune ne voit que ses demandes et ses documents ; la direction voit tout.
const RH_STORE = path.join(DATA_DIR, "rh.json");
const RH_DIR = path.join(DATA_DIR, "rh_docs");
try { fs.mkdirSync(RH_DIR, { recursive: true }); } catch (e) {}
function loadRh() { try { return JSON.parse(fs.readFileSync(RH_STORE, "utf8")); } catch (e) { return { absences: [], docs: [] }; } }
function saveRh(o) { try { fs.writeFileSync(RH_STORE, JSON.stringify(o, null, 2)); } catch (e) {} }
function rhSlackTo(email) { return (COPILOT.slackIds || {})[String(email || "").toLowerCase()] || ""; }
function dmyFr(d) { return String(d).split("-").reverse().join("/"); }
const RH_TYPES = ["Congés payés", "Sans solde", "Maladie", "Télétravail", "Autre"];
const RH_DEFAULT_QUOTA = 25; // jours de congés payés par an, modifiable par la direction et par personne
function rhWorkDays(du, au) { // jours OUVRÉS (lun-ven) inclus entre deux dates ISO
  let n = 0; const d = new Date(du + "T12:00:00Z"), end = new Date(au + "T12:00:00Z");
  while (d <= end) { const wd = d.getUTCDay(); if (wd !== 0 && wd !== 6) n++; d.setUTCDate(d.getUTCDate() + 1); }
  return n;
}
function rhLeave(o, name) { // congés payés VALIDÉS de l'année en cours (clippés à l'année)
  const year = new Date().getFullYear();
  const y0 = year + "-01-01", y1 = year + "-12-31";
  let taken = 0;
  (o.absences || []).forEach((a) => {
    if (a.type !== "Congés payés" || a.statut !== "validée" || normName(a.who) !== normName(name)) return;
    const du = a.du > y0 ? a.du : y0, au = a.au < y1 ? a.au : y1;
    if (au >= du) taken += rhWorkDays(du, au);
  });
  const quota = Number(((o.quotas || {})[normName(name)])) || RH_DEFAULT_QUOTA;
  return { quota, taken, left: quota - taken };
}
app.get("/api/rh", auth, (req, res) => {
  const o = loadRh(); const sup = req.user.role === "supervisor";
  const me = normName(req.user.name);
  const abs = (o.absences || []).filter((a) => sup || normName(a.who) === me);
  const docs = (o.docs || []).filter((x) => sup || normName(x.who) === me);
  const leave = sup
    ? USERS.filter((u) => !COPILOT.departed.includes(String(u.email).toLowerCase()) && normName(u.name) !== "kendia").map((u) => ({ who: u.name, ...rhLeave(o, u.name) }))
    : [{ who: req.user.name, ...rhLeave(o, req.user.name) }];
  res.json({ ok: true, supervisor: sup, types: RH_TYPES,
    absences: abs.slice().sort((a, b) => String(b.du).localeCompare(String(a.du))),
    docs: docs.slice().sort((a, b) => (b.at || 0) - (a.at || 0)),
    leave, year: new Date().getFullYear(),
    team: sup ? USERS.filter((u) => u.role !== "supervisor").map((u) => u.name) : [] });
});
app.post("/api/rh/absence", auth, async (req, res) => {
  const du = String(req.body?.du || ""), au = String(req.body?.au || du);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(du) || !/^\d{4}-\d{2}-\d{2}$/.test(au)) return res.status(400).json({ error: "dates invalides" });
  if (au < du) return res.status(400).json({ error: "la fin est avant le début" });
  const type = RH_TYPES.includes(req.body?.type) ? req.body.type : "Autre";
  const o = loadRh();
  const a = { id: crypto.randomBytes(6).toString("hex"), who: req.user.name, email: req.user.email, type, du, au, note: String(req.body?.note || "").slice(0, 400), statut: "en attente", at: Date.now() };
  o.absences = o.absences || []; o.absences.push(a); saveRh(o);
  try {
    for (const u of USERS.filter((x) => x.role === "supervisor")) {
      const su = rhSlackTo(u.email);
      if (su) await copilotNotify({ slackUser: su, text: "🏖️ Demande d'absence de *" + a.who + "* : " + type + " du " + dmyFr(du) + " au " + dmyFr(au) + (a.note ? " (« " + a.note + " »)" : "") + ". À valider dans le cockpit, onglet RH." });
    }
  } catch (e) {}
  res.json({ ok: true, id: a.id });
});
app.post("/api/rh/absence/:id/decide", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  const ok2 = req.body?.decision === "validee";
  const o = loadRh(); const a = (o.absences || []).find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "demande introuvable" });
  a.statut = ok2 ? "validée" : "refusée"; a.decidedBy = req.user.name; a.decidedAt = Date.now();
  if (req.body?.comment) a.comment = String(req.body.comment).slice(0, 300);
  saveRh(o);
  try { const su = rhSlackTo(a.email); if (su) await copilotNotify({ slackUser: su, text: (ok2 ? "✅ Absence validée" : "❌ Absence refusée") + " par " + req.user.name + " : " + a.type + " du " + dmyFr(a.du) + " au " + dmyFr(a.au) + (a.comment ? " · « " + a.comment + " »" : "") + "." }); } catch (e) {}
  res.json({ ok: true, statut: a.statut });
});
app.post("/api/rh/absence/:id/del", auth, (req, res) => {
  // annuler : la direction toujours, la personne seulement tant que c'est en attente
  const o = loadRh(); const a = (o.absences || []).find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "introuvable" });
  if (req.user.role !== "supervisor" && (normName(a.who) !== normName(req.user.name) || a.statut !== "en attente")) return res.status(403).json({ error: "plus modifiable" });
  o.absences = (o.absences || []).filter((x) => x.id !== a.id); saveRh(o);
  res.json({ ok: true });
});
app.post("/api/rh/quota", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  const who = String(req.body?.who || ""); const days = Number(req.body?.days);
  if (!who || !(days >= 0 && days <= 60)) return res.status(400).json({ error: "quota invalide (0 à 60 jours)" });
  const o = loadRh(); o.quotas = o.quotas || {}; o.quotas[normName(who)] = days; saveRh(o);
  res.json({ ok: true });
});
app.post("/api/rh/doc", auth, async (req, res) => {
  // dépôt : la direction pour n'importe qui, chacune pour elle-même (ex. sa facture)
  const who = (req.user.role === "supervisor" && req.body?.who) ? String(req.body.who) : req.user.name;
  const m = /^data:([^;]+);base64,(.+)$/.exec(String(req.body?.data || ""));
  if (!m) return res.status(400).json({ error: "fichier illisible" });
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: "fichier trop lourd (15 Mo max)" });
  const fid = crypto.randomBytes(8).toString("hex");
  try { fs.writeFileSync(path.join(RH_DIR, fid), buf); } catch (e) { return res.status(500).json({ error: "impossible d'enregistrer sur le disque" }); }
  const o = loadRh(); o.docs = o.docs || [];
  const cat = ["Fiche de paie", "Facture", "Contrat", "Autre"].includes(req.body?.cat) ? req.body.cat : "Autre";
  o.docs.push({ id: fid, who, cat, filename: String(req.body?.filename || "document").slice(0, 100), mime: m[1], size: buf.length, by: req.user.name, at: Date.now() });
  saveRh(o);
  try {
    if (normName(who) !== normName(req.user.name)) {
      const em = emailOf(who); const su = em ? rhSlackTo(em) : "";
      if (su) await copilotNotify({ slackUser: su, text: "📄 " + req.user.name + " a déposé un document pour toi dans le cockpit (onglet RH) : " + cat + " · " + String(req.body?.filename || "document") + "." });
    }
  } catch (e) {}
  res.json({ ok: true, id: fid });
});
app.get("/api/rh/doc/:fid", auth, (req, res) => {
  const o = loadRh(); const f = (o.docs || []).find((x) => x.id === req.params.fid);
  const p = path.join(RH_DIR, String(req.params.fid).replace(/[^a-f0-9]/g, ""));
  if (!f || !fs.existsSync(p)) return res.status(404).send("document introuvable");
  if (req.user.role !== "supervisor" && normName(f.who) !== normName(req.user.name)) return res.status(403).send("pas ton document");
  res.setHeader("Content-Type", f.mime || "application/octet-stream");
  res.setHeader("Content-Disposition", (req.query.dl ? "attachment" : "inline") + "; filename=\"" + encodeURIComponent(f.filename) + "\"");
  res.send(fs.readFileSync(p));
});
app.post("/api/rh/doc/:fid/del", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  const o = loadRh(); const f = (o.docs || []).find((x) => x.id === req.params.fid);
  if (!f) return res.status(404).json({ error: "introuvable" });
  o.docs = (o.docs || []).filter((x) => x.id !== f.id); saveRh(o);
  try { fs.unlinkSync(path.join(RH_DIR, String(req.params.fid).replace(/[^a-f0-9]/g, ""))); } catch (e) {}
  res.json({ ok: true });
});
// --- Cockpit CEO : finances saisies (v1), roadmap annuelle, arbitrages, brief IA ---
// V1 du brief produit de Mélany (19/07). Les chiffres financiers sont SAISIS À LA MAIN
// et datés (jamais inventés) ; Pennylane arrivera en V2. Stocké sur le disque persistant.
const CEO_STORE = path.join(DATA_DIR, "ceo.json");
function loadCeo() { try { return JSON.parse(fs.readFileSync(CEO_STORE, "utf8")); } catch (e) { return { treso: null, ca: null, roadmap: [], arbitrages: [] }; } }
function saveCeo(o) { try { fs.writeFileSync(CEO_STORE, JSON.stringify(o, null, 2)); } catch (e) {} }
const ARB_TYPES = ["Validation", "Budget", "Prestataire", "Recrutement", "Client sensible", "Autre"];
const RM_AXES = ["Offre & positionnement", "Croissance & acquisition", "Excellence opérationnelle", "Équipe & recrutement", "Rentabilité & finance", "Marque & contenu"];
const RM_STATUTS = ["À venir", "En cours", "À risque", "Bloqué", "Terminé"];
app.get("/api/ceo", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  const o = loadCeo();
  res.json({ ok: true, treso: o.treso || null, ca: o.ca || null,
    roadmap: o.roadmap || [], axes: RM_AXES, rmStatuts: RM_STATUTS, arbTypes: ARB_TYPES,
    arbitrages: (o.arbitrages || []).filter((a) => a.statut === "en attente").sort((a, b) => (a.deadline || "9999").localeCompare(b.deadline || "9999")) });
});
app.post("/api/ceo/config", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  const o = loadCeo();
  if (req.body?.treso !== undefined) {
    const v = Number(req.body.treso);
    if (!(v >= -10000000 && v < 100000000)) return res.status(400).json({ error: "montant invalide" });
    o.treso = { amount: v, at: Date.now(), by: req.user.name, source: "saisie manuelle" };
  }
  if (req.body?.ca !== undefined || req.body?.objectif !== undefined) {
    const prev = o.ca || {};
    const enc = req.body?.ca !== undefined ? Number(req.body.ca) : prev.encaisse;
    const obj = req.body?.objectif !== undefined ? Number(req.body.objectif) : prev.objectif;
    if (!(enc >= 0) || !(obj >= 0)) return res.status(400).json({ error: "montants invalides" });
    o.ca = { encaisse: enc, objectif: obj, periode: String(req.body?.periode || prev.periode || "année"), at: Date.now(), by: req.user.name, source: "saisie manuelle (encaissé uniquement)" };
  }
  saveCeo(o); res.json({ ok: true });
});
// Roadmap annuelle : initiatives par trimestre et par axe, gérées par la direction
app.post("/api/ceo/roadmap", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  const o = loadCeo(); o.roadmap = o.roadmap || [];
  const b = req.body || {};
  if (b.del) { o.roadmap = o.roadmap.filter((x) => x.id !== String(b.del)); saveCeo(o); return res.json({ ok: true }); }
  if (b.id) { // mise à jour (statut, progression…)
    const it = o.roadmap.find((x) => x.id === String(b.id));
    if (!it) return res.status(404).json({ error: "initiative introuvable" });
    if (b.statut && RM_STATUTS.includes(b.statut)) it.statut = b.statut;
    if (b.progression !== undefined) it.progression = Math.max(0, Math.min(100, Number(b.progression) || 0));
    if (b.nom) it.nom = String(b.nom).slice(0, 140);
    if (b.next !== undefined) it.next = String(b.next || "").slice(0, 200);
    saveCeo(o); return res.json({ ok: true });
  }
  const nom = String(b.nom || "").trim();
  if (!nom) return res.status(400).json({ error: "nom manquant" });
  const it = { id: crypto.randomBytes(6).toString("hex"), q: ["Q1", "Q2", "Q3", "Q4"].includes(b.q) ? b.q : "Q3",
    axe: RM_AXES.includes(b.axe) ? b.axe : RM_AXES[0], nom: nom.slice(0, 140),
    resp: String(b.resp || req.user.name).slice(0, 40), cible: String(b.cible || "").slice(0, 20),
    statut: RM_STATUTS.includes(b.statut) ? b.statut : "À venir", progression: 0, next: String(b.next || "").slice(0, 200), at: Date.now() };
  o.roadmap.push(it); saveCeo(o); res.json({ ok: true, id: it.id });
});
// Arbitrages CEO : TOUTE l'équipe peut escalader une décision à la direction
app.post("/api/ceo/arbitrage", auth, async (req, res) => {
  const sujet = String(req.body?.sujet || "").trim();
  if (!sujet) return res.status(400).json({ error: "sujet manquant" });
  const o = loadCeo(); o.arbitrages = o.arbitrages || [];
  const a = { id: crypto.randomBytes(6).toString("hex"), type: ARB_TYPES.includes(req.body?.type) ? req.body.type : "Autre",
    sujet: sujet.slice(0, 200), projet: String(req.body?.projet || "").slice(0, 80),
    montant: Number(req.body?.montant) || 0, deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.deadline || "")) ? req.body.deadline : "",
    impact: String(req.body?.impact || "").slice(0, 300), par: req.user.name, parEmail: req.user.email, statut: "en attente", at: Date.now() };
  o.arbitrages.push(a); saveCeo(o);
  try {
    for (const u of USERS.filter((x) => x.role === "supervisor")) {
      const su = rhSlackTo(u.email);
      if (su && normName(u.name) !== normName(req.user.name)) await copilotNotify({ slackUser: su, text: "⚖️ Arbitrage demandé par *" + a.par + "* (" + a.type + (a.projet ? " · " + a.projet : "") + ") : " + a.sujet + (a.montant ? " · " + a.montant + " €" : "") + (a.deadline ? " · pour le " + dmyFr(a.deadline) : "") + ". À trancher dans le Cockpit CEO." });
    }
  } catch (e) {}
  res.json({ ok: true, id: a.id });
});
app.post("/api/ceo/arbitrage/:id/decide", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  const o = loadCeo(); const a = (o.arbitrages || []).find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "introuvable" });
  const d = String(req.body?.decision || "");
  if (!["valide", "refuse", "precisions"].includes(d)) return res.status(400).json({ error: "décision inconnue" });
  if (d === "precisions") {
    const q = String(req.body?.comment || "").slice(0, 300);
    try { const su = rhSlackTo(a.parEmail); if (su) await copilotNotify({ slackUser: su, text: "💬 " + req.user.name + " a besoin de précisions sur ton arbitrage « " + a.sujet + " »" + (q ? " : " + q : "") + ". Réponds-lui puis renvoie la demande si besoin." }); } catch (e) {}
    return res.json({ ok: true });
  }
  a.statut = d === "valide" ? "validé" : "refusé"; a.decidedBy = req.user.name; a.decidedAt = Date.now();
  if (req.body?.comment) a.comment = String(req.body.comment).slice(0, 300);
  saveCeo(o);
  try { const su = rhSlackTo(a.parEmail); if (su) await copilotNotify({ slackUser: su, text: (d === "valide" ? "✅ Arbitrage validé" : "❌ Arbitrage refusé") + " par " + req.user.name + " : « " + a.sujet + " »" + (a.comment ? " · " + a.comment : "") + "." }); } catch (e) {}
  res.json({ ok: true });
});
// Brief IA quotidien : synthèse des DONNÉES EXISTANTES uniquement, avec cache 1 h
let CEO_BRIEF_CACHE = { at: 0, text: "" };
app.get("/api/ceo/brief", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé à la direction" });
  if (Date.now() - CEO_BRIEF_CACHE.at < 3600000 && CEO_BRIEF_CACHE.text && !req.query.force) return res.json({ ok: true, text: CEO_BRIEF_CACHE.text, at: CEO_BRIEF_CACHE.at, faits: CEO_BRIEF_CACHE.faits || [] });
  try {
    const today = new Date().toISOString().slice(0, 10);
    const o = loadCeo(); const rhO = loadRh(); const cop = loadCopilot();
    const tasks = DEMO ? [] : await fetchAllTasks();
    const faits = []; // chaque fait est typé et pointe vers sa source (recommandations cliquables)
    const arb = (o.arbitrages || []).filter((a) => a.statut === "en attente");
    if (arb.length) faits.push({ go: "dec", t: arb.length + " arbitrage(s) en attente : " + arb.map((a) => a.sujet + (a.montant ? " (" + a.montant + " €)" : "")).slice(0, 5).join(" ; ") });
    const dec = (cop.proposals || []).filter((p) => p.categorie === "decision" && p.status === "pending");
    if (dec.length) faits.push({ go: "messages", t: dec.length + " décision(s) copilote en attente : " + dec.map((p) => p.question || p.resume).slice(0, 4).join(" ; ") });
    const absP = (rhO.absences || []).filter((a) => a.statut === "en attente");
    if (absP.length) faits.push({ go: "chg", t: absP.length + " demande(s) de congés à valider : " + absP.map((a) => a.who + " du " + dmyFr(a.du) + " au " + dmyFr(a.au)).join(" ; ") });
    for (const u of USERS.filter((x) => !COPILOT.departed.includes(String(x.email).toLowerCase()) && normName(x.name) !== "kendia")) {
      const mine = tasks.filter((t) => t.statut !== "Fait" && normName(t.responsable) === normName(u.name));
      const late = mine.filter((t) => t.echeance && t.echeance < today);
      if (late.length >= 3) faits.push({ go: "chg", t: u.name + " a " + late.length + " tâches en retard (" + late.slice(0, 3).map((t) => t.task).join(" ; ") + ")" });
      const absNow = (rhO.absences || []).find((x) => x.statut === "validée" && normName(x.who) === normName(u.name) && x.du <= today && today <= x.au);
      if (absNow) faits.push({ go: "chg", t: u.name + " est absente (" + absNow.type + ") jusqu'au " + dmyFr(absNow.au) });
    }
    try {
      const persoP = (loadPerso().posts || []).filter((x) => x.statut !== "Posté" && x.date && x.date <= new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10));
      if (persoP.length) faits.push({ go: "__perso", t: "Contenu personnel à préparer : " + persoP.map((x) => "« " + x.titre + " » pour le " + dmyFr(x.date)).slice(0, 2).join(" ; ") });
    } catch (e) {}
    try {
      for (const b of ["In Haircare", "Doucéa", "Curls Matter", "LIVA"]) {
        const bd = await budgetForBrand(b, new Date().toISOString().slice(0, 7));
        if (bd && bd.budgetMensuel > 0 && bd.total >= 0.8 * bd.budgetMensuel) faits.push({ go: "budget", t: b + " a consommé " + Math.round(100 * bd.total / bd.budgetMensuel) + " % de son budget mensuel (" + bd.total + " € / " + bd.budgetMensuel + " €)" });
      }
    } catch (e) {}
    if (!faits.length) { CEO_BRIEF_CACHE = { at: Date.now(), text: "Rien d'urgent aujourd'hui : pas d'arbitrage ni de décision en attente, pas de retard critique, budgets sous contrôle. Profites-en pour avancer sur la roadmap ✨", faits: [] }; return res.json({ ok: true, text: CEO_BRIEF_CACHE.text, at: CEO_BRIEF_CACHE.at, faits: [] }); }
    const sys = "Tu es l'assistante de direction de Mélany (agence Hyped). À partir des FAITS fournis (et RIEN d'autre : n'invente aucun chiffre), écris un brief matinal en français : 3 à 6 phrases courtes, priorités d'abord, ton direct et chaleureux, sans tiret quadratin, sans liste à puces.";
    const out = process.env.OPENAI_API_KEY ? await callOpenAI(sys, faits.map((f) => f.t).join("\n"), 600) : (process.env.ANTHROPIC_API_KEY ? await callAnthropic(sys, faits.map((f) => f.t).join("\n"), 600) : null);
    const text = (out && out.ok) ? out.body : ("À traiter aujourd'hui : " + faits.slice(0, 5).map((f) => f.t).join(" · "));
    CEO_BRIEF_CACHE = { at: Date.now(), text, faits };
    res.json({ ok: true, text, at: CEO_BRIEF_CACHE.at, faits });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
  catch (e) {
    if (e && e.mismatch) return res.send(copilotPage("Mauvais compte Google 🙃", "Tu as autorisé la boîte " + e.real + " alors que ton cockpit est " + e.expected + ". Rien n'a été connecté. Recommence en choisissant le BON compte Google dans la fenêtre de connexion (ou déconnecte d'abord l'autre compte de Chrome)."));
    res.redirect("/?gmail=err");
  }
});
// Débrancher une boîte : la sienne, ou celle d'une CP si superviseure (?as=Prénom).
app.post("/api/gmail/disconnect", auth, (req, res) => {
  if (!gm.ENABLED) return res.status(400).json({ error: "Gmail non configuré" });
  const t = inboxTarget(req);
  gm.disconnect(t.email);
  delete INBOX_CACHE[t.email];
  res.json({ ok: true, email: t.email });
});
// Cache court de l'analyse Gmail par boîte (évite de tout relire à chaque rechargement)
const INBOX_CACHE = {}; // email -> { at, data }
const INBOX_TTL = 3 * 60 * 1000; // 3 min (bouton Actualiser = fresh=1 pour forcer)
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
    // Doublons de boîtes : un mail créateur qui appartient en réalité à une AUTRE CP
    // surveillée (voir isOtherCpMail) est masqué de cette liste, il est traité chez elle.
    const shown = { ...r };
    if (shown.creatorReplies) shown.creatorReplies = shown.creatorReplies.filter((m) => !isOtherCpMail(t.email, m));
    // état « traité » (par qui/quand) appliqué à chaque réponse créateur, toujours à jour
    const tt = treatedFor(t.email);
    if (shown.creatorReplies) shown.creatorReplies.forEach((x) => { x.treated = (x.threadId && tt[x.threadId]) ? tt[x.threadId] : null; });
    res.json({ enabled: true, viewing: t.viewing, cached, ...shown });
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
async function callOpenAI(sys, ctx, maxTok) {
  const key = process.env.OPENAI_API_KEY;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": "Bearer " + key },
      body: JSON.stringify({ model: OPENAI_MODEL, max_tokens: maxTok || 700, temperature: 0.7,
        messages: [{ role: "system", content: sys }, { role: "user", content: ctx }] }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { ok: false, reason: "api", detail: (t || "").slice(0, 300), status: r.status }; }
    const d = await r.json();
    const text = (d.choices?.[0]?.message?.content || "").trim();
    return text ? { ok: true, body: text, via: "openai" } : { ok: false, reason: "empty" };
  } catch (e) { return { ok: false, reason: "exc", detail: String(e && e.message || e) }; }
}
async function callAnthropic(sys, ctx, maxTok) {
  const key = process.env.ANTHROPIC_API_KEY;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: REPLY_MODEL, max_tokens: maxTok || 700, system: sys, messages: [{ role: "user", content: ctx }] }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ""); return { ok: false, reason: "api", detail: (t || "").slice(0, 300), status: r.status }; }
    const d = await r.json();
    const text = (d.content || []).filter((c) => c.type === "text").map((c) => c.text).join("").trim();
    return text ? { ok: true, body: text, via: "anthropic" } : { ok: false, reason: "empty" };
  } catch (e) { return { ok: false, reason: "exc", detail: String(e && e.message || e) }; }
}
// Résumé du calendrier d'une marque pour l'IA : jours de publication déjà pris
// sur les 6 prochaines semaines. Sert à proposer des dates optimales (règles :
// au moins 3 jours couverts par semaine, idéalement mardi/mercredi/jeudi).
function planningForBrand(collabs, brand) {
  try {
    if (!brand) return "";
    const taken = new Set();
    for (const r of collabs || []) { if (r.brand === brand && r.date) taken.add(String(r.date).slice(0, 10)); }
    const today = new Date(); today.setHours(12, 0, 0, 0);
    const monday = new Date(today); monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));
    const JOURS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
    const MOIS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
    const lines = [];
    for (let w = 0; w < 6; w++) {
      const start = new Date(monday); start.setDate(monday.getDate() + w * 7);
      const days = [];
      for (let j = 0; j < 7; j++) {
        const d = new Date(start); d.setDate(start.getDate() + j);
        if (taken.has(d.toISOString().slice(0, 10))) days.push(JOURS[j] + " " + d.getDate() + " " + MOIS[d.getMonth()]);
      }
      lines.push("semaine du " + start.getDate() + " " + MOIS[start.getMonth()] + " : " + (days.length ? (days.join(", ") + " -> " + days.length + " jour(s) couvert(s)") : "aucune publication prévue"));
    }
    return lines.join("\n");
  } catch (e) { return ""; }
}
// Consignes spécifiques d'une marque, écrites dans sa fiche (champ « Consignes pour l'IA »).
// L'IA les reçoit à chaque réponse liée à cette marque.
function brandNotesFor(brand) {
  try {
    if (!brand) return "";
    const rec = loadBrandFiches()[brand];
    return (rec && String(rec.iaNotes || "").trim().slice(0, 2000)) || "";
  } catch (e) { return ""; }
}
// Informations de facturation OFFICIELLES de la marque (fiche) : à qui facturer (agence
// ou marque), coordonnées exactes. L'IA les recopie telles quelles, jamais de mémoire.
function brandFacturationFor(brand) {
  try {
    if (!brand) return "";
    const rec = loadBrandFiches()[brand];
    return (rec && String(rec.facturation || "").trim().slice(0, 1200)) || "";
  } catch (e) { return ""; }
}
// Histoire/valeurs de la marque (fiche marque) : l'IA s'en sert pour répondre
// aux créateurs qui veulent en savoir plus sur la marque, avec des faits fiables.
function brandInfoFor(brand) {
  try {
    if (!brand) return "";
    const rec = loadBrandFiches()[brand];
    return (rec && String(rec.histoire || "").trim().slice(0, 1500)) || "";
  } catch (e) { return ""; }
}
// Consigne de la marque sur UN profil précis (ex. « uniquement gifting », « en crosspost »),
// venue de la shortlist importée : on la retrouve via la tâche « Prise de contact » du créateur,
// et elle suit le profil pendant TOUTE la conversation.
async function profileNoteFor(creator) {
  if (!creator) return "";
  try {
    const all = await fetchAllTasks();
    const n = normName(String(creator).replace(/^@/, ""));
    if (!n) return "";
    const hit = all.find((t) => t.type === "Prise de contact" && normName(String(t.task).replace(/^contacter\s+/i, "").replace(/^@/, "")) === n);
    return hit && hit.commentaire ? String(hit.commentaire).slice(0, 500) : "";
  } catch (e) { return ""; }
}
// Voix personnelle de chaque CP : un mail réel jugé « parfait » par l'équipe, que l'IA
// imite en PRIORITÉ quand elle écrit au nom de cette CP (par-dessus la voix Kendia générique).
const CP_VOICE = {
  prunelle: [
    "Hello ! 🤍",
    "J'espère que tu vas bien !",
    "Je me présente, je suis Prunelle, cheffe de projet chez Hyped Agency.",
    "Je me permets de te contacter au sujet d'In Haircare, une marque française spécialisée dans le soin des cheveux texturés. Depuis 2019, elle accompagne les cheveux bouclés, frisés et crépus avec des produits fabriqués en France, pensés pour révéler la beauté naturelle de chaque texture. ✨",
    "J'adore ton univers et l'énergie que tu transmets à ta communauté. Je trouve qu'ils résonnent parfaitement avec les valeurs de la marque, c'est pourquoi j'ai tout de suite pensé à toi pour cette campagne.",
    "Ce que nous recherchons avant tout, c'est un contenu authentique qui te ressemble : partager ton expérience, montrer comment tu intègres la routine dans ton quotidien, raconter ton ressenti et laisser parler ta créativité. L'objectif n'est pas de réciter un script, mais de créer un contenu naturel auquel ta communauté pourra s'identifier.",
    "Dans l'idéal, nous aimerions réaliser un Reel Instagram/TikTok, accompagné d'un set de stories. Nous restons bien entendu ouverts à tes idées créatives pour que le contenu reflète pleinement ton univers.",
    "Nous partons principalement sur une approche en gifting, avec l'envoi de la routine complète afin que tu puisses réellement la tester. Si tu fonctionnes uniquement sur des collaborations rémunérées, n'hésite pas à me partager tes modalités et tes tarifs afin que nous puissions en discuter ensemble.",
    "J'espère que cette collaboration te plaira et j'ai hâte d'avoir ton retour ! 🤍",
    "Belle journée,",
    "Prunelle",
  ].join("\n"),
  rozenn: [
    "Hello Chloé 🤍",
    "Et avant toute chose, toutes mes excuses pour mon précédent mail, j'ai mélangé mes échanges et je me suis trompée de prénom. 🙈",
    "Merci encore pour l'envoi ! On a fait un dernier tour du contenu et on aurait juste quelques petits ajustements :",
    "Sur la story, il faudrait retirer la partie où tu mentionnes l'eczéma. D'un point de vue réglementaire (DGCCRF), il n'est malheureusement pas possible de faire le lien entre le produit et l'eczéma, car cela pourrait être considéré comme une allégation non autorisée. On préfère donc supprimer cette partie pour éviter tout risque.",
    "Dans la caption, pourrais-tu ajouter le tag de @Doucéa ?",
    "Est-ce que tu pourrais également nous partager la cover prévue pour le Reel ?",
    "Une fois ces petits points ajustés, ce sera tout bon de notre côté. 🤍",
    "Merci beaucoup ✨",
    "",
    "--- Autre exemple réel de Rozenn (passation du fil à une collègue) ---",
    "Hello Eva 🤍",
    "Merci beaucoup pour l'envoi de la caption, et encore merci pour ta réactivité ! ✨",
    "Je reviens vers toi dans la journée avec une confirmation sur l'ensemble du contenu. 😊",
    "Ensuite, je te passerai entre les mains Amena, notre super cheffe de projet, qui est de retour. Elle prendra le relais pour la suite de la campagne et t'accompagnera jusqu'à la mise en ligne.",
    "Et bien sûr, je ne disparais pas pour autant ! Je reste en backup si tu as la moindre question ou le moindre besoin, ce sera toujours un plaisir d'échanger avec toi. 🤍",
    "À très vite, et encore merci !",
    "Rozenn",
  ].join("\n"),
};
function cpVoiceFor(cp) { return CP_VOICE[normName(cp || "").split(" ")[0]] || ""; }
async function claudeReply({ cp, creator, brand, category, received, subject, transcript, directive, planning, brandNotes, brandInfo, profileNote, draft, rework }) {
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
    "LANGUE (PRIORITÉ ABSOLUE) : tu réponds TOUJOURS dans la LANGUE du dernier message reçu. Mail en anglais = réponse ENTIÈREMENT en anglais (même chaleur, mêmes règles, salutation adaptée type 'Hi [prénom],'). Mail en français = réponse en français. Ne mélange jamais les deux.",
    "RÈGLE D'OR : tu réponds VRAIMENT au contenu du dernier message : tu reprends ses points, réponds à ses questions, rebondis sur ce qu'il dit. JAMAIS de réponse générique.",
    "SENS DES ÉCHANGES (NE JAMAIS INVERSER) : c'est L'AGENCE (nous) qui envoie au créateur le contrat, le brief et les produits ; c'est le CRÉATEUR qui les reçoit. Ne dis JAMAIS « j'ai bien reçu le contrat / le brief / les produits » : c'est LUI qui les reçoit, pas toi. Ce que TOI tu reçois de lui : previews, contenus, factures, infos postales, stats.",
    "ÉTAPES D'UNE COLLAB, dans l'ordre : 1 prise de contact, 2 accord du créateur, 3 NOUS envoyons contrat + brief, 4 le créateur SIGNE le contrat, 5 NOUS envoyons les produits, 6 le créateur crée le contenu et NOUS envoie la preview, 7 validation par nous, 8 publication, 9 facture s'il y a rémunération. Quand le créateur confirme une étape, ta réponse acte cette étape et amène NATURELLEMENT à la SUIVANTE (ex. il a reçu contrat + brief -> tu te réjouis et l'invites à signer le contrat, en rappelant la suite).",
    "RÈGLE BUDGET, déterminer le type : la collab est rémunérée UNIQUEMENT si un budget / tarif / facture / paiement a déjà été ACTÉ par l'agence dans le fil. Sinon c'est un envoi de produits (gifting). N'affirme JAMAIS que c'est payé si ça n'a pas été acté.",
    "RÈGLE BUDGET, comment l'annoncer (FORMULATION OBLIGATOIRE, à respecter à la lettre) :",
    "  - On n'IMPOSE jamais et on ne REFUSE jamais frontalement. INTERDITS ABSOLUS (ne JAMAIS écrire) : 'on ne pourra pas activer le budget', 'on ne peut pas te rémunérer', 'ce n'est pas rémunéré', 'pas de budget', 'non rémunéré', 'collab non payée', 'en échange de ton contenu'.",
    "  - On présente le gifting comme un AVANTAGE, avec des tournures TENTATIVES ('nous pensions', 'on pensait partir sur') : ex. 'Nous pensions partir sur un envoi de nos produits afin que tu puisses tester toute la gamme ✨' (mets en avant l'intérêt de recevoir / tester la gamme).",
    "  - PUIS on suggère le contenu en douceur, jamais en ordre : ex. 'et nous pensions que tu pourrais ensuite donner ton avis dans une vidéo 🫶'. Si tu connais la plateforme (TikTok/Instagram) d'après le fil, précise-la ('dans une vidéo sur TikTok') ; SINON écris 'sur tes réseaux'. N'écris JAMAIS de crochet type '[plateforme]'.",
    "  - Si le créateur a PROPOSÉ un tarif/budget qu'on ne fait pas : ne refuse pas le montant, n'en parle même pas, réoriente positivement vers l'envoi produits (test de la gamme) + la suggestion de contenu.",
    "  - INTERDICTION ABSOLUE de VALIDER un tarif/budget proposé par le créateur ('c'est ok pour nous', 'on accepte ton tarif', 'ça marche pour ce montant') sans une DIRECTIVE explicite de la CP qui accepte CE tarif. Si le tarif est en suspens : 'pour tes tarifs, je valide en interne et je reviens vers toi très vite ✨'.",
    "PÉRIMÈTRE DE LA DIRECTIVE : quand une directive de la CP existe, elle ne vaut QUE pour la question tranchée. Tu n'acceptes, ne valides et ne promets RIEN d'autre (tarif, budget, date, contrat, exclusivité) : pour ces autres sujets, accuse réception avec chaleur et indique que tu reviens vite.",
    profileNote ? ("CONSIGNE DE LA MARQUE SUR CE PROFIL, valable pendant TOUTE la collab, elle prime sur le reste : « " + String(profileNote).slice(0, 400) + " ». Ex. « uniquement gifting » = tu n'évoques JAMAIS de rémunération pour ce profil, même s'il en demande : tu réorientes gentiment vers l'envoi de produits.") : "",
    (() => { const f = brandFacturationFor(brand); return f ? ("INFORMATIONS DE FACTURATION OFFICIELLES pour " + brand + " : si le créateur demande à qui adresser sa facture ou les coordonnées de facturation, recopie EXACTEMENT ces informations, n'improvise JAMAIS d'autres coordonnées : « " + f + " ». Si ces informations ne répondent pas à sa question, dis que tu vérifies et reviens vers lui.") : ""; })(),
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
    (() => { const v = cpVoiceFor(cp); return v ? ("\nEXEMPLE RÉEL d'un mail écrit par " + cp + " ELLE-MÊME, jugé parfait par l'équipe : quand tu écris en son nom, imite en PRIORITÉ sa voix, ses tournures et sa structure (par-dessus la voix Kendia) :\n\"\"\"\n" + v + "\n\"\"\"") : ""; })(),
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
    brandNotes ? ("CONSIGNES SPÉCIFIQUES DE LA MARQUE (écrites par l'agence dans la fiche marque, à respecter ABSOLUMENT, prioritaires sur les règles générales) :\n" + brandNotes) : "",
    brandInfo ? ("CONTEXTE MARQUE (histoire et valeurs, source interne fiable : sers-t'en si le créateur pose des questions sur la marque, sans mentionner l'existence de cette fiche) :\n" + brandInfo) : "",
    planning ? ("PLANNING de la marque (publications déjà calées sur les prochaines semaines) :\n" + planning) : "",
    planning ? "RÈGLE DATES : si le mail concerne une date de publication (caler, décaler, confirmer), privilégie un MARDI, MERCREDI ou JEUDI, dans une semaine où moins de 3 jours sont déjà couverts (objectif : au moins 3 jours différents remplis par semaine). Si la date proposée par le créateur respecte déjà ces règles, valide-la simplement. Sinon, reste souple : accepte le principe mais suggère la meilleure date proche ('est-ce que le jeudi 23 t'irait ?'), sans jamais imposer ni mentionner l'existence d'un planning interne." : "",
    directive ? ("DIRECTIVE DE LA CHEFFE DE PROJET (décision prise, à appliquer absolument, avec tact et dans la voix Hyped) : " + directive) : "",
    draft ? ("BROUILLON PRÉCÉDENT (celui que la CP veut retravailler) :\n\"\"\"\n" + String(draft).slice(0, 3000) + "\n\"\"\"") : "",
    rework ? ("CONSIGNE DE REFORMULATION DE LA CHEFFE DE PROJET (PRIORITÉ ABSOLUE : applique-la VRAIMENT et intégralement, quitte à changer le ton, la longueur ou la structure ; le résultat doit être sensiblement différent du brouillon, ne rends JAMAIS le même texte) : " + rework) : "",
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
  let planning = ""; try { planning = planningForBrand(await fetchRows(), brand); } catch (e) {}
  const out = await claudeReply({ cp: req.user.name, creator, brand, category, received, subject, transcript, planning, brandNotes: brandNotesFor(brand), brandInfo: brandInfoFor(brand), profileNote: await profileNoteFor(creator) });
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
    await notion.pages.update({ page_id: req.params.id, properties: { "Statut": { select: { name: next } } } }); invalidateTasksCache();
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
// Cache partagé de la base Tâches (60 s) : évite de rescanner Notion à chaque panneau.
// Invalidé à chaque écriture pour rester frais après un clic.
let TASKS_CACHE = { at: 0, all: [] };
function invalidateTasksCache() { TASKS_CACHE.at = 0; }
async function fetchAllTasks() {
  if (Date.now() - TASKS_CACHE.at < 60000 && TASKS_CACHE.all.length) return TASKS_CACHE.all;
  const all = []; let cursor;
  do {
    const r = await notion.databases.query({ database_id: TASKS_DB, start_cursor: cursor, page_size: 100 });
    r.results.forEach((pg) => all.push(mapTask(pg))); cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  TASKS_CACHE = { at: Date.now(), all };
  return all;
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
    const all = await fetchAllTasks();
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
  try { const pg = await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); invalidateTasksCache(); res.json({ ok: true, id: pg.id }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/todos/:id/done", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  try { await notion.pages.update({ page_id: req.params.id, properties: { "Statut": { select: { name: "Fait" } } } }); invalidateTasksCache(); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Cliquer une tâche → ajouter des détails (Commentaire veille) et une échéance
app.post("/api/todos/:id/edit", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  try {
    const props = {};
    if (req.body?.echeance !== undefined) {
      const e = String(req.body.echeance || "");
      props["Échéance"] = (e && /^\d{4}-\d{2}-\d{2}$/.test(e)) ? { date: { start: e } } : { date: null };
    }
    if (req.body?.details !== undefined) {
      const t = String(req.body.details || "").trim();
      props["Commentaire veille"] = { rich_text: t ? [{ text: { content: t.slice(0, 1900) } }] : [] };
    }
    if (!Object.keys(props).length) return res.status(400).json({ error: "rien à modifier" });
    await notion.pages.update({ page_id: req.params.id, properties: props });
    invalidateTasksCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
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
const BRAND_BASE_FIELDS = ["histoire", "clientDepuis", "clientJusqua", "objectifs", "reunions", "kpis", "pole", "interlocuteurHA", "contactsOu", "instagram", "tiktok", "siteweb", "iaNotes", "facturation", "budgetMensuel"];
const BRAND_FILES_DIR = path.join(DATA_DIR, "brandfiles");
try { fs.mkdirSync(BRAND_FILES_DIR, { recursive: true }); } catch (e) {}
function loadBrandFiches() { try { return JSON.parse(fs.readFileSync(BRANDS_STORE, "utf8")); } catch (e) { return {}; } }
function saveBrandFiches(o) { try { fs.writeFileSync(BRANDS_STORE, JSON.stringify(o)); } catch (e) {} }
app.get("/api/brands", auth, (req, res) => {
  res.json({ brands: loadBrandFiches(), canEditBase: req.user.role === "supervisor" });
});
// --- Suivi budget mensuel par marque -------------------------------------------
// Budget engagé = somme des « Budget » du calendrier Notion de la marque sur le mois.
// Le copilote y inscrit déjà les montants validés par mail (pipeline) ; les ajouts
// à la main dans le calendrier comptent pareil. Budget mensuel = champ de la fiche.
const BUDGET_CALS = {
  "in haircare": { dbId: "380f8ac3-c3ae-80ce-ba4c-e8e82490edc6", dateProp: "Date" },
  "doucea": { dbId: "37bf8ac3-c3ae-81d6-9dbd-d7f4a64165a8", dateProp: "Date" },
};
// Le « + » de la vue Budget : ajoute un profil et son budget directement dans le
// calendrier Notion de la marque (la CP connectée devient l'Interlocuteur).
app.post("/api/budget/:brand/add", auth, async (req, res) => {
  if (!notion || DEMO) return res.status(400).json({ error: "Notion non branché" });
  const brand = String(req.params.brand || "").trim();
  const cfg = BUDGET_CALS[nrmName(brand)];
  if (!cfg) return res.status(400).json({ error: "pas de calendrier branché pour cette marque (ajoute la collab dans Notion)" });
  const nom = String(req.body?.nom || "").trim();
  if (!nom) return res.status(400).json({ error: "il me faut le nom du profil 🙂" });
  const budget = parseFloat(String(req.body?.budget ?? "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || "")) ? String(req.body.date) : new Date().toISOString().slice(0, 10);
  const props = {
    "Nom": { title: [{ text: { content: nom.slice(0, 120) } }] },
  };
  // Budget validé mais date à confirmer : on crée SANS date (le calendrier reste honnête),
  // et la collab compte dans le mois en cours avec un marqueur TBC.
  if (!req.body?.tbc) props[cfg.dateProp] = { date: { start: date } };
  if (budget > 0) props["Budget"] = { number: budget };
  try { const uid = await userIdByName(req.user.name); if (uid) props["Interlocuteur"] = { people: [{ id: uid }] }; } catch (e) {}
  try {
    const pg = await notion.pages.create({ parent: { database_id: cfg.dbId }, properties: props });
    logActivity({ type: "collab", creator: nom, brand, cp: req.user.name });
    res.json({ ok: true, id: pg.id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Instantané budget d'une marque (total engagé du mois, TBC inclus) : sert au brief IA CEO
async function budgetForBrand(brand, month) {
  const fiche = (loadBrandFiches() || {})[brand] || {};
  const budgetMensuel = parseFloat(String(fiche.budgetMensuel || "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
  const cfg = BUDGET_CALS[nrmName(brand)];
  if (!notion || DEMO || !cfg) return { budgetMensuel, total: 0 };
  const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  let total = 0, cursor;
  do {
    const r = await notion.databases.query({ database_id: cfg.dbId, start_cursor: cursor, page_size: 100,
      filter: { and: [
        { property: cfg.dateProp, date: { on_or_after: month + "-01" } },
        { property: cfg.dateProp, date: { on_or_before: month + "-" + String(lastDay).padStart(2, "0") } },
      ] } });
    r.results.forEach((pg) => { total += Number((pg.properties || {})["Budget"]?.number || 0); });
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  if (month === new Date().toISOString().slice(0, 7)) {
    let cursor2;
    do {
      const r2 = await notion.databases.query({ database_id: cfg.dbId, start_cursor: cursor2, page_size: 100,
        filter: { property: cfg.dateProp, date: { is_empty: true } } });
      r2.results.forEach((pg) => { total += Number((pg.properties || {})["Budget"]?.number || 0); });
      cursor2 = r2.has_more ? r2.next_cursor : null;
    } while (cursor2);
  }
  return { budgetMensuel, total };
}
app.get("/api/budget/:brand", auth, async (req, res) => {
  try {
    const brand = String(req.params.brand || "").trim();
    const fiche = (loadBrandFiches() || {})[brand] || {};
    const budgetMensuel = parseFloat(String(fiche.budgetMensuel || "").replace(/[^\d.,]/g, "").replace(",", ".")) || 0;
    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || "")) ? String(req.query.month) : new Date().toISOString().slice(0, 7);
    const cfg = BUDGET_CALS[nrmName(brand)];
    if (!notion || DEMO || !cfg) return res.json({ enabled: true, noCal: !cfg, month, budgetMensuel, total: 0, entries: [] });
    const lastDay = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
    const entries = []; let cursor;
    do {
      const r = await notion.databases.query({ database_id: cfg.dbId, start_cursor: cursor, page_size: 100,
        // filtre composé explicite : les deux bornes du mois (la forme à double clé était ignorée)
        filter: { and: [
          { property: cfg.dateProp, date: { on_or_after: month + "-01" } },
          { property: cfg.dateProp, date: { on_or_before: month + "-" + String(lastDay).padStart(2, "0") } },
        ] } });
      r.results.forEach((pg) => {
        const p = pg.properties || {};
        entries.push({
          nom: (p["Nom"]?.title || []).map((t) => t.plain_text).join("") || "(sans nom)",
          date: p[cfg.dateProp]?.date?.start?.slice(0, 10) || null,
          statut: p["Statut"]?.select?.name || "",
          budget: Number(p["Budget"]?.number || 0),
          cp: firstPerson(p["Interlocuteur"]) || "",
        });
      });
      cursor = r.has_more ? r.next_cursor : null;
    } while (cursor);
    // Budgets validés SANS date (TBC) : comptés dans le mois en cours uniquement
    if (month === new Date().toISOString().slice(0, 7)) {
      let cursor2;
      do {
        const r2 = await notion.databases.query({ database_id: cfg.dbId, start_cursor: cursor2, page_size: 100,
          filter: { property: cfg.dateProp, date: { is_empty: true } } });
        r2.results.forEach((pg) => {
          const p = pg.properties || {};
          const b = Number(p["Budget"]?.number || 0);
          if (!(b > 0)) return;
          entries.push({ nom: (p["Nom"]?.title || []).map((t) => t.plain_text).join("") || "(sans nom)", date: null, tbc: true, statut: p["Statut"]?.select?.name || "", budget: b, cp: firstPerson(p["Interlocuteur"]) || "" });
        });
        cursor2 = r2.has_more ? r2.next_cursor : null;
      } while (cursor2);
    }
    entries.sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
    const total = entries.reduce((s, e) => s + (Number(e.budget) || 0), 0);
    res.json({ enabled: true, month, budgetMensuel, total, restant: budgetMensuel ? (budgetMensuel - total) : null, entries });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/brand/:name", auth, (req, res) => {
  const name = String(req.params.name || "").trim();
  if (!name) return res.status(400).json({ error: "marque manquante" });
  const isSup = req.user.role === "supervisor";
  const body = req.body || {};
  const all = loadBrandFiches();
  if (body.create) { // création d'une fiche de marque : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut créer une marque" });
    if (all[name]) return res.status(400).json({ error: "cette marque a déjà une fiche" });
    all[name] = { createdAt: Date.now(), createdBy: req.user.name };
    saveBrandFiches(all);
    logActivity({ type: "fiche", creator: name, cp: req.user.name });
    return res.json({ ok: true, created: true });
  }
  if (body.remove) { // suppression de la fiche : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut supprimer une fiche" });
    delete all[name];
    saveBrandFiches(all);
    logActivity({ type: "fiche", creator: name + " (fiche supprimée)", cp: req.user.name });
    return res.json({ ok: true, removed: true });
  }
  const rec = all[name] || {};
  const changes = [];
  if (body.base) { // socle de la fiche : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut modifier la base de la fiche" });
    for (const k of BRAND_BASE_FIELDS) {
      if (body.base[k] !== undefined) { rec[k] = String(body.base[k]).slice(0, 4000); changes.push(k); }
    }
  }
  // Migration : l'ancien champ unique « interlocuteur » devient une LISTE (plusieurs
  // contacts côté marque : responsable influence, assistante, fondateur…).
  const migrateIts = () => {
    rec.interlocuteurs = rec.interlocuteurs || [];
    if (rec.interlocuteur && (rec.interlocuteur.nom || rec.interlocuteur.email)) {
      rec.interlocuteurs.unshift({ at: (rec.updatedAt || Date.now()) - 1, by: "", ...rec.interlocuteur });
    }
    delete rec.interlocuteur;
  };
  const cleanIt = (it) => ({ at: Date.now(), by: req.user.name, nom: String(it.nom || "").slice(0, 120), email: String(it.email || "").slice(0, 200), tel: String(it.tel || "").slice(0, 40), role: String(it.role || "").slice(0, 120) });
  if (body.interlocuteur !== undefined) { // ancien format (compat) : on ajoute à la liste
    migrateIts();
    rec.interlocuteurs = rec.interlocuteurs.concat([cleanIt(body.interlocuteur || {})]).slice(-20);
    changes.push("interlocuteur");
  }
  if (body.addInterlocuteur) { // interlocuteurs côté marque : toutes les CP, plusieurs possibles
    const it = body.addInterlocuteur || {};
    if (!String(it.nom || "").trim() && !String(it.email || "").trim()) return res.status(400).json({ error: "il faut au moins un nom ou un email" });
    migrateIts();
    rec.interlocuteurs = rec.interlocuteurs.concat([cleanIt(it)]).slice(-20);
    changes.push("interlocuteur");
  }
  if (body.editInterlocuteur) { // modification d'un interlocuteur existant : toutes les CP
    const it = body.editInterlocuteur || {};
    migrateIts();
    const x = rec.interlocuteurs.find((y) => y.at === Number(it.at));
    if (!x) return res.status(404).json({ error: "interlocuteur introuvable" });
    if (!String(it.nom || "").trim() && !String(it.email || "").trim()) return res.status(400).json({ error: "il faut au moins un nom ou un email" });
    x.nom = String(it.nom || "").slice(0, 120); x.email = String(it.email || "").slice(0, 200); x.tel = String(it.tel || "").slice(0, 40); x.role = String(it.role || "").slice(0, 120);
    x.by = req.user.name;
    changes.push("interlocuteur modifié");
  }
  if (body.deleteInterlocuteurAt) { // suppression d'un interlocuteur : responsable uniquement
    if (!isSup) return res.status(403).json({ error: "Seule la responsable peut supprimer un interlocuteur" });
    migrateIts();
    rec.interlocuteurs = rec.interlocuteurs.filter((x) => x.at !== Number(body.deleteInterlocuteurAt));
    changes.push("suppression interlocuteur");
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
// --- Message de PREMIER contact (veille) rédigé par l'IA ---------------------
// Fini le modèle à trous « Hello prénom » : l'IA écrit le message d'approche dans
// la voix Hyped, nourri par la fiche marque (histoire + consignes IA), selon la
// trame de la fiche 03 du process. Règle d'or : ne JAMAIS parler d'argent en premier.
app.post("/api/contact/message", auth, async (req, res) => {
  const creator = String((req.body || {}).creator || "").slice(0, 80);
  const brand = String((req.body || {}).brand || "").slice(0, 80);
  const disp = String((req.body || {}).disp || "").slice(0, 200);
  let consignes = String((req.body || {}).consignes || "").slice(0, 600); // consignes de la marque sur CE profil (import shortlist)
  if (!consignes) consignes = await profileNoteFor(String((req.body || {}).creator || "")); // fallback : retrouvées via la tâche du profil
  const langRaw = String((req.body || {}).lang || "auto");
  let lang = langRaw === "en" ? "en" : langRaw === "fr" ? "fr" : "auto";
  // Langue par défaut de certaines marques quand la fiche est muette (mode Auto).
  // La fiche marque reste prioritaire : une consigne « marque anglophone » dans les
  // Consignes pour l'IA suffit à basculer n'importe quelle marque en anglais.
  const CONTACT_LANG_DEFAULT = { "liva": "en" };
  const hinted = CONTACT_LANG_DEFAULT[String((req.body || {}).brand || "").trim().toLowerCase()];
  if (lang === "auto" && hinted) lang = hinted;
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return res.json({ ok: false });
  const cp = req.user.name || "la cheffe de projet";
  const prenom = creator && !/^https?:/i.test(creator) && creator !== "[prénom]" ? creator.replace(/^@/, "").split(/[\s|·@\/(_-]+/)[0] : "";
  const sys = [
    "Tu es " + cp + ", cheffe de projet influence chez Hyped Agency. Tu écris le PREMIER message de contact à un créateur / une créatrice pour la marque " + (brand || "que nous représentons") + " (personne jamais contactée auparavant).",
    "TRAME, dans cet ordre, fluide et naturel : salutation avec le prénom · qui tu es (ton prénom, cheffe de projet chez Hyped Agency) · présentation de la marque et de son univers en 2-3 phrases APPUYÉES SUR L'HISTOIRE FOURNIE (bénéfices produits concrets, où la trouver si l'info existe) · compliment sincère sur son contenu et son énergie, en lien avec les valeurs de la marque, SANS inventer de détail précis sur ses posts · proposition : lui envoyer les produits à découvrir et créer " + (disp || "du contenu") + " dans le cadre d'une collaboration · question ouverte pour savoir si ça lui plairait · clôture chaleureuse + ton prénom.",
    "RÈGLE D'OR ABSOLUE : ne JAMAIS proposer de budget, tarif ou rémunération en premier. Ne parle pas d'argent du tout : c'est le créateur qui annonce ses tarifs s'il y a lieu.",
    "TON (voix Hyped) : chaleureux, enthousiaste, tutoiement, emojis légers (✨ 🤍 🫶, 2-3 max).",
    "STYLE : jamais de tiret quadratin « — ». 6 à 10 lignes. Réponds UNIQUEMENT par le corps du message, sans objet, sans guillemets, sans commentaire.",
    lang === "en" ? "LANGUE : écris le message ENTIÈREMENT en anglais."
      : lang === "fr" ? "LANGUE : français."
      : "LANGUE : déduis-la de la MARQUE : si son histoire ou les consignes montrent une marque / audience anglophone (marché UK ou US, communication en anglais), écris TOUT le message en anglais ; sinon en français.",
    "PRÉNOM : " + (prenom ? ("adresse-toi à « " + prenom + " »") : "prénom INCONNU : salutation SANS prénom (« Hello ! J'espère que tu vas bien » / « Hi! Hope you're doing well »). N'écris JAMAIS [prénom] ni aucun crochet : le message doit partir tel quel") + ".",
    "N'invente AUCUN fait précis sur le créateur (pas de stats, de vidéo ou de post inventés).",
    consignes ? ("CONSIGNES DE LA MARQUE SUR CE PROFIL (PRIORITAIRES, à respecter à la lettre) : « " + consignes + " ». Exemples d'application : « gifting uniquement » = ne promets et ne laisse entrevoir AUCUNE rémunération ; « en crosspost » = précise que la marque souhaite repartager le contenu sur ses propres réseaux ; un budget indiqué = c'est ton plafond interne, ne le révèle PAS dans le message.") : "",
  ].filter(Boolean).join("\n");
  const info = brandInfoFor(brand) || "";
  const notes = brandNotesFor(brand) || "";
  const ctx = "Marque : " + (brand || "?")
    + (info ? ("\n\nHISTOIRE / IDENTITÉ DE LA MARQUE :\n" + info) : "")
    + (notes ? ("\n\nCONSIGNES DE LA RESPONSABLE POUR CETTE MARQUE :\n" + notes) : "")
    + (consignes ? ("\n\nCONSIGNE DE LA MARQUE SUR CE PROFIL (elle prime, ex. « uniquement gifting » = ne jamais évoquer de rémunération) :\n" + consignes) : "")
    + "\n\nLivrables envisagés : " + (disp || "à définir ensemble")
    + "\nCréateur : " + (creator || "inconnu");
  try {
    const out = hasOpenAI ? await callOpenAI(sys, ctx) : await callAnthropic(sys, ctx);
    let bodyOut = out.ok ? String(out.body || "").trim() : "";
    // Ceinture et bretelles : prénom inconnu = AUCUN crochet dans le message (le modèle
    // écrit parfois quand même « [prénom] » malgré la consigne) : on nettoie, le message
    // doit pouvoir partir tel quel.
    if (!prenom && bodyOut) bodyOut = bodyOut.replace(/\s*\[[^\]\n]{0,30}\]\s*/g, " ").replace(/ {2,}/g, " ").replace(/\s+([!,.?])/g, "$1");
    res.json({ ok: !!out.ok, body: bodyOut });
  } catch (e) { res.json({ ok: false }); }
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
// Un mail créateur qui appartient en réalité à la boîte d'une AUTRE CP surveillée :
// soit le « À » vise une autre boîte (la nôtre n'est qu'en copie), soit le message
// salue une autre CP par son prénom ET sa boîte est aussi destinataire (réponse à
// tous). Utilisé par le copilote ET par l'onglet Messages : même histoire partout.
// Fil qui ne vit QUE dans cette boîte mais dont la conversation est menée par une
// AUTRE CP surveillée (« Hello Rozenn » dans la boîte d'Amena, sans rozenn@ en
// destinataire) : renvoie cette CP. La carte lui est attribuée, l'envoi technique
// reste sur la boîte d'origine pour ne pas casser le fil.
function greetedOtherCp(email, m) {
  try {
    const me = String(email || "").toLowerCase();
    const g = nrmName(String(m.snippet || "").slice(0, 90)).match(/^(?:re\s*:?\s*)?(?:hello|bonjour|coucou|salut|hey|hi)[\s,!:]*([a-z-]{2,20})/);
    if (!g || g[1] === nrmName(copilotCpName(me))) return null;
    const u = USERS.find((x) => nrmName(x.name) === g[1]);
    return (u && (COPILOT.cps || []).includes(String(u.email || "").toLowerCase())) ? u : null;
  } catch (e) { return null; }
}
function isOtherCpMail(email, m) {
  try {
    const me = String(email || "").toLowerCase();
    const toL = String(m.to || "").toLowerCase();
    const tocc = toL + " " + String(m.cc || "").toLowerCase();
    const notToMe = toL && !toL.includes(me);
    const toOther = (COPILOT.cps || []).some((e2) => e2 !== me && toL.includes(e2));
    const g = nrmName(String(m.snippet || "").slice(0, 90)).match(/^(?:re\s*:?\s*)?(?:hello|bonjour|coucou|salut|hey|hi)[\s,!:]*([a-z-]{2,20})/);
    const greeted = g && g[1] !== nrmName(copilotCpName(me)) ? USERS.find((u) => nrmName(u.name) === g[1]) : null;
    const gb = greeted ? String(greeted.email || "").toLowerCase() : "";
    const hersToo = !!(gb && (COPILOT.cps || []).includes(gb) && tocc.includes(gb));
    return (notToMe && toOther) || hersToo;
  } catch (e) { return false; }
}
const COPILOT = {
  enabled: process.env.COPILOT_ENABLED === "1" && !!process.env.COPILOT_MAKE_WEBHOOK && !!process.env.COPILOT_SECRET,
  webhook: process.env.COPILOT_MAKE_WEBHOOK || "",
  secret: process.env.COPILOT_SECRET || "",
  cps: String(process.env.COPILOT_CPS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  slackIds: (() => { try { return JSON.parse(process.env.COPILOT_SLACK_IDS || "{}"); } catch (e) { return {}; } })(),
  publicUrl: (process.env.PUBLIC_URL || "https://hyped-cockpit.onrender.com").replace(/\/$/, ""),
  includeTeam: process.env.COPILOT_INCLUDE_TEAM === "1", // notifier aussi les mails internes @hyped-agency.fr
  // Ex-collègues parties de l'agence : plus personne ne gère leurs fils. Quand un de leurs mails
  // (avec une CP en copie) implique un contact externe, la CP en copie reprend le lead.
  departed: String(process.env.COPILOT_DEPARTED || "kendia@hyped-agency.fr").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
};
function saveCopilot(o) { try { fs.writeFileSync(COPILOT_STORE, JSON.stringify(o)); } catch (e) { try { console.error("[copilot] ECRITURE copilot.json ECHOUEE :", e.message); } catch (e2) {} } }
// Nettoyage à la lecture : les propositions « interne » liées à une marque ou vieilles de 12 h
// sont classées d'office (ceinture et bretelles, en plus du balayage périodique).
function loadCopilot() {
  let store; try { store = JSON.parse(fs.readFileSync(COPILOT_STORE, "utf8")); } catch (e) { return { proposals: [] }; }
  let purged = 0;
  // Régénération one-shot : les décisions créées AVANT le dernier correctif du classifieur
  // (transcript tronqué par la fin -> l'IA jugeait sur de vieux messages et inversait le sens,
  // ex. « Keylanne veut décliner » alors qu'elle écrivait « je suis partante ») sont supprimées
  // pour être réanalysées proprement avec le prompt corrigé.
  // (13:55 : re-bump après l'ajout des règles « sens des échanges » et « étapes d'une collab » :
  // les réponses qui inversaient les rôles, ex. « j'ai bien reçu le contrat », sont réécrites.)
  const FIX_ETIQUETAGE = Date.parse("2026-07-06T13:55:00+02:00");
  // Les « internes » créés avant le scan To/Cc sont repassés au filtre : un mail de collègue
  // adressé à une externe (collègue qui gère, on est juste en copie) ne doit RIEN proposer.
  const FIX_INTERNE = Date.parse("2026-07-06T13:05:00+02:00");
  const avant = (store.proposals || []).length;
  store.proposals = (store.proposals || []).filter((p) => {
    if (p.status !== "pending") return true;
    if (p.categorie === "interne") return (p.at || 0) >= FIX_INTERNE;
    return (p.at || 0) >= FIX_ETIQUETAGE;
  });
  purged += avant - store.proposals.length;
  for (const p of store.proposals || []) {
    if ((p.status === "pending" || p.status === "ready") && p.categorie === "interne" && (p.brand || (Date.now() - (p.at || 0)) > 12 * 3600 * 1000)) {
      p.status = "handled"; p.decidedAt = Date.now(); purged++;
    }
  }
  if (purged) { try { console.log("[copilot] purge lecture :", purged, "proposition(s) interne(s) périmée(s) classée(s)"); } catch (e) {} saveCopilot(store); }
  return store;
}
function copilotSign(id, action) { return crypto.createHmac("sha256", COPILOT.secret).update(id + "|" + action).digest("hex").slice(0, 32); }
function copilotLink(id, action) { return COPILOT.publicUrl + "/copilot/act?id=" + encodeURIComponent(id) + "&action=" + action + "&sig=" + copilotSign(id, action); }
function copilotCpName(email) { const u = USERS.find((x) => String(x.email).toLowerCase() === email); return u ? u.name : email.split("@")[0]; }
function mailAddr(from) { const m = String(from || "").match(/<([^>]+)>/); return m ? m[1].trim() : (String(from || "").includes("@") ? String(from).trim() : ""); }
// Nom affiché de l'expéditeur, tiré de l'en-tête From (« Julie Dupont <julie@x.com> » -> « Julie Dupont »).
// Sert quand le nom ne matche aucun créateur des calendriers : fini l'« expéditeur inconnu » sec.
function fromLabelOf(from) { const n = String(from || "").replace(/<[^>]*>/g, "").replace(/["']/g, "").trim(); return n || mailAddr(from); }
async function copilotNotify(payload) {
  // Trajet direct cockpit -> Slack (0 crédit Make) si SLACK_BOT_TOKEN est configuré ; sinon via le webhook Make.
  const botToken = process.env.SLACK_BOT_TOKEN || "";
  if (botToken) {
    try {
      const r = await fetch("https://slack.com/api/chat.postMessage", {
        method: "POST",
        headers: { "content-type": "application/json; charset=utf-8", "authorization": "Bearer " + botToken },
        // unfurl:false = pas d'aperçu de lien : Slack ne "visite" pas nos liens d'action
        body: JSON.stringify({ channel: payload.slackUser, text: payload.text, unfurl_links: false, unfurl_media: false }),
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
    "RÈGLES ABSOLUES : dans le fil, les messages marqués 'NOUS (agence…)' viennent de NOTRE équipe (Rozenn, Kendia, Amena… sont des collègues, JAMAIS des créateurs). La question porte UNIQUEMENT sur ce que demande le CRÉATEUR.",
    "N'invente JAMAIS un montant, une quantité ou une contre-proposition : reprends EXACTEMENT les chiffres et termes écrits dans le fil, en attribuant chaque proposition à la bonne personne. Si les chiffres sont ambigus, pose la question sans chiffres ('X propose un tarif, tu veux regarder ?').",
    "LE DERNIER MESSAGE FAIT FOI : ton résumé et ta question portent sur le message le plus récent du créateur (marqué 'DERNIER MESSAGE' en bas du fil). Les messages plus anciens ne sont que du contexte : si le créateur a changé d'avis entre-temps, c'est sa DERNIÈRE position qui compte.",
    "NE DÉFORME JAMAIS LE SENS : accepter n'est pas refuser. Dans resume, cite entre guillemets une phrase clé du dernier message du créateur (ses mots exacts, courts) pour que la CP puisse vérifier d'un coup d'œil.",
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
    "Ton : chaleureux, direct, professionnel, tutoiement. Court (2 à 6 phrases). Un emoji léger max.",
    "LANGUE : réponds TOUJOURS dans la langue du dernier message reçu (anglais si le mail est en anglais, français sinon).",
    "Réponds VRAIMENT au contenu du message : réponds aux questions posées, confirme ce qui doit l'être, dis clairement si quelque chose sera fait.",
    "Ne signe que par le prénom : " + (cp || "") + ". Jamais de tiret quadratin.",
  ].join("\n");
  const ctx = "Sujet : " + (subject || "") + "\n\n" + (transcript ? ("Fil :\n" + String(transcript).slice(0, 5000) + "\n\n") : "") + "Dernier message reçu :\n\"\"\"\n" + String(received || "").slice(0, 3000) + "\n\"\"\"\n\nRédige la réponse.";
  return hasOpenAI ? callOpenAI(sys, ctx) : callAnthropic(sys, ctx);
}
function copilotSlackText(p) {
  // Identité de l'expéditeur : nom matché dans les calendriers, sinon nom de l'en-tête From,
  // et l'adresse mail en plus quand le nom n'est pas un créateur connu (on sait QUI parle).
  const who = p.creator || p.fromLabel || "un créateur";
  const whoFull = who + (!p.creator && p.to ? (" · " + p.to) : "");
  const brand = p.brand ? (" · " + p.brand) : "";
  if (p.categorie === "interne") {
    return "📨 Interne · *" + (p.creator || p.to || "quelqu'un de l'équipe") + "* → boîte " + p.cpName + " : " + (p.subject || "(sans objet)")
      + (p.resume ? ("\n_" + p.resume + "_") : "")
      + (p.reply ? ("\n\n_Réponse proposée :_\n>>> " + String(p.reply).slice(0, 900)) : "")
      + "\n\n" + (p.reply ? ("<" + copilotLink(p.id, "send") + "|📤 Envoyer>  ·  ") : "") + "<" + copilotLink(p.id, "self") + "|✍️ Je gère dans le cockpit>  ·  <" + copilotLink(p.id, "seen") + "|👁️ Vu, rien à répondre>";
  }
  if (p.status === "ready") {
    return "*Étape 2/2 · Relis et envoie* ✍️ (réponse à *" + who + "*" + brand + ", rédigée selon " + (p.decision === "accept" ? "ta décision : oui ✅" : p.decision === "refuse" ? "ta décision : non ❌" : "ta consigne ✍️") + ")\n\n>>> " + String(p.reply || "").slice(0, 900)
      + "\n\n<" + copilotLink(p.id, "send") + "|📤 Envoyer>  ·  <" + copilotLink(p.id, "self") + "|✍️ Je gère dans le cockpit>  ·  <" + copilotLink(p.id, "seen") + "|👁️ Vu, rien à répondre>";
  }
  if (p.categorie === "decision") {
    return "*Étape 1/2 · Décision* 🔔 *" + (p.question || p.resume) + "*\n_(" + whoFull + brand + " · boîte " + p.cpName + ")_\n\n"
      + "<" + copilotLink(p.id, "accept") + "|✅ Oui>  ·  <" + copilotLink(p.id, "refuse") + "|❌ Non>  ·  <" + copilotLink(p.id, "directive") + "|💬 Je te dis quoi répondre>  ·  <" + copilotLink(p.id, "self") + "|✍️ Je gère moi-même>"
      + "\n\n_Comment ça marche : rien ne part tout seul, tu relis toujours le mail avant l'envoi._"
      + "\n_• ✅ Oui ou ❌ Non : je rédige un mail qui répond oui (ou non) à la question ci-dessus._"
      + "\n_• 💬 Je te dis quoi répondre : tu m'écris ta réponse avec tes mots (ex. « propose 500 € max »), j'en fais un mail propre._"
      + "\n_• ✍️ Je gère moi-même : je ne fais rien, tu réponds toi-même._"
      + "\n_• <" + copilotLink(p.id, "seen") + "|👁️ Vu, rien à répondre> : je classe le mail, rien ne part._";
  }
  return "✉️ *" + who + "*" + brand + " : " + (p.resume || p.subject || "nouveau message") + "\n\n_Réponse prête (voix Hyped) :_\n>>> " + String(p.reply || "(IA indisponible, ouvre le cockpit)").slice(0, 900)
    + "\n\n<" + copilotLink(p.id, "send") + "|📤 Envoyer>  ·  <" + copilotLink(p.id, "self") + "|✍️ Je gère dans le cockpit>  ·  <" + copilotLink(p.id, "seen") + "|👁️ Vu, rien à répondre>";
}
// Suivi de pipeline dans les fils : le copilote capte si le créateur a dit oui, si un budget
// est acté, et n'ajoute la collab au calendrier QUE quand une date de publication est clairement
// actée par les deux parties. Jamais de date devinée, une seule entrée par fil.
async function copilotPipeline({ creator, brand, transcript }) {
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return null;
  const sys = [
    "Tu suis l'avancement d'une négociation entre une agence d'influence et un créateur. Réponds UNIQUEMENT un JSON valide :",
    '{"accord":"oui"|"non"|"en_cours","budget":"...","date_publication":"YYYY-MM-DD ou null","date_preview":"YYYY-MM-DD ou null","livrables":"..."}',
    "accord = \"oui\" seulement si le CRÉATEUR a clairement accepté la collaboration dans le fil.",
    "budget = le montant ACTÉ par les DEUX parties (ex. « 300€ »), « gifting » si envoi produits sans rémunération acté, chaîne vide si rien d'acté. N'invente JAMAIS un montant.",
    "date_publication / date_preview = UNIQUEMENT si une date précise a été proposée ET acceptée dans le fil. Sinon null. Une date seulement évoquée ou proposée sans réponse = null. Année en cours : 2026.",
    "livrables = ce qui est convenu (ex. « 1 Reel + 2 stories »), chaîne vide sinon.",
  ].join("\n");
  const ctx = "Marque : " + (brand || "?") + "\nCréateur : " + (creator || "?") + "\n\nFil :\n" + String(transcript || "").slice(0, 6000);
  try {
    const out = hasOpenAI ? await callOpenAI(sys, ctx) : await callAnthropic(sys, ctx);
    if (!out.ok) return null;
    return JSON.parse(String(out.body).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
  } catch (e) { return null; }
}
// --- Notifications Slack groupées : fini le ping à chaque mail ---------------
// Les nouveaux mails sont mis en file et partent en UN récap par heure et par CP
// (un mail isolé après une accalmie part tout de suite ; les rafales sont groupées).
// Les confirmations d'action (C'est fait, réponse à relire après une décision) restent immédiates.
const DIGEST_EVERY_MS = 60 * 60 * 1000;
function queueNotif(store, email, id) {
  store.notifQueue = store.notifQueue || {};
  (store.notifQueue[email] = store.notifQueue[email] || []).push(id);
}
function digestLine(p) {
  const who = p.creator || p.fromLabel || p.to || "expéditeur inconnu";
  const brand = p.brand ? (" · " + p.brand) : "";
  if (p.categorie === "decision" && p.status === "pending")
    return "• 🔔 *" + who + "*" + brand + " : " + String(p.question || p.resume || "").slice(0, 150)
      + "\n    <" + copilotLink(p.id, "accept") + "|✅ Oui> · <" + copilotLink(p.id, "refuse") + "|❌ Non> · <" + copilotLink(p.id, "directive") + "|💬 Consigne> · <" + copilotLink(p.id, "self") + "|✍️ Je gère> · <" + copilotLink(p.id, "seen") + "|👁️ Vu>";
  return "• ✉️ *" + who + "*" + brand + " : réponse prête à relire" + (p.resume ? (" — " + String(p.resume).slice(0, 110)) : "")
    + "\n    " + (p.reply ? ("<" + copilotLink(p.id, "send") + "|📤 Envoyer> · ") : "") + "<" + copilotLink(p.id, "self") + "|✍️ Je gère> · <" + copilotLink(p.id, "seen") + "|👁️ Vu>";
}
async function flushNotifDigests(store) {
  store.notifQueue = store.notifQueue || {}; store.lastDigest = store.lastDigest || {};
  for (const email of Object.keys(store.notifQueue)) {
    const ids = store.notifQueue[email] || [];
    if (!ids.length) continue;
    if (Date.now() - (store.lastDigest[email] || 0) < DIGEST_EVERY_MS) continue; // prochain récap à l'heure pleine
    const slackUser = COPILOT.slackIds[email] || "";
    if (!slackUser) { store.notifQueue[email] = []; continue; }
    const ps = ids.map((id) => (store.proposals || []).find((x) => x.id === id)).filter((p) => p && (p.status === "pending" || p.status === "ready"));
    store.notifQueue[email] = []; store.lastDigest[email] = Date.now();
    if (!ps.length) continue;
    if (ps.length === 1) { await copilotNotify({ slackUser, text: "<@" + slackUser + "> " + copilotSlackText(ps[0]) }); continue; }
    const MAX = 12;
    const text = "<@" + slackUser + "> 🤖 *Copilote · " + ps.length + " nouveaux mails*  _(récap groupé, 1 message par heure max ; tout est aussi dans le cockpit)_\n\n"
      + ps.slice(0, MAX).map(digestLine).join("\n")
      + (ps.length > MAX ? ("\n… et " + (ps.length - MAX) + " autres dans le cockpit (onglet Messages).") : "");
    await copilotNotify({ slackUser, text });
  }
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
          // Purge des fausses décisions « interne » créées sur des fils de collab (bug corrigé) : on classe sans bruit.
          // Et une question interne qui attend plus de 12 h est périmée de toute façon : on classe aussi.
          if (w.categorie === "interne" && (w.brand || (Date.now() - w.at) > 12 * 3600 * 1000)) { w.status = "handled"; w.decidedAt = Date.now(); continue; }
          // Cartes créées par erreur sur des notifications automatiques (Notion...) : on les classe
          if (/@mail\.notion\.so|no-?reply|notifications?@|calendar-notification|@slack\.com/.test(String(w.to || "").toLowerCase())) { w.status = "handled"; w.decidedAt = Date.now(); continue; }
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
        if (!m.threadId) continue;
        // Robots (Notion, no-reply, agendas, Slack...) : on ne répond JAMAIS à une notification automatique
        const fromL = String(m.from || "").toLowerCase();
        if (/@mail\.notion\.so|no-?reply|notifications?@|mailer-daemon|calendar-notification|@docs\.google\.com|@slack\.com|drive-shares/.test(fromL)) {
          const dupN = store.proposals.find((x) => x.cpEmail === email && x.threadId === m.threadId && (x.status === "pending" || x.status === "ready" || x.status === "proposed"));
          if (dupN) { dupN.status = "handled"; dupN.decision = "notification automatique : rien à répondre"; }
          continue;
        }
        // Réaction emoji Gmail (« X a réagi depuis Gmail ») : pas un vrai message, rien à répondre
        if (/a r[ée]agi depuis gmail|reacted (to|with)/i.test(String(m.snippet || ""))) continue;
        // Doublon de boîte (voir isOtherCpMail) : la conversation appartient à une autre CP.
        if (isOtherCpMail(email, m)) {
          const dup = store.proposals.find((x) => x.cpEmail === email && x.threadId === m.threadId && (x.status === "pending" || x.status === "ready"));
          if (dup) { dup.status = "handled"; dup.decision = "doublon de boîte : conversation d'une autre CP"; }
          continue;
        }
        // Fil mené par une autre CP mais vivant UNIQUEMENT dans cette boîte : la carte
        // est attribuée à la vraie interlocutrice (vue, Slack, signature), l'envoi
        // technique restant sur cette boîte. On migre aussi les cartes déjà en attente.
        const gCp = greetedOtherCp(email, m);
        if (gCp) {
          const old = store.proposals.find((x) => x.cpEmail === email && x.threadId === m.threadId && (x.status === "pending" || x.status === "ready"));
          if (old && !old.handlerEmail) { old.cpName = gCp.name; old.handlerEmail = String(gCp.email).toLowerCase(); old.via = copilotCpName(email); }
        }
        // Fil déjà traité : on ne l'ignore QUE si rien de nouveau depuis. Si le créateur a écrit
        // APRÈS le traitement, le fil redevient à traiter (sinon ses relances passaient aux oubliettes).
        const tr = tt[m.threadId];
        if (tr) {
          const md = m.date ? new Date(m.date).getTime() : 0;
          if (!md || md <= (tr.at || 0)) continue; // rien de nouveau depuis le traitement
          unmarkTreated(email, m.threadId); delete tt[m.threadId];
        }
        if (seen.has(email + "|" + (m.id || m.threadId))) continue; // déjà proposé
        let transcript = "", lastText = "";
        try { const full = await gm.fetchThreadText(email, m.threadId); if (full && full.ok) { transcript = full.transcript || full.text || ""; lastText = full.text || ""; } } catch (e) {}
        const creator = m["créateur"] || "";
        const cls = await copilotClassify({ creator, subject: m.subject, received: m.snippet, transcript });
        const rep = await claudeReply({ cp: (gCp ? gCp.name : copilotCpName(email)), creator, brand: m.brand, category: m.category, received: m.snippet, subject: m.subject, transcript, planning: planningForBrand(collabs, m.brand), brandNotes: brandNotesFor(m.brand), brandInfo: brandInfoFor(m.brand), profileNote: await profileNoteFor(creator) });
        const p = {
          id: crypto.randomBytes(8).toString("hex"),
          cpEmail: email, cpName: (gCp ? gCp.name : copilotCpName(email)),
          handlerEmail: (gCp ? String(gCp.email).toLowerCase() : undefined), via: (gCp ? copilotCpName(email) : undefined),
          msgId: m.id || m.threadId, threadId: m.threadId,
          to: mailAddr(m.from), creator, fromLabel: fromLabelOf(m.from), brand: m.brand || "", subject: m.subject || "",
          lastMsg: String(lastText || m.snippet || "").slice(0, 1500), // le VRAI dernier message du créateur, affiché sur la carte
          categorie: cls.categorie, resume: cls.resume, question: cls.question,
          reply: rep && rep.ok ? rep.body : "",
          status: "pending", at: Date.now(),
        };
        store.proposals.push(p);
        seen.add(email + "|" + p.msgId);
        const slackUser = COPILOT.slackIds[(gCp ? String(gCp.email).toLowerCase() : email)] || COPILOT.slackIds[email] || "";
        queueNotif(store, (gCp ? String(gCp.email).toLowerCase() : email), p.id); // notification groupée, à la vraie interlocutrice
        // Pipeline : entrée au calendrier UNIQUEMENT quand une date de publication est actée dans le fil
        try {
          store.calAdded = store.calAdded || {};
          if (m.brand && !store.calAdded[m.threadId] && notion && !DEMO) {
            const pl = await copilotPipeline({ creator, brand: m.brand, transcript });
            // Garde-fous : un NOM identifiable, et des dates dans le FUTUR (une « date actée »
            // extraite dans le passé = mauvaise lecture du fil, on n'écrit rien).
            const nomCal = String(creator || fromLabelOf(m.from) || "").trim();
            const today0 = new Date().toISOString().slice(0, 10);
            if (pl && pl.accord === "oui" && nomCal && pl.date_publication && /^\d{4}-\d{2}-\d{2}$/.test(String(pl.date_publication)) && String(pl.date_publication) >= today0) {
              if (m.brand === "In Haircare") {
                const props = { "Nom": { title: [{ text: { content: nomCal } }] }, "Statut": { select: { name: "Non posté" } }, "Date": { date: { start: pl.date_publication } } };
                if (pl.date_preview && /^\d{4}-\d{2}-\d{2}$/.test(String(pl.date_preview)) && String(pl.date_preview) >= today0) props["Date preview"] = { date: { start: pl.date_preview } };
                const bnum = parseFloat(String(pl.budget || "").replace(/[^\d.,]/g, "").replace(",", "."));
                if (bnum) props["Budget"] = { number: bnum };
                const uid = await userIdByName(copilotCpName(email));
                if (uid) props["Interlocuteur"] = { people: [{ id: uid }] };
                const pg = await notion.pages.create({ parent: { database_id: INHAIRCARE_DB }, properties: props });
                store.calAdded[m.threadId] = pg.id; CACHE.at = 0;
                if (slackUser) await copilotNotify({ slackUser, text: "📅 Collab ajoutée au calendrier In Haircare : *" + nomCal + "* · publication le " + pl.date_publication + (props["Date preview"] ? (" · preview le " + pl.date_preview) : "") + (pl.budget ? (" · " + pl.budget) : "") + (pl.livrables ? (" · " + pl.livrables) : "") + "\n<" + copilotLink(pg.id, "fixcal") + "|✏️ Corriger la fiche> (date, preview, budget, nom : écris ce qui change, j'applique · « supprime la fiche » pour la retirer)." });
              } else {
                store.calAdded[m.threadId] = "manuel";
                if (slackUser) await copilotNotify({ slackUser, text: "📅 Dates actées avec *" + nomCal + "* (" + m.brand + ") : publication le " + pl.date_publication + (pl.budget ? (" · " + pl.budget) : "") + ". Ajoute la collab au calendrier " + m.brand + " dans Notion (je n'écris que dans le calendrier In Haircare pour l'instant)." });
              }
            }
          }
        } catch (e) { try { console.error("[copilot] pipeline :", e.message); } catch (e2) {} }
      }
      // Mails internes (si COPILOT_INCLUDE_TEAM=1) : on voit tout, on peut répondre en un clic
      if (COPILOT.includeTeam) {
        for (const m of (r && r.teamMails) || []) {
          if (!m.threadId) continue;
          const tr2 = tt[m.threadId];
          if (tr2) {
            const md2 = m.date ? new Date(m.date).getTime() : 0;
            if (!md2 || md2 <= (tr2.at || 0)) continue;
            unmarkTreated(email, m.threadId); delete tt[m.threadId];
          }
          if (seen.has(email + "|" + (m.id || m.threadId))) continue;
          const fromAddr = mailAddr(m.from);
          if (fromAddr.toLowerCase() === email) continue; // ses propres mails, non merci
          let ext = null; try { ext = await gm.threadExternalContact(email, m.threadId); } catch (e) {}
          // Ex-collègue PARTIE (ex. Kendia) : plus personne ne gère ses fils. Si le fil implique
          // un contact externe, la CP en copie reprend le lead : proposition adressée au contact
          // EXTERNE (jamais à l'ex-collègue), avec le circuit décision habituel.
          if (COPILOT.departed.includes(fromAddr.toLowerCase()) && ext) {
            let transcript = "", lastText2 = "";
            try { const full = await gm.fetchThreadText(email, m.threadId); if (full && full.ok) { transcript = full.transcript || full.text || ""; lastText2 = full.text || ""; } } catch (e) {}
            const creator = ext.name || ext.addr;
            const cls = await copilotClassify({ creator, subject: m.subject, received: m.snippet, transcript });
            const rep = await claudeReply({ cp: copilotCpName(email), creator, brand: m.brand, category: "réponse", received: m.snippet, subject: m.subject, transcript, planning: planningForBrand(collabs, m.brand), brandNotes: brandNotesFor(m.brand), brandInfo: brandInfoFor(m.brand), profileNote: await profileNoteFor(creator) });
            const p = {
              id: crypto.randomBytes(8).toString("hex"),
              cpEmail: email, cpName: copilotCpName(email),
              msgId: m.id || m.threadId, threadId: m.threadId,
              to: ext.addr, creator, fromLabel: creator, brand: m.brand || "", subject: m.subject || "",
              lastMsg: String(lastText2 || m.snippet || "").slice(0, 1500),
              categorie: cls.categorie, resume: "🔁 Reprise du fil de " + (fromLabelOf(m.from) || "une ex-collègue") + " (plus dans l'agence) · " + (cls.resume || ""), question: cls.question,
              reply: rep && rep.ok ? rep.body : "",
              status: "pending", at: Date.now(),
            };
            store.proposals.push(p);
            seen.add(email + "|" + p.msgId);
            queueNotif(store, email, p.id);
            continue;
          }
          // Fil de COLLAB (marque détectée) écrit par une collègue : c'est ELLE qui gère le créateur,
          // il n'y a rien à lui répondre. Sans ce garde-fou, l'IA proposait de répondre à sa collègue
          // sur ses propres mails sortants (mails en copie) : absurde.
          if (m.brand) continue;
          // Même règle si le fil implique un participant EXTERNE (créateur/marque hors calendriers) :
          // ce n'est pas une conversation interne, la collègue gère.
          if (ext) continue;
          let transcript = "";
          try { const full = await gm.fetchThreadText(email, m.threadId); if (full && full.ok) transcript = full.transcript || full.text || ""; } catch (e) {}
          const fromName = String(m.from || "").replace(/<[^>]*>/, "").trim() || fromAddr;
          const rep = await copilotInternalReply({ cp: copilotCpName(email), fromName, subject: m.subject, received: m.snippet, transcript });
          const p = {
            id: crypto.randomBytes(8).toString("hex"),
            cpEmail: email, cpName: copilotCpName(email),
            msgId: m.id || m.threadId, threadId: m.threadId,
            to: fromAddr, creator: fromName, fromLabel: fromName, brand: m.brand || "", subject: m.subject || "",
            categorie: "interne", resume: String(m.snippet || "").slice(0, 200), question: "",
            reply: rep && rep.ok ? rep.body : "",
            status: "pending", at: Date.now(),
          };
          store.proposals.push(p);
          seen.add(email + "|" + p.msgId);
          queueNotif(store, email, p.id);
        }
      }
    }
    try { await flushNotifDigests(store); } catch (e) { try { console.error("[copilot] digest :", e.message); } catch (e2) {} }
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
// Vérification de signature partagée (timing-safe)
function copilotActOk(req) {
  const { id, action, sig } = req.query || {};
  try {
    const expected = Buffer.from(copilotSign(String(id || ""), String(action || "")));
    const given = Buffer.from(String(sig || ""));
    return !!(id && action && sig && COPILOT.secret) && given.length === expected.length && crypto.timingSafeEqual(given, expected);
  } catch (e) { return false; }
}
// GET = AUCUN effet. Slack (et d'autres services) "visitent" les liens pour les prévisualiser,
// et cette simple visite déclenchait l'action : un mail est parti tout seul. Désormais le lien
// ouvre une page neutre qui exécute l'action via le navigateur (POST en JS) : un robot ne
// clique pas et n'exécute pas de JS, donc plus jamais d'action fantôme.
app.get("/copilot/act", (req, res) => {
  const { id, action, sig } = req.query || {};
  if (!copilotActOk(req)) return res.status(403).send(copilotPage("Lien invalide 🤔", "Ce lien n'est pas valide ou a été modifié. Repasse par le message Slack."));
  // ✏️ Correction d'une fiche calendrier (id = page Notion, pas une proposition)
  if (action === "fixcal") {
    const qf = "id=" + encodeURIComponent(String(id)) + "&action=fixcal&sig=" + encodeURIComponent(String(sig));
    const form = "<form method=\"POST\" action=\"/copilot/act/do?" + qf + "\" style=\"margin-top:14px;text-align:left\">"
      + "<textarea name=\"text\" required rows=\"3\" placeholder=\"Ex. publication le 18 juillet, budget 250 €, preview le 12 juillet\" style=\"width:100%;box-sizing:border-box;font-family:inherit;font-size:14px;padding:10px 12px;border:1px solid #E4E0D5;border-radius:10px\"></textarea>"
      + "<button type=\"submit\" style=\"margin-top:10px;font-family:inherit;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px;border:none;background:#2C9087;color:#fff;cursor:pointer\">Corriger la fiche ✏️</button></form>";
    return res.send(copilotPage("Corriger la fiche 📅", "Écris ce qui change avec tes mots : date de publication, date de preview, budget, ou nom. J'applique directement sur la fiche du calendrier.").replace("</div></body>", form + "</div></body>"));
  }
  const store = loadCopilot();
  const p = (store.proposals || []).find((x) => x.id === id);
  if (!p) return res.status(404).send(copilotPage("Introuvable", "Cette proposition n'existe plus (elle a peut-être expiré)."));
  if (p.status === "sent") return res.send(copilotPage("C'est fait ! ✅", "La réponse à " + (p.creator || "ce créateur") + " est bien partie. Rien n'a été envoyé en double, tout est ok. Tu peux fermer cette page."));
  if (p.status === "handled") return res.send(copilotPage("Déjà traité ✅", "Ce mail a déjà été géré (réponse envoyée directement depuis Gmail, ou traité dans le cockpit). Rien n'a été envoyé en double, rien à faire."));
  if (p.status === "self" && action !== "send") return res.send(copilotPage("C'est toi qui gères ✍️", "Ce mail t'attend dans le cockpit, onglet Messages."));
  const q = "id=" + encodeURIComponent(String(id)) + "&action=" + encodeURIComponent(String(action)) + "&sig=" + encodeURIComponent(String(sig));
  if (action === "directive") {
    // Page avec champ texte : la CP écrit sa consigne, l'IA rédige dans ce sens
    const form = "<form method=\"POST\" action=\"/copilot/act/do?" + q + "\" style=\"margin-top:14px;text-align:left\">"
      + "<textarea name=\"text\" required rows=\"4\" placeholder=\"Ex. propose 500 € pour 1 Reel + 2 stories, livraison avant le 20 juillet\" style=\"width:100%;box-sizing:border-box;font-family:inherit;font-size:14px;padding:10px 12px;border:1px solid #E4E0D5;border-radius:10px\"></textarea>"
      + "<button type=\"submit\" style=\"margin-top:10px;font-family:inherit;font-size:14px;font-weight:600;padding:10px 18px;border-radius:10px;border:none;background:#2C9087;color:#fff;cursor:pointer\">Générer la réponse ✍️</button></form>";
    return res.send(copilotPage("Dis-moi quoi répondre 💬", "Écris ta réponse pour " + (p.creator || p.fromLabel || "ce contact") + " avec tes mots (ex. « propose 500 € max », « demande-lui ses stats »). J'en fais un mail propre et je te l'envoie à relire avant tout envoi.").replace("</div></body>", form + "</div></body>"));
  }
  const runner = "<script>fetch('/copilot/act/do?" + q + "',{method:'POST'}).then(r=>r.text()).then(h=>{document.open();document.write(h);document.close();}).catch(()=>{var d=document.querySelector('p');if(d)d.textContent='Petit souci réseau, recharge cette page pour réessayer.';});</script>"
    + "<noscript><form method=\"POST\" action=\"/copilot/act/do?" + q + "\" style=\"text-align:center;margin-top:14px\"><button style=\"font-family:inherit;font-size:14px;padding:10px 18px;border-radius:10px;border:1px solid #E4E0D5;background:#2C9087;color:#fff;cursor:pointer\">Continuer</button></form></noscript>";
  return res.send(copilotPage("Un instant ⏳", "J'exécute ton choix, la confirmation arrive dans une seconde.").replace("</body>", runner + "</body>"));
});
// Exécution d'une action copilote. Partagée entre les liens Slack (/copilot/act/do)
// et les boutons du cockpit (/api/copilot/act). Renvoie { code, title, msg }.
// Convertit une correction en langage naturel (« publication le 18 juillet, 250€ »)
// en champs de fiche calendrier. N'extrait QUE ce qui est explicitement demandé.
async function calFixParse(texte) {
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return null;
  const sys = 'Tu convertis une correction de fiche de collab en JSON. Réponds UNIQUEMENT :\n{"date_publication":"YYYY-MM-DD ou null","date_preview":"YYYY-MM-DD ou null","budget":"montant ou chaîne vide","nom":"nouveau nom ou chaîne vide","supprimer":true|false}\nsupprimer = true UNIQUEMENT si la correction demande explicitement de supprimer / retirer / annuler la fiche ou la collab. Année en cours : 2026. N\'extrais que ce qui est explicitement demandé dans la correction, null ou vide pour le reste. N\'invente rien.';
  try {
    const out = hasOpenAI ? await callOpenAI(sys, String(texte || "")) : await callAnthropic(sys, String(texte || ""));
    if (!out.ok) return null;
    return JSON.parse(String(out.body).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
  } catch (e) { return null; }
}
async function copilotExecute(id, action, text) {
  // ✏️ Correction d'une fiche calendrier depuis Slack (id = page Notion)
  if (action === "fixcal") {
    const consigne = String(text || "").trim().slice(0, 500);
    if (!consigne) return { code: 400, title: "Correction vide ✍️", msg: "Écris ce qui change (ex. « publication le 18 juillet, budget 250 € »)." };
    if (!notion || DEMO) return { code: 400, title: "Indisponible", msg: "Notion n'est pas connecté." };
    const fix = await calFixParse(consigne);
    if (fix && fix.supprimer === true) { // « supprime la fiche » : corbeille Notion (récupérable)
      try { await notion.pages.update({ page_id: String(id), archived: true }); CACHE.at = 0; }
      catch (e) { return { code: 500, title: "Échec 😖", msg: "Notion n'a pas voulu : " + String((e && e.message) || e).slice(0, 120) + ". Supprime directement dans Notion." }; }
      return { code: 200, title: "Fiche supprimée 🗑", msg: "La fiche est dans la corbeille Notion (récupérable pendant 30 jours si besoin)." };
    }
    const okDate = (d) => d && /^\d{4}-\d{2}-\d{2}$/.test(String(d));
    const props = {};
    if (fix && okDate(fix.date_publication)) props["Date"] = { date: { start: fix.date_publication } };
    if (fix && okDate(fix.date_preview)) props["Date preview"] = { date: { start: fix.date_preview } };
    const bnum = fix ? parseFloat(String(fix.budget || "").replace(/[^\d.,]/g, "").replace(",", ".")) : 0;
    if (bnum) props["Budget"] = { number: bnum };
    if (fix && String(fix.nom || "").trim()) props["Nom"] = { title: [{ text: { content: String(fix.nom).trim().slice(0, 120) } }] };
    if (!Object.keys(props).length) return { code: 200, title: "Pas compris 🤔", msg: "Je n'ai pas su extraire de correction. Réessaie avec une formulation type « publication le 18 juillet, budget 250 € », ou corrige dans le cockpit (onglet Contenus) / Notion." };
    try { await notion.pages.update({ page_id: String(id), properties: props }); CACHE.at = 0; }
    catch (e) { return { code: 500, title: "Échec 😖", msg: "Notion n'a pas voulu : " + String((e && e.message) || e).slice(0, 120) + ". Corrige directement dans Notion." }; }
    const applied = [props["Date"] ? ("publication " + fix.date_publication) : "", props["Date preview"] ? ("preview " + fix.date_preview) : "", bnum ? ("budget " + bnum + "€") : "", props["Nom"] ? ("nom « " + fix.nom + " »") : ""].filter(Boolean).join(" · ");
    return { code: 200, title: "Fiche corrigée ✅", msg: "Appliqué sur la fiche du calendrier : " + applied + "." };
  }
  const store = loadCopilot(); store.proposals = store.proposals || [];
  const p = store.proposals.find((x) => x.id === id);
  if (!p) return { code: 404, title: "Introuvable", msg: "Cette proposition n'existe plus (elle a peut-être expiré)." };
  if (p.status === "sent") return { code: 200, title: "C'est fait ! ✅", msg: "La réponse à " + (p.creator || "ce créateur") + " est bien partie. Rien n'a été envoyé en double, tout est ok." };
  if (p.status === "handled") return { code: 200, title: "Déjà traité ✅", msg: "Ce mail a déjà été géré (réponse envoyée directement depuis Gmail, ou traité dans le cockpit). Rien n'a été envoyé en double, rien à faire." };
  if (p.status === "self" && action !== "send") return { code: 200, title: "C'est toi qui gères ✍️", msg: "Ce mail t'attend dans le cockpit, onglet Messages." };
  try {
    if (action === "send") {
      if (!p.reply) return { code: 200, title: "Pas de réponse prête", msg: "L'IA n'a pas pu rédiger. Ouvre le cockpit pour répondre." };
      if (!p.to) return { code: 200, title: "Destinataire introuvable", msg: "Impossible d'extraire l'email du créateur. Ouvre le cockpit pour répondre." };
      const r = await gm.sendEmail(p.cpEmail, { to: p.to, subject: p.subject ? (/^re\s*:/i.test(p.subject) ? p.subject : "Re: " + p.subject) : "Re:", body: p.reply });
      if (!r || !r.ok) return { code: 500, title: "Échec de l'envoi 😖", msg: "Gmail n'a pas voulu. Réessaie ou passe par le cockpit." };
      markTreated(p.cpEmail, p.threadId, { by: p.cpName + " (copilote)", action: "répondu" });
      logActivity({ type: "email", creator: p.to, cp: p.cpName });
      p.status = "sent"; p.decidedAt = Date.now(); saveCopilot(store);
      // Confirmation aussi sur Slack : le fil se termine par un vrai "c'est fait", pas par "Étape 2/2"
      try {
        const slackUser = COPILOT.slackIds[p.cpEmail] || "";
        if (slackUser) await copilotNotify({ slackUser, text: "✅ C'est fait ! La réponse à *" + (p.creator || p.to) + "* (" + (p.brand || "sans marque") + ") est partie depuis la boîte de " + p.cpName + ", signature comprise. Mail marqué traité dans le cockpit, rien d'autre à faire." });
      } catch (e) {}
      return { code: 200, title: "C'est fait ! 🎉", msg: "La réponse est partie chez " + (p.creator || p.to) + ", depuis la boîte de " + p.cpName + ", signature comprise. Le mail est marqué traité dans le cockpit." };
    }
    if (action === "rework") {
      // 🪄 La CP dit COMMENT reformuler (« plus court », « moins d'emojis », « propose un appel »...)
      const consigne = String(text || "").trim().slice(0, 1000);
      if (!consigne) return { code: 400, title: "Consigne vide ✍️", msg: "Dis-moi comment reformuler (ex. « plus court et moins d'emojis », « propose plutôt un appel »)." };
      if (!p.reply) return { code: 400, title: "Pas de brouillon", msg: "Il n'y a pas encore de réponse rédigée à reformuler sur ce fil." };
      let transcript2 = "";
      try { const full2 = await gm.fetchThreadText(p.cpEmail, p.threadId); if (full2 && full2.ok) transcript2 = full2.transcript || full2.text || ""; } catch (e) {}
      let planning2 = ""; try { planning2 = planningForBrand(await fetchRows(), p.brand); } catch (e) {}
      const rep2 = await claudeReply({ cp: p.cpName, creator: p.creator, brand: p.brand, category: "réponse", received: p.resume, subject: p.subject, transcript: transcript2, planning: planning2, brandNotes: brandNotesFor(p.brand), brandInfo: brandInfoFor(p.brand), profileNote: await profileNoteFor(p.creator), draft: p.reply, rework: consigne });
      if (!rep2 || !rep2.ok) return { code: 500, title: "IA indisponible 💤", msg: "Impossible de reformuler là tout de suite, réessaie dans un instant." };
      p.reply = rep2.body; p.reworkedAt = Date.now(); saveCopilot(store);
      return { code: 200, title: "Reformulé ✨", msg: "Réponse réécrite selon ta consigne. Relis, redemande une retouche si besoin, et envoie quand c'est bon." };
    }
    if (action === "accept" || action === "refuse" || action === "directive") {
      let directive;
      if (action === "directive") {
        const consigne = String(text || "").trim().slice(0, 1000);
        if (!consigne) return { code: 400, title: "Consigne vide ✍️", msg: "Écris ta consigne (ex. « propose 500 € pour 1 Reel + 2 stories ») puis renvoie." };
        directive = "INSTRUCTION PRÉCISE DE LA CHEFFE DE PROJET (à appliquer à la lettre, elle prime sur tout) : " + consigne;
      } else {
        directive = action === "accept"
          ? "La CP ACCEPTE la demande du créateur (" + (p.resume || p.question) + "). Confirme-lui gentiment que c'est ok."
          : "La CP REFUSE la demande du créateur (" + (p.resume || p.question) + "). Dis-le avec tact, sans fermer la relation, propose une alternative si pertinent.";
      }
      let transcript = "";
      try { const full = await gm.fetchThreadText(p.cpEmail, p.threadId); if (full && full.ok) transcript = full.transcript || full.text || ""; } catch (e) {}
      let planning = ""; try { planning = planningForBrand(await fetchRows(), p.brand); } catch (e) {}
      const rep = await claudeReply({ cp: p.cpName, creator: p.creator, brand: p.brand, category: "réponse", received: p.resume, subject: p.subject, transcript, directive, planning, brandNotes: brandNotesFor(p.brand), brandInfo: brandInfoFor(p.brand), profileNote: await profileNoteFor(p.creator) });
      if (!rep || !rep.ok) return { code: 500, title: "IA indisponible 💤", msg: "Impossible de rédiger là tout de suite. Réponds depuis le cockpit." };
      p.reply = rep.body; p.status = "ready"; p.decision = action; p.decidedAt = Date.now(); saveCopilot(store);
      const slackUser = COPILOT.slackIds[p.cpEmail] || "";
      if (slackUser) await copilotNotify({ slackUser, text: "<@" + slackUser + "> " + copilotSlackText(p) }); // mention = vraie notification
      return { code: 200, title: "C'est noté " + (action === "accept" ? "✅" : action === "refuse" ? "❌" : "✍️"), msg: "L'IA a rédigé la réponse " + (action === "directive" ? "selon ta consigne" : "dans ce sens") + ". Relis-la et envoie-la en un clic (ici ou sur Slack)." };
    }
    if (action === "seen") {
      // « Vu, rien à répondre » : on classe la proposition ET on marque le fil traité dans le
      // cockpit (la carte et la notice sur la ligne du mail disparaissent). Rien n'est envoyé.
      p.status = "handled"; p.decidedAt = Date.now(); saveCopilot(store);
      try { markTreated(p.cpEmail, p.threadId, { by: p.cpName + " (vu, sans réponse)", action: "vu" }); } catch (e) {}
      return { code: 200, title: "Vu 👌", msg: "Mail classé, rien n'a été envoyé. Il ressortira si " + (p.creator || p.fromLabel || "le contact") + " écrit à nouveau." };
    }
    if (action === "self") {
      p.status = "self"; p.decidedAt = Date.now(); saveCopilot(store);
      try {
        const slackUser = COPILOT.slackIds[p.cpEmail] || "";
        if (slackUser) await copilotNotify({ slackUser, text: "✍️ Noté, tu gères toi-même le mail de *" + (p.creator || p.to || "ce contact") + "*. Rien n'a été envoyé, il t'attend dans le cockpit (onglet Messages)." });
      } catch (e) {}
      return { code: 200, title: "C'est toi qui gères ✍️", msg: "Rien n'a été envoyé. Le mail t'attend dans le cockpit, onglet Messages." };
    }
  } catch (e) {
    return { code: 500, title: "Oups", msg: "Une erreur est survenue : " + String(e && e.message || e).slice(0, 120) };
  }
  return { code: 400, title: "Action inconnue", msg: "Ce lien ne correspond à aucune action." };
}
app.post("/copilot/act/do", async (req, res) => {
  const { id, action } = req.query || {};
  if (!copilotActOk(req)) return res.status(403).send(copilotPage("Lien invalide 🤔", "Ce lien n'est pas valide ou a été modifié. Repasse par le message Slack."));
  const out = await copilotExecute(String(id), String(action), req.body && req.body.text);
  res.status(out.code).send(copilotPage(out.title, out.msg + " Tu peux fermer cette page."));
});
// --- Copilote dans le cockpit : mêmes décisions que sur Slack, en un clic -----
app.get("/api/copilot/box", auth, (req, res) => {
  if (!COPILOT.enabled) return res.json({ enabled: false, proposals: [] });
  const t = inboxTarget(req);
  const sup = req.user.role === "supervisor";
  const asked = String(req.query.as || "").trim(); // boîte précise demandée via le filtre
  const store = loadCopilot();
  const list = (store.proposals || [])
    .filter((p) => (p.status === "pending" || p.status === "ready"))
    // superviseure sans filtre : elle voit les décisions de TOUTES les boîtes ; sinon la
    // boîte affichée OU les fils attribués à cette CP (handlerEmail, ex. Rozenn via Amena)
    .filter((p) => ((sup && !asked) ? true : (p.cpEmail === t.email || p.handlerEmail === t.email)))
    .slice(-30).reverse()
    .map((p) => ({ id: p.id, cpName: p.cpName, via: p.via || "", threadId: p.threadId, creator: p.creator, fromLabel: p.fromLabel || "", to: p.to || "", brand: p.brand, subject: p.subject, lastMsg: p.lastMsg || "", categorie: p.categorie, resume: p.resume, question: p.question, reply: p.reply, status: p.status, decision: p.decision, at: p.at }));
  res.json({ enabled: true, proposals: list });
});
// Le fil complet d'une proposition : Rozenn n'a plus à retourner dans Gmail pour
// retrouver le contexte avant de décider.
app.get("/api/copilot/thread", auth, async (req, res) => {
  if (!COPILOT.enabled) return res.status(400).json({ error: "copilote désactivé" });
  const store = loadCopilot();
  const p = (store.proposals || []).find((x) => x.id === String(req.query.id || ""));
  if (!p) return res.status(404).json({ error: "proposition introuvable" });
  if (p.cpEmail !== req.user.email && req.user.role !== "supervisor") return res.status(403).json({ error: "pas ta boîte" });
  try {
    const full = await gm.fetchThreadText(p.cpEmail, p.threadId);
    if (!full || !full.ok) return res.json({ ok: false });
    res.json({ ok: true, transcript: full.transcript || full.text || "" });
  } catch (e) { res.json({ ok: false }); }
});
app.post("/api/copilot/act", auth, async (req, res) => {
  if (!COPILOT.enabled) return res.status(400).json({ error: "copilote désactivé" });
  const { id, action, text } = req.body || {};
  if (!id || !["send", "accept", "refuse", "self", "directive", "seen", "rework"].includes(String(action))) return res.status(400).json({ error: "action inconnue" });
  const store = loadCopilot();
  const p = (store.proposals || []).find((x) => x.id === String(id));
  if (!p) return res.status(404).json({ error: "proposition introuvable" });
  // Chacune agit sur SA boîte ; les superviseures peuvent agir sur toutes
  if (p.cpEmail !== req.user.email && req.user.role !== "supervisor") return res.status(403).json({ error: "pas ta boîte" });
  const out = await copilotExecute(String(id), String(action), text);
  res.status(out.code === 200 ? 200 : out.code).json({ ok: out.code === 200, title: out.title, msg: out.msg });
});
// --- Bibliothèque de process : tous les documents de référence dans le cockpit ---
// Documents intégrés (guide, fiches de passation, storytelling, modèle shortlist)
// + documents déposés par l'équipe, stockés sur le DISQUE PERSISTANT (jamais sur GitHub).
const PROCESS_DIR = path.join(DATA_DIR, "process_docs");
try { fs.mkdirSync(PROCESS_DIR, { recursive: true }); } catch (e) {}
const PROCESS_STORE = path.join(DATA_DIR, "process_docs.json");
function loadProcDocs() { try { return JSON.parse(fs.readFileSync(PROCESS_STORE, "utf8")); } catch (e) { return []; } }
function saveProcDocs(a) { try { fs.writeFileSync(PROCESS_STORE, JSON.stringify(a)); } catch (e) {} }
app.get("/api/process/list", auth, (req, res) => {
  const builtins = [
    { id: "guide", label: "Guide CP · le cockpit, la voix Hyped, le process de A à Z", url: "/guide" },
    { id: "fiches", label: "Fiches de Process influence · la passation (12 fiches)", url: "/process" },
    { id: "story", label: "Storytelling de marque · l'exemple GLASH Paris", url: "/story" },
    { id: "modele", label: "Modèle de shortlist à envoyer aux marques (Excel)", url: "/modele-shortlist.xlsx" },
  ];
  const docs = loadProcDocs().map((d) => ({ id: d.id, label: d.label, url: "/api/process/doc/" + d.id, by: d.by, at: d.at, size: d.size, filename: d.filename }));
  res.json({ builtins, docs, canDelete: req.user.role === "supervisor" });
});
app.post("/api/process/doc", auth, (req, res) => {
  const { label, filename, data } = req.body || {};
  const raw = String(data || "").replace(/^data:[^;]*;base64,/, "");
  const buf = Buffer.from(raw, "base64");
  if (!buf.length) return res.status(400).json({ error: "fichier vide" });
  if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: "fichier trop lourd (15 Mo max)" });
  const safe = String(filename || "document").replace(/[^\w.\-()À-ſ ]+/g, "_").slice(0, 120);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  try { fs.writeFileSync(path.join(PROCESS_DIR, id + "_" + safe), buf); } catch (e) { return res.status(500).json({ error: "écriture impossible" }); }
  const a = loadProcDocs(); a.push({ id, label: String(label || "").slice(0, 160) || safe, filename: safe, by: req.user.name, at: Date.now(), size: buf.length });
  saveProcDocs(a);
  logActivity({ type: "process_doc", creator: safe, cp: req.user.name });
  res.json({ ok: true, id });
});
app.get("/api/process/doc/:id", auth, (req, res) => {
  const d = loadProcDocs().find((x) => x.id === String(req.params.id));
  if (!d) return res.status(404).json({ error: "document introuvable" });
  const fp = path.join(PROCESS_DIR, d.id + "_" + d.filename);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: "fichier disparu du disque" });
  if (req.query.view === "1") { // ?view=1 : lecture dans le navigateur au lieu du téléchargement
    const ext = (d.filename.split(".").pop() || "").toLowerCase();
    const mimes = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", txt: "text/plain; charset=utf-8", html: "text/html; charset=utf-8" };
    res.setHeader("Content-Type", mimes[ext] || "application/octet-stream");
    res.setHeader("Content-Disposition", "inline; filename*=UTF-8''" + encodeURIComponent(d.filename));
    return res.send(fs.readFileSync(fp));
  }
  res.download(fp, d.filename);
});
app.post("/api/process/doc/:id/delete", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const a = loadProcDocs(); const d = a.find((x) => x.id === String(req.params.id));
  if (d) { try { fs.unlinkSync(path.join(PROCESS_DIR, d.id + "_" + d.filename)); } catch (e) {} }
  saveProcDocs(a.filter((x) => x.id !== String(req.params.id)));
  res.json({ ok: true });
});
// --- Fiches créatrices : l'identité d'un créateur, agrégée automatiquement -----
// (collabs au calendrier, veille, échanges vus par le copilote, traçabilité) et
// enrichissable par l'équipe (réseaux sociaux, emails, notes). Ouvre via « Qui c'est ? ».
const CREATORS_STORE = path.join(DATA_DIR, "creators.json");
function loadCreators() { try { return JSON.parse(fs.readFileSync(CREATORS_STORE, "utf8")); } catch (e) { return {}; } }
function saveCreators(o) { try { fs.writeFileSync(CREATORS_STORE, JSON.stringify(o)); } catch (e) {} }
app.get("/api/creator", auth, async (req, res) => {
  const name = String(req.query.name || "").trim();
  if (!name) return res.status(400).json({ error: "nom manquant" });
  const n = normName(name.replace(/^@/, ""));
  const fiche = loadCreators()[n] || {};
  let collabs = [];
  try { collabs = (await fetchRows()).filter((r) => normName(r.name || "") === n || (n.length > 3 && normName(r.name || "").includes(n))).map((r) => ({ brand: r.brand, statut: r.statut || r.grp || "", date: r.date || null })); } catch (e) {}
  let history = [];
  try { const h = loadHistory(); history = Object.values(h).filter((rec) => normName(rec.name || "") === n).flatMap((rec) => (rec.events || []).map((ev) => ({ ...ev, brand: rec.brand }))).sort((a, b) => b.at - a.at).slice(0, 20); } catch (e) {}
  let mails = [];
  try { mails = (loadCopilot().proposals || []).filter((p) => normName(String(p.creator || "").replace(/^@/, "")) === n).map((p) => ({ at: p.at, subject: p.subject, brand: p.brand, status: p.status, cp: p.cpName, to: p.to })).sort((a, b) => b.at - a.at).slice(0, 15); } catch (e) {}
  const emails = [...new Set([...(fiche.emails || []), ...mails.map((m) => m.to).filter(Boolean)])];
  let veille = [];
  try { veille = (await fetchAllTasks()).filter((t) => t.type === "Prise de contact" && normName(String(t.task).replace(/^contacter\s+/i, "").replace(/^@/, "")) === n).map((t) => ({ brand: t.projet, statut: t.statut, commentaire: t.commentaire || "", lien: t.lien || null })); } catch (e) {}
  res.json({ name, fiche: { reseaux: fiche.reseaux || {}, notes: fiche.notes || [], emails }, collabs, history, mails, veille });
});
app.post("/api/creator", auth, (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ error: "nom manquant" });
  const n = normName(name.replace(/^@/, ""));
  const all = loadCreators(); const rec = all[n] || {};
  const b = req.body || {};
  if (b.reseaux) { rec.reseaux = { ...(rec.reseaux || {}) }; for (const k of ["instagram", "tiktok", "youtube", "autre"]) if (b.reseaux[k] !== undefined) rec.reseaux[k] = String(b.reseaux[k]).slice(0, 300); }
  if (b.email) rec.emails = [...new Set([...(rec.emails || []), String(b.email).slice(0, 200)])];
  if (b.note) rec.notes = (rec.notes || []).concat([{ at: Date.now(), by: req.user.name, text: String(b.note).slice(0, 1000) }]).slice(-50);
  rec.name = name;
  all[n] = rec; saveCreators(all);
  res.json({ ok: true });
});
// --- Onboarding des nouvelles arrivantes -------------------------------------
// Checklist de bienvenue dans le cockpit de la personne (cases persistées sur disque),
// progression visible des superviseures. Nouvelle arrivante = ajouter son adresse dans
// la variable d'env ONBOARDING_USERS (adresses séparées par des virgules).
const ONBOARDING_STORE = path.join(DATA_DIR, "onboarding.json");
const ONBOARDING_USERS = String(process.env.ONBOARDING_USERS || "prunelle@hyped-agency.fr").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// Jour 2 de Prunelle : le parcours du jour 1 est terminé, on ne garde que l'essentiel.
const ONBOARDING_STEPS = [
  { id: "casting", group: "Jour 2 🚀", label: "Faire valider ma première sélection de profils par Mélany", hint: "règle de départ : le casting se valide ensemble AVANT toute prise de contact. Ensuite tu voleras de tes propres ailes" },
  { id: "debrief", group: "Jour 2 🚀", label: "Débrief de fin de journée avec Mélany", hint: "questions, impressions, ce qui reste flou : rien n'est bête ✨" },
];
// Encart « Matériel » (QR eSIM, codes wifi…) : ajouté par une superviseure depuis le cockpit,
// stocké sur le DISQUE PERSISTANT (jamais dans le dépôt public !), servi uniquement à la
// personne concernée (ou aux superviseures) une fois connectée.
const ONB_FILES = path.join(DATA_DIR, "onb_files");
try { fs.mkdirSync(ONB_FILES, { recursive: true }); } catch (e) {}
function loadOnb() {
  let store; try { store = JSON.parse(fs.readFileSync(ONBOARDING_STORE, "utf8")); } catch (e) { return {}; }
  // One-shot jour 2 (8 juillet) : l'eSIM est installée, on retire l'encart, et on décoche
  // casting/debrief (cochés au jour 1) pour repartir sur le parcours réduit du jour 2.
  if (!store._j2) {
    try { delete (store._attach || {})["prunelle@hyped-agency.fr"]; } catch (e) {}
    if (store["prunelle@hyped-agency.fr"]) { delete store["prunelle@hyped-agency.fr"].casting; delete store["prunelle@hyped-agency.fr"].debrief; }
    store._j2 = 1; saveOnb(store);
  }
  return store;
}
function saveOnb(o) { try { fs.writeFileSync(ONBOARDING_STORE, JSON.stringify(o)); } catch (e) { try { console.error("[onboarding] écriture échouée :", e.message); } catch (e2) {} } }
function onbFor(email) {
  const done = loadOnb()[email] || {};
  // « gmail » se coche automatiquement dès que la boîte est vraiment connectée
  return ONBOARDING_STEPS.map((s) => ({ ...s, done: !!done[s.id] || (s.id === "gmail" && gm.ENABLED && gm.isConnected(email)) }));
}
app.get("/api/onboarding", auth, (req, res) => {
  const me = String(req.user.email || "").toLowerCase();
  const store = loadOnb();
  const mine = ONBOARDING_USERS.includes(me) ? onbFor(me) : null;
  let attach = null;
  if (mine) {
    const a = (store._attach || {})[me];
    if (a) attach = { title: a.title || "Matériel", text: a.text || "", hasImg: !!a.img, done: !!(store[me] || {}).attach };
  }
  let team = [];
  if (req.user.role === "supervisor") {
    team = ONBOARDING_USERS.filter((e) => e !== me).map((e) => {
      const st = onbFor(e);
      const u = USERS.find((x) => String(x.email).toLowerCase() === e);
      return { email: e, name: u ? u.name : e, hasAttach: !!(store._attach || {})[e], steps: st.map((s) => ({ id: s.id, label: s.label, done: s.done })), done: st.filter((s) => s.done).length, total: st.length };
    }).filter((t) => t.done < t.total); // parcours terminé : on ne l'affiche plus
  }
  res.json({ mine, attach, team });
});
// Ajout / remplacement / suppression de l'encart matériel : superviseures pour n'importe qui,
// et la personne concernée peut aussi gérer son PROPRE encart (il n'est visible que d'elle).
app.post("/api/onboarding/attach", auth, (req, res) => {
  const { email, title, text, image, remove } = req.body || {};
  const me0 = String(req.user.email || "").toLowerCase();
  const e = String(email || me0).toLowerCase();
  if (req.user.role !== "supervisor" && e !== me0) return res.status(403).json({ error: "réservé aux superviseures" });
  if (!ONBOARDING_USERS.includes(e)) return res.status(400).json({ error: "cette personne n'a pas de parcours d'arrivée" });
  const store = loadOnb(); store._attach = store._attach || {};
  const fname = e.replace(/[^a-z0-9@.-]/g, "_") + ".img";
  if (remove) {
    delete store._attach[e];
    try { fs.unlinkSync(path.join(ONB_FILES, fname)); } catch (err) {}
    if (store[e]) delete store[e].attach;
    saveOnb(store);
    return res.json({ ok: true });
  }
  const a = { title: String(title || "Matériel").slice(0, 80), text: String(text || "").slice(0, 1500), img: "" };
  if (image) {
    const m = String(image).match(/^data:(image\/(?:png|jpe?g|webp|gif));base64,(.+)$/);
    if (!m) return res.status(400).json({ error: "image invalide (png/jpg/webp/gif)" });
    const buf = Buffer.from(m[2], "base64");
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: "image trop lourde (5 Mo max)" });
    try { fs.writeFileSync(path.join(ONB_FILES, fname), buf); } catch (err) { return res.status(500).json({ error: "écriture impossible" }); }
    a.img = fname; a.mime = m[1];
  } else {
    const prev = store._attach[e]; if (prev && prev.img) { a.img = prev.img; a.mime = prev.mime; } // texte modifié, image conservée
  }
  store._attach[e] = a;
  if (store[e]) delete store[e].attach; // nouvel encart : la case redevient à cocher
  saveOnb(store);
  res.json({ ok: true });
});
// --- Documents internes d'onboarding (ex. fiches de process) : stockés sur le DISQUE
// PERSISTANT, jamais dans le dépôt public GitHub. Dépôt par un compte connecté de l'équipe,
// lecture derrière le login du cockpit uniquement.
const ONB_DOCS = { process: "process.pdf", story: "story.pdf" }; // documents internes servis derrière le login
app.post("/api/onboarding/doc", auth, (req, res) => {
  const name = String((req.body || {}).name || "process");
  if (!ONB_DOCS[name]) return res.status(400).json({ error: "document inconnu" });
  const m = String((req.body || {}).base64 || "").match(/^data:application\/pdf;base64,(.+)$/);
  if (!m) return res.status(400).json({ error: "PDF attendu" });
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 10 * 1024 * 1024) return res.status(400).json({ error: "10 Mo max" });
  try { fs.writeFileSync(path.join(ONB_FILES, ONB_DOCS[name]), buf); } catch (e) { return res.status(500).json({ error: "écriture impossible" }); }
  res.json({ ok: true, name, size: buf.length });
});
app.get(["/process", "/story"], auth, (req, res) => {
  const name = req.path.replace("/", "");
  const p = path.join(ONB_FILES, ONB_DOCS[name]);
  if (!fs.existsSync(p)) return res.status(404).send(copilotPage("Pas encore là 📄", "Ce document n'a pas encore été déposé."));
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Cache-Control", "private, no-store");
  res.send(fs.readFileSync(p));
});
// L'image (QR…) : servie uniquement à la personne concernée ou aux superviseures
app.get("/api/onboarding/file", auth, (req, res) => {
  const me = String(req.user.email || "").toLowerCase();
  const target = req.user.role === "supervisor" ? String(req.query.email || me).toLowerCase() : me;
  if (target !== me && req.user.role !== "supervisor") return res.status(403).end();
  const a = (loadOnb()._attach || {})[target];
  if (!a || !a.img) return res.status(404).end();
  try {
    const buf = fs.readFileSync(path.join(ONB_FILES, a.img));
    res.setHeader("Content-Type", a.mime || "image/png");
    res.setHeader("Cache-Control", "private, no-store");
    res.send(buf);
  } catch (e) { res.status(404).end(); }
});
app.post("/api/onboarding/check", auth, (req, res) => {
  const me = String(req.user.email || "").toLowerCase();
  if (!ONBOARDING_USERS.includes(me)) return res.status(403).json({ error: "pas de checklist pour ce compte" });
  const { id, done } = req.body || {};
  if (!ONBOARDING_STEPS.some((s) => s.id === String(id)) && String(id) !== "attach") return res.status(400).json({ error: "étape inconnue" });
  const store = loadOnb(); store[me] = store[me] || {};
  if (done === false) delete store[me][String(id)]; else store[me][String(id)] = Date.now();
  saveOnb(store);
  res.json({ ok: true });
});
// Mail de demande de stats/bilan (J+5 après publication)
function genStatsFR(brand, name, cp) {
  return `Hello ${name} ✨\n\nMerci encore pour ta superbe collab avec ${brand} ! 🤍\n\nPour clôturer la campagne côté marque, est-ce que tu pourrais m'envoyer les statistiques de tes contenus : vues, portée/impressions, likes, partages, enregistrements, et les captures des stories ?\n\nUn petit screenshot de chaque contenu suffit largement. Ça nous permet de faire le bilan avec ${brand}.\n\nMerci d'avance et à très vite,\n${cp}`;
}

// --- To-do par marque : les tâches Notion de la personne, groupées par Projet ---
app.get("/api/todo", auth, async (req, res) => {
  if (DEMO || !notion) return res.json({ enabled: false, taches: [] });
  try {
    const all = await fetchAllTasks();
    const me = normName(req.user.name);
    const sup = req.user.role === "supervisor";
    const qui = String(req.query.qui || "").trim(); // superviseures : filtre par personne
    // Les tâches de la boss ne sont visibles que par elle (couvre « Mélany » et « Melany »)
    const BOSS = "melany";
    const viewerIsBoss = me === BOSS;
    const taches = all
      .filter((t) => t.statut !== "Fait")
      .filter((t) => viewerIsBoss || normName(t.responsable || "") !== BOSS)
      .filter((t) => (sup ? (!qui || normName(t.responsable || "") === normName(qui)) : normName(t.responsable || "") === me))
      .sort((a, b) => String(a.echeance || "9999").localeCompare(String(b.echeance || "9999")));
    const responsables = sup ? [...new Set(all.map((t) => t.responsable).filter(Boolean))].filter((n) => viewerIsBoss || normName(n) !== BOSS).sort() : [];
    res.json({ enabled: true, taches, responsables });
  } catch (e) { res.json({ enabled: false, error: e.message, taches: [] }); }
});
app.post("/api/todo/check", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  const id = String(req.body?.id || "");
  if (!id) return res.status(400).json({ error: "id manquant" });
  try {
    // Garde-fou : une CP ne coche que SES tâches ; les superviseures peuvent tout cocher
    const pg = await notion.pages.retrieve({ page_id: id });
    const t = mapTask(pg);
    if (req.user.role !== "supervisor" && normName(t.responsable || "") !== normName(req.user.name)) return res.status(403).json({ error: "pas ta tâche" });
    await notion.pages.update({ page_id: id, properties: { "Statut": { select: { name: req.body?.done ? "Fait" : "À faire" } } } }); invalidateTasksCache();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: String(e && e.message || e).slice(0, 160) }); }
});

// --- Veille / Sourcing : profils à contacter (board Tâches, Type=Prise de contact) ---
const INHAIRCARE_DB = "380f8ac3-c3ae-80ce-ba4c-e8e82490edc6";
app.get("/api/sourcing", auth, async (req, res) => {
  if (DEMO || !notion) return res.json({ enabled: false, profils: [] });
  try {
    const all = (await fetchAllTasks()).filter((t) => t.type === "Prise de contact");
    const me = normName(req.user.name);
    const sup = req.user.role === "supervisor";
    const profils = all
      .filter((t) => t.statut !== "Fait" && (sup || !t.responsable || normName(t.responsable) === me))
      .sort((a, b) => (a.echeance || "9999").localeCompare(b.echeance || "9999"));
    res.json({ enabled: true, profils });
  } catch (e) { res.json({ enabled: false, error: e.message, profils: [] }); }
});
// Marques + équipe pour l'ajout express (page /ajout)
app.get("/api/quickmeta", auth, (req, res) => {
  const brands = [...new Set(["In Haircare", "Curls Matter", "Doucéa", "LIVA", "Toki Bona", "FND'HER", "Hyped Agency", "Autres", ...Object.keys(loadBrandFiches())])];
  const cps = USERS.map((u) => u.name);
  res.json({ brands, cps, me: req.user.name });
});
// Import en masse : une seule notif Slack récapitulative par CP (90 s après le dernier ajout),
// pour éviter 30 pings d'affilée quand Mélany importe une shortlist entière.
const SRC_DIGEST = {};
function queueSourcingDigest(cpName, brand, byName) {
  const k = normName(cpName);
  const d = (SRC_DIGEST[k] = SRC_DIGEST[k] || { count: 0, brands: new Set(), timer: null });
  d.count++; d.brands.add(brand); d.by = byName; d.cpName = cpName;
  if (d.timer) clearTimeout(d.timer);
  d.timer = setTimeout(async () => {
    delete SRC_DIGEST[k];
    try {
      const cpEmail = emailOf(d.cpName);
      const su = cpEmail ? (COPILOT.slackIds[cpEmail] || "") : "";
      if (su) await copilotNotify({ slackUser: su, text: "🔎 " + d.count + " nouveau(x) profil(s) à contacter pour *" + [...d.brands].join(", ") + "* (ajoutés par " + d.by + "). Ils sont dans ton onglet Profils, messages d'approche prêts." });
    } catch (e) {}
  }, 90 * 1000);
}
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
      if (!req.body?.noDraft && resp && gm.ENABLED && typeof gm.createDraft === "function") { // noDraft : import en masse, pas 30 brouillons d'un coup
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
    // Notif Slack : par DEFAUT on prévient la CP dès qu'un profil est ajouté pour quelqu'un d'autre
    // (cockpit, ajout express, peu importe). Ajout unitaire = notif immédiate ;
    // import en masse (noDraft) = une seule notif récapitulative via queueSourcingDigest.
    try {
      const forOther = resp && normName(resp) !== normName(req.user.name);
      const explicit = req.body?.notify;
      if (resp && (explicit === true || (explicit === undefined && forOther))) {
        if (req.body?.noDraft) queueSourcingDigest(resp, req.body?.marque || "?", req.user.name);
        else {
          const cpEmail2 = emailOf(resp);
          const su = cpEmail2 ? (COPILOT.slackIds[cpEmail2] || "") : "";
          if (su) await copilotNotify({ slackUser: su, text: "🔎 Nouveau profil à contacter pour *" + (req.body?.marque || "?") + "* : " + profil + " (ajouté par " + req.user.name + "). Il est dans ton onglet Profils, message d'approche prêt." });
        }
      }
    } catch (e) {}
    res.json({ ok: true, id: pg.id, draft });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// Supprimer un profil de la liste « à contacter » (erreur, doublon, plus d'actualité) :
// la tâche Notion part à la corbeille, récupérable depuis Notion si besoin.
app.post("/api/sourcing/:id/delete", auth, async (req, res) => {
  if (DEMO || !notion) return res.status(400).json({ error: "indisponible" });
  try {
    await notion.pages.update({ page_id: req.params.id, archived: true });
    invalidateTasksCache();
    res.json({ ok: true });
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
    // NB : on ne crée PLUS de ligne dans le calendrier de la marque à ce stade. Process (fiche 08) :
    // une collab n'entre au calendrier que quand le créateur a ACCEPTÉ, livrables validés et dates
    // définies. Avant, un simple mail de première approche créait une fausse collab « planifiée ».
    res.json({ ok: true, brand: t.projet });
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
// Modèle de shortlist à envoyer aux marques : leurs fichiers rentrent alors parfaitement dans l'import
app.get("/modele-shortlist.xlsx", (req, res) => res.download(path.join(__dirname, "modele_shortlist.xlsx"), "Shortlist profils - modele Hyped Agency.xlsx"));
// --- Kickoff du lundi : la transcription Sembly devient des tâches, toute seule --
// Le mail Sembly arrive dans la boîte de Mélany après la weekly. Le cockpit le détecte,
// lit la transcription (corps du mail + PDF joint), extrait les « qui fait quoi » avec
// l'IA (responsables et marques matchés sur l'équipe réelle, rien d'inventé), crée les
// tâches dans Notion (donc dans la to-do de chacune) et envoie le récap Slack à Mélany.
const KICKOFF_STORE = path.join(DATA_DIR, "kickoff.json");
const KICKOFF_BOX = (process.env.KICKOFF_BOX || "melany@hyped-agency.fr").toLowerCase();
function loadKickoff() { try { return JSON.parse(fs.readFileSync(KICKOFF_STORE, "utf8")); } catch (e) { return { done: [] }; } }
function saveKickoff(o) { try { fs.writeFileSync(KICKOFF_STORE, JSON.stringify(o)); } catch (e) {} }
async function kickoffExtract(transcript, deja) {
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return null;
  const team = USERS.map((u) => u.name).join(", ");
  const brands = quickBrandsList().join(", ");
  const lines = [
    "Tu lis la transcription d'une réunion d'équipe d'une agence d'influence et tu en extrais UNIQUEMENT les tâches décidées (les « qui fait quoi »). Réponds UNIQUEMENT un JSON valide :",
    '{"taches":[{"tache":"...","responsable":"...","marque":"...","echeance":"YYYY-MM-DD ou null"}]}',
    "RÈGLES STRICTES :",
    "- tache = une action concrète décidée en réunion, reformulée courte et claire (ex. « Relancer Yasmine pour la preview »). PAS les sujets simplement évoqués, PAS le bavardage, PAS ce qui est déjà fait.",
    "- responsable = EXACTEMENT un de : " + team + ". Si la personne n'est pas claire, mets \"\".",
    "- marque = EXACTEMENT une de : " + brands + ". Sinon \"\".",
    "- echeance = SEULEMENT si une date précise a été dite, sinon null. Année 2026.",
    "- Maximum 25 tâches, les plus importantes. N'invente RIEN : chaque tâche doit être traçable à un passage de la réunion.",
  ];
  // Anti-doublons : ce qui est DÉJÀ dans les to-do (dont les notes weekly déjà poussées)
  if (deja && deja.length) lines.push("- DÉJÀ dans la to-do (ne PAS les recréer, même reformulées différemment) :\n" + deja.slice(0, 90).map((s) => "• " + String(s).slice(0, 120)).join("\n"));
  const sys = lines.join("\n");
  try {
    // 25 tâches en JSON ne tiennent pas dans 700 tokens : plafond dédié bien plus large,
    // sinon la réponse est tronquée, le JSON invalide, et on croit qu'il n'y a « rien ».
    const out = hasOpenAI ? await callOpenAI(sys, String(transcript || "").slice(0, 90000), 4000) : await callAnthropic(sys, String(transcript || "").slice(0, 90000), 4000);
    if (!out.ok) { try { console.error("[kickoff] IA :", out.reason, out.status || "", String(out.detail || "").slice(0, 200)); } catch (e2) {} return null; }
    try {
      const j = JSON.parse(String(out.body).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
      return Array.isArray(j.taches) ? j.taches : null;
    } catch (e) { try { console.error("[kickoff] JSON invalide :", e.message, "· réponse :", String(out.body).slice(0, 250)); } catch (e2) {} return null; }
  } catch (e) { try { console.error("[kickoff] extract :", e.message); } catch (e2) {} return null; }
}
async function kickoffTick() {
  try {
    if (!gm.ENABLED || !notion || DEMO) return;
    if (!gm.isConnected(KICKOFF_BOX)) return;
    const store = loadKickoff();
    const mails = await gm.fetchMessagesByQuery(KICKOFF_BOX, 'from:sembly newer_than:3d (subject:"Weekly" OR subject:"meeting" OR subject:"Transcription" OR subject:"notes")', 3);
    for (const m of mails) {
      if (store.done.includes(m.id)) continue;
      store.done.push(m.id); store.done = store.done.slice(-50); saveKickoff(store); // marqué AVANT traitement : jamais de doublon
      let text = String(m.body || "");
      // PDF joint (transcription complète) : on le préfère au corps du mail
      for (const a of (m.attachments || [])) {
        if (/pdf$/i.test(a.filename || "") || /pdf/.test(a.mime || "")) {
          try {
            const buf = await gm.getAttachment(KICKOFF_BOX, m.id, a.attId);
            if (buf) { const pdfParse = require("pdf-parse"); const r = await pdfParse(buf); if (r && r.text && r.text.length > text.length) text = r.text; }
          } catch (e) { try { console.error("[kickoff] pdf :", e.message); } catch (e2) {} }
        }
      }
      const su = COPILOT.slackIds[KICKOFF_BOX] || "";
      // Mail Sembly « insights » : souvent juste un LIEN, sans la transcription.
      // Dans ce cas on préviens clairement et on pointe vers l'import manuel du PDF.
      if (!text || text.length < 1500) {
        if (su) await copilotNotify({ slackUser: su, text: "📋 J'ai vu le mail Sembly (« " + (m.subject || "réunion") + " ») mais la transcription n'était pas dedans, juste un lien. Exporte le PDF de la transcription depuis Sembly et importe-le dans le cockpit : panneau « 🧠 À dire à la weekly » → bouton 📥 Importer le compte-rendu. Les tâches seront créées pareil." });
        continue;
      }
      const out = await kickoffProcess(text, m.subject);
      try { console.log("[kickoff]", m.subject, ":", (out.created || []).length, "tâches créées,", (out.orphans || []).length, "orphelines"); } catch (e) {}
    }
  } catch (e) { try { console.error("[kickoff] tick :", e.message); } catch (e2) {} }
}
// Le cœur du kickoff : transcription → tâches Notion + récap Slack.
// Utilisé par la détection auto (mail Sembly) ET par l'import manuel du PDF.
async function kickoffProcess(text, subject) {
      // Anti-doublons : tâches ouvertes existantes + notes weekly (poussées ou pas)
      let existing = []; try { existing = (await fetchAllTasks()).filter((x) => x.statut !== "Fait"); } catch (e) {}
      const wkNotes = (loadWeekly().notes || []).map((x) => (x.who ? x.who + " : " : "") + x.text);
      const deja = existing.slice(-80).map((x) => (x.responsable ? x.responsable + " : " : "") + x.task).concat(wkNotes.slice(-30));
      const taches = await kickoffExtract(text, deja);
      const su = COPILOT.slackIds[KICKOFF_BOX] || "";
      if (!taches || !taches.length) { if (su) await copilotNotify({ slackUser: su, text: "📋 J'ai lu le compte-rendu (« " + (subject || "réunion") + " ») mais je n'ai extrait aucune tâche claire. Tu peux les ajouter à la main dans la to-do." }); return { created: [], skipped: [], orphans: [] }; }
      // VALIDATION D'ABORD : rien ne part dans les to-do sans relecture de Mélany.
      // Les tâches extraites attendent dans le cockpit (panneau À dire à la weekly).
      const st = loadKickoff();
      st.pending = { id: crypto.randomBytes(6).toString("hex"), subject: String(subject || "réunion"), at: Date.now(), taches: taches.slice(0, 25) };
      saveKickoff(st);
      if (su) await copilotNotify({ slackUser: su, text: "📋 J'ai extrait *" + st.pending.taches.length + " tâche(s)* de « " + st.pending.subject + " ». Rien n'est encore créé : relis-les et valide dans le cockpit → panneau « 🧠 À dire à la weekly »." });
      return { pending: st.pending.taches.length };
}
// La création réelle, après validation : anti-doublons + récap Slack.
async function kickoffCreate(taches, subject) {
      let existing = []; try { existing = (await fetchAllTasks()).filter((x) => x.statut !== "Fait"); } catch (e) {}
      const su = COPILOT.slackIds[KICKOFF_BOX] || "";
      const teamNames = USERS.map((u) => u.name);
      const created = [], orphans = [], skipped = [];
      const nrmT = (s) => nrmName(s).replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
      for (const t of taches.slice(0, 25)) {
        const resp = teamNames.find((n) => nrmName(n) === nrmName(t.responsable || "")) || "";
        const brand = quickBrandsList().find((b) => nrmName(b) === nrmName(t.marque || "")) || "";
        if (!String(t.tache || "").trim()) continue;
        if (!resp) { orphans.push(t.tache); continue; }
        // Filet de sécurité anti-doublons : si une tâche ouverte très proche existe déjà
        // pour la même personne, on ne la recrée pas (même si l'IA l'a laissée passer).
        const a = nrmT(t.tache);
        const dup = existing.some((e) => nrmName(e.responsable) === nrmName(resp) && (() => { const b = nrmT(e.task); return (a.length > 14 && b.includes(a.slice(0, 35))) || (b.length > 14 && a.includes(b.slice(0, 35))); })());
        if (dup) { skipped.push(t.tache + " → " + resp); continue; }
        const props = {
          "Tâche": { title: [{ text: { content: String(t.tache).slice(0, 200) } }] },
          "Type": { select: { name: "Autre" } },
          "Statut": { select: { name: "À faire" } },
          "Responsable": { select: { name: resp } },
        };
        if (brand) props["Projet"] = { select: { name: brand } };
        if (t.echeance && /^\d{4}-\d{2}-\d{2}$/.test(String(t.echeance))) props["Échéance"] = { date: { start: t.echeance } };
        try { await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); created.push("• " + t.tache + " → *" + resp + "*" + (brand ? (" (" + brand + ")") : "") + (t.echeance ? (" · " + t.echeance) : "")); }
        catch (e) { orphans.push(t.tache + " (échec Notion)"); }
      }
      invalidateTasksCache();
      if (su) await copilotNotify({ slackUser: su, text: "📋 *Kickoff traité* (« " + (subject || "réunion") + " ») : " + created.length + " tâche(s) créée(s) dans les to-do :\n" + created.join("\n") + (skipped.length ? ("\n\n♻️ Déjà dans la to-do, pas recréées :\n• " + skipped.join("\n• ")) : "") + (orphans.length ? ("\n\n🤷 Sans responsable clair (à attribuer à la main) :\n• " + orphans.join("\n• ")) : "") + "\n\n_Une tâche en trop ? Supprime-la dans Notion ou décoche-la, rien d'autre à faire._" });
      return { created, skipped, orphans };
}
// Les tâches extraites en attente de validation (relues dans le cockpit)
app.get("/api/kickoff/pending", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const st = loadKickoff();
  res.json({ pending: st.pending || null });
});
// Validation : on crée UNIQUEMENT les tâches cochées, le reste est oublié
app.post("/api/kickoff/confirm", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const st = loadKickoff();
  if (!st.pending) return res.status(400).json({ error: "rien à valider" });
  const keep = Array.isArray(req.body?.keep) ? req.body.keep.map(Number) : [];
  const taches = st.pending.taches.filter((_, i) => keep.includes(i));
  const subject = st.pending.subject;
  st.pending = null; saveKickoff(st);
  if (!taches.length) return res.json({ ok: true, created: 0, skipped: 0, orphans: [] });
  try {
    const out = await kickoffCreate(taches, subject);
    res.json({ ok: true, created: (out.created || []).length, skipped: (out.skipped || []).length, orphans: out.orphans || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/kickoff/discard", auth, (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  const st = loadKickoff(); st.pending = null; saveKickoff(st);
  res.json({ ok: true });
});
// Import manuel du compte-rendu (PDF Sembly exporté) : mêmes tâches, même récap.
app.post("/api/kickoff/upload", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.status(403).json({ error: "réservé aux superviseures" });
  if (!notion || DEMO) return res.status(400).json({ error: "Notion non branché" });
  const mm = /^data:([^;]+);base64,(.+)$/.exec(String(req.body?.data || ""));
  if (!mm) return res.status(400).json({ error: "fichier illisible" });
  const buf = Buffer.from(mm[2], "base64");
  if (buf.length > 15 * 1024 * 1024) return res.status(400).json({ error: "PDF trop lourd (15 Mo max)" });
  let text = "";
  try { const pdfParse = require("pdf-parse"); const r = await pdfParse(buf); text = r.text || ""; } catch (e) {}
  if (!text || text.length < 200) return res.status(400).json({ error: "je n'arrive pas à lire de texte dans ce PDF" });
  try {
    const out = await kickoffProcess(text, String(req.body?.filename || "compte-rendu importé").replace(/\.pdf$/i, ""));
    res.json({ ok: true, pending: out.pending || 0, created: (out.created || []).length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
function nrmName(s) { return String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim(); }
setInterval(kickoffTick, 15 * 60 * 1000); // toutes les 15 min : le récap tombe peu après la fin de la réunion
setTimeout(kickoffTick, 30 * 1000);
// ===== Perso branding de Mélany : calendrier éditorial Instagram ==============
// Son calendrier de posts vit sur le disque privé ; les rappels tombent tout
// seuls dans sa to-do : « Préparer » à J-2, « Poster » le jour J.
const PERSO_STORE = path.join(DATA_DIR, "persoIG.json");
const PERSO_OWNER = (process.env.PERSO_OWNER || "melany@hyped-agency.fr").toLowerCase();
function loadPerso() { try { return JSON.parse(fs.readFileSync(PERSO_STORE, "utf8")); } catch (e) { return { posts: [] }; } }
function savePerso(o) { try { fs.writeFileSync(PERSO_STORE, JSON.stringify(o, null, 2)); } catch (e) {} }
function persoOnly(req, res) { if (String(req.user.email || "").toLowerCase() !== PERSO_OWNER) { res.status(403).json({ error: "réservé à la propriétaire du compte" }); return false; } return true; }
app.get("/api/perso", auth, (req, res) => { if (!persoOnly(req, res)) return; res.json(loadPerso()); });
app.post("/api/perso/set", auth, (req, res) => {
  if (!persoOnly(req, res)) return;
  const posts = Array.isArray(req.body?.posts) ? req.body.posts.slice(0, 100) : null;
  if (!posts) return res.status(400).json({ error: "posts manquants" });
  const o = loadPerso();
  o.posts = posts.map((p) => ({
    id: String(p.id || crypto.randomBytes(4).toString("hex")),
    date: String(p.date || "").slice(0, 10), format: String(p.format || "").slice(0, 40),
    titre: String(p.titre || "").slice(0, 140), cover: String(p.cover || "").slice(0, 30),
    statut: ["A faire", "Préparé", "Posté"].includes(p.statut) ? p.statut : "A faire",
    prepTask: !!p.prepTask, postTask: !!p.postTask,
  })).filter((p) => p.date && p.titre);
  savePerso(o); res.json({ ok: true, n: o.posts.length });
});
app.post("/api/perso/:id/statut", auth, (req, res) => {
  if (!persoOnly(req, res)) return;
  const o = loadPerso(); const p = (o.posts || []).find((x) => x.id === req.params.id);
  if (!p) return res.status(404).json({ error: "post introuvable" });
  const cycle = ["A faire", "Préparé", "Posté"];
  p.statut = cycle[(cycle.indexOf(p.statut) + 1) % cycle.length];
  savePerso(o); res.json({ ok: true, statut: p.statut });
});
async function persoTick() {
  try {
    if (!notion || DEMO) return;
    const o = loadPerso(); let changed = false;
    const today = new Date().toISOString().slice(0, 10);
    const j2 = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
    for (const p of o.posts || []) {
      if (!p.date || p.statut === "Posté") continue;
      const mk = async (title, due) => { await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: { "Tâche": { title: [{ text: { content: title.slice(0, 200) } }] }, "Type": { select: { name: "Autre" } }, "Statut": { select: { name: "À faire" } }, "Responsable": { select: { name: "Mélany" } }, "Échéance": { date: { start: due } } } }); };
      if (!p.prepTask && p.date <= j2) { await mk("🎬 Préparer le post IG « " + p.titre + " » (" + p.format + ", cover " + (p.cover || "?") + ")", today); p.prepTask = true; changed = true; }
      if (!p.postTask && p.date <= today) { await mk("📱 Poster sur Instagram : « " + p.titre + " »", p.date); p.postTask = true; changed = true; }
    }
    if (changed) { savePerso(o); invalidateTasksCache(); }
  } catch (e) { try { console.error("[perso]", e.message); } catch (e2) {} }
}
setInterval(persoTick, 60 * 60 * 1000);
setTimeout(persoTick, 45 * 1000);
// --- Hypedbot en direct : envoie un lien en DM Slack, la tâche est créée -------
// Remplace le chatbot Make. Analyse DÉTERMINISTE (lien + nom de marque + prénom de CP
// tels quels, aucune devinette IA) et confirmation explicite. S'il manque une info,
// il la demande et attend la réponse. Zéro crédit Make.
const SLACK_SEEN = new Set(); // anti-doublons (Slack renvoie les événements non acquittés)
const SLACK_PENDING = {};     // userId -> { link, brand, cp, at } en attente de complément
function slackVerify(req) {
  // Vérification de signature si SLACK_SIGNING_SECRET est configuré (recommandé).
  // Sans secret : on n'accepte que les utilisateurs connus de COPILOT_SLACK_IDS (garde-fou).
  const sec = process.env.SLACK_SIGNING_SECRET || "";
  if (!sec) return true;
  try {
    const ts = req.headers["x-slack-request-timestamp"];
    if (!ts || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
    const base = "v0:" + ts + ":" + (req.rawBody || JSON.stringify(req.body));
    const sig = "v0=" + crypto.createHmac("sha256", sec).update(base).digest("hex");
    const given = String(req.headers["x-slack-signature"] || "");
    return given.length === sig.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(given));
  } catch (e) { return false; }
}
function slackWho(userId) { // Slack userId -> { email, name } via COPILOT_SLACK_IDS
  const email = Object.keys(COPILOT.slackIds || {}).find((e) => COPILOT.slackIds[e] === userId);
  if (!email) return null;
  const u = USERS.find((x) => String(x.email).toLowerCase() === String(email).toLowerCase());
  return { email, name: u ? u.name : email.split("@")[0], role: u ? u.role : "cp" };
}
function quickBrandsList() { return [...new Set(["In Haircare", "Curls Matter", "Doucéa", "LIVA", "Toki Bona", "FND'HER", "Hyped Agency", ...Object.keys(loadBrandFiches())])]; }
// --- Relances de tâches en retard + « c'est fait » (remplace le scénario Make) ---
// Chaque matin (jours ouvrés), le bot relance en DM les tâches en retard de chacun.
// Quand la personne répond « c'est fait », il passe la tâche en Fait dans Notion
// et VERIFIE que l'écriture a bien pris avant de confirmer (fini les faux « ✅ »).
const nlow = normName; // alias (correctif : nlow n'était pas défini, tout DM au bot plantait)
const REMIND_FILE = path.join(DATA_DIR, "remind.json");
function loadRemind() { try { return JSON.parse(fs.readFileSync(REMIND_FILE, "utf8")); } catch (e) { return { lastRun: "", byUser: {} }; } }
function saveRemind(o) { try { fs.writeFileSync(REMIND_FILE, JSON.stringify(o, null, 2)); } catch (e) {} }
const DONE_PENDING = {}; // slackUserId -> { tasks:[...], at } quand on a demandé « laquelle ? »
async function markTaskDone(t) {
  await notion.pages.update({ page_id: t.id, properties: { "Statut": { select: { name: "Fait" } } } });
  const pg = await notion.pages.retrieve({ page_id: t.id }); // relecture : on ne confirme que si c'est VRAIMENT passé
  invalidateTasksCache();
  return (pg?.properties?.["Statut"]?.select?.name || "") === "Fait";
}
async function finishTasks(list, say) {
  const ok = [], ko = [];
  for (const t of list.slice(0, 10)) { try { (await markTaskDone(t)) ? ok.push(t) : ko.push(t); } catch (e) { ko.push(t); } }
  let msg = "";
  if (ok.length) msg += "✅ Passé en Fait dans Notion (vérifié) : " + ok.map((t) => "« " + t.task + " »").join(", ") + ". Bien joué !";
  if (ko.length) msg += (msg ? "\n" : "") + "⚠️ Je n'ai PAS réussi à mettre à jour : " + ko.map((t) => "« " + t.task + " »").join(", ") + ". Je préviens Mélany.";
  await say(msg || "Rien à mettre à jour.");
  if (ok.length) { try { logActivity({ type: "tache_faite_slack", creator: ok.map((t) => t.task).join(" · ") }); } catch (e) {} }
}
async function myOpenTasks(name) {
  return (await fetchAllTasks()).filter((t) => t.statut !== "Fait" && normName(t.responsable) === normName(name));
}
async function hypedbotDoneIntent(ev, who, low, say) {
  if (!notion || DEMO) return false;
  // réponse à « laquelle ? » : numéro(s) ou « toutes »
  const pend = DONE_PENDING[ev.user] && (Date.now() - DONE_PENDING[ev.user].at < 15 * 60 * 1000) ? DONE_PENDING[ev.user] : null;
  if (pend) {
    const nums = [...low.matchAll(/\b(\d{1,2})\b/g)].map((m) => Number(m[1])).filter((n) => n >= 1 && n <= pend.tasks.length);
    const tout = /toutes|tout est fait|les deux|les 2/.test(low);
    const picked = tout ? pend.tasks : nums.map((n) => pend.tasks[n - 1]);
    if (picked.length) { delete DONE_PENDING[ev.user]; await finishTasks(picked, say); return true; }
  }
  // simple politesse : on ne relance pas le flux « envoie un lien » sur un merci
  if (/^\s*(merci+( beaucoup)?( cherie| ma vie)?|top|parfait|nickel|super)\s*\W*\s*$/.test(low)) { await say("Avec plaisir 🤍"); return true; }
  if (/pas\s+(encore\s+)?(fait|fini|termine)|toujours\s+pas|pas\s+eu\s+le\s+temps/.test(low)) return false; // « pas encore fait » : on ne coche rien
  const done = /(^|\W)(c\s*['\u2019`]?\s*est\s+(deja\s+)?(fait|bon|regle|ok)|deja\s+fait|j\s*['\u2019`]?\s*ai\s+(deja\s+)?(fait|fini|envoye|termine)|fini|termine|done)(\W|$)/.test(low)
    || /\best\s+fait(e|es|s)?(\W|$)/.test(low) || /^\W*fait\W*$/.test(low);
  if (!done) return false;
  const mine = await myOpenTasks(who.name);
  // 1) la personne cite la tâche (« le moodboard est fait ») : on cherche les mots dans les titres
  const stop = new Set(["est", "fait", "fini", "termine", "done", "deja", "bon", "depuis", "hier", "aujourd", "hui", "vie", "cest", "pour", "avec", "dans", "les", "des", "une", "sur", "que", "qui", "pas", "tache", "notion"]);
  const words = low.replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !stop.has(w));
  const scored = mine.map((t) => { const tl = normName(t.task); return { t, score: words.filter((w) => tl.includes(w)).length }; }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  let picked = [];
  if (scored.length && scored[0].score >= 2) picked = scored.filter((x) => x.score === scored[0].score).map((x) => x.t).slice(0, 3);
  else if (scored.length === 1) picked = [scored[0].t];
  // 2) sinon : la ou les tâches relancées ce matin (encore ouvertes)
  if (!picked.length) {
    const rem = loadRemind().byUser[ev.user];
    if (rem && Date.now() - rem.at < 7 * 86400000) {
      const ids = new Set((rem.tasks || []).map((x) => x.id));
      const open = mine.filter((t) => ids.has(t.id));
      if (open.length === 1) picked = [open[0]];
      else if (open.length > 1) { DONE_PENDING[ev.user] = { tasks: open, at: Date.now() }; await say("Bien reçu ! Laquelle est faite ?\n" + open.map((t, i) => (i + 1) + ". " + t.task).join("\n") + "\n(réponds avec le numéro, ou « toutes »)"); return true; }
    }
  }
  // 3) sinon : ses tâches en retard
  if (!picked.length) {
    const today = new Date().toISOString().slice(0, 10);
    const late = mine.filter((t) => t.echeance && t.echeance < today);
    if (late.length === 1) picked = [late[0]];
    else if (late.length > 1) { DONE_PENDING[ev.user] = { tasks: late.slice(0, 8), at: Date.now() }; await say("Super ! Tu me dis laquelle ?\n" + late.slice(0, 8).map((t, i) => (i + 1) + ". " + t.task).join("\n") + "\n(numéro, ou « toutes »)"); return true; }
    else { await say("Je te crois 😄 mais je ne vois pas de quelle tâche tu parles. Donne-moi un bout de son nom (ex. « le moodboard est fait ») et je la passe en Fait dans Notion."); return true; }
  }
  await finishTasks(picked, say);
  return true;
}
async function remindTick() {
  try {
    if (!notion || DEMO) return;
    if (String(process.env.HYPEDBOT_RELANCES || "on").toLowerCase() === "off") return;
    const now = new Date();
    const day = now.getUTCDay(); // aux heures visées, le jour UTC = le jour Paris
    if (day === 0 || day === 6) return; // week-end : on laisse tout le monde tranquille
    const parts = new Intl.DateTimeFormat("fr-FR", { hour: "numeric", minute: "numeric", hour12: false, timeZone: "Europe/Paris" }).formatToParts(now);
    const hm = Number((parts.find((p) => p.type === "hour") || {}).value || 0) * 60 + Number((parts.find((p) => p.type === "minute") || {}).value || 0);
    // deux créneaux (demande de Mélany) : 10h30 le matin, 17h30 avant la fin de journée (18h)
    let slot = null;
    if (hm >= 630 && hm < 720) slot = "am";        // 10h30 → 12h00
    else if (hm >= 1050 && hm < 1080) slot = "pm"; // 17h30 → 17h59, jamais après 18h
    if (!slot) return;
    const today = now.toISOString().slice(0, 10);
    const st = loadRemind();
    if (st["last_" + slot] === today) return;
    const all = await fetchAllTasks();
    for (const u of USERS) {
      const sid = (COPILOT.slackIds || {})[String(u.email || "").toLowerCase()];
      if (!sid) continue;
      const late = all.filter((t) => t.statut !== "Fait" && normName(t.responsable) === normName(u.name) && t.echeance && t.echeance < today)
        .sort((a, b) => String(a.echeance).localeCompare(String(b.echeance))).slice(0, 5);
      if (!late.length) { delete st.byUser[sid]; continue; }
      const dmy = (d) => String(d).split("-").reverse().join("/");
      const lignes = late.map((t) => "• « " + t.task + " » (échéance le " + dmy(t.echeance) + ")").join("\n");
      let txt;
      if (slot === "am") {
        txt = late.length === 1
          ? "Coucou ✨ petite relance : la tâche « " + late[0].task + " » est en retard (échéance le " + dmy(late[0].echeance) + ").\nRéponds « c'est fait » et je la passe en Fait dans Notion, ou dis-moi si tu bloques 🙂"
          : "Coucou ✨ petit point du matin, " + late.length + " tâches en retard :\n" + lignes + "\nRéponds « c'est fait » (ou « le moodboard est fait ») et je mets Notion à jour, pour de vrai 😉";
      } else {
        txt = late.length === 1
          ? "Avant de partir 🌙 il reste « " + late[0].task + " » en retard. Si c'est réglé, réponds « c'est fait » et je m'occupe de Notion ✨"
          : "Avant de partir 🌙 petit point de fin de journée, il reste " + late.length + " tâches en retard :\n" + lignes + "\nSi certaines sont réglées, dis-le-moi et je mets Notion à jour ✨";
      }
      await copilotNotify({ slackUser: sid, text: txt });
      st.byUser[sid] = { at: Date.now(), tasks: late.map((t) => ({ id: t.id, task: t.task })) };
    }
    st["last_" + slot] = today;
    saveRemind(st);
  } catch (e) { try { console.error("[relances]", e.message); } catch (e2) {} }
}
setInterval(remindTick, 15 * 60 * 1000);
setTimeout(remindTick, 90 * 1000);
// --- Attribution de tâches par DM : « dis à Rozenn de relancer la facture pour vendredi » ---
// L'IA extrait {tâche, responsable, échéance}, la tâche est créée dans Notion,
// l'expéditrice reçoit une confirmation et la personne assignée une notification.
async function taskExtractFromDm(text, senderName) {
  const hasOpenAI = !!process.env.OPENAI_API_KEY, hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  if (!hasOpenAI && !hasAnthropic) return null;
  const team = USERS.map((u) => u.name).join(", ");
  const today = new Date().toISOString().slice(0, 10);
  const sys = [
    "Tu aides " + senderName + " (agence d'influence) à créer des tâches depuis un message Slack. Réponds UNIQUEMENT un JSON valide :",
    '{"taches":[{"tache":"...","responsable":"...","echeance":"YYYY-MM-DD ou null"}]}',
    "- tache : reformulée courte et impérative, SANS le nom du responsable dedans.",
    "- responsable : EXACTEMENT un de : " + team + ". Si aucun nom n'est cité, mets \"" + senderName + "\".",
    "- echeance : date ISO si mentionnée (aujourd'hui = " + today + " ; calcule « demain », « vendredi », « le 20 »…), sinon null.",
    "- Si le message n'est PAS une demande de création de tâche, réponds {\"taches\":[]}.",
  ].join("\n");
  try {
    const out = hasOpenAI ? await callOpenAI(sys, String(text || "").slice(0, 2000), 800) : await callAnthropic(sys, String(text || "").slice(0, 2000), 800);
    if (!out.ok) { try { console.error("[hypedbot tache] IA :", out.reason || out.status); } catch (e2) {} return null; }
    const j = JSON.parse(String(out.body).replace(/^[^{]*/, "").replace(/[^}]*$/, ""));
    return Array.isArray(j.taches) ? j.taches : [];
  } catch (e) { try { console.error("[hypedbot tache]", e.message); } catch (e2) {} return null; }
}
async function hypedbotTaskIntent(ev, who, raw, low, say) {
  const trigger = /(^|\W)(tache|todo)s?(\W|$)/.test(low) || /^(dis|demande|rappelle)\s+a\s+/.test(low) || /^(ajoute|mets|note|cree|creer)\b/.test(low);
  if (!trigger || !notion || DEMO) return false;
  const taches = await taskExtractFromDm(String(raw || "").replace(/<[^>]*>/g, " "), who.name);
  if (taches === null) { await say("Je n'arrive pas à analyser ta demande là tout de suite 🙈 Réessaie, ou passe par l'onglet To-do du cockpit."); return true; }
  if (!taches.length) return false; // pas une création de tâche : on laisse le reste du flux répondre
  const dmy = (d) => String(d).split("-").reverse().join("/");
  const done = [];
  for (const x of taches.slice(0, 10)) {
    const respName = USERS.map((u) => u.name).find((n) => normName(n) === normName(x.responsable)) || who.name;
    const props = {
      "Tâche": { title: [{ text: { content: String(x.tache || "").slice(0, 200) } }] },
      "Statut": { select: { name: "À faire" } },
      "Responsable": { select: { name: respName } },
    };
    if (x.echeance && /^\d{4}-\d{2}-\d{2}$/.test(String(x.echeance))) props["Échéance"] = { date: { start: x.echeance } };
    try { await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props }); done.push({ ...x, responsable: respName }); }
    catch (e) { await say("⚠️ Échec sur « " + String(x.tache || "") + " » : " + String((e && e.message) || e).slice(0, 100)); }
  }
  if (done.length) {
    invalidateTasksCache();
    await say("✅ Créé dans Notion :\n" + done.map((x) => "• « " + x.tache + " » → *" + x.responsable + "*" + (x.echeance ? " (pour le " + dmy(x.echeance) + ")" : "")).join("\n"));
    const byResp = {};
    done.forEach((x) => { (byResp[x.responsable] = byResp[x.responsable] || []).push(x); });
    for (const [name, list] of Object.entries(byResp)) {
      if (normName(name) === normName(who.name)) continue;
      const em = emailOf(name); const sid = em ? (COPILOT.slackIds || {})[em.toLowerCase()] : "";
      if (sid) { try { await copilotNotify({ slackUser: sid, text: "🆕 " + who.name + " t'a ajouté " + (list.length > 1 ? list.length + " tâches" : "une tâche") + " :\n" + list.map((x) => "• « " + x.tache + " »" + (x.echeance ? " (pour le " + dmy(x.echeance) + ")" : "")).join("\n") + "\nC'est dans ta to-do du cockpit ✨" }); } catch (e) {} }
    }
    if (done.length) { try { logActivity({ type: "tache_dm", creator: done.map((x) => x.tache).join(" · "), cp: who.name }); } catch (e) {} }
  }
  return true;
}
async function hypedbotHandle(ev) {
  const channel = ev.channel;
  const say = (text) => copilotNotify({ slackUser: channel, text });
  const who = slackWho(ev.user);
  if (!who) { await say("Je ne reconnais pas encore ton compte Slack 🙈 Demande à Mélany de m'ajouter ton identifiant (COPILOT_SLACK_IDS), et on pourra bosser ensemble."); return; }
  const raw = String(ev.text || "");
  // liens : Slack les enveloppe en <url> ou <url|libellé>
  const links = [...raw.matchAll(/<(https?:\/\/[^>|]+)(?:\|[^>]*)?>/g)].map((m) => m[1]);
  const plain = raw.replace(/<[^>]*>/g, " ");
  const low = nlow(plain);
  // réponses aux relances (« c'est fait », merci…) : prioritaires sur le flux « ajout de profil »
  if (!links.length) { try { if (await hypedbotDoneIntent(ev, who, low, say)) return; } catch (e) { try { console.error("[hypedbot done]", e.message); } catch (e2) {} } }
  if (!links.length) { try { if (await hypedbotTaskIntent(ev, who, raw, low, say)) return; } catch (e) { try { console.error("[hypedbot tache]", e.message); } catch (e2) {} } }
  const brand = quickBrandsList().find((b) => low.includes(nlow(b))) || "";
  const cpUser = USERS.map((u) => u.name).find((n) => new RegExp("(^|[^a-zà-ÿ])" + nlow(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "([^a-zà-ÿ]|$)").test(low)) || "";
  const pend = SLACK_PENDING[ev.user] && (Date.now() - SLACK_PENDING[ev.user].at < 10 * 60 * 1000) ? SLACK_PENDING[ev.user] : null;
  const state = { link: links[0] || (pend && pend.link) || "", brand: brand || (pend && pend.brand) || "", cp: cpUser || (pend && pend.cp) || "", at: Date.now() };
  // plusieurs liens d'un coup : on traite tous avec la même marque/CP
  const allLinks = links.length ? links : (state.link ? [state.link] : []);
  if (!allLinks.length) { SLACK_PENDING[ev.user] = state; await say("Envoie-moi le lien du profil (TikTok / Instagram), avec la marque et la CP. Ex. : `https://tiktok.com/@fille in haircare prunelle`"); return; }
  if (!state.brand) { SLACK_PENDING[ev.user] = { ...state, link: allLinks[0] }; await say("Pour quelle *marque* ? (" + quickBrandsList().slice(0, 6).join(", ") + "…)"); return; }
  if (!state.cp) {
    if (who.role !== "supervisor") state.cp = who.name; // une CP qui s'ajoute un profil = pour elle
    else { SLACK_PENDING[ev.user] = { ...state, link: allLinks[0] }; await say("Pour quelle *CP* ? (" + USERS.filter((u) => u.role !== "supervisor").map((u) => u.name).join(", ") + "… ou toi)"); return; }
  }
  delete SLACK_PENDING[ev.user];
  const done = [];
  for (const lk of allLinks.slice(0, 10)) {
    try {
      const props = {
        "Tâche": { title: [{ text: { content: "Contacter " + lk } }] },
        "Type": { select: { name: "Prise de contact" } },
        "Statut": { select: { name: "À faire" } },
        "Projet": { select: { name: state.brand } },
        "Responsable": { select: { name: state.cp } },
        "Lien profil": { url: lk },
      };
      await notion.pages.create({ parent: { database_id: TASKS_DB }, properties: props });
      invalidateTasksCache();
      done.push(lk);
      logActivity({ type: "profil_ajoute", creator: lk, brand: state.brand, cp: state.cp });
    } catch (e) { await say("⚠️ Échec sur " + lk + " : " + String((e && e.message) || e).slice(0, 100)); }
  }
  if (done.length) {
    await say("✅ Ajouté : " + done.length + " profil" + (done.length > 1 ? "s" : "") + " → *" + state.brand + "* → *" + state.cp + "* (À faire dans Notion, visible dans son onglet Profils).");
    try {
      const cpEmail3 = emailOf(state.cp);
      const su3 = cpEmail3 ? (COPILOT.slackIds[cpEmail3] || "") : "";
      if (su3 && su3 !== ev.user) await copilotNotify({ slackUser: su3, text: "🔎 " + done.length + " nouveau(x) profil(s) à contacter pour *" + state.brand + "* (ajouté par " + who.name + ") :\n" + done.join("\n") + "\nIls sont dans ton onglet Profils, messages d'approche prêts." });
    } catch (e) {}
  }
}
app.post("/slack/events", (req, res) => {
  const body = req.body || {};
  if (body.type === "url_verification") return res.send(body.challenge || ""); // poignée de main Slack
  if (!slackVerify(req)) return res.sendStatus(401);
  res.sendStatus(200); // acquitter sous 3 s, traiter ensuite
  try {
    const ev = body.event || {};
    if (body.event_id) { if (SLACK_SEEN.has(body.event_id)) return; SLACK_SEEN.add(body.event_id); if (SLACK_SEEN.size > 2000) SLACK_SEEN.clear(); }
    if (ev.type !== "message" || ev.channel_type !== "im") return;   // uniquement les DM
    if (ev.bot_id || ev.subtype) return;                             // jamais nos propres messages
    setImmediate(() => { hypedbotHandle(ev).catch((e) => { try { console.error("[hypedbot]", e.message); } catch (e2) {} }); });
  } catch (e) { try { console.error("[hypedbot] event :", e.message); } catch (e2) {} }
});
// --- Ajout express (mobile) : remplace le chatbot Make ------------------------
// Tu vois un profil sur les réseaux -> Partager -> cette page (lien prérempli via ?lien=),
// deux tapes (marque + CP) -> tâche Notion créée, CP notifiée sur Slack, message IA prêt.
app.get("/ajout", (req, res) => {
  res.send(`<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ajout express · Cockpit</title>
<style>
body{font-family:Montserrat,system-ui,sans-serif;background:#F5F3EE;color:#1C3A44;margin:0;padding:18px;display:flex;justify-content:center}
.card{background:#fff;border:1px solid #E4E0D5;border-radius:16px;padding:22px;max-width:430px;width:100%}
h1{font-size:17px;margin:0 0 4px}.sub{font-size:12px;color:#8A948F;margin:0 0 14px}
input{width:100%;box-sizing:border-box;font-family:inherit;font-size:15px;padding:12px;border:1px solid #E4E0D5;border-radius:10px;margin-bottom:12px}
.lbl{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#8A948F;margin:8px 0 6px}
.chips{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:6px}
.chip{border:1px solid #E4E0D5;border-radius:999px;padding:8px 14px;font-size:13.5px;cursor:pointer;background:#fff}
.chip.on{background:#1C3A44;color:#fff;border-color:#1C3A44}
button.go{width:100%;margin-top:14px;font-family:inherit;font-size:15px;font-weight:700;padding:14px;border-radius:12px;border:none;background:#2C9087;color:#fff;cursor:pointer}
.msg{margin-top:10px;font-size:13px;text-align:center;min-height:18px}
a{color:#2C9087}
</style></head><body><div class="card">
<h1>🔎 Ajout express</h1><p class="sub">Colle le lien du profil, choisis la marque et la CP : tâche créée dans Notion, CP prévenue sur Slack.</p>
<input id="lien" placeholder="Lien TikTok / Instagram ou @profil" autocomplete="off">
<div class="lbl">Marque</div><div class="chips" id="brands"></div>
<div class="lbl">Cheffe de projet</div><div class="chips" id="cps"></div>
<button class="go" id="go">＋ Ajouter le profil</button>
<div class="msg" id="msg"></div>
</div><script>
const $=id=>document.getElementById(id);
const p=new URLSearchParams(location.search);
$('lien').value=p.get('lien')||p.get('u')||p.get('url')||'';
let marque='',cp='';
function chips(el,list,cur,set){el.innerHTML='';list.forEach(v=>{const c=document.createElement('span');c.className='chip'+(v===cur?' on':'');c.textContent=v;c.onclick=()=>set(v);el.appendChild(c);});}
async function boot(){
  try{
    const r=await fetch('/api/quickmeta',{credentials:'include'});
    if(r.status===401){$('msg').innerHTML='Connecte-toi d\\'abord au <a href="/">cockpit</a> (une fois), puis reviens ici.';$('go').disabled=true;return;}
    const d=await r.json();
    window.__meta=d;
    marque=localStorage.getItem('aj_marque')||d.brands[0];cp=localStorage.getItem('aj_cp')||d.me;
    if(d.brands.indexOf(marque)<0)marque=d.brands[0];
    if(d.cps.indexOf(cp)<0)cp=d.me;
    boot2();
  }catch(e){$('msg').textContent='Réseau indisponible, réessaie.';}
}
function boot2(){const d=window.__meta;chips($('brands'),d.brands,marque,v=>{marque=v;localStorage.setItem('aj_marque',v);boot2();});chips($('cps'),d.cps,cp,v=>{cp=v;localStorage.setItem('aj_cp',v);boot2();});}
$('go').onclick=async()=>{
  const lien=$('lien').value.trim();
  if(!lien){$('msg').textContent='Colle d\\'abord le lien du profil 🙂';return;}
  $('go').disabled=true;$('go').textContent='Ajout…';
  try{
    const r=await fetch('/api/sourcing',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json'},body:JSON.stringify({profil:lien,marque,responsable:cp,notify:true})});
    const d=await r.json().catch(()=>({}));
    if(r.ok){$('msg').textContent='✅ Ajouté pour '+marque+', assigné à '+cp+' (prévenue sur Slack).';$('lien').value='';}
    else $('msg').textContent=d.error||('Erreur '+r.status);
  }catch(e){$('msg').textContent='Erreur réseau, réessaie.';}
  $('go').disabled=false;$('go').textContent='＋ Ajouter le profil';
};
boot();
</script></body></html>`);
});
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Cockpit ${DEMO ? "(DÉMO)" : "(Notion live, clients actifs)"} → http://localhost:${PORT}`));
