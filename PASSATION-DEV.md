# Hyped Cockpit · Passation développeur

> Document de reprise pour tout·e dev qui prend le relais.
> Dernière mise à jour : 22 juillet 2026.
> Propriétaire produit : Mélany (melany@hyped-agency.fr).

---

## 1. Ce que c'est

Cockpit web interne de l'agence Hyped : suivi des collaborations créateurs/influenceuses, mails, to-do, finances, RH, roadmap, budgets par marque. Une seule appli, un login par personne, des vues différentes selon le rôle.

- **URL de prod** : https://hyped-cockpit.onrender.com
- **Repo GitHub** : `melany-tech/hyped-cockpit` (branche `main`)
- **Hébergement** : Render — service web `srv-d8vadqsm0tmc7393ibpg` (plan Starter, Node)

---

## 2. Stack

- **Backend** : Node.js + Express (un seul gros fichier `server.js`).
- **Frontend** : une seule page HTML avec tout le JS inline. Pas de framework, pas de bundler.
- **Base de données** : aucune. Tout est stocké en fichiers JSON sur un disque persistant Render (`/var/data`).
- **Dépendances** (package.json) : express, @notionhq/client, googleapis, jsonwebtoken, bcryptjs, cookie-parser, dotenv, pdf-parse.

---

## 3. ⚠️ STRUCTURE DU REPO — À LIRE EN PREMIER

**L'appli tourne depuis la RACINE du repo, pas depuis le dossier `deploy/`.**

Sur le serveur Render, le code est dans `/opt/render/project/src` et la commande de démarrage est `node server.js` (le `server.js` de la racine). Le serveur sert le `index.html` de la racine (`app.get("*", … sendFile(__dirname + "/index.html"))`).

Le repo contient AUSSI un sous-dossier `deploy/` qui est une **copie/vestige historique**. Modifier les fichiers dans `deploy/` sur GitHub **n'a AUCUN effet** sur la prod. Ça a coûté plusieurs heures de debug : ne pas retomber dans le piège.

**Règle d'or : les fichiers déployés (`index.html`, `server.js`, `index.real2.html`) doivent être commités à la RACINE du repo.**

> Piste d'amélioration : supprimer le dossier `deploy/` du repo pour éviter toute confusion future, OU configurer Render "Root Directory = deploy" et n'utiliser que celui-là. Aujourd'hui c'est la racine qui fait foi.

### Fichiers clés (à la racine)
- `server.js` — tout le backend (routes API, auth, intégrations).
- `index.real2.html` — **la SOURCE du frontend** (c'est ce fichier qu'on édite).
- `index.html` — le frontend **généré** à partir de `index.real2.html` (c'est ce qui est servi). Ne jamais l'éditer à la main.
- `build_front.py` — script de build : lit `index.real2.html`, injecte la police et 2 logos en base64, écrit `index.html`.
- `gmail-oauth.js` — intégration Gmail/Google Agenda (OAuth).
- `mail-analyzer.js` — classification des mails.
- `package.json` — `start: node server.js`.

---

## 4. Workflow de déploiement (étape par étape)

1. **Éditer** `deploy/index.real2.html` (ou le `index.real2.html` de ta copie locale) — jamais `index.html` directement.
2. **Builder** : `python3 build_front.py` → régénère `index.html`.
   - ⚠️ Le build a un **garde anti tiret-quadratin** : le caractère `—` (em-dash) est INTERDIT dans le front (préférence produit de Mélany). Utiliser `·` ou `:` à la place. Le build échoue s'il en trouve.
   - Police par défaut : **Montserrat**.
3. **Vérifier** : `node --check server.js` et extraire le `<script>` principal de `index.html` pour le passer à `node --check` (attrape les erreurs de syntaxe inline).
4. **Commiter sur GitHub à la RACINE** : page `github.com/melany-tech/hyped-cockpit/upload/main` (PAS `/upload/main/deploy`). Uploader `index.html`, `index.real2.html` et/ou `server.js`, message de commit, "Commit directly to main", "Commit changes".
5. **Déployer sur Render** : dashboard → service → **Manual Deploy → Deploy latest commit**. (~50 s. Le menu déroulant se referme parfois au premier clic : recliquer "Manual Deploy" puis "Deploy latest commit".)
6. **Vérifier en prod** : recharger le site. Un `Cache-Control: no-cache` est désormais posé sur `index.html`, donc les déploiements sont visibles sans vider le cache (voir §5).

> Si un déploiement "ne change rien" en prod alors que le commit est bien là : vérifier via le **Shell Render** (`grep` dans `/opt/render/project/src/index.html`) qu'on a bien uploadé à la racine et pas dans `deploy/`.

---

## 5. Cache

`index.html` est servi avec `Cache-Control: no-cache, must-revalidate` (dans le `app.get("*")` de `server.js`). Le navigateur revalide à chaque chargement → un nouveau déploiement est visible tout de suite. Note : `res.sendFile` d'Express réécrit l'en-tête en `public, max-age=0`, donc l'en-tête visible peut différer, mais le comportement de revalidation est OK car l'ETag change à chaque build.

---

## 6. Données & persistance

- Répertoire de données : `DATA_DIR` = `/var/data` (disque persistant Render). En local, fallback sur `__dirname`.
- **Fichier central : `ceo.json`** (`o.roadmap`, `o.crm`, `o.missions`, `o.attendus`, `o.encAttr`, `o.finPrev`, `o.persoTodo`, `o.mood`, etc.). Beaucoup de choses y sont regroupées **parce que les fichiers JSON nouvellement créés n'étaient pas persistés de façon fiable** — quand tu ajoutes une nouvelle donnée persistante, préfère l'ajouter dans un JSON déjà existant (ex. `ceo.json`) plutôt que créer un nouveau fichier.
- Autres stores : `rh.json` (absences, quotas, fiches/`profils`, docs), `weekly.json`, `relances_ig.json`, `treated.json`, `assignments.json`, `brands.json`, `copilot.json`, `activity.json`, etc. Tous dans `DATA_DIR`.
- Fichiers binaires (docs RH, pièces jointes weekly) : dans des sous-dossiers de `DATA_DIR`.

### Sauvegardes
- **Code** : historique Git complet sur GitHub + Rollback Render à chaque déploiement.
- **Données** : ⚠️ uniquement sur le disque persistant Render. **Pas de sauvegarde externe automatique.** Si tu veux durcir : mettre en place un export/backup quotidien (ex. mail avec les JSON en pièce jointe via `gmail-oauth.js` qui supporte les pièces jointes) ou migrer vers Postgres.

---

## 7. Modèle de permissions (IMPORTANT)

Trois rôles utilisateurs : `cp` (cheffe de projet), `supervisor` (direction/superviseure), `team` (ex. social media). Définis dans le store users.

Mais surtout : une notion de **propriétaire** ajoutée par-dessus les rôles.

```js
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "melany@hyped-agency.fr").toLowerCase();
function isOwner(req) { return String(req.user?.email||"").toLowerCase() === OWNER_EMAIL; }
```

`isOwner` sert à réserver les données/fonctions sensibles à **Mélany uniquement**, même vis-à-vis des autres superviseures (ex. Rozenn est `supervisor` mais PAS propriétaire).

Le viewer envoyé au front inclut `owner: isOwner(req)` → côté front on teste `VIEWER.owner`.

### Réservé au propriétaire (owner-only)
- **Finance** : onglet + KPIs Facturé/Encaissé + toutes les données Pennylane (`/api/ceo` strippe les champs finance pour les non-owners ; `/api/finance/*`, `/api/ceo/pennylane*` renvoient 403).
- **Vue CEO** (le `ceopanel` plein écran) : gated par `VIEWER.owner`. Les autres superviseures ont la "Vue détaillée" (dirigeant) mais pas le panneau CEO.
- **Commercial** (`/api/crm`).
- **Suivi de projets / "Vue CEO" des missions** (`/api/missions`).
- **Weekly** ("À dire à la weekly", extraction de tâches des visios : `/api/weekly*`).
- **Roadmap** : lecture seule pour les non-owners (ils voient, ne modifient pas — `/api/ceo/roadmap` en écriture est owner-only). Cadenas 🔒 par initiative : `it.private` masque l'initiative aux non-owners (filtré dans `/api/ceo`).
- **RH admin** : les fiches de toute l'équipe (RIB, contrats, adresses), quotas, validation des absences, dépôt/suppression de docs pour autrui → owner-only. Chaque personne ne voit/gère que SON propre RH (`/api/rh` et `/api/rh/fiches` renvoient `supervisor: isOwner(req)` et filtrent sur la personne connectée).

### Accessible à l'équipe
- **Budget** (`/api/budget/*`) — volontairement ouvert à l'équipe.
- To-do, Campagnes, Contenus, Marques, Process, Calendrier, Messages, Rapports.
- Le suivi d'équipe "Mon équipe / dirigeant" reste dispo aux superviseures (mais **Mélany n'apparaît jamais** dans l'équipe vue par les autres — filtrée par email côté serveur : team list, oversight, agenda, et `inboxTarget` bloque la consultation de la boîte/agenda du propriétaire par un autre superviseur).

### Garde-fous
- Front : nav masquée + `showView()` renvoie au cockpit si un non-owner tente `finance/commercial/projets`.
- Serveur : chaque route sensible fait `if(!isOwner(req)) return 403`. **La sécurité réelle est côté serveur** (le masquage front n'est que cosmétique).

---

## 8. Intégrations externes

- **Pennylane** (compta/finance) : External API v2. Clé soit dans la variable d'env `PENNYLANE_API_KEY` (prioritaire), soit stockée sur disque (`pennylane_key.txt`) via l'onglet Finance. Endpoints utilisés : `/customer_invoices`, `/transactions` (scope `transactions:readonly`), `/bank_accounts`. Le nom du client est souvent absent dans les transactions → on l'extrait du **libellé** par regex sur le numéro de facture `F-AAAA-MM-NNNNN`. Voir `pennylaneSnapshot()`.
- **Gmail / Google Agenda** : `gmail-oauth.js`, OAuth par personne. Sert les mails créateurs, l'agenda du jour, la création d'événements "OFF" à la validation d'un congé, l'envoi de mails (supporte les pièces jointes). Chaque personne connecte son propre Google.
- **Notion** : `@notionhq/client`. Base des tâches équipe (`TASKS_DB = 5e993c84-9927-4c20-986b-32c2a14c2cbf`). Les tâches agence viennent de là (`/api/todo`). Cache 60 s (`TASKS_CACHE`).
- **Slack** : notifications (demandes d'absence, tâches assignées, décisions) via `copilotNotify` / `rhSlackTo`.

---

## 9. Fonctionnalités par onglet (survol)

- **Cockpit** (accueil) : KPIs, agenda, priorités, suivi équipe. Vue CEO plein écran pour la propriétaire.
- **Messages** : mails créateurs classés par marque, réponses à traiter, brouillons, **relances Instagram** (créatrices sans réponse ≥ 5 j). Un détecteur `isAuto()` exclut les mails automatiques/signatures (YouSign, DocuSign, "a signé", "formulaire", no-reply…) des relances et des réponses créateurs. "Ouvrir le fil" affiche le fil dans le cockpit (via `/api/copilot/thread`), sans renvoyer sur Gmail.
- **To-do** : un seul tableau qui fusionne les tâches perso (dans `ceo.json` → `o.persoTodo`, par thématique/colonnes, vues Kanban/Semaine/Liste) + les tâches agence Notion **de la personne connectée uniquement** (filtre `?qui=` + filtre front sur `responsable`). Colonnes = marques + Interne + Social Media + Personal branding + Maintenance. Drag & drop, couleurs, cadenas de colonnes.
- **Finance** (owner) : Facturé/Encaissé, trésorerie, encaissé par service (fees vs pocket), prévisionnel, encaissements attendus + rapprochement avec virements Pennylane.
- **Budget** (équipe) : budgets par marque, conso, saisie d'entrées (`/api/budget/*`).
- **Roadmap** : Kanban Q1–Q4 par axe. Éditable pour la propriétaire, lecture seule pour les autres. Cadenas 🔒 privé par initiative.
- **Commercial** (owner) : CRM léger (deals/pipeline).
- **Projets** (owner) : suivi des missions vendues (Vue CEO).
- **RH** : demande d'absence, congés, fiches, documents. Admin (toute l'équipe) réservé à la propriétaire ; chacune ne voit que son propre RH. **Freelances** : détectés via le champ `Contrat = Freelance` de la fiche → affichage "Congés" (pas "Congés payés") et **pas de décompte** de jours ; le type d'absence proposé s'appelle "Congés". Logique dans `rhLeave()` (flag `freelance`).

---

## 10. Points d'attention / dette technique

- **Racine vs `deploy/`** (§3) : le piège numéro un.
- **`index.real2.html` = source, `index.html` = build** : toujours passer par `build_front.py`.
- **Interdiction du `—`** dans le front (build cassé sinon).
- **Pas de tests automatisés.** Vérif = `node --check` + tests manuels en prod.
- **Données non sauvegardées hors Render** (§6).
- **Tout le front dans un seul fichier de ~800 Ko** : chercher avec grep, éditer chirurgicalement.
- Le menu "Manual Deploy" de Render se referme parfois : recliquer.
- Les fichiers JSON nouvellement créés ne persistaient pas de façon fiable → regrouper dans `ceo.json`.

---

## 11. Contacts / accès

- Propriétaire produit : **Mélany** (melany@hyped-agency.fr).
- GitHub : compte `melany-tech`, repo `hyped-cockpit`.
- Render : dashboard sous le workspace de Mélany, service `hyped-cockpit`.
- Variables d'env sensibles (Render → Environment) : clés Pennylane, secrets OAuth Google, token Notion, secrets Slack, `JWT_SECRET`, éventuellement `OWNER_EMAIL`.

---

*Fin du document de passation. Pour l'historique détaillé plus ancien, voir `HANDOFF.md` (peut être partiellement obsolète — ce fichier-ci fait foi pour l'état actuel).*
