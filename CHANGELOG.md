# Changelog

What changed in OpenVibe.Help, newest first. Each site also publishes its patch notes at /updates.

## 0.2.0 — 2026-10-08

The product: a help centre generated from OpenVibe.Contracts, search over it and over the network, and support
tickets that stay one conversation.

- **Help articles from real content, generated at boot.** `server/catalog.js` reads every product manifest and every
  service manifest whose `site` block presents a site, and builds one page per site (`/sites`, `/sites/<domain>`) and
  one page per FAQ entry (`/a/<domain>/<slug>`, one question per page, the question as the title). Every text is the
  manifest's, verbatim; each page names the manifests it read and links back to them.
- **Search** (`server/search.js`, `/search`, `GET /api/v1/articles?q=`): a fixed, explainable score over the question,
  the answer and the site's own text, plus OpenVibe.Search's public API in a second section. The network answer is
  cached in-process for 5 minutes; a failure is shown as a failure and the page falls back to the articles alone.
- **Support tickets** (`migrations/0002_tickets.sql`, `server/tickets/`, `/tickets`, `/staff`): a signed-in person
  opens one (site from the catalog, subject, message, an optional page URL stored as text and never fetched), sees
  only their own, and replies; staff (`admin` / `global_mod` on the session's role claim) read the queue, filter it by
  site and state, reply, and set `open | waiting | solved`. Bodies are plain text, escaped with their line breaks,
  capped at 10 000 characters.
- **API:** `GET /sites`, `GET /sites/:id`, `GET /articles?q=`, `POST|GET /tickets`, `GET /tickets/:id`,
  `POST /tickets/:id/messages`, and for staff `GET /staff/tickets` and `POST /tickets/:id/state`. Writes made with the
  session cookie must come from openvibe.help itself; another person's ticket is a 404; an app token cannot act as a
  person. `http/principal.js` now carries the Network role claim so a route can tell staff from everyone else.
- **Per-caller limits:** `help.ticket.create` 6 a minute / 60 an hour, `help.ticket.message` 30 / 300. The skeleton's
  `caller-limits.test.js` pinned an empty `BUDGETS`; it now pins these.
- **Pages:** the home page is the help centre (a search box, the questions the sites answer, the site grid, contact
  support), plus `/sites`, `/sites/:id`, `/a/:site/:slug`, `/search`, `/tickets`, `/tickets/new`, `/tickets/:id`,
  `/staff` and `/updates`. All server-rendered, all working without JavaScript. The navbar gained Answers, Search and
  Your tickets.
- **Discovery:** the sitemap and `llms-full.txt` are two renderings of one page list, so every site and every question
  is crawlable in both; `llms.txt` lists the sites; `/tickets` and `/staff` are disallowed. The home page's JSON-LD
  gained the sitelinks search action.
- **CSS budget raised** (16.5 → 18.5 KB raw, 4.1 → 4.5 KB brotli) for the help centre's own styles: measured
  17.5/4.3 KB. The HTML budget did not move — the home page is 25.3 KB against 27.5.
- **Tests:** `test/help-articles.test.js` (the pages against the manifests, escaping), `test/help-search.test.js` (the
  score and the OpenVibe.Search stand-in, `test/helpers/search-provider.js`), `test/tickets.test.js` (the whole
  lifecycle, privacy, cross-site writes, limits). `test/skeleton.test.js` now skips itself in a generated service
  (the skeleton's placeholders are already substituted here, so the generator cannot rebuild the sample) — a skip, not
  a pass.

## 0.1.0 — 2026-10-08

- **First release:** the service starts from the OpenVibe skeleton — sign-in with OpenVibe.Network (OAuth 2 + PKCE), server-rendered pages through the OpenVibe Frame, the `/api/v1` mount with per-caller limits, crawl artifacts, PostgreSQL migrations, the deploy files and the test suite.
