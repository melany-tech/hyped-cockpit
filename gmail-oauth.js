/* Connexion Gmail PAR PERSONNE — Hyped Agency
 * Chaque cheffe de projet connecte SA propre boîte ; on ne lit JAMAIS la boîte d'une autre.
 * Scope minimal : lecture seule (gmail.readonly). Aucun mail n'est envoyé ni modifié.
 *
 * S'active uniquement si GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI
 * sont définis (sinon l'appli tourne normalement, sans la partie mails).
 */
const fs = require("fs");
const path = require("path");
const { analyzeMailbox } = require("./mail-analyzer");

const ENABLED = !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly", // visios du jour (lecture seule)
  "https://www.googleapis.com/auth/gmail.compose",     // créer des brouillons (jamais d'envoi auto)
];
// Choix du dossier de stockage : on PRÉFÈRE le disque persistant monté sur /var/data
// (les jetons survivent alors aux redéploiements), peu importe la variable DATA_DIR.
// Fallback : DATA_DIR si défini & accessible en écriture, sinon le dossier de l'app.
function resolveDataDir() {
  for (const d of ["/var/data", process.env.DATA_DIR, __dirname]) {
    if (!d) continue;
    try { fs.mkdirSync(d, { recursive: true }); fs.accessSync(d, fs.constants.W_OK); return d; } catch (e) {}
  }
  return __dirname;
}
const DATA_DIR = resolveDataDir();
const STORE = path.join(DATA_DIR, "gmail-tokens.json"); // jeton de rafraîchissement par email (survit aux redéploiements)
try { console.log("[gmail] stockage des jetons →", STORE); } catch (e) {}

let google = null;
if (ENABLED) { google = require("googleapis").google; }

function client() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}
// --- Stockage des jetons (par email de CP) ------------------------------
function loadStore() { try { return JSON.parse(fs.readFileSync(STORE, "utf8")); } catch (e) { return {}; } }
function saveStore(s) { try { fs.writeFileSync(STORE, JSON.stringify(s)); } catch (e) {} }
function setToken(email, tokens) { const s = loadStore(); s[email] = { ...(s[email] || {}), ...tokens }; saveStore(s); }
function getToken(email) { return loadStore()[email] || null; }
function isConnected(email) { return !!(getToken(email) && getToken(email).refresh_token); }
function connectedEmails() { const s = loadStore(); return Object.keys(s).filter((e) => s[e] && s[e].refresh_token); }

// --- Flux OAuth ---------------------------------------------------------
function getAuthUrl(stateEmail) {
  return client().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES,
    state: Buffer.from(stateEmail).toString("base64"), login_hint: stateEmail });
}
async function handleCallback(code, state) {
  const email = Buffer.from(state, "base64").toString("utf8");
  const c = client();
  const { tokens } = await c.getToken(code);
  setToken(email, tokens); // contient refresh_token (1re fois) + access_token
  return email;
}

// --- Lecture + analyse de LA boîte de cette CP --------------------------
function gmailFor(email) {
  const tok = getToken(email);
  if (!tok) return null;
  const c = client(); c.setCredentials(tok);
  return google.gmail({ version: "v1", auth: c });
}
async function fetchEmails(gmail, query = "newer_than:30d -in:sent -in:draft -category:promotions -category:social", max = 60) {
  const list = await gmail.users.threads.list({ userId: "me", q: query, maxResults: max });
  const out = [];
  for (const th of list.data.threads || []) {
    const t = await gmail.users.threads.get({ userId: "me", id: th.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
    const msgs = t.data.messages || [];
    const last = msgs[msgs.length - 1];
    const h = Object.fromEntries((last.payload?.headers || []).map((x) => [x.name, x.value]));
    out.push({ id: last.id, threadId: th.id, from: h.From || "", subject: h.Subject || "", snippet: last.snippet || "",
      date: h.Date || "", url: `https://mail.google.com/mail/u/0/#all/${th.id}` });
  }
  return out;
}
// --- Lecture du corps complet d'un fil (pour la réponse intelligente) ----
function b64urlDecode(s) {
  try { return Buffer.from(String(s || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch (e) { return ""; }
}
function htmlToText(h) {
  return String(h || "")
    .replace(/<\s*(br|\/p|\/div|\/li)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;/g, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function extractBody(payload) {
  if (!payload) return "";
  // privilégie text/plain, sinon text/html nettoyé
  let plain = "", html = "";
  const walk = (p) => {
    if (!p) return;
    const mt = p.mimeType || "";
    if (mt === "text/plain" && p.body?.data) plain += b64urlDecode(p.body.data) + "\n";
    else if (mt === "text/html" && p.body?.data) html += b64urlDecode(p.body.data) + "\n";
    (p.parts || []).forEach(walk);
  };
  walk(payload);
  const txt = plain.trim() || htmlToText(html);
  // coupe la citation du fil précédent (Le ... a écrit / lignes >)
  return txt
    .split(/\n\s*(?:Le\s.+?a écrit\s*:|On\s.+?wrote:|De\s*:|-{2,}\s*Message)/)[0]
    .split(/\n>/)[0]
    .trim()
    .slice(0, 4000);
}
/** Renvoie le texte du dernier message REÇU (pas de la boîte `email`) d'un fil. */
async function fetchThreadText(email, threadId) {
  const gmail = gmailFor(email);
  if (!gmail || !threadId) return { ok: false };
  try {
    const t = await gmail.users.threads.get({ userId: "me", id: threadId, format: "full" });
    const msgs = t.data.messages || [];
    const mine = String(email || "").toLowerCase();
    // dernier message dont l'expéditeur n'est PAS la boîte connectée
    let pick = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const h = Object.fromEntries((msgs[i].payload?.headers || []).map((x) => [x.name, x.value]));
      if (!String(h.From || "").toLowerCase().includes(mine)) { pick = { m: msgs[i], h }; break; }
    }
    if (!pick) { const m = msgs[msgs.length - 1]; pick = { m, h: Object.fromEntries((m?.payload?.headers || []).map((x) => [x.name, x.value])) }; }
    return { ok: true, from: pick.h.From || "", subject: pick.h.Subject || "", date: pick.h.Date || "", text: extractBody(pick.m.payload) || pick.m.snippet || "" };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

/** Analyse la boîte de `email` avec les créateurs/marques de `collabs`. */
async function analyzeFor(email, collabs, brandProducts = {}) {
  const gmail = gmailFor(email);
  if (!gmail) return { connected: false };
  const emails = await fetchEmails(gmail);
  return { connected: true, ...analyzeMailbox(emails, collabs, brandProducts) };
}

// --- Visios du jour : agenda Google de cette personne -------------------
async function calendarToday(email) {
  const tok = getToken(email);
  if (!tok) return { connected: false };
  const c = client(); c.setCredentials(tok);
  const cal = google.calendar({ version: "v3", auth: c });
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59);
  const r = await cal.events.list({
    calendarId: "primary", timeMin: start.toISOString(), timeMax: end.toISOString(),
    singleEvents: true, orderBy: "startTime", maxResults: 25,
  });
  const events = (r.data.items || [])
    .filter((e) => e.status !== "cancelled")
    .map((e) => {
      const video = (e.conferenceData?.entryPoints || []).find((p) => p.entryPointType === "video");
      return {
        id: e.id, title: e.summary || "(sans titre)",
        start: e.start?.dateTime || e.start?.date || null,
        end: e.end?.dateTime || e.end?.date || null,
        allDay: !e.start?.dateTime,
        meet: e.hangoutLink || video?.uri || null,
        location: e.location || null,
        htmlLink: e.htmlLink || null,
      };
    });
  return { connected: true, events };
}

// --- Brouillons : le cockpit prépare, la CP relit et envoie depuis Gmail ---
const DRAFTS_STORE = path.join(DATA_DIR, "gmail-drafts.json");
function loadDrafts() { try { return JSON.parse(fs.readFileSync(DRAFTS_STORE, "utf8")); } catch (e) { return {}; } }
function saveDrafts(s) { try { fs.writeFileSync(DRAFTS_STORE, JSON.stringify(s)); } catch (e) {} }
function b64url(s) { return Buffer.from(s, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function encSubject(s) { return "=?UTF-8?B?" + Buffer.from(s || "", "utf8").toString("base64") + "?="; }
function mime({ to, subject, body }) {
  return [
    "To: " + (to || ""),
    "Subject: " + encSubject(subject || ""),
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    body || "",
  ].join("\r\n");
}
/** Crée un brouillon dans la boîte de `email`. N'envoie rien. */
async function createDraft(email, { to, subject, body }) {
  const gmail = gmailFor(email);
  if (!gmail) return { ok: false, error: "non connecté" };
  const raw = b64url(mime({ to, subject, body }));
  const r = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  const s = loadDrafts(); (s[email] = s[email] || []).push(r.data.id); saveDrafts(s);
  return { ok: true, id: r.data.id };
}
/** Envoie un mail (sur clic explicite de la CP). Nécessite un destinataire. */
async function sendEmail(email, { to, subject, body }) {
  const gmail = gmailFor(email);
  if (!gmail) return { ok: false, error: "non connecté" };
  if (!to) return { ok: false, error: "destinataire manquant" };
  const raw = b64url(mime({ to, subject, body }));
  const r = await gmail.users.messages.send({ userId: "me", requestBody: { raw } });
  return { ok: true, id: r.data.id };
}
/** Compte nos brouillons encore présents (= pas encore envoyés). Élague ceux envoyés. */
async function draftsToValidate(email) {
  const gmail = gmailFor(email);
  if (!gmail) return { count: 0 };
  const store = loadDrafts(); const ours = store[email] || [];
  if (!ours.length) return { count: 0 };
  const list = await gmail.users.drafts.list({ userId: "me", maxResults: 200 });
  const present = new Set((list.data.drafts || []).map((d) => d.id));
  const keep = ours.filter((id) => present.has(id));
  store[email] = keep; saveDrafts(store);
  return { count: keep.length };
}

module.exports = { ENABLED, isConnected, connectedEmails, getAuthUrl, handleCallback, analyzeFor, calendarToday, createDraft, sendEmail, draftsToValidate, fetchThreadText, SCOPES };
