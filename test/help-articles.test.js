'use strict';
/**
 * The help centre is generated, not written: /sites, /sites/:id and /a/:site/:slug are built at boot from
 * OpenVibe.Contracts, and this test checks them against the manifests themselves — every catalog domain has a
 * page, every product or service site that carries an `faq` gets one page per question, the text is the manifest's
 * own, the state is the manifest's own exposure.state, and nothing read from a manifest or a URL is rendered raw.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { esc } = require('../server/render/html');
const { boot, check, done } = require('./helpers/boot');

const siteDomain = contracts.products.siteDomain;
const PRODUCTS = contracts.products.manifests;
const SERVICE_SITES = contracts.services.manifests.filter((m) => m.site);
const WITH_FAQ = [
    ...PRODUCTS.filter((p) => Array.isArray(p.faq) && p.faq.length).map((p) => ({ domain: p.domain, faq: p.faq, name: p.name })),
    ...SERVICE_SITES.filter((m) => Array.isArray(m.site.faq) && m.site.faq.length).map((m) => ({ domain: siteDomain(m), faq: m.site.faq, name: m.site.name })),
];

(async () => {
    const t = await boot();
    const catalog = t.ctx.catalog;

    await check('the catalog is exactly the manifests: every product domain and every service site, once each', () => {
        const expected = new Set([...PRODUCTS.map((p) => p.domain), ...SERVICE_SITES.map(siteDomain)]);
        const got = catalog.sites.map((s) => s.id);
        assert.deepStrictEqual([...new Set(got)].length, got.length, 'a domain appears twice in the catalog');
        assert.deepStrictEqual([...got].sort(), [...expected].sort(), 'the catalog and the manifests disagree');
        assert.ok(catalog.sites.length > 30, `only ${catalog.sites.length} sites`);
        assert.ok(catalog.sites.some((s) => s.id === 'openvibe.help'), 'the help centre itself is a site');
    });

    await check('a live site is one a service manifest exposes live; everything else is coming', () => {
        const live = new Set();
        for (const m of contracts.services.manifests) {
            if (!m.exposure || m.exposure.state !== 'live') continue;
            for (const d of m.domains || []) live.add(d);
            if (m.site && m.site.tld) live.add(siteDomain(m));
        }
        for (const s of catalog.sites) assert.strictEqual(s.state, live.has(s.id) ? 'live' : 'coming', `${s.id}: ${s.state}`);
        assert.ok(catalog.sites.some((s) => s.state === 'live') && catalog.sites.some((s) => s.state === 'coming'));
        // Ordered live first, so a reader meets the working sites first.
        const first = catalog.sites.findIndex((s) => s.state === 'coming');
        if (first !== -1) assert.ok(catalog.sites.slice(first).every((s) => s.state === 'coming'), 'live and coming sites are interleaved');
    });

    await check('every site has a page at /sites/<domain>, in the manifest\'s own words', async () => {
        for (const site of catalog.sites) {
            const r = await t.get(`/sites/${site.id}`);
            assert.strictEqual(r.status, 200, `${site.id} → ${r.status}`);
            assert.ok(r.text.includes(site.name), `${site.id}: the name is not on the page`);
            if (site.oneLine) assert.ok(r.text.includes(esc(site.oneLine.slice(0, 40))), `${site.id}: the one line is not on the page`);
            assert.ok(r.text.includes('OpenVibe.Contracts'), `${site.id}: no provenance`);
        }
    });

    await check('every question in every faq is a page of its own, with the question as the SEO title and the answer verbatim', async () => {
        assert.ok(WITH_FAQ.length >= 3, `only ${WITH_FAQ.length} sites answer questions`);
        let articles = 0;
        for (const { domain, faq } of WITH_FAQ) {
            const site = catalog.byId.get(domain);
            assert.ok(site, `${domain} is not in the catalog`);
            assert.strictEqual(site.faq.length, faq.length, `${domain}: the catalog lost a question`);
            for (const entry of faq) {
                const article = (catalog.bySite.get(domain) || []).find((a) => a.question === entry.question);
                assert.ok(article, `${domain}: no article for "${entry.question}"`);
                const r = await t.get(article.path);
                assert.strictEqual(r.status, 200, `${article.path} → ${r.status}`);
                // The page's own heading is the question, verbatim; the <title> is the question too — openvibe-shared/clip
                // shortens it to 60 characters and only appends the site name when both fit.
                assert.ok(r.text.includes(`<h1>${esc(entry.question)}</h1>`), `${article.path}: the heading is not the question`);
                const title = (r.text.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
                assert.ok(title.startsWith(esc(entry.question.slice(0, 40))), `${article.path}: the title is not the question (${title})`);
                if (entry.question.length <= 60) assert.ok(title.startsWith(esc(entry.question)), `${article.path}: the title is not the question (${title})`);
                assert.ok(r.text.includes(esc(entry.answer)), `${article.path}: the answer is not the manifest's`);
                assert.ok(r.text.includes(`<link rel="canonical" href="https://openvibe.help${article.path}">`), `${article.path}: canonical`);
                const ld = [...r.text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]));
                assert.ok(ld.some((n) => n['@type'] === 'Article' && n.headline && n.headline.startsWith(entry.question.slice(0, 40))), `${article.path}: no Article JSON-LD`);
                articles++;
            }
            const page = await t.get(`/sites/${domain}`);
            for (const a of catalog.bySite.get(domain)) {
                assert.ok(page.text.includes(`id="${a.slug}"`), `${domain}: ${a.slug} has no anchor on the site page`);
            }
        }
        assert.ok(articles >= 20, `only ${articles} question pages`);
    });

    await check('a service manifest\'s own site faq is used, not only a product manifest\'s', () => {
        const openre = catalog.byId.get('openre.stream');
        assert.ok(openre && openre.faq.length === 5, `openre.stream has ${openre ? openre.faq.length : 'no'} questions`);
        assert.ok((catalog.bySite.get('openre.stream') || []).length === 5, 'no article pages for openre.stream');
    });

    await check('the link back to the site and to its /updates is on the site page', async () => {
        const r = await t.get('/sites/openvibe.actor');
        assert.ok(r.text.includes('href="https://openvibe.actor"'), 'no link to the site itself');
        assert.ok(r.text.includes('href="https://openvibe.actor/updates"'), 'no link to its /updates');
    });

    await check('a site the catalog does not know is a 404 page, and the URL it was asked for is escaped', async () => {
        const r = await t.get('/sites/nope');
        assert.strictEqual(r.status, 404);
        const bad = await t.get(`/sites/${encodeURIComponent('"<script>alert(1)</script>')}`);
        assert.strictEqual(bad.status, 404);
        assert.ok(!bad.text.includes('<script>alert(1)</script>'), 'the path was rendered raw');
        assert.ok(bad.text.includes('&lt;script&gt;'), 'the path is not shown escaped');
    });

    await check('/api/v1/sites lists the catalog, and one site answers with its pillars, questions and source', async () => {
        const all = (await t.get('/api/v1/sites')).json();
        assert.strictEqual(all.count, catalog.sites.length);
        assert.strictEqual(all.sites.length, catalog.sites.length);
        assert.ok(all.source.name.startsWith('OpenVibe.Contracts'), all.source.name);
        const one = (await t.get('/api/v1/sites/openvibe.actor')).json();
        assert.strictEqual(one.id, 'openvibe.actor');
        assert.strictEqual(one.state, 'live');
        assert.strictEqual(one.faq.length, 8);
        assert.ok(one.pillars.length === 4);
        assert.ok(one.url === 'https://openvibe.actor');
        assert.ok(Array.isArray(one.source.manifests) && one.source.manifests.length === 2, 'both manifests are named');
        assert.strictEqual((await t.get('/api/v1/sites/nope')).status, 404);
        assert.strictEqual((await t.get('/api/v1/sites/nope')).json().code, 'help.site.not_found');
    });

    await check('/api/v1/articles?q= ranks the articles and names where each came from', async () => {
        const all = (await t.get('/api/v1/articles')).json();
        assert.strictEqual(all.count, catalog.articles.length);
        const hits = (await t.get('/api/v1/articles?q=agent')).json();
        assert.ok(hits.count > 0, 'no hits for "agent"');
        assert.ok(hits.articles.every((a) => a.url.startsWith('/a/')), 'an article without a URL');
        assert.ok(hits.articles[0].score >= hits.articles[hits.articles.length - 1].score, 'not ranked');
        assert.ok(hits.articles[0].question.toLowerCase().includes('agent') || hits.articles[0].site_name, 'the top hit is unrelated');
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
