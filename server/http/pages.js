'use strict';

/**
 * Public pages: the help centre generated from OpenVibe.Contracts (home, /sites, one site, one question) and the
 * support side (/search, /tickets, one ticket, /staff, the update log). Crawl artifacts are http/discovery.js.
 *
 * Every page is server-rendered and complete without JavaScript — forms are plain POSTs and the search box is a
 * GET — through openvibe-shared/shell (render/layout.js). Nothing here is hand-written copy: the sites, the one
 * lines, the pillars and every question and answer come from the manifests (server/catalog.js), and each page says
 * which manifest it read. A signed-in write must come from openvibe.help itself, as in the API.
 */
const express = require('express');
const ovServe = require('openvibe-shared/serve');
const frame = require('openvibe-shared/frame');
const showcase = require('openvibe-shared/showcase');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');
const { createDiscoveryRoutes, homeJsonLd } = require('./discovery');
const { sameOrigin } = require('./principal');
const { html, raw, render, table, notice, time, badge } = require('../render/html');
// The short home (the owner's rule, 2026-10-30): a pick block for the site list, folds for the parts a reader
// rarely needs.
const { pickList, pickListRules, foldBlock } = require('../render/short');
const { send } = require('../render/layout');
const { searchArticles, markTerms } = require('../search');
const tickets = require('../tickets/tickets');
const store = require('../tickets/store');
const { isStaff } = require('../tickets/staff');

const SITE_NAME = 'OpenVibe.Help';
const TAGLINE = 'Answers, support and a way to reach people.';
const PAGE_LIMIT = 50;

const STATE_KIND = { open: 'info', waiting: 'warn', solved: 'ok' };
const STATE_TEXT = { open: 'open', waiting: 'waiting', solved: 'solved' };
const SITE_STATE_KIND = { live: 'ok', coming: '' };
const SITE_STATE_TEXT = { live: 'live', coming: 'coming' };

/** Plain text exactly as it was typed: escaped by the template, line breaks kept by the stylesheet. */
const textBlock = (t) => html`<p class="txt">${t}</p>`;
const truncate = (s, n) => (String(s == null ? '' : s).length > n ? `${String(s).slice(0, n - 1).trimEnd()}…` : String(s == null ? '' : s));

// Stated where the answers and the sites are listed: there is no ad or promoted slot in either (outcome 5). It is a
// fact about how the catalog is built, not a slogan: every entry comes from OpenVibe.Contracts, in the site's words.
const NO_PROMOTED = 'No promoted or sponsored answers or sites: every entry comes from OpenVibe.Contracts, in its site\'s own words, and no one can pay for a place.';

/** A measured reply time, in words: under a minute, minutes, hours, days. No number is made up. */
function replyTime(ms) {
    if (!Number.isFinite(ms)) return '';
    const minutes = Math.round(ms / 60_000);
    if (minutes < 1) return 'under a minute';
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours < 24) return rest ? `${hours} h ${rest} min` : `${hours} h`;
    const days = Math.floor(hours / 24);
    const spare = hours % 24;
    return spare ? `${days} d ${spare} h` : `${days} d`;
}

/**
 * The page's JSON-LD in one script: every node in one @graph, so a page carries exactly one JSON-LD script.
 * The nodes keep their own fields; only their own @context goes, because the graph carries it once.
 */
const oneGraph = (nodes) => {
    const graph = nodes.filter(Boolean).map((n) => { const c = { ...n }; delete c['@context']; return c; });
    return [{ '@context': 'https://schema.org', '@graph': graph }];
};

function createPageRoutes(ctx) {
    const { config, s, catalog, search } = ctx;
    const r = asyncRouter();
    // The pages' forms are plain POSTs (no JavaScript): urlencoded only, and small — a ticket is text.
    r.use(express.urlencoded({ extended: false, limit: '64kb' }));
    const PUBLIC_CACHE = cache.htmlHeaders({ maxAge: 300 });
    const page = (req, res, o, status = 200) => send(res, status, { viewer: req.viewer, config, path: req.originalUrl, ...o });
    const signedIn = (req) => req.viewer && req.viewer.kind === 'user' && req.viewer.subject;
    const staffViewer = (req) => isStaff(req.viewer);
    const requesterOf = (req) => `user:${req.viewer.subject}`;
    const base = () => String(config.baseUrl).replace(/\/+$/, '');

    // ── Small pieces ─────────────────────────────────────────
    const siteBadge = (state) => badge(SITE_STATE_TEXT[state] || state, SITE_STATE_KIND[state] || '');
    const ticketBadge = (state) => badge(STATE_TEXT[state] || state, STATE_KIND[state] || '');

    /** Where a page's text came from: the manifests it was read from, and when. */
    const provenance = (p, { compact = false } = {}) => {
        const files = p.manifests || (p.manifest ? [p.manifest] : []);
        return html`<p class="prov small muted">Generated from <a href="${p.url}" rel="noopener nofollow">${p.source || p.name}</a>${files.length ? html` · ${files.map((f) => html`<code>${f}</code>`)}` : ''}${compact ? '' : html` · read ${time(catalog.generatedAt)}`}</p>`;
    };

    const signInPrompt = (what, next) => html`<div class="notice">${what} <a href="/auth/login?next=${encodeURIComponent(next)}">Sign in with OpenVibe</a>.</div>`;

    /**
     * The ticket promise: what a reader gets back, and the first-reply time this service has measured. The number is
     * the median over its own help_messages rows (server/tickets/store.js replyStats); until a ticket has had a staff
     * reply it says so. Never a target typed in by hand.
     */
    const ticketPromise = (stats) => {
        const measured = stats && stats.answered
            ? html`<strong>Median first reply: ${replyTime(stats.medianMs)}, from ${stats.answered} answered ticket${stats.answered === 1 ? '' : 's'}.</strong>`
            : html`<strong>First-reply time: not measured yet${stats && stats.unknown ? '' : ' — no ticket here has had a staff reply'}.</strong>`;
        return notice(html`A person on the OpenVibe team replies here, not a bot; the conversation stays on this ticket. ${measured}`, 'info');
    };
    const measuredReplies = async () => {
        // A read that failed is not the same as no reply: the page then says "not measured yet" and stops there.
        try { return await store.replyStats(s); } catch { return { answered: 0, medianMs: null, unknown: true }; }
    };

    const searchForm = (q = '', { big = false } = {}) => html`<form class="search-form${big ? ' search-big' : ''}" method="get" action="/search" role="search">
<label class="sr-only" for="q">Search the help centre</label>
<input id="q" name="q" type="search" value="${q}" placeholder="Search every OpenVibe site: how a feature works, what a price is, what is not working" maxlength="200" required>
<button class="sc-btn sc-primary" type="submit">Search</button>
</form>`;

    // ── Home ─────────────────────────────────────────────────
    /** Contact support: the form itself is /tickets/new, and a visitor who is not signed in is asked to sign in. */
    function contactBlock(req, replies) {
        if (!signedIn(req)) {
            return html`<div class="card">${signInPrompt('To open a ticket', '/tickets/new')}
${ticketPromise(replies)}
<p class="small muted">A ticket is one conversation with the people who run OpenVibe, kept in your account — not an inbox you lose. Signing in also lets you see and answer it later.</p></div>`;
        }
        return html`<div class="card">${ticketPromise(replies)}
<p class="small muted">Signed in as <strong>${req.viewer.displayName || req.viewer.username || 'you'}</strong>.</p>
<p><a class="sc-btn sc-primary" href="/tickets/new">Open a ticket</a> <a class="sc-btn" href="/tickets">Your tickets</a></p></div>`;
    }

    r.get('/', async (req, res) => {
        const live = catalog.sites.filter((x) => x.live);
        // Real figures only: the catalog's own counts, and tickets solved once there are any.
        const answersBySite = new Map();
        for (const a of catalog.articles) answersBySite.set(a.site, (answersBySite.get(a.site) || 0) + 1);
        const features = catalog.sites.reduce((n, x) => n + ((x.pillars && x.pillars.length) || 0), 0);
        let solved = 0;
        try { solved = (await store.staffCounts(s)).solved; } catch { /* the figure is left out, never guessed */ }
        const replies = await measuredReplies();
        const n = (v) => Number(v).toLocaleString('en-US');
        const stats = [[`${n(live.length)} sites`, 'live, every one with its own page here'], [`${n(catalog.articles.length)} answers`, 'each in the site\'s own words, linked back']];
        if (features) stats.push([`${n(features)} features`, 'described by the sites that run them']);
        if (solved) stats.push([`${n(solved)} tickets`, 'solved by the people who run OpenVibe']);
        const hero = showcase.hero({
            eyebrow: `${SITE_NAME} · ${TAGLINE}`,
            title: 'How can we help?',
            accent: 'Every OpenVibe site in one place.',
            lede: `The answers come from the sites themselves: each product's own manifest, kept word for word, with a link back to where it was read. Search it, or open a ticket and it stays one conversation.`,
            actions: signedIn(req)
                ? [{ label: 'Your tickets', href: '/tickets' }, { label: 'Open a ticket', href: '/tickets/new', primary: true }]
                : [{ label: 'Search the answers', href: '#search', primary: true }, { label: 'Sign in to open a ticket', href: '/auth/login?next=%2Ftickets%2Fnew' }],
            note: `Open source (AGPL-3.0). ${catalog.sites.length} sites in the catalog${live.length === catalog.sites.length ? ', every one live' : `: ${live.length} live, ${catalog.sites.length - live.length} still coming`}.`,
            html: `<dl class="help-stats">${stats.map(([dt, dd]) => `<div><dt>${dt}</dt><dd>${dd}</dd></div>`).join('')}</dl>`,
        });
        // The questions shown with their answers are FAQPage data too: the same words, verbatim from the manifests.
        const faqLd = catalog.popular.length ? { '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: catalog.popular.map((a) => ({ '@type': 'Question', name: a.question, acceptedAnswer: { '@type': 'Answer', text: a.answer } })) } : null;
        page(req, res, {
            index: true, cache: signedIn(req) ? null : PUBLIC_CACHE,
            jsonLd: faqLd ? [...homeJsonLd(config), faqLd] : homeJsonLd(config),
            description: `Search the answers of every OpenVibe site, browse them one by one, or open a support ticket that stays one conversation.`,
            styles: [showcase.STYLESHEET],
            // The rule that shows the picked site of the pick list: one per site, written for this page.
            inlineStyles: [`@supports selector(:has(*)){@media (max-width:640px){${pickListRules('sites', catalog.sites.length)}}}`],
            body: html`${raw(hero)}
<section class="sc-sec" id="search" aria-labelledby="h-search"><h2 id="h-search">Search the help centre</h2>
<p class="sc-lede">One box over every site's answers, and over the whole OpenVibe network.</p>
${searchForm()}</section>
${raw(pickList({
    key: 'sites',
    label: 'Browse by site',
    head: 'Browse by site',
    labels: catalog.sites.map((x) => x.shortName),
    html: render(html`<section class="sc-sec" aria-labelledby="h-sites"><h2 id="h-sites">Browse by site</h2>
<p class="sc-lede">Live sites first; each name opens that site's page, with its own words and its own questions. <a href="/sites">The full list, with what each one is</a>.</p>
<p class="small muted">${NO_PROMOTED}</p>
<ul class="site-cards pick-list">${catalog.sites.map((x, i) => html`<li data-i="${i}"><a class="site-card${x.live ? '' : ' coming'}" href="/sites/${x.id}"><span class="site-card-top"><b>${x.shortName}</b><span class="site-state">${x.live ? 'live' : 'coming'}</span></span><span class="site-card-line">${x.oneLine}</span>${answersBySite.get(x.domain) ? html`<span class="site-card-count">${String(answersBySite.get(x.domain))} ${answersBySite.get(x.domain) === 1 ? 'answer' : 'answers'}</span>` : ''}</a></li>`)}</ul>
<p class="small"><a href="/sites">All ${catalog.sites.length} sites, with what each one is</a></p></section>`),
}))}
${raw(foldBlock({
    id: 'popular',
    head: '<h2 id="h-popular">Popular questions</h2>',
    html: render(html`<section class="sc-sec" aria-labelledby="h-popular"><h2>Popular questions</h2>
<p class="sc-lede">One question from each site in turn, answered the way the site answers it in its own manifest.</p>
<div class="q-faq">${catalog.popular.map((a) => html`<details><summary><span>${a.question}</span><span class="q-site">${String(a.siteName).replace(/^OpenVibe\./, '')}</span></summary><p>${a.answer}</p><p class="small"><a href="${a.path}">The answer's own page</a> · <a href="/sites/${a.site}">Every ${String(a.siteName).replace(/^OpenVibe\./, '')} question</a></p></details>`)}</div>
<p class="small"><a href="/sites">Every question, site by site</a></p></section>`),
}))}
<section class="sc-sec" aria-labelledby="h-contact"><h2 id="h-contact">Contact support</h2>
<p class="sc-lede">Nothing here answered it? Open a ticket: you and the people who run OpenVibe, in one thread.</p>
${contactBlock(req, replies)}</section>
${raw(foldBlock({
    id: 'network',
    head: '<h2 id="h-network">Part of OpenVibe</h2>',
    html: showcase.network({ service: 'help' }),
}))}`,
        });
    });

    // ── The sites ────────────────────────────────────────────
    r.get('/sites', (req, res) => {
        const group = (state, title, lede) => {
            const list = catalog.sites.filter((x) => x.state === state);
            if (!list.length) return '';
            return html`<section class="sc-sec" aria-labelledby="h-${state}"><h2 id="h-${state}">${title}</h2><p class="sc-lede">${lede}</p>
<ul class="site-list">${list.map((x) => html`<li><a href="/sites/${x.id}"><b>${x.name}</b></a> <span class="muted">${x.oneLine}</span> <span class="small"><a href="${x.url}" rel="noopener nofollow">${x.domain}</a></span></li>`)}</ul></section>`;
        };
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: 'Every OpenVibe site',
            description: `${catalog.sites.length} OpenVibe sites with what each one is, whether it is live yet, and its own questions and answers.`,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Sites' }],
            jsonLd: [
                seo.jsonLd.breadcrumbs([{ name: 'OpenVibe.Help', url: `${base()}/` }, { name: 'Sites', url: `${base()}/sites` }]),
                seo.jsonLd.itemList('OpenVibe sites', catalog.sites.map((x) => ({ name: x.name, url: `${base()}/sites/${x.id}`, description: x.oneLine })), { url: `${base()}/sites` }),
            ],
            body: html`<h1>Every OpenVibe site</h1>
<p class="sc-lede">${catalog.sites.length} addresses, ${catalog.sites.every((x) => x.live) ? 'every one live' : `${catalog.sites.filter((x) => x.live).length} of them live`}. The state is the service manifest's own <code>exposure.state</code>: a site is live when a service exposes it live. Everything else on this page is that site's manifest, word for word.</p>
<p class="small muted">${NO_PROMOTED}</p>
${provenance(catalog.source)}
${group('live', 'Live', 'These answer today.')}
${group('coming', 'Coming', 'Registered in the catalog, not serving yet, or serving something else for now.')}`,
        });
    });

    r.get('/sites/:id', (req, res) => {
        const site = catalog.get(req.params.id);
        if (!site) return page(req, res, {
            title: 'No such site', crumbs: [{ label: 'Home', href: '/' }, { label: 'Sites', href: '/sites' }, { label: 'Not found' }],
            body: html`<h1>No such site</h1><p class="muted">The catalog has no site <code>${truncate(String(req.params.id), 80)}</code>. <a href="/sites">See all ${catalog.sites.length} sites</a>.</p>`,
        }, 404);
        const articles = catalog.bySite.get(site.id) || [];
        const faqPairs = articles.map((a) => ({ q: a.question, a: a.answer }));
        // The network's own status page is the public read of whether a service is serving. A site that is not live
        // links there in one line instead of reporting a health state Help does not own.
        const statusHref = site.service ? `${config.statusUrl}#svc-${site.service}` : config.statusUrl;
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            // "Help with Search", not "Search": the bare name of the OpenVibe.Search page read exactly like Help's own
            // search page in titles and results (2026-10-17).
            title: `Help with ${site.name}`,
            description: truncate(site.oneLine || site.description, 160),
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Sites', href: '/sites' }, { label: site.name }],
            jsonLd: [
                seo.jsonLd.breadcrumbs([{ name: 'OpenVibe.Help', url: `${base()}/` }, { name: 'Sites', url: `${base()}/sites` }, { name: site.name, url: `${base()}/sites/${site.id}` }]),
                faqPairs.length ? seo.jsonLd.faq(faqPairs) : null,
            ],
            body: html`<h1>${site.name} ${siteBadge(site.state)}</h1>
${site.tagline ? html`<p class="sc-lede">${site.tagline}</p>` : ''}
${site.description ? textBlock(site.description) : ''}
${site.state === 'live'
        ? html`<p class="site-links"><a class="sc-btn sc-primary" href="${site.url}" rel="noopener nofollow">Open ${site.domain}</a>
<a class="sc-btn" href="${site.updatesUrl}" rel="noopener nofollow">What shipped on ${site.name}</a></p>`
        : notice(html`${site.name} is not serving yet. <a href="${statusHref}" rel="noopener nofollow">See its status on the OpenVibe status page</a>.`, 'warn')}
${provenance(site.provenance)}

${site.pillars.length ? html`<section class="sc-sec" aria-labelledby="h-pillars"><h2 id="h-pillars">${site.state === 'live' ? 'What you can do' : 'What it will do'}</h2>
<ul class="pillars">${site.pillars.map((p) => html`<li><b>${p.title}</b>${p.text ? html` <span class="muted">${p.text}</span>` : ''}</li>`)}</ul></section>` : ''}

<section class="sc-sec" aria-labelledby="h-faq"><h2 id="h-faq">Questions</h2>
${articles.length
        ? html`<p class="sc-lede">${articles.length} question${articles.length === 1 ? '' : 's'} this site answers about itself. Each one has its own page, so it can be linked and found on its own.</p>
${articles.map((a) => html`<article class="faq-item" id="${a.anchor}">
<h3><a href="${a.path}">${a.question}</a></h3>
${textBlock(a.answer)}
<p class="small"><a href="${a.path}">Open this question on its own page</a></p></article>`)}`
        : html`<p class="muted">This site's manifest has no questions yet.${site.state === 'coming' ? ' It is still coming.' : ''} <a href="/tickets/new">Ask us instead</a> or read the site's own pages at <a href="${site.url}" rel="noopener nofollow">${site.domain}</a>.</p>`}
</section>`,
        });
    });

    // ── One question, one page (SEO title = the question) ────
    r.get('/a/:site/:slug', (req, res) => {
        const article = catalog.article(req.params.site, req.params.slug);
        if (!article) return page(req, res, {
            title: 'No such question', crumbs: [{ label: 'Home', href: '/' }, { label: 'Sites', href: '/sites' }, { label: 'Not found' }],
            body: html`<h1>No such question</h1><p class="muted">No answer here for <code>${truncate(`${req.params.site}/${req.params.slug}`, 90)}</code>. <a href="/sites">See every site</a>.</p>`,
        }, 404);
        const site = catalog.get(article.site);
        page(req, res, {
            index: true, cache: PUBLIC_CACHE,
            title: article.question,
            description: truncate(article.answer, 160),
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Sites', href: '/sites' }, { label: article.siteName, href: `/sites/${article.site}` }, { label: truncate(article.question, 60) }],
            jsonLd: oneGraph([
                seo.jsonLd.article({ headline: article.question, url: `${base()}${article.path}`, description: truncate(article.answer, 160) }),
                // One question, one answer, both verbatim from the manifest: the page's own <h1> and its body.
                seo.jsonLd.faq([{ q: article.question, a: article.answer }]),
                seo.jsonLd.breadcrumbs([{ name: 'OpenVibe.Help', url: `${base()}/` }, { name: article.siteName, url: `${base()}/sites/${article.site}` }, { name: article.question, url: `${base()}${article.path}` }]),
            ]),
            body: html`<article class="answer">
<h1>${article.question}</h1>
<p class="small muted">Answered by <a href="/sites/${article.site}">${article.siteName}</a> ${siteBadge(article.siteState)}</p>
${textBlock(article.answer)}
<div class="card answer-facts">
<p class="small"><strong>Site:</strong> <a href="/sites/${article.site}">${article.siteName}</a> <span class="muted">· ${article.site}</span> ${siteBadge(article.siteState)}</p>
<p class="small"><strong>Last changed:</strong> not recorded by the site's manifest (${catalog.source.name}); Help last read it ${time(catalog.generatedAt)}.</p>
</div>
<p class="site-links"><a class="sc-btn" href="/sites/${article.site}">Everything ${article.siteName} answers</a>
${site ? html`<a class="sc-btn" href="${site.url}" rel="noopener nofollow">${site.domain}</a><a class="sc-btn" href="${site.updatesUrl}" rel="noopener nofollow">What shipped</a>` : ''}</p>
${provenance(article.provenance)}
</article>
<section class="sc-sec" aria-labelledby="h-more"><h2 id="h-more">Other questions from ${article.siteName}</h2>
<ul class="q-list">${(catalog.bySite.get(article.site) || []).filter((a) => a.slug !== article.slug).map((a) => html`<li><a href="${a.path}">${a.question}</a></li>`)}</ul></section>`,
        });
    });

    // ── Search ───────────────────────────────────────────────
    r.get('/search', async (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
        const hits = q ? searchArticles(catalog, q, { limit: 20 }) : [];
        const network = q ? await search.search(q) : { ok: false, reason: 'no query', results: [] };
        page(req, res, {
            // Indexable, and in the sitemap: every query canonicalises to /search (the layout drops the query), so a
            // crawler keeps one page, not one per query.
            index: true, cache: PUBLIC_CACHE,
            title: q ? `Search: ${truncate(q, 60)}` : 'Search',
            description: 'Search every OpenVibe site\'s own answers, and the whole network through OpenVibe.Search.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Search' }],
            body: html`<h1>Search</h1>
${searchForm(q, { big: true })}
${!q ? html`<p class="sc-lede">Type something above. The first half of the answer comes from each site's own manifest; the second from <a href="${search.url}" rel="noopener nofollow">OpenVibe.Search</a>, the network's own index.</p>` : ''}
${q ? html`<section class="sc-sec" aria-labelledby="h-help"><h2 id="h-help">Help articles</h2>
<p class="small muted">${NO_PROMOTED}</p>
${hits.length
                ? html`<p class="sc-lede">${hits.length} article${hits.length === 1 ? '' : 's'} from the sites' own manifests, best match first.</p>
<ol class="results">${hits.map((h) => html`<li><a href="${h.article.path}">${markTerms(h.article.question, q)}</a>
<p class="small muted">${markTerms(h.snippet, q)}</p>
<p class="small"><a href="/sites/${h.article.site}">${h.article.siteName}</a></p></li>`)}</ol>`
                : html`<p class="muted">No article matches “${q}”. Try fewer or different words, <a href="/sites">browse the sites</a>, or <a href="/tickets/new">open a ticket</a>.</p>`}
</section>` : ''}
${q ? html`<section class="sc-sec" aria-labelledby="h-net"><h2 id="h-net">From across OpenVibe</h2>
${network.ok
                    ? (network.results.length
                        ? html`<p class="sc-lede">From <a href="${search.url}" rel="noopener nofollow">OpenVibe.Search</a>, the network's index of streams, clips, pastes, posts and wiki pages.</p>
<ul class="results net">${network.results.map((x) => html`<li><a href="${x.url}" rel="noopener nofollow">${x.title}</a>${x.summary ? html`<p class="small muted">${x.summary}</p>` : ''}<p class="small">${x.type ? html`<span class="badge">${x.type}</span> ` : ''}${x.owner ? html`<span class="muted">${x.owner}</span>` : ''}</p></li>`)}</ul>`
                        : html`<p class="muted">OpenVibe.Search answered, with nothing for “${q}”.</p>`)
                    : html`<p class="muted">OpenVibe.Search could not be reached just now (<span class="badge warn">${network.reason}</span>), so this page shows the help articles only. Try again in a moment.</p>`}
</section>` : ''}`,
        });
    });

    // ── Tickets ──────────────────────────────────────────────
    /** A page write must come from this site, exactly as in the API: a cross-site form must not act as the person. */
    function sameSite(req, res, back) {
        if (sameOrigin(req, config.baseUrl)) return true;
        page(req, res, {
            title: 'Not from this site',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Not from this site' }],
            body: html`<h1>That came from somewhere else</h1><p class="muted">A signed-in page that changes something has to come from openvibe.help itself. <a href="${back}">Go back</a> and try again.</p>`,
        }, 403);
        return false;
    }

    /**
     * The same per-caller budget the API applies to opening a ticket and replying, given an HTML face. The limiter
     * writes its refusal straight to the response, so it writes to a shim and the page renders its own 429 — a person
     * using the form should not be handed problem+json. The counters, the windows and the metric are the API's: the
     * form is the same action through another door, so it cannot be a way round the limit.
     */
    const budgeted = (name) => {
        const limit = ctx.limits.budget(name);
        return (req, res, next) => {
            let settled = false;
            const refusal = (body) => {
                let problem = null;
                try { problem = JSON.parse(String(body)); } catch { problem = null; }
                if (problem && problem.retry_after_seconds) res.set('Retry-After', String(problem.retry_after_seconds));
                return page(req, res, {
                    title: 'Too many requests',
                    crumbs: [{ label: 'Home', href: '/' }, { label: 'Too many requests' }],
                    body: html`<h1>Too many requests just now</h1>
${notice(problem && problem.detail ? problem.detail : 'You are over the limit for this', 'warn')}
<p class="muted">Wait a moment and send it again — nothing was lost. Everything you already opened is under <a href="/tickets">your tickets</a>.</p>`,
                }, 429);
            };
            limit(req, {
                statusCode: 0,
                setHeader: () => {}, getHeader: () => undefined, removeHeader: () => {},
                end: (body) => { if (!settled) { settled = true; refusal(body); } },
            }, (err) => {
                if (settled) return undefined;
                settled = true;
                return err ? next(err) : next();
            });
            return undefined;
        };
    };

    /** The site picker: every catalog site, live ones first (the catalog is already in that order). */
    function siteSelect(selected = '') {
        const group = (state, label) => {
            const list = catalog.sites.filter((x) => x.state === state);
            if (!list.length) return '';
            return html`<optgroup label="${label}">${list.map((x) => html`<option value="${x.id}"${x.id === selected ? raw(' selected') : ''}>${x.name}${x.live ? '' : ' (coming)'}</option>`)}</optgroup>`;
        };
        return html`<select id="site" name="site"><option value="">Not about one site</option>${group('live', 'Live')}${group('coming', 'Coming')}</select>`;
    }

    const ticketForm = ({ values = {}, problem = null } = {}) => html`<form class="card ticket-form" method="post" action="/tickets">
${problem ? notice(problem, 'warn') : ''}
<div class="field"><label for="site">Which site is this about?</label>${siteSelect(values.site || '')}
<p class="small muted">Optional. Pick the OpenVibe site you were using, if it was one.</p></div>
<div class="field"><label for="subject">Subject</label><input id="subject" name="subject" type="text" maxlength="${tickets.LIMITS.subject}" required value="${values.subject || ''}"></div>
<div class="field"><label for="message">What happened?</label><textarea id="message" name="message" rows="8" maxlength="${tickets.LIMITS.body}" required placeholder="What you did, what you expected, what happened instead.">${values.message || ''}</textarea>
<p class="small muted">Plain text, up to ${tickets.LIMITS.body} characters.</p></div>
<div class="field"><label for="page_url">Page you were on</label><input id="page_url" name="page_url" type="text" maxlength="${tickets.LIMITS.pageUrl}" value="${values.pageUrl || ''}" placeholder="https://openvibe.example/some/page">
<p class="small muted">Optional, and only useful if you have it: it is stored as text and never opened by us.</p></div>
<p><button class="sc-btn sc-primary" type="submit">Open the ticket</button> <a class="sc-btn" href="/tickets">Your tickets</a></p>
</form>`;

    // "Report a problem" in every site's footer (openvibe-shared footer.js) opens /tickets/new?site=<domain>&page=<url>:
    // the form starts with that site and page. A site Help does not know, or a page that is not an http(s) address of
    // at most 500 characters, is left blank; the page is stored as text and never fetched, as when typed.
    const prefillOf = (q) => {
        const site = String(q.site || '').toLowerCase().replace(/^www\./, '');
        const pageUrl = typeof q.page === 'string' && q.page.length <= tickets.LIMITS.pageUrl ? tickets.pageLink(q.page) : null;
        return { site: catalog.byId.has(site) ? site : '', pageUrl: pageUrl || '' };
    };
    r.get('/tickets/new', async (req, res) => {
        const pre = prefillOf(req.query);
        const replies = await measuredReplies();
        const back = `/tickets/new${pre.site || pre.pageUrl ? `?${new URLSearchParams({ ...(pre.site ? { site: pre.site } : {}), ...(pre.pageUrl ? { page: pre.pageUrl } : {}) })}` : ''}`;
        if (!signedIn(req)) return page(req, res, {
            title: 'Open a ticket', crumbs: [{ label: 'Home', href: '/' }, { label: 'Your tickets', href: '/tickets' }, { label: 'New' }],
            body: html`<h1>Open a ticket</h1>${ticketPromise(replies)}${signInPrompt('A ticket belongs to your OpenVibe account, so you can see and answer it later.', back)}`,
        }, 401);
        page(req, res, {
            title: 'Open a ticket',
            description: 'Tell OpenVibe support what happened; the ticket stays one conversation.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your tickets', href: '/tickets' }, { label: 'New' }],
            body: html`<h1>Open a ticket</h1>
${ticketPromise(replies)}
<p class="sc-lede">One conversation with the people who run OpenVibe. You will see it under <a href="/tickets">your tickets</a> and can reply there.</p>
${ticketForm({ values: pre })}`,
        });
    });

    const mustSignIn = (back) => (req, res, next) => (signedIn(req) ? next()
        : page(req, res, { title: 'Sign in', crumbs: [{ label: 'Home', href: '/' }, { label: 'Sign in' }], body: html`<h1>Sign in first</h1>${signInPrompt('A ticket belongs to an account, so you can see and answer it later.', back)}` }, 401));

    r.post('/tickets', mustSignIn('/tickets/new'), budgeted('help.ticket.create'), async (req, res) => {
        if (!sameSite(req, res, '/tickets/new')) return;
        const b = req.body || {};
        const check = tickets.validateNew({ site: b.site, subject: b.subject, message: b.message, pageUrl: b.page_url }, { sites: new Set(catalog.sites.map((x) => x.id)) });
        if (!check.ok) return page(req, res, {
            title: 'Open a ticket', crumbs: [{ label: 'Home', href: '/' }, { label: 'Your tickets', href: '/tickets' }, { label: 'New' }],
            body: html`<h1>Open a ticket</h1>${ticketForm({ values: { site: b.site, subject: b.subject, message: b.message, pageUrl: b.page_url }, problem: check.detail })}`,
        }, 422);
        const row = await store.create(s, {
            requester: requesterOf(req), site: check.fields.site, subject: check.fields.subject,
            // Text only: this service never fetches a URL a caller sent.
            pageUrl: check.fields.pageUrl, body: check.fields.message,
        });
        return res.redirect(303, `/tickets/${row.id}`);
    });

    const canSee = (req, row) => Boolean(row) && (row.requester === requesterOf(req) || staffViewer(req));

    r.get('/tickets', async (req, res) => {
        const replies = await measuredReplies();
        if (!signedIn(req)) return page(req, res, {
            title: 'Your tickets', crumbs: [{ label: 'Home', href: '/' }, { label: 'Your tickets' }],
            body: html`<h1>Your tickets</h1>${ticketPromise(replies)}${signInPrompt('Your tickets belong to your OpenVibe account.', '/tickets')}`,
        }, 401);
        const out = await store.listForRequester(s, requesterOf(req), { limit: PAGE_LIMIT });
        return page(req, res, {
            title: 'Your tickets',
            description: 'The support tickets you opened, and where each conversation stands.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your tickets' }],
            body: html`<h1>Your tickets</h1>
${ticketPromise(replies)}
<p class="sc-lede">Everything you opened, newest first. A ticket stays one conversation — reply on its page and it carries on there.</p>
${staffViewer(req) ? notice(html`You are OpenVibe staff, so you can also <a href="/staff">read the whole support queue</a>.`, 'info') : ''}
<p><a class="sc-btn sc-primary" href="/tickets/new">Open a ticket</a></p>
${out.rows.length
                ? html`<ul class="ticket-list">${out.rows.map((t) => html`<li><a href="/tickets/${t.id}"><b>${t.subject}</b></a> ${ticketBadge(t.state)}
<span class="muted small">${t.site || 'not about one site'} · ${t.message_count} message${Number(t.message_count) === 1 ? '' : 's'} · updated ${time(t.updated_at)}</span></li>`)}</ul>`
                : html`<p class="muted">No tickets yet. <a href="/tickets/new">Open one</a> if a site did not answer your question.</p>`}
${out.next ? html`<p><a href="/tickets?before=${out.next}">Older tickets</a></p>` : ''}`,
        });
    });

    r.get('/tickets/:id', async (req, res) => {
        const replies = await measuredReplies();
        if (!signedIn(req)) return page(req, res, {
            title: 'Your tickets', crumbs: [{ label: 'Home', href: '/' }, { label: 'Tickets', href: '/tickets' }, { label: 'Ticket' }],
            body: html`<h1>A ticket</h1>${ticketPromise(replies)}${signInPrompt('A ticket belongs to an OpenVibe account.', `/tickets/${encodeURIComponent(String(req.params.id).slice(0, 40))}`)}`,
        }, 401);
        const row = tickets.isTicketId(req.params.id) ? await store.get(s, req.params.id) : null;
        if (!canSee(req, row)) return page(req, res, {
            title: 'No such ticket', crumbs: [{ label: 'Home', href: '/' }, { label: 'Your tickets', href: '/tickets' }, { label: 'Not found' }],
            body: html`<h1>No such ticket</h1><p class="muted">There is no ticket here for you. <a href="/tickets">Your tickets</a>.</p>`,
        }, 404);
        const messages = await store.messages(s, row.id);
        const isMine = row.requester === requesterOf(req);
        const link = tickets.pageLink(row.page_url);
        // Who wrote a message, read from where the viewer sits: "You" for your own, the staff by their side, and for
        // staff a stranger is "the person who opened it" (their subject id is on the page, not their name).
        const whoLabel = (m) => (m.role === 'staff' ? 'OpenVibe support'
            : (m.author === requesterOf(req) ? 'You' : (m.author === row.requester ? 'The person who opened it' : m.author)));
        page(req, res, {
            title: row.subject,
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Your tickets', href: '/tickets' }, { label: truncate(row.subject, 50) }],
            body: html`<h1>${row.subject}</h1>
<p>${ticketBadge(row.state)} <span class="muted small">${row.site ? html`about <a href="/sites/${row.site}">${row.site}</a>` : 'not about one site'} · opened ${time(row.created_at)}${isMine ? '' : html` · by <code>${row.requester}</code>`}</span></p>
${row.page_url ? html`<p class="small muted">Page they were on: ${link ? html`<a href="${link}" rel="noopener nofollow">${row.page_url}</a>` : row.page_url} <span title="stored as text, never fetched">(text only)</span></p>` : ''}
<ol class="conversation">${messages.map((m) => html`<li class="msg ${m.role}">
<p class="msg-meta small muted"><b>${whoLabel(m)}</b> · ${time(m.created_at)}</p>
${textBlock(m.body)}</li>`)}</ol>
${staffViewer(req) ? html`<form class="card state-form" method="post" action="/tickets/${row.id}/state">
<fieldset><legend>State</legend>
${tickets.STATES.map((st) => html`<label class="radio"><input type="radio" name="state" value="${st}"${st === row.state ? raw(' checked') : ''}> ${STATE_TEXT[st]}</label>`)}
<button class="sc-btn" type="submit">Set the state</button></fieldset>
<p class="small muted">Changing the state does not send a message. Reply below if the person needs to hear something.</p>
</form>` : ''}
${ticketPromise(replies)}
<form class="card reply-form" method="post" action="/tickets/${row.id}">
<label for="message">${staffViewer(req) ? 'Reply as OpenVibe support' : 'Reply'}</label>
<textarea id="message" name="message" rows="6" maxlength="${tickets.LIMITS.body}" required placeholder="${staffViewer(req) ? 'Answer the question, or ask for what you still need.' : 'Anything else we should know?'}"></textarea>
<p class="small muted">Plain text, up to ${tickets.LIMITS.body} characters. Everything here stays in this one ticket.</p>
<p><button class="sc-btn sc-primary" type="submit">Send the reply</button></p>
</form>`,
        });
    });

    r.post('/tickets/:id', mustSignIn('/tickets'), budgeted('help.ticket.message'), async (req, res) => {
        if (!sameSite(req, res, '/tickets')) return;
        const row = tickets.isTicketId(req.params.id) ? await store.get(s, req.params.id) : null;
        if (!canSee(req, row)) return page(req, res, { title: 'No such ticket', body: html`<h1>No such ticket</h1><p class="muted"><a href="/tickets">Your tickets</a>.</p>` }, 404);
        const check = tickets.validateMessage(req.body || {});
        if (!check.ok) return res.redirect(303, `/tickets/${row.id}`);
        await store.addMessage(s, row.id, { author: requesterOf(req), role: staffViewer(req) ? 'staff' : 'person', body: check.fields.body });
        return res.redirect(303, `/tickets/${row.id}`);
    });

    r.post('/tickets/:id/state', async (req, res) => {
        if (!signedIn(req) || !staffViewer(req)) return page(req, res, { title: 'Staff only', body: html`<h1>Staff only</h1><p class="muted">Setting a ticket's state is for OpenVibe staff.</p>` }, 403);
        if (!sameSite(req, res, '/staff')) return;
        const row = tickets.isTicketId(req.params.id) ? await store.get(s, req.params.id) : null;
        if (!row) return page(req, res, { title: 'No such ticket', body: html`<h1>No such ticket</h1><p class="muted"><a href="/staff">The support queue</a>.</p>` }, 404);
        const state = (req.body || {}).state;
        if (tickets.isState(state)) await store.setState(s, row.id, state);
        return res.redirect(303, `/tickets/${row.id}`);
    });

    // ── The support queue (staff) ────────────────────────────
    r.get('/staff', async (req, res) => {
        if (!signedIn(req)) return page(req, res, {
            title: 'Support queue', crumbs: [{ label: 'Home', href: '/' }, { label: 'Support queue' }],
            body: html`<h1>The support queue</h1>${signInPrompt('The queue is for OpenVibe staff.', '/staff')}`,
        }, 401);
        if (!staffViewer(req)) return page(req, res, {
            title: 'Staff only', crumbs: [{ label: 'Home', href: '/' }, { label: 'Support queue' }],
            body: html`<h1>Staff only</h1><p class="muted">The support queue is for OpenVibe staff — a Network role of <code>admin</code> or <code>global_mod</code>. Yours is <code>${truncate(req.viewer.role || 'user', 32)}</code>. <a href="/tickets">Your own tickets</a>.</p>`,
        }, 403);
        const state = tickets.isState(req.query.state) || req.query.state === 'all' ? String(req.query.state) : 'open';
        const site = catalog.byId.has(String(req.query.site)) ? String(req.query.site) : null;
        const out = await store.listForStaff(s, { site, state, limit: PAGE_LIMIT });
        const counts = await store.staffCounts(s);
        return page(req, res, {
            title: 'Support queue',
            description: 'Every OpenVibe support ticket, filtered by site and state.',
            crumbs: [{ label: 'Home', href: '/' }, { label: 'Support queue' }],
            body: html`<h1>The support queue</h1>
<p class="sc-lede">Every ticket, newest first. ${counts.open} open, ${counts.waiting} waiting on the person, ${counts.solved} solved.</p>
<form class="card filters" method="get" action="/staff">
<div class="field"><label for="state">State</label><select id="state" name="state">
${[...tickets.STATES, 'all'].map((st) => html`<option value="${st}"${st === state ? raw(' selected') : ''}>${st === 'all' ? 'all' : STATE_TEXT[st]}</option>`)}
</select></div>
<div class="field"><label for="site">Site</label><select id="site" name="site"><option value="">any site</option>${catalog.sites.map((x) => html`<option value="${x.id}"${x.id === site ? raw(' selected') : ''}>${x.name}</option>`)}</select></div>
<p><button class="sc-btn sc-primary" type="submit">Filter</button> <a class="sc-btn" href="/staff">Clear</a></p>
</form>
${table(['Ticket', 'Who', 'Site', 'State', 'Messages', 'Updated'], out.rows.map((t) => [
            html`<a href="/tickets/${t.id}">${truncate(t.subject, 70)}</a>`,
            html`<code>${t.requester}</code>`,
            t.site ? html`<a href="/sites/${t.site}">${t.site}</a>` : '—',
            ticketBadge(t.state),
            String(t.message_count),
            time(t.updated_at),
        ]), { empty: 'No tickets with that filter.' })}
${out.next ? html`<p><a href="/staff?state=${encodeURIComponent(state)}${site ? `&site=${encodeURIComponent(site)}` : ''}&before=${out.next}">Older tickets</a></p>` : ''}`,
        });
    });

    // ── The update log ───────────────────────────────────────
    r.get('/updates', (req, res) => page(req, res, {
        index: true, cache: PUBLIC_CACHE,
        title: `What shipped on ${SITE_NAME}`,
        body: raw(frame.updatesBody({ service: 'help', siteName: SITE_NAME }) + `<script src="${ovServe.url('shipped.js')}" defer></script>`),
    }));

    // ── Discovery: robots.txt, sitemap.xml, llms.txt, llms-full.txt ──
    r.use(createDiscoveryRoutes(ctx));
    return r;
}

module.exports = { createPageRoutes };
