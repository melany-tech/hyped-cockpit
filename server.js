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
  const alerts = [];
  for (const c of FILL_CHECK) {
    if (c.unverifiable) { alerts.push({ brand: c.brand, status: "inconnu", monthLabel }); continue; }
    let count;
    try { count = await countInMonth(c.dbId, c.dateProp, iso(start), iso(end)); }
    catch (e) { alerts.push({ brand: c.brand, status: "erreur", monthLabel }); continue; }
    if (count === 0) alerts.push({ brand: c.brand, status: "vide", count, target, monthLabel });
    else if (count < target) alerts.push({ brand: c.brand, status: "faible", count, target, monthLabel });
  }
  return { monthLabel, minPerWeek: MIN_PER_WEEK, target, alerts };
}

// id utilisateur Notion -> prénom (pour les champs "personne")
let USERMAP = {};
async function resolveUsers() {
  let cursor;
  do {
    const r = await notion.users.list({ start_cursor: cursor, page_size: 100 });
    r.results.forEach((u) => { USERMAP[u.id] = (u.name || "").replace(/ Hyped Agency$/i, "").trim(); });
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
    let rows = await fetchRows();
    if (req.user.role !== "supervisor") rows = rows.filter((r) => r.cp === req.user.name);
    res.json({ rows, demo: DEMO, viewer: { name: req.user.name, role: req.user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/alerts", auth, async (req, res) => {
  if (req.user.role !== "supervisor") return res.json({ alerts: [] });
  if (DEMO) return res.json({ monthLabel: "juillet 2026", minPerWeek: MIN_PER_WEEK, target: 12, alerts: [
    { brand: "Doucéa", status: "vide", count: 0, target: 12, monthLabel: "juillet 2026" },
    { brand: "In Haircare", status: "faible", count: 5, target: 12, monthLabel: "juillet 2026" },
    { brand: "Curls Matter", status: "inconnu", monthLabel: "juillet 2026" } ] });
  try { res.json(await buildAlerts()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Cockpit ${DEMO ? "(DÉMO)" : "(Notion live, clients actifs)"} → http://localhost:${PORT}`));
