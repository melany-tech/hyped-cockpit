/* Cockpit des chefs de projet — Hyped Agency
 * Lit la RÉALITÉ : auto-détecte chaque base Notion « COLLABORATIONS [CLIENT] »,
 * les agrège, et filtre par Interlocuteur (= la cheffe de projet).
 * Login par personne (JWT). Sans NOTION_TOKEN → MODE DÉMO (sample-data.json, format réel).
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
const USERS = loadUsers(); // [{email, name (= Interlocuteur), role, passwordHash}]

let notion = null;
if (!DEMO) {
  const { Client } = require("@notionhq/client");
  notion = new Client({ auth: process.env.NOTION_TOKEN });
}

// --- Découverte + agrégation des calendriers clients --------------------
let CACHE = { at: 0, rows: [] };
async function discoverCollabDatabases() {
  const dbs = [];
  let cursor;
  do {
    const r = await notion.search({
      query: "COLLABORATIONS",
      filter: { property: "object", value: "database" },
      start_cursor: cursor,
      page_size: 100,
    });
    for (const db of r.results) {
      const title = (db.title || []).map((t) => t.plain_text).join("").trim();
      if (/^COLLABORATIONS/i.test(title)) dbs.push({ id: db.id, title });
    }
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return dbs;
}
function P(props, name) { return props && props[name] ? props[name] : null; }
function normalize(page, brand) {
  const p = page.properties || {};
  return {
    brand,
    name: (P(p, "Name")?.title || []).map((t) => t.plain_text).join("") || "(sans nom)",
    interlocuteur: P(p, "Interlocuteur")?.select?.name || null,
    statut: P(p, "Statut")?.select?.name || null,
    date: P(p, "Date")?.date?.start || null,
    preview: P(p, "Preview reçue ?")?.select?.name || null,
    tarif: P(p, "Tarif")?.number ?? null,
    type: P(p, "Type")?.select?.name || null,
    url: page.url,
  };
}
async function fetchAllReal() {
  if (Date.now() - CACHE.at < 60000 && CACHE.rows.length) return CACHE.rows;
  const dbs = await discoverCollabDatabases();
  const rows = [];
  for (const db of dbs) {
    const brand = db.title.replace(/^COLLABORATIONS\s*/i, "").trim() || db.title;
    let cursor;
    try {
      do {
        const r = await notion.databases.query({ database_id: db.id, start_cursor: cursor, page_size: 100 });
        r.results.forEach((pg) => rows.push(normalize(pg, brand)));
        cursor = r.has_more ? r.next_cursor : null;
      } while (cursor);
    } catch (e) { console.warn("query", brand, e.message); }
  }
  CACHE = { at: Date.now(), rows };
  return rows;
}
async function fetchRows() {
  if (DEMO) return JSON.parse(fs.readFileSync(path.join(__dirname, "sample-data.json"), "utf8"));
  return fetchAllReal();
}

// --- App ----------------------------------------------------------------
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
    if (req.user.role !== "supervisor") rows = rows.filter((r) => r.interlocuteur === req.user.name);
    res.json({ rows, demo: DEMO, viewer: { name: req.user.name, role: req.user.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.listen(PORT, () => console.log(`Cockpit ${DEMO ? "(DÉMO)" : "(Notion live, auto-agrégation)"} → http://localhost:${PORT}`));
