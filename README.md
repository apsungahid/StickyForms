# StickyForms.io — local dev server

Build customizable forms, send each person a personal link, and collect their submissions.

**Stack:** Node.js 22.13+ · Express · Knex (query builder + migrations) · SQLite built into Node (`node:sqlite`, dev — nothing to compile) → PostgreSQL (later, config change only)

## Quick start (Windows, macOS, Linux)

```bash
# 1. Install Node.js 22.13+ (LTS recommended): https://nodejs.org
# 2. In this folder:
npm install
copy .env.example .env      # macOS/Linux: cp .env.example .env
npm run setup               # create tables + demo data
npm run dev                 # starts on http://localhost:3000 and restarts on file changes
```

Then open:

| URL | What it is |
|---|---|
| http://localhost:3000 | Admin: build forms, create personal links, view submissions |
| http://localhost:3000/f/demo-token | The demo form as a recipient sees it |
| http://localhost:3000/health | Server + database health check |

To test from your phone on the same Wi‑Fi, set `HOST=0.0.0.0` in `.env` and open `http://<your-PC-IP>:3000` (allow Node through Windows Firewall when prompted).

## Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start with auto-reload |
| `npm start` | Start normally |
| `npm test` | API tests on an in-memory database |
| `npm run migrate` | Apply pending migrations (also runs automatically on start) |
| `npm run migrate:make <name>` | Create a new migration file |
| `npm run migrate:rollback` | Undo the last migration batch |
| `npm run seed` | Reset demo data (**wipes all forms/links/submissions**) |
| `npm run set-owner -- you@gmail.com` | Give every existing form to that account (created now if they haven't signed in; linked on their first Google sign-in) |

## Project layout

```
knexfile.js          DB config — SQLite or Postgres, picked by DB_CLIENT
migrations/          Schema changes (portable across SQLite/Postgres)
seeds/               Demo data
src/server.js        Entry point (auto-migrates, graceful shutdown)
src/app.js           Express app, routes, error handling
src/routes/forms.js  Admin API
src/routes/public.js Recipient API (open link, submit)
src/validation.js    Form-definition and submission validation
src/sqlite-client.js Knex driver for Node's built-in SQLite
src/recipients.js    Reads recipient spreadsheets (.xlsx / .csv)
src/results.js       Poll totals and ranking averages
src/storage.js       Saves uploaded files to disk (swap for S3/Blob later)
src/poster.js        Poster image checks (type by content) and serving
src/auth.js          Sign in with Google, sessions, ownership checks
src/routes/auth.js   Sign-in API · src/routes/me.js  "Sent to me" list
src/mailer.js        Renders and sends link emails (SMTP, or outbox in test mode)
public/              Dashboard (index.html), sign-in page (login.html), recipient page (fill.html)
test/                node:test + supertest
```

## Signing in

The dashboard (`/`) needs a Google account; `/login` shows the **Sign in with Google** button. People who only answer a form through their personal link never need to sign in.

- Each account sees and manages only its own forms (titles must be unique per account). Forms created before sign-in existed belong to the first account that signs in.
- **Sent to me:** every form whose recipient email matches the signed-in Google email (case-insensitive) is listed with its status — to fill in, submitted, expired or closed — and opens the person's link.

Setup (Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID → *Web application*):
1. Authorized JavaScript origins: `http://localhost:3000` and `http://localhost` (later add your real `https://…` address). Open the app at **http://localhost:3000**, not 127.0.0.1.
2. Copy the Client ID into `.env` as `GOOGLE_CLIENT_ID=…` and restart. (No client secret is needed for this kind of sign-in.)
3. While setting up, `DEV_LOGIN=true` in `.env` adds an email-only developer sign-in that works only from this computer. Set it back to `false` before putting the app online.

Auth API: `GET /api/auth/config` · `POST /api/auth/google {credential}` · `POST /api/auth/dev {email}` (DEV_LOGIN only) · `GET /api/auth/me` · `POST /api/auth/logout` · `GET /api/me/invitations`. Sessions are an HttpOnly cookie (30 days, `SESSION_DAYS`); only a hash of the session id is stored. Requests from other websites are refused.

## API

Admin (`/api/forms`)
- `GET /` list · `POST /` create · `GET /:id` · `PUT /:id` · `DELETE /:id` — form titles must be unique (case-insensitive); a clash returns 409.
- `POST /:id/duplicate` `{title, description}` — copy the questions and email template into a new form (no recipients, links or submissions). New title required and must be unique.
- `PUT /:id/poster` (raw image body) · `DELETE /:id/poster` · `GET /:id/poster` — optional poster image shown at the top of the form: JPG, PNG, GIF or WebP (checked by the file's contents), up to 5 MB. Stored in `UPLOAD_DIR/<formId>/poster/`; replaced posters are deleted, duplicates get their own copy, deleting the form deletes it. Recipients load it via `GET /api/public/:token/poster` (`posterUrl` in the link's form data).
- `POST /:id/lock` · `POST /:id/unlock` — while locked, every link answers 423 "temporarily closed" and nothing can be submitted. Links and expiry dates are untouched, so unlocking makes all unexpired, unused links work again.
- `GET /:id/links` · `POST /:id/links` `{recipientName, recipientEmail, expiresOn, maxSubmissions}`
  - `expiresOn` is a date (`YYYY-MM-DD`); the link works until the end of that day (server time zone). Omit for no expiry.
  - `maxSubmissions`: default 1; 0 or null = unlimited.
- `POST /:id/links/delete` `{linkIds}` (and `DELETE /:id/links/:linkId` for one) — remove recipients/links of this form **together with their submissions and uploaded files** (database rows and files on disk). Returns `{removed, submissionsDeleted, filesDeleted}`.
- `POST /:id/links/import` — raw .xlsx/.csv file body (+ `X-Filename` header) → preview `{recipients:[{row,name,email,error}], validCount}`. Finds the Name/Email columns (also First/Last name, `;`-separated CSVs, no-header sheets). Max 1000 rows, 5 MB.
- `POST /:id/links/bulk` `{recipients:[{name,email}], expiresOn, maxSubmissions}` — creates all links in one transaction (all or nothing).
- `GET /:id/links.csv` — download every link (name, email, URL, expiry) for mail merge.
- `GET /:id/email-template` — saved subject/message for this form, plus `testMode` and whether link URLs are local-only.
- `POST /:id/links/send` `{linkIds, subject, message}` — emails each selected person their current link. Skips links with no email, expired, used up, or replaced.
- `POST /:id/links/resend` `{linkIds, subject, message, expiresOn, maxSubmissions}` — creates a **new** link per person, marks the old one replaced (it stops working), and emails the new one.
  - Placeholders in subject/message: `{date}` (date sent), `{name}`, `{form}` (title), `{description}`, `{link}` (shown as an "Open the form" button), `{expiry}`. Default subject is the form title; default body is defined in `src/mailer.js`. Empty name/description are tidied away ("Hi there,").
- `GET /:id/emails/:logId` — preview an email as sent (sandboxed HTML).
- `GET /:id/submissions` · `GET /:id/submissions.xlsx` (Excel only) · `GET /:id/files/:fileId` (download; add `?view=1` to show JPG/PNG/GIF/WebP/BMP/AVIF images in the browser — used for the admin thumbnails. SVG and other types always download.)
- `GET /:id/submissions.zip` — one folder containing the Excel file plus every uploaded file, grouped in a sub-folder per file question, each keeping its original uploaded file name (`Profile photo/IMG_1234.jpg`). Only characters Windows can't use are replaced, and if two uploads in one folder share a name the later one gets " (2)". File cells in that Excel link to the files beside it, so they open with a click once the ZIP is extracted.

Public (`/api/public`)
- `GET /:token` — form definition for a valid link (404 unknown, 410 expired/used/replaced, 423 form locked)
- `POST /:token` `{data: {...}}` — submit; validated server-side against the form's fields

Field types: `text, email, number, textarea, select (needs options), checkbox, date, file, poll, ranking`.

Every field can have `notes` (up to 500 characters): a short guide shown under the field in small italic text on the form. Fields appear in the order of the `fields` array; the builder's **#** dropdown moves a field to any position.

**Polls** take `options` (2–50) and `maxChoices` (1 = one choice, shown as radio buttons; more = checkboxes, up to that many). Stored as an array of the chosen options.
**Rankings** take `options`; people number every item 1..n (each number once). Submit as `{item: rank}` or an ordered array; stored as an array in rank order. Optional rankings may be left completely blank, never half-filled.

**After submitting**, opening the same link shows the person's own answers read-only (`GET /api/public/:token` returns `mode: "view"` when the link can't take another submission — used up, expired or locked). Poll answers show live totals for every choice with theirs highlighted; rankings show their order plus everyone's average order. `GET /api/public/:token/submission` returns the same view (used right after submitting). `GET /api/forms/:id/results` gives admins the totals; the Excel export adds a "Poll results" sheet.

**File fields** take `maxSizeMB` (default 10, never above `MAX_UPLOAD_MB`) and `accept` (list of extensions like `.pdf`; empty = any type). Program files (.exe, .bat, .js, …) are always rejected. Recipients submit forms with files as `multipart/form-data` (a `data` JSON part plus one part per file field). Files are stored on disk under `UPLOAD_DIR/<formId>/<submissionId>/` and listed in the `files` table; admins download them via `GET /api/forms/:id/files/:fileId` (also linked from the Excel export). Deleting a form deletes its files.

## Sending email

Configure SMTP in `.env` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`). Examples: Gmail `smtp.gmail.com:587` with a Google *App password*; Outlook/Microsoft 365 `smtp.office365.com:587`.

**Test mode:** with `SMTP_HOST` empty nothing is sent — each email is saved as an `.eml` file in `data/outbox` and can be previewed from the admin. Before sending real emails, set `PUBLIC_BASE_URL` to an address recipients can reach (links to `localhost` only work on your computer). Personal mailboxes have daily sending limits (Gmail ≈ 500/day); for large lists use a sending service's SMTP (SendGrid, Mailgun, Amazon SES…).

## Why SQLite now, and moving to PostgreSQL later

SQLite is free, needs no server, and is fast for a single machine — the whole DB is one file in `data/`. All queries go through Knex and the schema only uses portable types (string UUID keys, JSON columns, ISO timestamps), so the exact same code has been verified against PostgreSQL 16.

To switch:
1. `docker compose up -d` (or use any hosted Postgres: Neon, Supabase, RDS…)
2. `npm install pg`
3. In `.env`: `DB_CLIENT=pg` and `DATABASE_URL=postgres://stickyforms:stickyforms@localhost:5432/stickyforms`
4. `npm run migrate` — then copy data over if you need to keep it (a small export/import script, or `pgloader` which reads SQLite directly).

## Not done yet (before going public)

- Uploaded files are stored on this computer's disk — back up `data/` (database + uploads) together. For production, move uploads to S3/Azure Blob and add virus scanning.

- Bounce/open tracking for emails; unsubscribe handling if used for marketing.
- Rate limiting on public submit, CSRF/CORS policy, HTTPS (via a reverse proxy).
