# AGENTS.md — OpenVibe.Help

## Project Overview

OpenVibe.Help is the help and support centre for every OpenVibe site: answers generated from the pinned
OpenVibe.Contracts manifests, search over those answers plus OpenVibe.Search's public network index, and a support
ticket that stays one conversation with staff.

- **Domain:** `openvibe.help` · **Port:** 5020 · **Service id:** `help` · **Env prefix:** `HELP`
- **Runtime:** Node 22, Express 4, PostgreSQL 18 through `openvibe-sdk/db` (embedded PGlite in development/tests),
  Valkey 9 for shared per-caller counters.
- **Read first:** [README.md](README.md) and [STATUS.json](STATUS.json).

**Network context:** identity, sessions and staff roles are OpenVibe.Network (OAuth client `help`, PKCE S256; staff is
the Network role `admin` or `global_mod`). The help text is OpenVibe.Contracts (read-only, quoted verbatim). The
"From across OpenVibe" half of `/search` calls OpenVibe.Search's public API. Account export/deletion arrives from
OpenVibe.Events at `/internal/events`. Help owns no text, account, search index or event broker of its own.

## Commands

```bash
npm ci                         # install (contracts/sdk/shared are pinned by tag)
npm run dev                    # http://localhost:5020, NODE_ENV=development
npm start                      # node server/index.js
npm test                       # every test/*.test.js on temp PGlite, mocked Network/Search, no internet
npm run test:pg                # the same through PostgreSQL + PgBouncer
npm test -- tickets            # only test files whose name contains the word
npm test -- --strict           # a skipped test fails the run
node --check <file.js>         # syntax check (no linter configured)
```

`test/run.js` uses `openvibe-shared/test-runner`, one process per file. There is **no build step**; pages are
server-rendered and static assets are served from [public/](public/).

## Architecture at a Glance

- **Entry:** [server/index.js](server/index.js) — listener, telemetry flush/retention and the Events subscriptions;
  graceful stop is `createLifecycle()` in the same file.
- **App factory:** [server/app.js](server/app.js) — helmet/CSP, SSO, `/auth`, `/internal/events`, static/`/shared`,
  `/api/v1`, discovery + Markdown twins, pages, 404/error handler. Tests call `createApp({ store, fetchImpl, ... })`.
- **Config:** [server/config.js](server/config.js) — `load(env)` is pure; production reads `/etc/openvibe/help.env`.
  Only variable names appear in code/docs.
- **Catalog (no database):** [server/catalog.js](server/catalog.js) reads every product and service manifest from
  `openvibe-contracts` at boot, merges a domain that is both, and generates one article per manifest FAQ entry.
  Nothing is stored; restart to pick up a new Contracts pin. Pages are [server/http/pages.js](server/http/pages.js).
- **Search:** [server/search.js](server/search.js) is the OpenVibe.Search client for network results;
  [server/search-index.js](server/search-index.js) publishes Help's own article pages to Search using
  `openvibe-publishing/search-feed` and the outbox tables `event_outbox` / `help_index_revisions`.
- **Tickets:** [server/tickets/](server/tickets/) (store, pages/routes, staff) — the only personal data Help owns.
  `server/http/api.js` mounts the ticket API; [server/http/principal.js](server/http/principal.js) keeps
  `CAPABILITIES` deliberately empty.
- **Auth/account data:** [server/auth/sso.js](server/auth/sso.js), [server/auth/keys.js](server/auth/keys.js) and
  [server/identity/account-data.js](server/identity/account-data.js).
- **Database:** [server/db.js](server/db.js) — [migrations/](migrations/) at boot with `DATABASE_DIRECT_URL` (owner);
  `DATABASE_URL` serves. Tables: `help_tickets`, `help_messages`, `account_data_events`, `event_outbox`,
  `help_index_revisions`, `telemetry_samples` (plus the Contracts-free `things` fixture table).
- **Frontend:** server-rendered HTML through [server/render/layout.js](server/render/layout.js) and
  [server/render/html.js](server/render/html.js), with the OpenVibe Frame/kit from `openvibe-shared`; assets in
  [public/css/](public/css/). Pages work with JavaScript off. Markdown twins:
  [server/agent-pages.js](server/agent-pages.js), [server/agent-descriptor.js](server/agent-descriptor.js).
- **Deploy:** [deploy/systemd/openvibe-help.service](deploy/systemd/openvibe-help.service) (127.0.0.1:5020,
  `/etc/openvibe/help.env`) and [deploy/nginx/openvibe.help.conf](deploy/nginx/openvibe.help.conf). `sudo ovhost
  deploy help`; database `ov_help`; checkout at `/opt/openvibe.help`; rollback restores the previous sha when
  `/api/ready` fails after the restart.

## Ownership and Boundaries

Help owns support tickets, their messages and the receipts of account-export/deletion events it applied. It does
**not** own accounts, roles or sessions (Network), the help text or manifests (Contracts), the network search index
(Search), event delivery (Events), or the host/database/Valkey (Host). The catalog is derived state: never put it in
a migration or cache it across a Contracts pin. A ticket is private: anyone but its requester gets 404, staff may read
all via their Network role.

## Auth and Capabilities

- A person is the `help_at` session cookie or a Network user token verified offline with the Network JWKS. A
  cookie-authenticated write must be same-origin (`request.cross_site`).
- Staff = Network role `admin` or `global_mod`; no `help.*` capability exists yet. `CAPABILITIES` in
  [server/http/principal.js](server/http/principal.js) is empty on purpose — add a capability here and in
  `openvibe-contracts` together when a route is for an app, never one alone.
- Outbound: `events.subscription.manage` at boot; `network.account.export.contribute` and
  `network.account.deletion.confirm` through `openvibe-sdk/account-data`; `search.document.write` for the search feed.
- Problem codes are RFC 9457 `application/problem+json`: `token.required`, `help.person_required`,
  `request.cross_site`, `staff.forbidden`, `ticket.not_found`, `help.site.not_found`, `ticket.invalid`,
  `rate_limited`.

## API and Pages

Pages: `/`, `/sites`, `/sites/:id`, `/a/:site/:slug`, `/search`, `/tickets`, `/tickets/:id`, `/staff`, `/updates`,
plus discovery (`/llms.txt`, `/sitemap.xml`, `/robots.txt`, `/.well-known/agent.json`) and the Markdown twins.

`/api/v1`: `GET /ping`, `GET /sites`, `GET /sites/:id`, `GET /articles?q=`, `POST /tickets`, `GET /tickets`,
`GET /tickets/:id`, `POST /tickets/:id/messages`, `GET /staff/tickets` (staff), `POST /tickets/:id/state` (staff).
Machine endpoints `/api/health`, `/api/ready`, `/release.json`, `/metrics` are loopback only.

## Conventions

- CommonJS, 4-space indent, single quotes, semicolons; no linter/formatter.
- Route handlers go through [server/http/router.js](server/http/router.js); errors from async handlers must reach the
  error handler. Never log request bodies or ticket bodies.
- IDs are `tkt_`/`msg_` + ULID; reads are explicit field maps, not raw rows.
- New schema = a new `migrations/NNNN_name.sql`; never edit a migration that has run.
- CSP: every external origin belongs in the `helmet` directives in [server/app.js](server/app.js); `frameAncestors`
  stays `'none'`. The kit/Frame come from the named OpenVibe hosts, not arbitrary CDNs.
- Phone first: every answer and ticket page must fit 390 px (and the longest at 320 px) with no horizontal scroll;
  [test/phone-clipping.test.js](test/phone-clipping.test.js) measures this in Chrome.
- Empty states use the shared kit (`class="ovk-empty"` with a next action), not bespoke markup
  ([test/empty-states.test.js](test/empty-states.test.js)).
- "Calm reduces, only Off removes": preferences may de-emphasize, never delete. Never add a hidden removal path.
- No model call belongs in Help: articles are manifest text, not generated copy.

## Key Pitfalls

- **Catalog is rebuilt at boot.** A new site or FAQ is a Contracts change and a pin bump, not an edit here; a stale
  pin means a missing site. Never hand-write an article.
- **Ticket privacy.** `GET /tickets/:id` returns 404 to anyone but the requester (staff excepted); keep that check on
  every new read path. `page_url` is stored as text and never fetched.
- **No build step.** Editing [public/](public/) takes effect on deploy; content hashing adds `?v=`, so never hand-add
  it. `home-short` and `perf-budget` tests fail when first paint or the home's size grows.
- **Account deletion** is loopback-only, signature-verified and idempotent: a redelivered `/internal/events` event
  must change nothing.
- **Drill mode** (`HELP_DRILL`) keeps boot-time timers, outbound calls and subscriptions off; add any new one to it.
- **Markdown twins** are served before page routes so `/a/site/x.md` is a twin, not an article slug; new top-level
  pages must be added to the page router and the sitemap/llms artifacts.
- **`event_outbox` indexing:** the rejected-count query needs the partial index in
  [migrations/0006_outbox_rejected_index.sql](migrations/0006_outbox_rejected_index.sql); do not drop it.
- **No Font Awesome** in new UI; use the shared kit's glyphs.

## Testing

`npm test` runs each `test/*.test.js` in its own process on a temp PGlite database with a mock Network.
[test/tickets.test.js](test/tickets.test.js), [test/help-articles.test.js](test/help-articles.test.js),
[test/help-search.test.js](test/help-search.test.js), [test/search-index.test.js](test/search-index.test.js),
[test/account-data.test.js](test/account-data.test.js), SSO/limits/secret-leak/redirect regressions, layout and
discovery. [test/phone-clipping.test.js](test/phone-clipping.test.js) uses a real Chrome and reports a skip when
Chrome is absent. Run the narrowest file (`npm test -- tickets`), then the suite; `npm run test:pg` for the PostgreSQL
path. Always `node --check` changed files.

## Documentation

- [README.md](README.md) — purpose, ownership, capabilities, what it does, pages, API, configuration, tests, deploy,
  account data, threat notes.
- [STATUS.json](STATUS.json) — stage, deployed state, features and not-yet list.
- [.env.example](.env.example) — every variable name (never commit values).
- [CHANGELOG.md](CHANGELOG.md), [SECURITY.md](SECURITY.md) — releases and vulnerability reporting.
