/* Connexion Gmail PAR PERSONNE - Hyped Agency
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
  "https://www.googleapis.com/auth/gmail.settings.basic", // lire la signature Gmail de la personne
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
async function fetchEmails(gmail, query = "newer_than:30d -in:sent -in:draft -category:promotions -category:social", max = 50) {
  const list = await gmail.users.threads.list({ userId: "me", q: query, maxResults: max });
  // EN PARALLÈLE : on récupère les fils tous en même temps (au lieu d'un par un), démarrage bien plus rapide
  const results = await Promise.all((list.data.threads || []).map(async (th) => {
    try {
      const t = await gmail.users.threads.get({ userId: "me", id: th.id, format: "metadata", metadataHeaders: ["From", "Subject", "Date"] });
      const msgs = t.data.messages || [];
      const last = msgs[msgs.length - 1];
      const h = Object.fromEntries((last.payload?.headers || []).map((x) => [x.name, x.value]));
      return { id: last.id, threadId: th.id, from: h.From || "", subject: h.Subject || "", snippet: last.snippet || "",
        date: h.Date || "", url: `https://mail.google.com/mail/u/0/#all/${th.id}` };
    } catch (e) { return null; }
  }));
  return results.filter(Boolean);
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
    // TOUTE adresse @hyped-agency.fr = l'agence (pas seulement la boîte connectée) :
    // sinon les mails des collègues (Rozenn, Kendia…) passaient pour ceux du créateur
    // et l'IA attribuait les propositions de l'agence au créateur. Catastrophique en négo.
    const isAgence = (from) => /@hyped-agency\.fr/i.test(String(from || ""));
    // dernier message dont l'expéditeur n'est PAS l'agence (= le vrai dernier mot du créateur)
    let pick = null;
    for (let i = msgs.length - 1; i >= 0; i--) {
      const h = Object.fromEntries((msgs[i].payload?.headers || []).map((x) => [x.name, x.value]));
      if (!isAgence(h.From)) { pick = { m: msgs[i], h }; break; }
    }
    if (!pick) { const m = msgs[msgs.length - 1]; pick = { m, h: Object.fromEntries((m?.payload?.headers || []).map((x) => [x.name, x.value])) }; }
    // transcript complet du fil (du + ancien au + récent), pour juger sur l'historique
    const transcript = msgs.map((m) => {
      const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name, x.value]));
      const who = isAgence(h.From) ? ("NOUS (agence · " + String(h.From).replace(/<.*$/, "").trim() + ")") : "CRÉATEUR";
      const body = extractBody(m.payload) || m.snippet || "";
      return who + " : " + body;
    }).join("\n\n---\n\n").slice(0, 7000);
    return { ok: true, from: pick.h.From || "", subject: pick.h.Subject || "", date: pick.h.Date || "", text: extractBody(pick.m.payload) || pick.m.snippet || "", transcript };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}

// Date (ms) du dernier message envoyé PAR la boîte connectée dans un fil (0 si aucun).
// Sert au copilote : si la CP a répondu directement depuis Gmail, le mail est considéré traité.
async function lastReplyFromMe(email, threadId) {
  const gmail = gmailFor(email);
  if (!gmail || !threadId) return 0;
  try {
    const t = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: ["From"] });
    const mine = String(email || "").toLowerCase();
    let last = 0;
    for (const m of (t.data.messages || [])) {
      const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name, x.value]));
      if (String(h.From || "").toLowerCase().includes(mine)) last = Math.max(last, Number(m.internalDate || 0));
    }
    return last;
  } catch (e) { return 0; }
}

// Le fil contient-il un participant EXTERNE (créateur, marque…) ? Sert au copilote :
// un mail de collègue sur une conversation externe n'est pas un « mail interne » à répondre.
async function threadHasExternal(email, threadId) {
  const gmail = gmailFor(email);
  if (!gmail || !threadId) return false;
  try {
    const t = await gmail.users.threads.get({ userId: "me", id: threadId, format: "metadata", metadataHeaders: ["From"] });
    for (const m of (t.data.messages || [])) {
      const h = Object.fromEntries((m.payload?.headers || []).map((x) => [x.name, x.value]));
      if (h.From && !/@hyped-agency\.fr/i.test(String(h.From))) return true;
    }
    return false;
  } catch (e) { return false; }
}

// --- Pièces jointes + liens de transfert (WeTransfer, Drive, Dropbox…) -----
function humanSize(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + " Go";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + " Mo";
  if (n >= 1e3) return Math.round(n / 1e3) + " Ko";
  return n + " o";
}
const TRANSFER_RE = /https?:\/\/[^\s"'<>)]*(?:we\.tl|wetransfer\.com|swisstransfer\.com|grosfichiers\.com|fromsmash\.com|smash\.io|drive\.google\.com|dropbox\.com|dropbox\.io|onedrive\.live\.com|1drv\.ms|mega\.nz|frame\.io|icloud\.com)[^\s"'<>)]*/gi;
function extractTransferLinks(text) {
  const set = new Set((String(text || "").match(TRANSFER_RE) || []).map((u) => u.replace(/[.,;)]+$/, "")));
  return [...set].slice(0, 6);
}
/** Pour un message : renvoie ses pièces jointes (nom/type/taille) et ses liens de transfert. */
async function attachmentsAndLinks(gmail, msgId) {
  try {
    const m = await gmail.users.messages.get({ userId: "me", id: msgId, format: "full" });
    const atts = [];
    const walk = (p) => {
      if (!p) return;
      if (p.filename && p.filename.length && p.body && p.body.attachmentId) {
        atts.push({ filename: p.filename, mimeType: p.mimeType || "", size: p.body.size || 0, sizeLabel: humanSize(p.body.size), msgId, attId: p.body.attachmentId });
      }
      (p.parts || []).forEach(walk);
    };
    walk(m.data.payload);
    const links = extractTransferLinks(extractBody(m.data.payload) || m.data.snippet || "");
    return { attachments: atts.slice(0, 8), links };
  } catch (e) { return { attachments: [], links: [] }; }
}

/** Télécharge le contenu binaire d'une pièce jointe. */
async function getAttachment(email, msgId, attId) {
  const gmail = gmailFor(email);
  if (!gmail || !msgId || !attId) return null;
  try {
    const r = await gmail.users.messages.attachments.get({ userId: "me", messageId: msgId, id: attId });
    const data = r.data && r.data.data ? Buffer.from(String(r.data.data).replace(/-/g, "+").replace(/_/g, "/"), "base64") : null;
    return data;
  } catch (e) { return null; }
}

/** Analyse la boîte de `email` avec les créateurs/marques de `collabs`. */
async function analyzeFor(email, collabs, brandProducts = {}) {
  const gmail = gmailFor(email);
  if (!gmail) return { connected: false };
  const emails = await fetchEmails(gmail, undefined, 80); // 80 fils : couvre aussi les boîtes chargées
  const res = analyzeMailbox(emails, collabs, brandProducts);
  // EN PARALLÈLE : on enrichit (PJ + liens) toutes les réponses créateurs en même temps
  await Promise.all((res.creatorReplies || []).map(async (r) => {
    const x = await attachmentsAndLinks(gmail, r.id);
    r.attachments = x.attachments; r.transferLinks = x.links;
  }));
  return { connected: true, ...res };
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
function htmlEsc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// --- Signature Gmail réelle de la personne (lue via l'API, mise en cache) ---
const SIG_CACHE = {}; // email -> { at, html }
const SIG_TTL = 60 * 60 * 1000; // 1 h
async function getSignature(email) {
  const c = SIG_CACHE[email];
  if (c && (Date.now() - c.at) < SIG_TTL) return c.html;
  try {
    const gmail = gmailFor(email);
    if (!gmail) return "";
    const r = await gmail.users.settings.sendAs.list({ userId: "me" });
    const list = r.data.sendAs || [];
    const mine = String(email || "").toLowerCase();
    const pick = list.find((s) => String(s.sendAsEmail || "").toLowerCase() === mine)
      || list.find((s) => s.isPrimary) || list.find((s) => s.isDefault) || list[0];
    const html = (pick && pick.signature) ? String(pick.signature) : "";
    SIG_CACHE[email] = { at: Date.now(), html };
    return html; // "" = autorisation OK mais aucune signature configurée dans Gmail
  } catch (e) { return null; } // null = scope pas encore accordé (à distinguer de "pas de signature")
}

// Construit le MIME. Avec signature HTML -> multipart/alternative (texte + HTML).
function mime({ to, cc, bcc, subject, body, sigHtml }) {
  const headers = [
    "To: " + (to || ""),
  ];
  if (cc) headers.push("Cc: " + cc);
  if (bcc) headers.push("Bcc: " + bcc);
  headers.push(
    "Subject: " + encSubject(subject || ""),
    "MIME-Version: 1.0",
  );
  if (!sigHtml) {
    return headers.concat(["Content-Type: text/plain; charset=UTF-8", "", body || ""]).join("\r\n");
  }
  const bnd = "hyped_" + Date.now().toString(36);
  const textPart = (body || "") + "\r\n\r\n" + htmlToText(sigHtml);
  const htmlPart = htmlEsc(body || "").replace(/\r?\n/g, "<br>") + "<br><br>" + sigHtml;
  return headers.concat([
    'Content-Type: multipart/alternative; boundary="' + bnd + '"',
    "",
    "--" + bnd,
    "Content-Type: text/plain; charset=UTF-8",
    "",
    textPart,
    "",
    "--" + bnd,
    "Content-Type: text/html; charset=UTF-8",
    "",
    htmlPart,
    "",
    "--" + bnd + "--",
    "",
  ]).join("\r\n");
}
/** Crée un brouillon dans la boîte de `email`. N'envoie rien. */
async function createDraft(email, { to, cc, bcc, subject, body }) {
  const gmail = gmailFor(email);
  if (!gmail) return { ok: false, error: "non connecté" };
  const sigHtml = await getSignature(email);
  const raw = b64url(mime({ to, cc, bcc, subject, body, sigHtml }));
  const r = await gmail.users.drafts.create({ userId: "me", requestBody: { message: { raw } } });
  const s = loadDrafts(); (s[email] = s[email] || []).push(r.data.id); saveDrafts(s);
  return { ok: true, id: r.data.id };
}
/** Envoie un mail (sur clic explicite de la CP). Nécessite un destinataire. */
async function sendEmail(email, { to, cc, bcc, subject, body }) {
  const gmail = gmailFor(email);
  if (!gmail) return { ok: false, error: "non connecté" };
  if (!to) return { ok: false, error: "destinataire manquant" };
  const sigHtml = await getSignature(email);
  const raw = b64url(mime({ to, cc, bcc, subject, body, sigHtml }));
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

module.exports = { ENABLED, isConnected, connectedEmails, getAuthUrl, handleCallback, analyzeFor, calendarToday, createDraft, sendEmail, draftsToValidate, fetchThreadText, lastReplyFromMe, threadHasExternal, getSignature, getAttachment, SCOPES };
