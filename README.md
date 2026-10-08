# OpenVibe.Help

> Answers, support and a way to reach people.

**Status:** the product is written and tested; it is not deployed yet (see [STATUS.json](STATUS.json)).
**Domain:** `openvibe.help` · **Port:** 5020 · **Service id:** `help` · **Env prefix:** `HELP`
**License:** AGPL-3.0 (same as every OpenVibe service).

The help and support centre for every OpenVibe site: the answers each site gives about itself, search over those and
over the whole network, and a support ticket that stays one conversation.

## What it does

### 1. Help articles, generated from real content — no database, no hand-written copy

`server/catalog.js` reads, at boot, from `openvibe-contracts`:

- **every product manifest** (`manifests/products/<domain>.json`) — `name`, `tagline`, `description`, `pillars`, `faq`,
  `keywords`, `launch`, `kind`;
- **every service manifest whose `site` block presents a site** (`manifests/services/<id>.json`) — the same fields,
  plus `exposure.state`.

It builds one site per domain (a domain that is both a product and a service site is merged into one) and one article
per FAQ entry. Every text is the manifest's, verbatim — this service quotes, it does not write. Each page shows where
its text came from (the manifest paths, a link back, and when it was read).

| Page | What it is |
|---|---|
| `/sites` | every OpenVibe site: its one-line what, its state (`live` / `coming`), and links |
| `/sites/:id` | one site: its pillars as "what you can do", its FAQ as anchored articles, links to the site and to its `/updates` |
| `/a/:site/:slug` | one question, one page (SEO title = the question), the answer verbatim, links back |

`live` is the manifest's own `exposure.state === 'live'` on a service that exposes that domain; everything else is
`coming`. Today: 45 sites, 22 live, 20 questions across the 3 sites that carry an `faq`.

### 2. Search

`/search?q=` shows two sections:

- **Help articles** — `server/search.js` scores the generated articles over the question, the answer and the site's own
  text (a phrase hit beats term hits; the question beats the answer; the answer beats the site's blurb). The same
  ranking answers `GET /api/v1/articles?q=`. There is no index and no stemming: the same query always answers the same
  order, and every rule is in one function so a surprising order can be explained instead of tuned.
- **From across OpenVibe** — OpenVibe.Search's public API,
  `GET {HELP_SEARCH_URL}/api/v1/search?q=&limit=8` → `results[{title, summary, canonical_url, type, owner}]`. Answers
  are cached in this process for 5 minutes. A failure (timeout, an error, an answer without a result list) is shown as
  a failure and the page degrades to the articles alone — never to a fake empty index.

OpenVibe.Search at `search.openvibe.network` is the **only** host `/search` calls; a person's query travels as a query
parameter, never as a URL, and a `canonical_url` becomes a link only when it parses as absolute http(s).

### 3. Support tickets

A signed-in person opens a ticket — the site it is about (picked from the catalog), a subject, a message, and
optionally the page they were on. The page URL is **stored as text only and never fetched**; it is rendered as a link
only when it parses as absolute http(s). The first message is the description, so a ticket is never empty; the ticket
page is the conversation; a reply stays there.

- **A person sees only their own tickets** — anyone else gets 404, exactly like a ticket that does not exist.
- **Staff** — the Network role claim on the session (`admin` or `global_mod`, `server/tickets/staff.js`) — see
  `/staff`: every ticket, filterable by site and state, and they may reply and set `open | waiting | solved`.
- Bodies are plain text rendered escaped with line breaks kept, at most 10 000 characters.

Tables (`migrations/0002_tickets.sql`): `help_tickets` (`tkt_<ULID>`, requester subject, site, subject, state,
`page_url`, created/updated) and `help_messages` (`ticket id, author subject, role person|staff, body, created_at`).
Neither is ever a credential, key or token.

### 4. Discovery

`sitemap.xml` and `llms-full.txt` are two renderings of one page list, so every site and every question is crawlable in
both and they cannot drift apart. `llms.txt` lists the sites with their state. `/tickets`, `/staff`, `/auth/` and
`/api/` are disallowed; the home page's JSON-LD carries the sitelinks search action.

## Pages

| Route | What it is |
|---|---|
| `/` | the help centre: a search box, "Popular questions" (the questions the sites answer), "Browse by site", and "Contact support" |
| `/sites`, `/sites/:id`, `/a/:site/:slug` | the generated help centre |
| `/search?q=` | the help articles and the network, in two sections |
| `/tickets/new`, `/tickets`, `/tickets/:id` | open a ticket, your tickets, one conversation (sign in required) |
| `/staff` | the support queue (staff only) |
| `/updates` | the network changelog for this service |

All of it is server-rendered through the OpenVibe Frame and works without JavaScript: the search box is a GET, the
forms are plain POSTs. A signed-in write must come from openvibe.help itself (as in the API).

## API

Everything under `/api/v1`. A person needs no capability (their own tickets, their own session); staff are judged by
their Network role claim. Writes made with the session cookie must be same-origin. Errors are RFC 9457
`application/problem+json` with a stable `code`.

| Route | Who | What |
|---|---|---|
| `GET /ping` | anyone | `{ ok: true, service: "help" }` |
| `GET /sites` | anyone | the whole catalog with each site's state, one line and source |
| `GET /sites/:id` | anyone | one site: pillars, FAQ (with article URLs), where it lives, its source |
| `GET /articles?q=` | anyone | the generated articles; `?q=` ranks them |
| `POST /tickets` | a person | open a ticket (`{ site?, subject, message, page_url? }`) → 201 `tkt_<ULID>` |
| `GET /tickets` | a person | your tickets, newest first (`?limit=&before=`) |
| `GET /tickets/:id` | a person | one ticket and its conversation (staff may read any; anyone else 404) |
| `POST /tickets/:id/messages` | a person | reply (`{ message }`); a staff reply is marked `staff` |
| `GET /staff/tickets` | staff | the queue (`?site=&state=open\|waiting\|solved\|all`) with counts |
| `POST /tickets/:id/state` | staff | `{ state: "open" \| "waiting" \| "solved" }` |

Problem codes: `token.required` (401), `help.person_required` (403 — an app token cannot act as a person),
`request.cross_site` (403), `staff.forbidden` (403), `ticket.not_found` (404), `help.site.not_found` (404),
`ticket.invalid` (422), `rate_limited` (429).

`http/principal.js`'s `CAPABILITIES` is deliberately empty: `openvibe-contracts` declares no `help.*` capability yet,
and every route here is a person acting for themself or staff by their role claim. The day a route exists for an app
(a support widget a site embeds, say), its capability is added here and in `openvibe-contracts` together.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET` (the `help` OAuth client on the
Network), `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`. Optional: `HELP_SEARCH_URL` (default
`https://search.openvibe.network`), `HELP_SEARCH_LIMIT`, `HELP_SEARCH_TIMEOUT_MS`, `HELP_SEARCH_CACHE_MS`, the
per-caller limits and Valkey. The database is the only required readiness check; the Network signing key, the OAuth
client and Valkey are optional (the service says so, per check, on `/api/ready`).

## Data sources and their terms

| Source | What is taken | Terms as applied |
|---|---|---|
| [OpenVibe.Contracts](https://github.com/OpenVibers/OpenVibe.Contracts) `manifests/products/*.json` and `manifests/services/*.json` (pinned `v0.115.0`, read at boot from `node_modules`) | site names, taglines, descriptions, pillars, FAQ, keywords, launch notes, `exposure.state` | Read-only, from the pinned release the service already depends on; quoted verbatim with the manifest path, a link back and the time it was read shown on the page. No text is invented, rewritten or translated. |
| [OpenVibe.Search](https://search.openvibe.network) (`GET /api/v1/search`) | the network half of `/search`: `title`, `summary`, `canonical_url`, `type`, `owner` | Public API (anonymous queries need no token). Fetched only from the configured host, with a `User-Agent` and a timeout, cached 5 minutes, never on a URL a person typed. Failures are shown as failures. |

Nothing else is fetched. No user-supplied URL is ever requested by this service.

## Development

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js, on temp PGlite databases with a mock Network
fnm exec --using=22 npm run dev     # http://localhost:5020
```

Without `DATABASE_URL` development uses an embedded PGlite database in `data/pglite` (one process only). `npm run
test:pg` runs the same suite through PostgreSQL and PgBouncer (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Tests

`npm test` runs every `test/*.test.js` in its own process, on a temp PGlite database, with an in-process mock of
OpenVibe.Network; outbound HTTP is stubbed (`test/helpers/search-provider.js` stands in for OpenVibe.Search), so
nothing calls the real internet.

| File | What it proves |
|---|---|
| `test/help-articles.test.js` | the catalog is exactly the manifests (once per domain), every site and every question has a page, the text and the state are the manifest's, escaping |
| `test/help-search.test.js` | the score and its rules, the ranking over the real catalog, both sections, the 5-minute cache, and failures (error, timeout, malformed) degrading to the articles alone |
| `test/tickets.test.js` | the whole lifecycle: create, list own only, reply, staff state change, another person 404, anonymous 401, app tokens refused, cross-site session writes refused, escaping, the 10 000-character cap, per-caller limits |

`test/skeleton.test.js` skips itself in a generated service: the skeleton's `__ID__`-style placeholders are already
substituted here, so `scripts/new-service.js` (which copies the tree it lives in) cannot rebuild the sample. A skip is
listed with ○ and is not counted as a pass.

## Deploy (for the lead)

- **Deploy:** `sudo ovhost deploy help` on the host (git checkout at `/opt/openvibe.help`, unit
  `openvibe-help.service` on 127.0.0.1:5020, env `/etc/openvibe/help.env`, database `ov_help` on the data role).
- **nginx:** [deploy/nginx/openvibe.help.conf](deploy/nginx/openvibe.help.conf), installed with `ov-vhost-install`.
- **Rollback:** ovhost puts the previous sha back by itself when `/api/ready` does not answer after the restart.
- Register the service and its capabilities in **OpenVibe.Contracts** (`contracts-service: help` in CI) and with
  **OpenVibe.Services** before the first deploy. No new environment variable is required to run: `HELP_SEARCH_URL` has
  a default.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- A ticket belongs to the person who opened it: another person gets 404, and staff are decided by the Network role
  claim on the session, never by anything in the request body.
- Nothing in a request may decide a URL this service fetches. A page URL a person pastes is stored as text and never
  opened; `/search` calls only the fixed `HELP_SEARCH_URL` host, with the query as a parameter. A `canonical_url` from
  OpenVibe.Search becomes a link only when it parses as absolute http(s).
- Every dynamic value in HTML goes through the `html` tagged template; bodies are escaped and shown with their line
  breaks.
- Secrets live only in the env file; only environment variable names appear in code and docs, and no secret is logged.
- Request bodies are never logged (a ticket body can be personal).

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.115.0
- openvibe-sdk: v0.35.2
- openvibe-shared: v2.14.0
<!-- versions:end -->
