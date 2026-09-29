# SPEC: AILA School voice and translation collector

You are a coding agent. Build exactly what this document describes. Every decision below is final. If something is ambiguous, pick the simplest option that satisfies the acceptance criteria in section 16 and note it in the README. Do not add features that are not listed.

---

## 1. Goal

A very light web app to collect **voice recordings** (and an optional **written translation**) of French words and expressions, in three languages:

| Code | Label shown to users |
|---|---|
| `ewondo` | Ewondo |
| `basaa` | Basaa |
| `ghomala` | Ghomala de Bandjoun |

- **Public side:** contributors open a link, give their email, choose **one** language, then go through the French words **one at a time**, recording the word and optionally typing the translation.
- **Private side:** the owner opens a password-protected dashboard to listen to and view all responses, filter them, and download everything.

The word list has **363 entries** (section 3). It is the same list for all three languages.

Core principles: extremely simple to use, mobile-first (most contributors use phones), nothing is mandatory, every word saves as soon as the contributor moves on, contributors can stop at any moment and continue later.

---

## 2. Final decisions

| Topic | Decision |
|---|---|
| Runtime | Node.js current LTS (24 preferred, 22 acceptable), pinned in the Dockerfile |
| Backend | Fastify (single process, single container) |
| Database | SQLite via `better-sqlite3` (a file, no separate DB server) |
| Frontend | Plain HTML + vanilla JavaScript (ES modules) + **Tailwind CSS** compiled with the official Tailwind CLI. No React/Vue, no bundler |
| Audio capture | Browser `MediaRecorder` API. **Keep whatever format the browser produces** (WebM/Opus on Chrome/Android/Firefox, MP4/AAC on iOS Safari). No server-side conversion |
| Contributor identity | Email + language. No password, no email verification |
| One language per contributor | A contributor picks exactly one language. To contribute in another language they use the same email with another language (a separate progress) |
| Public path | `PUBLIC_PATH`, value **`/collect`** |
| Admin path | `ADMIN_PATH`, value **`/adminView`**, protected by HTTP Basic Auth |
| UI language | **French only** (contributor pages and dashboard) |
| Consent step | None |
| Config | Everything configurable through a `.env` file (section 6) |
| Deployment | Docker + docker-compose, one service, bind-mounted `./data` volume. Nginx and HTTPS are set up by the owner outside the app |
| Re-recording a word | Replaces the previous recording of that contributor for that word and language (one response per contributor per word) |
| Word order | Workbook category order, then by ID (section 3) |

---

## 3. Source data (the word list)

The file `seed/words.csv` is **already provided** with the project (UTF-8, header row `id,category,french_text`, 363 rows, extracted and verified from the owner's workbook). Do not regenerate or edit it; just consume it.

- IDs look like `ASD-0001` ... `ASD-0363`.
- **Preserve every row**, including repeated French texts (e.g. "Merci" appears under several IDs, "Riz" twice). Each ID is its own entry. Never deduplicate.
- Some `french_text` values contain commas, quotes, slashes, parentheses, ellipses `…`, curly apostrophes `’`, or context notes (e.g. `Salut, comment vas-tu? (Je salue un ami proche)`, `Entrez, s’il vous plaît (à un groupe de personne). / Entrez, s’il vous plaît (à une personne d’autorité, respect).`). Store and display them **exactly as given** (trim whitespace only, normalize to Unicode NFC). Use a real CSV parser (`csv-parse`), never `split(',')`.

Categories, in the order they must be displayed and navigated, with ID ranges (use the ranges to fill in `category` if a CSV cell is empty):

| Order | Category | Words | ID range |
|---|---|---|---|
| 1 | Salutations | 93 | ASD-0262 to ASD-0354 |
| 2 | Prendre des nouvelles | 9 | ASD-0253 to ASD-0261 |
| 3 | Couleurs | 51 | ASD-0038 to ASD-0088 |
| 4 | Nombres | 20 | ASD-0223 to ASD-0242 |
| 5 | Famille | 133 | ASD-0089 to ASD-0221 |
| 6 | Corps | 30 | ASD-0008 to ASD-0037 |
| 7 | Vêtements | 0 | none |
| 8 | Nourriture et boissons | 10 | ASD-0243 to ASD-0252 |
| 9 | Maison | 1 | ASD-0222 |
| 10 | Extérieur | 0 | none |
| 11 | Animaux | 7 | ASD-0001 to ASD-0007 |
| 12 | École | 9 | ASD-0355 to ASD-0363 |

Total: 363. Categories with 0 words must not appear anywhere in the UI. Keep the category order list as a constant in code (`src/categories.js`); an unknown category found in the CSV is appended after the known ones.

Navigation order of words = (category order, then ID ascending).

---

## 4. Technology and dependencies

- `fastify`
- `@fastify/static` (serves compiled CSS and JS assets only)
- `@fastify/multipart` (audio upload)
- `@fastify/rate-limit`
- `@fastify/basic-auth`
- `better-sqlite3`
- `csv-parse` (seeding)
- `archiver` (ZIP export)
- Dev: `tailwindcss` + `@tailwindcss/cli` (Tailwind v4, official CLI, no PostCSS setup needed)
- Tests: built-in `node:test`

No other runtime dependencies unless truly needed. No frontend frameworks. No CDN scripts: everything is served by the app itself (the pages must work without external network access, except the browser itself).

npm scripts required: `start`, `dev` (node --watch), `build:css`, `dev:css` (Tailwind watch), `seed`, `backup`, `test`.

`start` must be `node --env-file-if-exists=.env src/server.js` (and `dev` likewise with `--watch`), so a plain `npm start` reads `.env` locally, and also works inside Docker where no `.env` file is in the image (variables come from `env_file`). `seed` and `backup` use the same flag.

This is a **monolith**: one Node process serves the API, the HTML pages, the JS and the compiled CSS on one port. There is no separate frontend dev server. The only extra step is compiling Tailwind CSS (`npm run build:css`, run automatically in the Docker build).

Tailwind: source `src/styles/input.css` → output `public/assets/app.css`, minified at build. Tailwind `content` must cover `public/**/*.html` and `public/**/*.js`. Do not commit the compiled CSS; the Docker build generates it.

---

## 5. Project structure

```
.
├─ src/
│  ├─ server.js            # Fastify bootstrap, config, plugins, route registration
│  ├─ config.js            # reads and validates env vars
│  ├─ db.js                # opens SQLite, creates schema, prepared statements
│  ├─ categories.js        # ordered category list + ID range fallback
│  ├─ languages.js         # { ewondo, basaa, ghomala } with labels
│  ├─ audio.js             # validation (mime, magic bytes), save/delete files
│  ├─ routes/
│  │  ├─ public.js         # /collect pages + API
│  │  └─ admin.js          # /adminView pages + API
│  └─ styles/input.css
├─ public/
│  ├─ collect.html
│  ├─ collect.js
│  ├─ admin.html
│  ├─ admin.js
│  └─ assets/              # compiled app.css goes here (build output)
├─ scripts/
│  ├─ seed.js
│  └─ backup.js
├─ seed/
│  ├─ words.csv            # provided by the owner
│  └─ words.sample.csv     # 10 sample rows for development
├─ test/                   # node:test files
├─ data/                   # runtime volume (gitignored): app.db, audio/, backups/
├─ Dockerfile
├─ docker-compose.yml
├─ .dockerignore
├─ .gitignore
├─ .env.example
└─ README.md
```

---

## 6. Configuration (`.env`)

All settings come from environment variables. Provide `.env.example` with these keys and comments. Load `.env` locally with Node's `--env-file-if-exists=.env` flag (no `dotenv` needed); in Docker, `env_file: .env` passes them.

| Variable | Default | Meaning |
|---|---|---|
| `NODE_ENV` | `production` | |
| `HOST` | `0.0.0.0` | |
| `PORT` | `3000` | |
| `PUBLIC_PATH` | `/collect` | Contributor pages prefix |
| `ADMIN_PATH` | `/adminView` | Dashboard prefix |
| `ADMIN_USER` | `admin` | Basic Auth user |
| `ADMIN_PASSWORD` | none | **Required.** Refuse to start if empty, or equal to `change-me` when `NODE_ENV=production` |
| `DATA_DIR` | `./data` | DB at `DATA_DIR/app.db`, audio at `DATA_DIR/audio/` |
| `MAX_AUDIO_SECONDS` | `60` | Client auto-stops here (also sent to the client) |
| `MAX_AUDIO_MB` | `10` | Server upload size limit |
| `MAX_TEXT_CHARS` | `500` | Max written translation length |
| `TRUST_PROXY` | `true` | Fastify `trustProxy` (app runs behind Nginx) |
| `RATE_LIMIT_API_PER_MIN` | `300` | Per IP |
| `RATE_LIMIT_UPLOADS_PER_HOUR` | `600` | Per IP (generous: mobile networks share IPs) |
| `LOG_LEVEL` | `info` | |

`PUBLIC_PATH` and `ADMIN_PATH` must be normalized (leading slash, no trailing slash). **Nothing may be hard-coded to `/collect` or `/adminView`**: all routes, asset URLs and fetch calls derive from these values (see 9.1).

---

## 7. Database (SQLite)

Open with `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`. Create the schema on startup if missing (`CREATE TABLE IF NOT EXISTS`). Timestamps are UTC ISO-8601 strings.

```sql
CREATE TABLE IF NOT EXISTS words (
  id             TEXT PRIMARY KEY,          -- 'ASD-0262'
  category       TEXT NOT NULL,
  category_order INTEGER NOT NULL,
  position       INTEGER NOT NULL,          -- global navigation order (1..N)
  french_text    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS contributors (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  email        TEXT NOT NULL,               -- lowercased, trimmed
  language     TEXT NOT NULL CHECK (language IN ('ewondo','basaa','ghomala')),
  token        TEXT NOT NULL UNIQUE,        -- 32 random bytes, hex
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE (email, language)
);

CREATE TABLE IF NOT EXISTS responses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  contributor_id INTEGER NOT NULL REFERENCES contributors(id),
  word_id        TEXT NOT NULL REFERENCES words(id),
  audio_path     TEXT,                      -- relative to DATA_DIR/audio, NULL if none
  audio_mime     TEXT,
  audio_bytes    INTEGER,
  text           TEXT,                      -- written translation, NULL if none
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  UNIQUE (contributor_id, word_id),
  CHECK (audio_path IS NOT NULL OR text IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_responses_word ON responses(word_id);
CREATE INDEX IF NOT EXISTS idx_contributors_lang ON contributors(language);
```

Rules:
- A response row exists only if it has audio and/or text. If an update removes both, delete the row.
- The word's language comes from the contributor, so the language is not stored on `responses`.
- Audio files live at `DATA_DIR/audio/<language>/<word_id>__c<contributor_id>.<ext>` (example: `audio/basaa/ASD-0262__c12.webm`). The extension comes from the validated MIME type, never from the client filename.

---

## 8. Public API

All routes below are registered under `PUBLIC_PATH` (shown with `/collect`). Errors return JSON `{ "error": "<code>", "message": "<French message>" }` with proper HTTP status codes.

Contributor requests (except `POST /session`) carry the header `X-Contributor-Token`. Missing/invalid token → `401`.

### `GET /collect`
Serves `collect.html` with the placeholder `__BASE_PATH__` replaced by `PUBLIC_PATH` and `__CONFIG__` replaced by a JSON blob `{ basePath, maxAudioSeconds, maxTextChars, languages }`. Read the file once at startup; do not template per request beyond that.

### `POST /collect/api/session`
Body: `{ "email": string, "language": "ewondo"|"basaa"|"ghomala" }`.
- Validate: email format (simple regex), max 254 chars, lowercased and trimmed; language in enum. Invalid → `400`.
- Upsert contributor by `(email, language)`; update `last_seen_at`. An existing pair returns the **same token**.
- Response `200`: `{ token, email, language, total_words, done_count, first_pending_word_id }`, where `done_count` = words with a response, and `first_pending_word_id` = first word (in navigation order) without any response, or `null` when all are done.

### `GET /collect/api/words`
Header: token. Returns all words in navigation order plus this contributor's state:
```json
{
  "categories": [{ "name": "Salutations", "order": 1, "count": 93, "first_word_id": "ASD-0262" }],
  "words": [{ "id": "ASD-0262", "category": "Salutations", "french_text": "S'il te plaît",
              "has_audio": false, "has_text": false, "text": null }]
}
```
Only categories with at least one word. Return everything in one response (363 rows is small); the client navigates locally.

### `PUT /collect/api/responses/:wordId`
Header: token. `multipart/form-data` with optional fields:
- `audio`: file
- `text`: string
- `remove_audio`: `"1"`

Behavior:
1. Unknown word → `404`.
2. If `audio` is present: validate (section 11), write to a temp file in the same folder, then rename into place, then delete any previous audio file for this response if its path differs. Never leave a half-written file.
3. If `text` is present: trim, NFC-normalize, enforce `MAX_TEXT_CHARS`; empty string means "clear the text".
4. If `remove_audio=1`: delete the file and clear the columns.
5. Upsert the row; if both audio and text end up empty, delete the row.
6. Response `200`: `{ word_id, has_audio, has_text, text, updated_at }`.

### `GET /collect/api/responses/:wordId/audio`
Header: token. Streams this contributor's own recording (correct `Content-Type`, `Accept-Ranges`, support `Range`). `404` if none. The client fetches it with the header and plays it through a Blob URL (an `<audio src>` cannot send custom headers).

### `GET /healthz`
Registered at the **root** (not under any prefix). Returns `200 {"ok":true}` and checks the DB with a trivial query. Used by the Docker healthcheck.

### `GET /`
`302` redirect to `PUBLIC_PATH`.

Static assets: served under `PUBLIC_PATH/assets/` (compiled CSS and the JS files). `admin.js` and `admin.css` must only be reachable under `ADMIN_PATH` (behind auth) to avoid exposing dashboard code publicly.

---

## 9. Contributor UI (French, mobile-first)

Single page `collect.html` + `collect.js` with two screens. Styling only with Tailwind utility classes. Look: clean, calm, high contrast, centered column (`max-w-md`), generous spacing, large touch targets (buttons at least 48px tall), the French word displayed very large.

### 9.1 Base path
The HTML receives `__BASE_PATH__`. All fetch URLs are built as `${BASE}/api/...`; all asset URLs as `${BASE}/assets/...`. No absolute `/collect` anywhere in the source.

### 9.2 Screen A: start
- Title: "Collecte de traductions et de voix"
- Intro: "Merci de nous aider ! Choisissez votre langue, puis enregistrez votre voix pour chaque mot. Rien n'est obligatoire : vous pouvez vous arrêter et revenir quand vous voulez."
- Email field (label "Votre adresse e-mail", `type="email"`, `inputmode="email"`, `autocomplete="email"`).
- Language choice as **three large radio-style buttons**: "Ewondo", "Basaa", "Ghomala de Bandjoun". Exactly one selectable.
- Button "Commencer" (disabled until email valid and language chosen).
- On success store `{ email, language, token }` in `localStorage` (wrap in try/catch; the app must work if storage fails, the user just re-enters). If a saved session exists on load, skip directly to Screen B.

### 9.3 Screen B: word
Layout, top to bottom:
1. Header: "Mot {n} sur {total}" and a thin progress bar showing `done_count / total` with the text "{done} mots complétés".
2. Category chip (e.g. "Famille") and a small select "Aller à la catégorie" (only non-empty categories). Choosing one jumps to that category's first word.
3. The **French word** (very large, wraps for long expressions, preserves the text exactly).
4. Hint text: "Prononcez uniquement le mot ou l'expression, dans un endroit calme."
5. **Record area** (see 9.4).
6. Text field: label "Traduction écrite (facultatif)", placeholder "Écrivez la traduction en {langue}". Use a `textarea` with `rows=2`, `maxlength` from config, and attributes `spellcheck="false" autocapitalize="off" autocorrect="off"` (keyboards must not autocorrect these languages).
7. A status line (`aria-live="polite"`): "Enregistré ✓", "Envoi en cours…", or an error.
8. Buttons: "Précédent" (secondary), "Suivant" (primary, full width on mobile).
9. Footer links: "Aller au prochain mot non fait" and "Changer d'e-mail ou de langue" (clears the stored session and returns to Screen A).

Navigation rules:
- On session start/return, open the first word without a response (`first_pending_word_id`); if all are done, open the last word and show the banner "Merci ! Vous avez terminé tous les mots."
- **Every navigation action** (Suivant, Précédent, category jump, next-pending link) first **auto-saves pending changes** (a new recording and/or edited text), then moves. There is no discard and no "Skip" button: moving on without changes simply sends nothing.
- If saving fails, stay on the word, show the error "Échec de l'envoi. Vérifiez votre connexion et réessayez." and keep the recording in memory so nothing is lost. Provide a retry by pressing "Suivant" again.
- Prevent double-submits (disable navigation while a save is in flight).
- After the last word, "Suivant" shows the "Merci !" banner instead of going further.
- Pre-fill: when a word already has a response, show the saved text and show the recording as existing (with a "Écouter" control loading the audio through the authenticated fetch).

### 9.4 Record area (states)
1. **Idle**: big round button labeled "Appuyez pour enregistrer".
2. **Recording**: the button turns red and shows "Arrêter"; a live timer `0:07`; auto-stop at `MAX_AUDIO_SECONDS`.
3. **Recorded**: shows a native `<audio controls>` for the new local recording plus a "Réenregistrer" button (returns to state 1 and discards the local recording).
4. If a saved recording exists and no new one is made: show "Écouter" (saved audio) and "Réenregistrer".

Implementation details:
- Request the mic only when the user presses the record button (never on page load): `navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } })`.
- Choose the MIME type by testing `MediaRecorder.isTypeSupported` in this order: `audio/webm;codecs=opus`, `audio/webm`, `audio/mp4`, `audio/ogg;codecs=opus`; otherwise let the browser pick its default.
- Stop all tracks of the stream when the recording ends (so the mic indicator turns off) and when leaving the word.
- Ignore recordings shorter than 0.5 s (show "Enregistrement trop court, réessayez.").
- Upload the resulting `Blob` in `FormData` under the field `audio`.
- Error messages (French):
  - Mic denied: "Le micro est bloqué. Autorisez l'accès au micro dans votre navigateur, puis réessayez."
  - Not supported / insecure context: "Votre navigateur ne permet pas l'enregistrement audio. Vous pouvez tout de même écrire la traduction."
- The page works fully in text-only mode when recording is unavailable.

---

## 10. Admin dashboard (French)

Everything under `ADMIN_PATH` (shown as `/adminView`), behind HTTP Basic Auth (`ADMIN_USER` / `ADMIN_PASSWORD`, constant-time comparison via `crypto.timingSafeEqual` on SHA-256 digests). Failed logins are rate limited (10 per 15 minutes per IP). Failure returns `401` with `WWW-Authenticate: Basic realm="Admin", charset="UTF-8"`. Set `Cache-Control: no-store` on all admin responses.

### API
- `GET /adminView` → `admin.html` (same `__BASE_PATH__` templating with `ADMIN_PATH`).
- `GET /adminView/assets/*` → admin JS/CSS.
- `GET /adminView/api/stats` → per language: `contributors`, `responses`, `with_audio`, `with_text`, `words_covered` (distinct words that have at least one audio), `total_words`.
- `GET /adminView/api/responses` with query: `language`, `category`, `q` (substring search on French text, case and accent insensitive is optional), `has_audio` (`1`), `has_text` (`1`), `page` (default 1), `page_size` (default 50, max 200). Sorted by `updated_at` descending. Returns `{ total, page, page_size, rows: [...] }` with rows:
  `{ response_id, word_id, category, french_text, language, email, text, has_audio, audio_mime, created_at, updated_at }`.
- `GET /adminView/api/audio/:responseId` → streams the audio with `Range` support (required so Safari and Chrome can play/seek), correct `Content-Type`.
- `GET /adminView/api/export.csv` → same filters as the list (without paging). UTF-8 **with BOM**, CRLF line endings, correct quoting. Columns: `response_id, word_id, category, french_text, language, email, text, audio_file, audio_mime, created_at, updated_at`. `audio_file` is the path inside the ZIP (section below) or empty. **CSV injection protection:** if a text cell begins with `=`, `+`, `-`, `@`, tab or CR, prefix it with `'`.
- `GET /adminView/api/export.zip?language=` (optional language filter; default all) → streams a ZIP (via `archiver`, never buffering everything in memory) containing `manifest.csv` (same columns as above) and `audio/<language>/<word_id>__c<contributor_id>.<ext>`. Filename: `aila-export-<language|all>-<YYYYMMDD>.zip`.

### UI (`admin.html` + `admin.js`, Tailwind, French)
- Top: stat cards, one per language (contributeurs, réponses, avec audio, avec texte, mots couverts sur 363).
- Filter bar: language select ("Toutes les langues"), category select, word search input, checkboxes "Avec audio" / "Avec texte".
- Results table columns: ID, Catégorie, Mot français, Langue, E-mail, Audio, Texte, Date.
  - Audio: native `<audio controls preload="none">` pointing at `/adminView/api/audio/:id` (never preload 50 files).
  - Text: render with `textContent` only. **Never use `innerHTML` with any user-provided value** (French text, email, written translation).
- Pagination: Précédent / Suivant, "Page X sur Y", total count.
- Buttons: "Exporter en CSV", "Télécharger l'audio (ZIP)" (uses the selected language, or all).
- The table scrolls horizontally inside its own container on small screens; the page body never scrolls sideways.
- Empty state: "Aucune réponse pour le moment."

---

## 11. Validation and security

- **Audio validation:** allowed MIME types: `audio/webm`, `audio/mp4`, `audio/ogg`, `audio/mpeg`, `audio/wav`, `audio/x-m4a`, `audio/aac`. Strip codec parameters before checking. Also check magic bytes: WebM starts with `1A 45 DF A3`; MP4/M4A has `ftyp` at offset 4; Ogg starts with `OggS`; WAV starts with `RIFF`; MP3 starts with `ID3` or `FF FB/F3/F2`. Reject empty files and files above `MAX_AUDIO_MB` (`413`). Reject mismatches (`415`).
- **Filenames** are always generated by the server. Never use a client-supplied filename or path. Guard against path traversal (the word id must exist in `words`; the language comes from the DB).
- **Audio is never served statically.** No directory listing. Only the token-checked or admin-checked routes stream it.
- **Text:** NFC-normalize, trim, length-limit. Store as-is (no HTML stripping needed if output is always escaped/`textContent`). Accented and special characters (ɛ, ɔ, ŋ, ə, ʉ, ɨ, ō, é, ô, combining tone marks…) must round-trip unchanged through the API, DB, dashboard and CSV. Add a test for this.
- **Emails are personal data:** never put them in URLs, never log them, only expose them in admin endpoints. Fastify logger redaction for request bodies is enabled.
- **Headers** (add via `onSend` hook): `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `Permissions-Policy: microphone=(self)`, `X-Frame-Options: DENY`.
- **Rate limits:** as in section 6. Apply the upload limit to `PUT /responses/:wordId`.
- **Trust proxy:** `trustProxy` from `TRUST_PROXY` so client IPs come from `X-Forwarded-For` (needed for rate limiting behind Nginx).
- **Microphone needs a secure context:** the app itself only serves HTTP; HTTPS is terminated by Nginx. Document this in the README.
- The server must never crash on a bad request: wrap handlers, return structured errors.

---

## 12. Docker and deployment artifacts

### Dockerfile (multi-stage, Debian-based image)
```
# build stage
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build:css && npm prune --omit=dev

# runtime stage
FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
```
- Use Debian (`bookworm-slim`), not Alpine, to avoid native-module problems with `better-sqlite3`. If `npm ci` needs to compile it, install `python3 make g++` in the **build stage only**.
- The runtime runs as the non-root `node` user. Create `/app/data` in the image owned by `node`.

### docker-compose.yml
```yaml
services:
  collector:
    build: .
    restart: unless-stopped
    env_file: .env
    environment:
      DATA_DIR: /app/data
    ports:
      - "127.0.0.1:3000:3000"   # only reachable from the host (Nginx proxies to it)
    volumes:
      - ./data:/app/data        # app.db + audio/ + backups/ live here
```
Bind to `127.0.0.1` on purpose: Docker-published ports bypass UFW, so the app must not be exposed publicly except through Nginx. The owner will merge this service into their own compose file; keep it a single self-contained service with no other dependencies.

`.dockerignore`: `node_modules`, `data`, `.env`, `.git`, `public/assets/app.css`.

### Graceful shutdown
On `SIGTERM`/`SIGINT`: close Fastify, then close the SQLite handle.

---

## 13. Scripts

### `scripts/seed.js` (`npm run seed`)
- Reads `seed/words.csv` (path overridable by argument).
- Validates: header `id,category,french_text`; ids match `ASD-\d{4}`; no duplicate ids; non-empty text. Fill an empty category from the ID ranges (section 3); unknown → error.
- Assigns `category_order` from `src/categories.js` and `position` from the navigation order.
- **Idempotent** upsert inside one transaction (updates existing words by id; never deletes words that have responses).
- Prints a summary: total rows and count per category. Warn if the total is not 363.
- In Docker it must be runnable as: `docker compose exec collector npm run seed`. Because `seed/` is in the image, that works after a build. Also run the seed automatically at server start **if the `words` table is empty**.

### `scripts/backup.js` (`npm run backup`)
Uses `better-sqlite3`'s `db.backup()` to write a consistent copy to `DATA_DIR/backups/app-YYYYMMDD-HHMM.db` (safe while the app runs; do not rely on copying the raw file because of WAL). Keep the 14 most recent backups and delete older ones. Audio files are backed up by copying `DATA_DIR/audio` (document this in the README).

---

## 14. Tests (`node:test`)

Minimal but real, running against a temporary `DATA_DIR`:
1. Session upsert: same email+language returns the same token; email is lowercased; different language creates a separate contributor.
2. `PUT /responses/:wordId`: audio only, text only, both; text clearing; `remove_audio`; row deletion when both empty; re-recording replaces the file (old file removed).
3. Validation: bad email, unknown language, oversized audio, wrong magic bytes, text too long.
4. Diacritics round trip: text containing `ɛ ɔ ŋ ə ɨ ʉ é ô` and combining marks is stored and returned identically (after NFC), and appears correctly in `export.csv`.
5. Admin: `401` without credentials, `200` with them; CSV starts with the UTF-8 BOM; CSV injection prefix works.
6. Base paths: with `PUBLIC_PATH=/x` and `ADMIN_PATH=/y`, the routes move accordingly.
7. Seed: idempotent; duplicates in French text (different ids) are all kept.

---

## 15. Suggested build order

1. Scaffold: `package.json`, config loader, Fastify server, `/healthz`, Dockerfile, compose, `.env.example`.
2. DB schema + `categories.js` + `seed.js` + sample CSV; run the seed.
3. Public API (`session`, `words`, `PUT responses`, own-audio stream).
4. Contributor UI (screens A and B, recording, auto-save, resume).
5. Admin API (stats, list, audio stream, CSV, ZIP).
6. Admin UI.
7. Tests, backup script, README (see below), final cleanup.

README must cover: local run (`npm i`, `cp .env.example .env`, `npm run build:css`, `npm run seed`, `npm start`; plus `npm run dev` and `npm run dev:css` in two terminals while developing), running the tests, the fact that `http://localhost` is treated as a secure context for the microphone but a LAN IP is not (use an HTTPS tunnel to test on a phone), Docker run, seeding, backups, and the Nginx requirement (see `CHECKLIST.md`).

---

## 16. Acceptance criteria

- A contributor opens `https://<domain>/collect`, enters an email, picks a language, and sees the first French word ("S'il te plaît") with a record button, an optional text field and Précédent/Suivant.
- Recording works on: Chrome desktop (localhost), Chrome Android, and Safari iOS (over HTTPS). The audio can be played back before moving on.
- Pressing Suivant saves the recording and/or text; closing the browser and coming back with the same email and language resumes at the first unanswered word, with saved answers pre-filled.
- Nothing is mandatory: pressing Suivant on an empty word creates no record.
- Re-recording a word replaces the previous recording.
- A network failure never loses a recording silently; the user sees the French error and can retry.
- All 363 words load in workbook category order; empty categories (Vêtements, Extérieur) do not appear; duplicates keep their own IDs.
- `https://<domain>/adminView` asks for the password; after login the owner sees stats, can filter, play any recording, and download the CSV and the ZIP. Diacritics display correctly in the dashboard and in Excel (BOM).
- All contributor and dashboard text is French. No English strings visible to users.
- Changing `PUBLIC_PATH` / `ADMIN_PATH` in `.env` moves the routes with no code change.
- `docker compose up -d --build` starts the service; the DB, audio and backups persist in `./data` after a rebuild.
- Tests pass.

---

## 17. Do not

- Do not add user accounts, passwords for contributors, email sending, or email verification.
- Do not add a consent screen.
- Do not convert audio on the server, and do not add ffmpeg.
- Do not add React, Vue, jQuery, a bundler, or any CDN dependency.
- Do not add PostgreSQL, Redis, or any second container.
- Do not serve audio files as static files.
- Do not build validation/voting/moderation, per-response deletion, or multi-admin roles.
- Do not translate or alter the French source text.
