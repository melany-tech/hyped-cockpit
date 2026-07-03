/* Moteur d'analyse des mails - Hyped Agency
 * Capture par marque + détection des réponses créateurs, à partir des calendriers.
 *
 * PRÊT À BRANCHER : ce module est indépendant de la source des mails.
 * Quand une boîte CP (ou une boîte agence) sera connectée, il suffit d'écrire
 * un petit adaptateur qui renvoie des mails au format { id, threadId, from, subject, snippet, date, url }
 * (voir `fetchGmail` plus bas) et de passer le résultat à `analyzeMailbox`.
 *
 * Aucun mot générique (« influence », « collab ») : on n'utilise que des termes
 * PRÉCIS (nom de la marque + pseudos des créateurs réellement présents dans les
 * calendriers) pour éviter le bruit (annonces d'emploi, newsletters, recruteurs).
 */

// --- Normalisation -------------------------------------------------------
function norm(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// --- Bruit (jamais des collabs) -----------------------------------------
const NOISE_PATTERNS = [
  /salaire entre/i, /offre d['e ]?emploi/i, /\brecrut/i, /\bcdi\b/i, /\bcdd\b/i, /alternance/i,
  /welcome to the jungle/i, /linkedin/i, /indeed/i, /hellowork/i, /apec\b/i,
  /newsletter/i, /se d[ée]sabonner/i, /unsubscribe/i, /no[- ]?reply/i, /ne pas r[ée]pondre/i,
  /le parisien/i, /fnac/i, /\bsoldes?\b/i, /promo(tion)?\b/i, /facture.*(edf|free|orange|sfr|bouygues)/i,
];
function isNoise(email) {
  const t = `${email.from || ""} ${email.subject || ""} ${email.snippet || ""}`;
  return NOISE_PATTERNS.some((re) => re.test(t));
}
// Un expéditeur @hyped-agency.fr = membre de l'équipe (CP/pilote) qui écrit lui-même
// à un créateur. Ce n'est PAS une réponse créateur → pas de "Répondre à sa collègue".
function isFromTeam(email) {
  return /@hyped-agency\.fr/i.test(email && email.from || "");
}

// --- Mots-clés par marque (depuis les calendriers) ----------------------
function handleVariants(name) {
  const n = norm(name).replace(/^@/, "").trim();
  if (!n) return [];
  const set = new Set([n, n.replace(/[._-]/g, " "), n.replace(/[._-]/g, "")]);
  return [...set].filter((x) => x.length >= 4); // évite les termes trop courts/ambigus
}
function brandVariants(brand) {
  const n = norm(brand);
  return [...new Set([n, n.replace(/\s+/g, ""), n.replace(/\s+/g, "-")])].filter(Boolean);
}

/**
 * @param {Array} collabs  - [{ brand, name (= créateur) }, ...] (issu des calendriers)
 * @param {Object} brandProducts - optionnel : { "In Haircare": ["mask", "curl cream"], ... }
 * @returns Map<brand, { brand, terms:Set, creatorByTerm:Map }>
 */
function buildBrandKeywords(collabs, brandProducts = {}) {
  const map = {};
  for (const c of collabs || []) {
    if (!c.brand) continue;
    if (!map[c.brand]) map[c.brand] = { brand: c.brand, terms: new Set(), creatorByTerm: new Map() };
    brandVariants(c.brand).forEach((t) => map[c.brand].terms.add(t));
    (brandProducts[c.brand] || []).forEach((p) => map[c.brand].terms.add(norm(p)));
    for (const h of handleVariants(c.name)) {
      map[c.brand].terms.add(h);
      map[c.brand].creatorByTerm.set(h, c.name); // permet de retrouver QUEL créateur
    }
  }
  return map;
}

// --- Classement d'un mail -----------------------------------------------
function isReplySubject(subject) {
  return /^\s*(re|tr|rép|fwd?)\s*:/i.test(subject || "");
}
function category(email) {
  const t = norm(`${email.subject} ${email.snippet}`);
  if (/\bfactur|\brib\b|paiement|virement|r[ée]glement/.test(t)) return "facturation";
  if (/preview|aper[çc]u|validation|brouillon|draft/.test(t)) return "preview";
  if (/adresse|colis|envoi|livraison/.test(t)) return "logistique";
  return "réponse";
}

/**
 * Classe un mail. Renvoie { brand, créateur, category, isReply, isNoise, matched }.
 * brand = null si non rattaché à une marque (bruit ou hors-sujet).
 */
function classifyEmail(email, brandKeywords) {
  if (isNoise(email)) return { brand: null, créateur: null, isNoise: true };
  const text = norm(`${email.from} ${email.subject} ${email.snippet}`);
  for (const b of Object.values(brandKeywords)) {
    let hit = null;
    for (const term of b.terms) { if (term && text.includes(term)) { hit = term; break; } }
    if (!hit) continue;
    // marque trouvée : on identifie le créateur (priorité au pseudo présent dans le mail)
    let créateur = b.creatorByTerm.get(hit) || null;
    if (!créateur) {
      for (const [term, cr] of b.creatorByTerm) { if (text.includes(term)) { créateur = cr; break; } }
    }
    return {
      brand: b.brand, créateur, isNoise: false, matched: hit,
      isReply: isReplySubject(email.subject) || !!créateur,
      category: category(email),
    };
  }
  return { brand: null, créateur: null, isNoise: false }; // hors-sujet (ni bruit ni marque connue)
}

// --- Analyse d'une boîte complète ---------------------------------------
function analyzeMailbox(emails, collabs, brandProducts = {}) {
  const kw = buildBrandKeywords(collabs, brandProducts);
  const byBrand = {};
  const creatorReplies = [];
  const teamMails = []; // mails internes reçus d'un membre @hyped-agency.fr (pour le copilote, si activé)
  let noise = 0, offTopic = 0;
  for (const e of emails || []) {
    const r = classifyEmail(e, kw);
    if (r.isNoise) { noise++; continue; }
    const team = isFromTeam(e);
    if (team) teamMails.push({ ...e, ...r, interne: true });
    if (!r.brand) { if (!team) offTopic++; continue; }
    (byBrand[r.brand] ||= []).push({ ...e, ...r });
    // réponse créateur = un mail REÇU d'un créateur (donc PAS d'un @hyped-agency.fr)
    if (r.isReply && !team) creatorReplies.push({ ...e, ...r });
  }
  return {
    total: (emails || []).length,
    noise, offTopic,
    relevant: Object.values(byBrand).reduce((n, a) => n + a.length, 0),
    byBrand, creatorReplies, teamMails,
  };
}

// --- Adaptateur Gmail (À BRANCHER quand une boîte est connectée) ---------
// Implémentation type : prend un client Gmail et renvoie des mails normalisés.
// Laisse tel quel ; il suffira de le compléter le jour où une boîte CP est connectée.
async function fetchGmail(gmail, query = "newer_than:30d -in:sent -in:draft", max = 100) {
  // Pseudo-implémentation de référence (Gmail API) :
  // const list = await gmail.users.threads.list({ userId: "me", q: query, maxResults: max });
  // -> pour chaque thread, récupérer le dernier message et le mapper sur :
  //    { id, threadId, from, subject, snippet, date, url }
  throw new Error("fetchGmail: à implémenter avec le client Gmail de la boîte connectée.");
}

module.exports = {
  norm, isNoise, NOISE_PATTERNS,
  buildBrandKeywords, classifyEmail, analyzeMailbox, fetchGmail,
};
