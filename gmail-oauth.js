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
const SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
const STORE = path.join(__dirname, "gmail-tokens.json"); // jeton de rafraîchissement par email (cf. note persistance)

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
/** Analyse la boîte de `email` avec les créateurs/marques de `collabs`. */
async function analyzeFor(email, collabs, brandProducts = {}) {
  const gmail = gmailFor(email);
  if (!gmail) return { connected: false };
  const emails = await fetchEmails(gmail);
  return { connected: true, ...analyzeMailbox(emails, collabs, brandProducts) };
}

module.exports = { ENABLED, isConnected, connectedEmails, getAuthUrl, handleCallback, analyzeFor, SCOPES };
