# AILA School: voice and translation collector

A small web app for collecting voice recordings (and optional written translations) of 363 French words and expressions in **Ewondo**, **Basaa** and **Ghomala de Bandjoun**.

- **Contributors** open `/collect`, enter their e-mail, pick one language and go through the words one at a time. Each word is saved when they move on, so they can stop and come back later.
- **The owner** opens `/adminView` (password protected) to see stats, filter responses, play recordings and download everything (CSV + ZIP).

Stack: Node.js 24, Fastify, SQLite (`better-sqlite3`), vanilla JS, Tailwind CSS v4. One process, one container.

---

## Run locally

```bash
npm i
cp .env.example .env        # then set ADMIN_PASSWORD (and NODE_ENV=development)
npm run build:css
npm run seed                # optional: the server also seeds automatically when the words table is empty
npm start
```

Open <http://localhost:3000/collect> (contributors) and <http://localhost:3000/adminView> (dashboard, user `admin` / your `ADMIN_PASSWORD`).

While developing, run these in two terminals:

```bash
npm run dev        # restarts the server on file changes
npm run dev:css    # rebuilds Tailwind CSS on changes
```

Note: `ADMIN_PASSWORD=change-me` is refused when `NODE_ENV=production` (the default). For local work, set `NODE_ENV=development` or choose a real password.

### Testing the microphone on a phone

Browsers only allow the microphone in a **secure context**:

- `http://localhost` counts as secure, so recording works on your computer.
- `http://192.168.x.x:3000` (a LAN IP) does **not**, so recording is disabled when you open the app from a phone on your Wi-Fi. Use an HTTPS tunnel instead (for example `cloudflared tunnel --url http://localhost:3000` or `ngrok http 3000`) and open the `https://` URL on the phone.

In production, HTTPS is handled by Nginx (see below). When recording is unavailable, the page still works in text-only mode.

## Tests

```bash
npm test
```

The tests use Node's built-in `node:test` and run against a temporary data directory. They cover sessions, saving responses, validation, diacritics round-tripping, the admin endpoints (auth, CSV BOM, CSV injection, ZIP), configurable base paths and the seed.

## Configuration

Everything is set through environment variables. See `.env.example` for the full, commented list. The most important ones:

| Variable | Default | Notes |
|---|---|---|
| `ADMIN_PASSWORD` | none | **Required** |
| `ADMIN_USER` | `admin` | |
| `PUBLIC_PATH` | `/collect` | Changing it moves all contributor routes. No code change needed |
| `ADMIN_PATH` | `/adminView` | Same for the dashboard |
| `DATA_DIR` | `./data` | `app.db`, `audio/`, `backups/` |
| `MAX_AUDIO_SECONDS` / `MAX_AUDIO_MB` / `MAX_TEXT_CHARS` | 60 / 10 / 500 | |

## Docker

```bash
cp .env.example .env    # set ADMIN_PASSWORD
docker compose up -d --build
```

- The service listens on `127.0.0.1:3000` only, so it is reachable from the host (Nginx) but not from the internet. This is deliberate: ports published by Docker bypass UFW.
- All data lives in `./data` on the host (bind mount): `app.db`, `audio/`, `backups/`. It survives rebuilds.
- The container runs as the non-root `node` user. If `./data` is created by root on the host, run `sudo chown -R 1000:1000 ./data` once.
- Health check: `GET /healthz`.
- The service is self-contained, so you can copy it into your own `docker-compose.yml`.

### Seeding

The words are imported automatically the first time the server starts (when the `words` table is empty). To re-import after editing `seed/words.csv` (then rebuild the image):

```bash
docker compose exec collector npm run seed
# locally: npm run seed [path/to/file.csv]
```

The seed is idempotent. It updates words by ID and never deletes any. `seed/words.sample.csv` (10 rows) is only meant for a fresh development database. Loading it into a database that already holds the full list would renumber those 10 words.

## Backups

```bash
docker compose exec collector npm run backup
# locally: npm run backup
```

This writes a consistent copy of the database (SQLite online backup, safe while the app is running) to `data/backups/app-YYYYMMDD-HHMM.db` and keeps the 14 most recent. Example cron entry on the host:

```
0 3 * * * cd /path/to/app && docker compose exec -T collector npm run backup
```

**Audio files are not in the database.** Back them up by copying the `data/audio/` folder, for example `rsync -a data/audio/ /backup/aila-audio/`. For a full backup, copy `data/backups/` and `data/audio/`.

## Nginx and HTTPS (required in production)

The app only serves plain HTTP. Put it behind Nginx with HTTPS: the microphone does not work without it. The full setup (server block, Certbot, firewall) is in `CHECKLIST.md`. Minimal location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 15m;   # a little above MAX_AUDIO_MB
}
```

`TRUST_PROXY=true` (the default) makes the app read client IPs from `X-Forwarded-For`, which rate limiting needs.

## Implementation notes (choices where the spec left room)

- **Audio formats.** Recordings are stored exactly as the browser produces them (WebM/Opus on Chrome/Android/Firefox, MP4/AAC on iOS Safari). File extensions come from the validated MIME type: `audio/mp4` and `audio/x-m4a` are stored as `.m4a`. `audio/aac` also accepts raw ADTS streams (`FF Fx` sync word) in addition to `ftyp` containers.
- **Admin assets.** There is a single compiled stylesheet, `app.css`. The dashboard loads it from `ADMIN_PATH/assets/app.css` (behind auth), and `admin.js` is only served there. Public and admin assets are whitelisted routes. The `public/` folder is never served as a directory.
- **Admin categories.** The category list for the filter comes from `GET /adminView/api/stats` (field `categories`). The same response also has a `languages` array with the per-language stats.
- **Search.** Search on French text ignores case and accents (a SQLite `fold()` function).
- **Failed-login limit.** Failed admin logins are counted in memory per IP (10 per 15 minutes, reset on restart). A request with no credentials, which is the browser's first try, is not counted.
- **Re-record on a saved word.** Pressing "Réenregistrer" on a word that already has a saved recording shows the record button again with a note. The saved recording is only replaced once a new one is recorded and saved.
- **Leaving the session.** "Changer d'e-mail ou de langue" first tries to save pending changes. If the save fails, the user is asked to confirm before anything is dropped.
- **Wording.** The progress label uses the singular for 0 or 1 ("1 mot complété") and the plural otherwise.
