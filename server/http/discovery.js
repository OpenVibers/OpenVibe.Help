'use strict';

/**
 * Crawl artifacts for openvibe.help, built with openvibe-shared/seo: robots.txt, sitemap.xml, llms.txt and
 * llms-full.txt, and the home page's JSON-LD. The public pages are for search engines and AI crawlers; sign-in,
 * the API, a person's tickets and the support queue are not.
 *
 * The sitemap and llms-full.txt are two renderings of one list (publicPages), so a page can never be in one and
 * missing from the other — including the help centre itself: every site and every question is a page here, which
 * is exactly what makes the answers findable.
 */
const fs = require('fs');
const path = require('path');
const seo = require('openvibe-shared/seo');
const cache = require('openvibe-shared/cache-policy');
const { asyncRouter } = require('./router');

const SITE_NAME = 'OpenVibe.Help';
const DESCRIPTION = 'OpenVibe.Help is the help and support centre for every OpenVibe site: search the answers each site gives about itself, browse them by site, and open a support ticket that stays one conversation.';
const DISALLOW = ['/auth/', '/api/', '/tickets', '/staff'];

function dayOf(ts) {
    const m = String(ts == null ? '' : ts).match(/^(\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
}
function siteUpdated() {
    try { return dayOf(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'STATUS.json'), 'utf8')).updated); } catch { return null; }
}

function homeJsonLd(config) {
    const site = String(config.baseUrl).replace(/\/+$/, '');
    return [
        seo.jsonLd.website({ name: SITE_NAME, url: site, description: DESCRIPTION, searchUrl: `${site}/search?q={q}` }),
        seo.jsonLd.softwareApp({ name: SITE_NAME, url: site, description: DESCRIPTION, category: 'BusinessApplication', keywords: 'openvibe help, openvibe support, help center, support tickets, troubleshooting' }),
        seo.jsonLd.webPage({ name: SITE_NAME, url: `${site}/`, description: DESCRIPTION, siteUrl: site }),
    ];
}

/**
 * Every public page, in the order a crawler should read them: the site's own pages, then one per catalog site, then
 * one per question. Each entry carries its own title and one-line text, so the sitemap and llms-full.txt are two
 * renderings of this one list and cannot drift apart.
 */
function publicPages(catalog) {
    const static_ = [
        { path: '/', changefreq: 'weekly', priority: 1.0, title: 'OpenVibe.Help home', text: 'Search the answers of every OpenVibe site, browse the sites one by one, or open a support ticket that stays one conversation.' },
        { path: '/sites', changefreq: 'weekly', priority: 0.9, title: 'Every OpenVibe site', text: `${catalog.sites.length} OpenVibe sites with what each one is, whether it is live yet, and its own questions and answers.` },
        { path: '/search', changefreq: 'weekly', priority: 0.7, title: 'Search the help centre', text: 'Search every OpenVibe site\'s own answers, and the whole network through OpenVibe.Search.' },
        { path: '/updates', changefreq: 'daily', priority: 0.5, title: `What shipped on ${SITE_NAME}`, text: 'This site\'s update log, from the network changelog feed.' },
    ];
    const sites = catalog.sites.map((s) => ({
        path: `/sites/${s.id}`, changefreq: 'weekly', priority: s.live ? 0.8 : 0.6,
        title: s.name, text: `${s.state === 'live' ? 'Live' : 'Coming'}: ${s.oneLine} ${s.description || ''}`.trim(),
    }));
    const articles = catalog.articles.map((a) => ({
        path: a.path, changefreq: 'monthly', priority: 0.5,
        title: a.question, text: `${a.answer} (Answered by ${a.siteName}.)`,
    }));
    return [...static_, ...sites, ...articles];
}

function createDiscoveryRoutes(ctx) {
    const { config, catalog } = ctx;
    const r = asyncRouter();
    const site = String(config.baseUrl).replace(/\/+$/, '');
    const abs = (p) => `${site}${p}`;
    const TEXT = cache.htmlHeaders({ maxAge: 3600 });
    const pages = publicPages(catalog);

    r.get('/robots.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(
            '# openvibe.help: the public pages are for search and AI crawlers; sign-in, the API and tickets are not.\n'
            + seo.robotsTxt({ sitemaps: [abs('/sitemap.xml')], disallow: DISALLOW }));
    });

    r.get('/llms.txt', (_req, res) => {
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsTxt({
            name: SITE_NAME,
            summary: 'OpenVibe.Help: the help and support centre for every OpenVibe site. The answers are generated from OpenVibe.Contracts at boot — each site\'s own manifest, verbatim — so a page here is the product\'s own words, with a link back to where they were read.',
            details: 'Every site and every question is a page: /sites lists them, /sites/<domain> is one site with its pillars and its questions, and /a/<domain>/<slug> is one question with its answer. /search searches those answers and the network through OpenVibe.Search. Signed in, a person can open a support ticket; the ticket and its conversation are private to them (and to OpenVibe staff). Every page is server-rendered and readable without JavaScript.',
            sections: [
                { title: 'Start here', links: [
                    { title: 'OpenVibe.Help', url: abs('/'), note: 'search the answers, browse the sites, open a ticket' },
                    { title: 'Every OpenVibe site', url: abs('/sites'), note: `${catalog.sites.length} sites with their state and their own words` },
                    { title: 'Search', url: abs('/search?q=help'), note: 'the help articles and the network, in two sections' },
                    { title: `What shipped on ${SITE_NAME}`, url: abs('/updates') },
                ] },
                { title: 'Sites', links: catalog.sites.map((s) => ({ title: s.name, url: abs(`/sites/${s.id}`), note: `${s.live ? 'live' : 'coming'} — ${s.oneLine}` })) },
                { title: 'Machine-readable', links: [
                    { title: 'Every site (JSON)', url: abs('/api/v1/sites') },
                    { title: 'One site (JSON)', url: abs(`/api/v1/sites/${catalog.sites[0] ? catalog.sites[0].id : 'openvibe.network'}`) },
                    { title: 'The articles (JSON, ?q= ranks them)', url: abs('/api/v1/articles?q=live') },
                    { title: 'Sitemap', url: abs('/sitemap.xml') },
                    { title: 'Full text for language models', url: abs('/llms-full.txt') },
                    { title: 'Release metadata (JSON)', url: abs('/release.json') },
                ] },
                { title: 'Elsewhere', links: [
                    { title: 'OpenVibe.Search', url: 'https://search.openvibe.network', note: 'the network\'s own index, the "From across OpenVibe" half of /search' },
                    { title: 'OpenVibe.Services', url: 'https://openvibe.services', note: 'apps, keys and capability grants' },
                    { title: 'OpenVibe.Network', url: 'https://openvibe.network', note: 'accounts, apps and grants' },
                ] },
            ],
        }));
    });

    r.get('/llms-full.txt', (_req, res) => {
        const entries = pages.map((p) => ({ url: p.path, title: p.title, text: p.text }));
        res.type('text/plain').set('Cache-Control', TEXT).send(seo.llmsFull({
            site: SITE_NAME,
            summary: 'Every public page of OpenVibe.Help, one line each: the site, and every question each site answers about itself.',
            base: site,
            maxBytes: 256 * 1024,
            sections: [{ title: 'Pages', pages: entries }],
        }));
    });

    r.get('/sitemap.xml', (_req, res) => {
        const lastmod = siteUpdated();
        const urls = pages.map((e) => ({ loc: abs(e.path), ...(lastmod ? { lastmod } : {}), changefreq: e.changefreq, priority: e.priority }));
        res.type('application/xml').set('Cache-Control', TEXT).send(seo.sitemapXml(urls));
    });

    return r;
}

module.exports = { createDiscoveryRoutes, homeJsonLd, publicPages, DESCRIPTION, SITE_NAME };
