# OpenVibe.Help

> Answers, support and a way to reach people.

**Status:** skeleton. It runs, it is tested, and its pages and API are live — but the product itself is not written yet.
**Domain:** `openvibe.help` · **Port:** 5020 · **Service id:** `help` · **Env prefix:** `HELP`
**License:** AGPL-3.0 (same as every OpenVibe service).

## What is already here

| Piece | Where | What it does |
|---|---|---|
| Config | [server/config.js](server/config.js) | Every value from the environment; `load(env)` is pure so tests build a config without touching `process.env` |
| App | [server/app.js](server/app.js) | helmet (CSP, frame-ancestors none), the Network session middleware, `/auth`, the legal pages, static assets, the `/api/v1` mount, the 404 and the error handler |
| Sign-in | [server/auth/sso.js](server/auth/sso.js) | OAuth 2 authorization code with PKCE (S256) against OpenVibe.Network; httpOnly `help_at` / `help_rt` cookies; `/auth/me` for the shared navbar |
| Signing key | [server/auth/keys.js](server/auth/keys.js) | The Network JWKS through `openvibe-sdk/auth`, kept fresh, verified offline |
| Who is calling | [server/http/principal.js](server/http/principal.js) | `req.principal`: a person, an app/agent/service with a capability, or anonymous |
| API | [server/http/api.js](server/http/api.js) | `GET /api/v1/ping`; the router, the problem+json errors and the guards are wired for the product's routes |
| Pages | [server/http/pages.js](server/http/pages.js), [server/render/](server/render/) | The home page and `/updates`, server-rendered through `openvibe-shared/shell`, readable without JavaScript |
| Discovery | [server/http/discovery.js](server/http/discovery.js) | `robots.txt`, `sitemap.xml`, `llms.txt`, `llms-full.txt` and the home page's JSON-LD |
| Limits | [server/http/caller-limits.js](server/http/caller-limits.js), [deploy/nginx/](deploy/nginx/) | Per-caller limits at the API and per-address limits at nginx |
| Health | [server/observability.js](server/observability.js) | `/api/health`, a truthful `/api/ready` (the database is required) and Prometheus metrics on loopback only |
| Database | [server/db.js](server/db.js), [migrations/](migrations/) | PostgreSQL through `openvibe-sdk/db`; `NNNN_*.sql` applied at boot; PGlite in development |
| Process | [server/index.js](server/index.js) | Listens on `PORT`, and stops gracefully through `openvibe-sdk/service` |
| Deploy | [deploy/nginx/openvibe.help.conf](deploy/nginx/openvibe.help.conf), [deploy/systemd/openvibe-help.service](deploy/systemd/openvibe-help.service) | nginx vhost and systemd unit (port 5020, `/opt/openvibe.help`, `/etc/openvibe/help.env`) |
| Tests | [test/](test/) | `npm test`: every `test/*.test.js` in its own process, on a temp PGlite database with an in-process mock of OpenVibe.Network |

## API

| Route | Who | |
|---|---|---|
| `GET /api/v1/ping` | anyone | `{ ok: true, service: "help" }` |

Everything else the site serves is a page. The product adds its routes in [server/http/api.js](server/http/api.js), naming
each route's capability in [server/http/principal.js](server/http/principal.js) (`CAPABILITIES`) and its numbers in
[server/http/caller-limits.js](server/http/caller-limits.js) (`BUDGETS`).

**Who can call it:** a person, with their Network token as a Bearer or this site's session; or an app, agent or service
with a Network token for audience `openvibe.help` that holds the route's capability. A write made with the session cookie
must come from `openvibe.help` itself. **Errors** are RFC 9457 `application/problem+json` with a stable `code`.

## Configuration

See [.env.example](.env.example). Required in production: `OV_OAUTH_CLIENT_SECRET` (the `help` OAuth client on the
Network), `BASE_URL`, `DATABASE_URL` and `DATABASE_DIRECT_URL`. The database is the only required readiness check; the
Network signing key, the OAuth client and Valkey are optional (the service says so, per check, on `/api/ready`).

## Development

```bash
npm install
fnm exec --using=22 npm test        # every test/*.test.js, on temp PGlite databases with a mock Network
fnm exec --using=22 npm run dev     # http://localhost:5020
```

Without `DATABASE_URL` development uses an embedded PGlite database in `data/pglite` (one process only). `npm run
test:pg` runs the same suite through PostgreSQL and PgBouncer (see [.github/workflows/ci.yml](.github/workflows/ci.yml)).

## Deploy (for the lead)

- **Deploy:** `sudo ovhost deploy help` on the host (git checkout at `/opt/openvibe.help`, unit
  `openvibe-help.service` on 127.0.0.1:5020, env `/etc/openvibe/help.env`, database `ov_help` on the data role).
- **nginx:** [deploy/nginx/openvibe.help.conf](deploy/nginx/openvibe.help.conf), installed with `ov-vhost-install`.
- **Rollback:** ovhost puts the previous sha back by itself when `/api/ready` does not answer after the restart.
- Register the service and its capabilities in **OpenVibe.Contracts** (`contracts-service: help` in CI) and with
  **OpenVibe.Services** before the first deploy.

## Security (threat notes)

Reporting a vulnerability: [SECURITY.md](SECURITY.md).

- Session tokens are httpOnly cookies; a FedCM assertion or an app or service token is never a session.
- Secrets live only in the env file; only environment variable names appear in code and docs, and no secret is logged.
- Request bodies are never logged.
- Nothing in a request may decide a URL this service fetches: a caller's URL goes to OpenVibe.Tools, whose own guard
  decides what may be fetched.

---

Part of the [OpenVibe network](https://openvibe.network). Built in the open by [OpenVibers](https://github.com/OpenVibers).

<!-- versions:start -->
- openvibe-contracts: v0.115.0
- openvibe-sdk: v0.35.2
- openvibe-shared: v2.14.0
<!-- versions:end -->
