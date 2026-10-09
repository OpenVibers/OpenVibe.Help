'use strict';

/**
 * The help centre's content, generated at boot — no database, no hand-written copy. Everything here is read
 * verbatim from OpenVibe.Contracts:
 *
 *   manifests/products/<domain>.json   a product domain of the catalog: name, tagline, description, pillars,
 *                                      faq, keywords, launch, kind
 *   manifests/services/<id>.json       a service whose `site` block presents it as a site (the same fields as a
 *                                      product), plus `exposure.state` (live, internal, placeholder, …)
 *
 * A domain can appear in both (openvibe.actor is a service site and a product manifest); the two are merged into
 * one site, so /sites lists each OpenVibe address exactly once. Nothing is invented: a question comes from the
 * manifest's own `faq`, a pillar from its `pillars`, and each page names its source and when it was read.
 *
 *   createCatalog({ now }) → { generatedAt, source, sites, byId, articles, byArticle, popular }
 *
 * The manifest text is deliberately NOT normalised, reformatted or translated — it is quoted. `site.url` is the
 * address the manifest itself gives (publicOrigin, else https://<domain>).
 */
const contracts = require('openvibe-contracts');

const PKG = require('openvibe-contracts/package.json');

/** Where the text came from, to show next to it (the manifest's repository, from the package itself). */
const SOURCE = (() => {
    const raw = typeof PKG.repository === 'string' ? PKG.repository : (PKG.repository && PKG.repository.url) || '';
    const m = raw.match(/github[:/]+([^/\s]+\/[^/\s#]+?)(?:\.git)?$/i);
    return { name: `OpenVibe.Contracts ${PKG.version}`, url: m ? `https://github.com/${m[1]}` : 'https://openvibe.network' };
})();

/** A URL-safe slug from arbitrary text: lowercase, runs of anything else become one hyphen, clipped. */
function slugify(text, max = 64) {
    return String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max).replace(/-+$/, '') || 'item';
}

/** The first sentence of a description, for a one-line "what" when the manifest has no `what` of its own. */
function firstSentence(text, max = 180) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return '';
    const cut = s.match(/^[\s\S]*?[.!?](?=\s|$)/);
    const one = (cut ? cut[0] : s).trim();
    return one.length > max ? `${one.slice(0, max - 1).replace(/[\s,;:]$/, '')}…` : one;
}

/** The host a service manifest's site is served on (products.siteDomain keeps one rule for both homes). */
const siteDomain = contracts.products.siteDomain;

/** The text pairs a site shows as "what you can do". Kept in manifest order; duplicates dropped. */
function textPairs(list) {
    const seen = new Set();
    const out = [];
    for (const p of Array.isArray(list) ? list : []) {
        const title = String((p && p.title) || '').trim();
        const text = String((p && p.text) || '').trim();
        if (!title || seen.has(title)) continue;
        seen.add(title);
        out.push({ title, text });
    }
    return out;
}

/** The site's own questions, verbatim; duplicates (a product and a service site may share one) dropped. */
function faqPairs(...lists) {
    const seen = new Set();
    const out = [];
    for (const list of lists) {
        for (const q of Array.isArray(list) ? list : []) {
            const question = String((q && q.question) || '').trim();
            const answer = String((q && q.answer) || '').trim();
            if (!question || !answer || seen.has(question)) continue;
            seen.add(question);
            out.push({ question, answer });
        }
    }
    return out;
}

/** One service manifest as a catalog entry (its `site` block, plus what exposes it). */
function fromService(m, exposure) {
    const s = m.site;
    return {
        domain: siteDomain(m),
        name: s.name || m.name,
        icon: s.icon || null,
        accent: s.accent || null,
        tagline: s.tagline || '',
        what: s.what || '',
        description: s.description || '',
        pillars: textPairs(s.pillars),
        faq: faqPairs(s.faq),
        keywords: s.keywords || '',
        launch: s.launch || '',
        kind: s.kind || null,
        legalProfile: s.legalProfile || null,
        position: s.position == null ? null : s.position,
        service: m.id,
        exposure,
        home: 'service',
        url: m.publicOrigin || `https://${siteDomain(m)}`,
        manifest: `manifests/services/${m.id}.json`,
    };
}

/** One product manifest as a catalog entry. */
function fromProduct(p) {
    return {
        domain: p.domain,
        name: p.name,
        icon: p.icon || null,
        accent: p.accent || null,
        tagline: p.tagline || '',
        what: '',
        description: p.description || '',
        pillars: textPairs(p.pillars),
        faq: faqPairs(p.faq),
        keywords: p.keywords || '',
        launch: p.launch || '',
        kind: p.kind || null,
        legalProfile: p.legalProfile || null,
        position: null,
        service: null,
        exposure: null,
        home: 'product',
        url: `https://${p.domain}`,
        manifest: `manifests/products/${p.domain}.json`,
    };
}

/** Merge a domain's two homes: the service site keeps its exposure, the product manifest keeps its name. */
function merge(serviceEntry, productEntry) {
    if (!serviceEntry) return productEntry;
    if (!productEntry) return serviceEntry;
    return {
        ...serviceEntry,
        name: productEntry.name || serviceEntry.name,
        icon: productEntry.icon || serviceEntry.icon,
        accent: productEntry.accent || serviceEntry.accent,
        tagline: productEntry.tagline || serviceEntry.tagline,
        what: serviceEntry.what || productEntry.what,
        description: productEntry.description || serviceEntry.description,
        pillars: serviceEntry.pillars.length ? serviceEntry.pillars : productEntry.pillars,
        faq: faqPairs(productEntry.faq, serviceEntry.faq),
        keywords: productEntry.keywords || serviceEntry.keywords,
        launch: productEntry.launch || serviceEntry.launch,
        kind: productEntry.kind || serviceEntry.kind,
        legalProfile: productEntry.legalProfile || serviceEntry.legalProfile,
        home: 'both',
        manifests: [productEntry.manifest, serviceEntry.manifest],
    };
}

/**
 * Every OpenVibe site the catalog knows, with its state, its one line and where to go — the union of the product
 * manifests and the service manifests that present a site. Sorted live first, then by name.
 */
function buildSites() {
    const services = contracts.services.manifests;
    // A domain is live when a service manifest exposes it live, wherever it is named (its site or its domains list).
    const live = new Set();
    for (const m of services) {
        if (!m.exposure || m.exposure.state !== 'live') continue;
        for (const d of m.domains || []) live.add(d);
        if (m.site && m.site.tld) live.add(siteDomain(m));
    }

    const byDomain = new Map();
    for (const m of services) if (m.site) byDomain.set(siteDomain(m), fromService(m, m.exposure ? m.exposure.state : null));
    for (const p of contracts.products.manifests) byDomain.set(p.domain, merge(byDomain.get(p.domain), fromProduct(p)));

    // The help centre is about products: a site is an apex domain (openvibe.live, openre.stream) or a live service's own
    // site on a subdomain (ai.openvibe.services). The network's operational hosts (admin., auth., api., status., themes.,
    // realtime. on openvibe.network) and moved addresses are not products and stay out of the catalog.
    const serviceSites = new Set(services.filter((m) => m.site).map(siteDomain));
    const isProduct = (e) => String(e.domain).split('.').length === 2 || (serviceSites.has(e.domain) && live.has(e.domain));

    const sites = [...byDomain.values()].filter(isProduct).map((e) => {
        const state = live.has(e.domain) ? 'live' : 'coming';
        const manifests = e.manifests || [e.manifest];
        return {
            ...e,
            id: e.domain,
            // "OpenVibe.Actor" in a list of OpenVibe sites reads as "Actor"; OpenRestream keeps its own name.
            shortName: String(e.name || e.domain).replace(/^OpenVibe\./, ''),
            state,
            live: state === 'live',
            // A product manifest has no `what` of its own: its tagline is the one line, or the description's first sentence.
            oneLine: e.what || e.tagline || firstSentence(e.description),
            updatesUrl: `${String(e.url).replace(/\/+$/, '')}/updates`,
            provenance: { source: SOURCE.name, url: SOURCE.url, manifests, path: `/sites/${e.domain}` },
        };
    });
    return sites.sort((a, b) => (a.state === b.state ? String(a.name).localeCompare(String(b.name)) : a.live ? -1 : 1));
}

/**
 * One article per FAQ entry: /a/<site>/<slug>, one question per page, the answer verbatim. The slug is derived
 * from the question; within a site it is made unique, so a reworded manifest never collides with an existing URL.
 */
function buildArticles(sites) {
    const articles = [];
    const bySite = new Map();
    for (const site of sites) {
        const mine = [];
        const used = new Set();
        for (const { question, answer } of site.faq) {
            let slug = slugify(question);
            for (let n = 2; used.has(slug); n++) slug = `${slugify(question, 60)}-${n}`;
            used.add(slug);
            const article = {
                site: site.domain, siteName: site.name, siteState: site.state, siteUrl: site.url,
                slug, question, answer,
                path: `/a/${site.domain}/${slug}`,
                anchor: slug,
                provenance: site.provenance,
            };
            mine.push(article);
            articles.push(article);
        }
        if (mine.length) bySite.set(site.domain, mine);
    }
    return { articles, bySite };
}

/**
 * The questions the home page shows: real ones, live sites first, in catalog order. `limit` is a display choice,
 * not a ranking claim, and the page says where they come from.
 */
function popularQuestions(sites, articles, limit = 8) {
    // One question from each site in turn (live sites first), so the list shows the breadth of the network rather than
    // every question of the first site in the catalog.
    const bySite = new Map();
    for (const a of articles) { if (!bySite.has(a.site)) bySite.set(a.site, []); bySite.get(a.site).push(a); }
    const queues = sites.map((s) => bySite.get(s.domain) || []).filter((q) => q.length);
    const out = [];
    for (let round = 0; out.length < limit && queues.some((q) => q.length > round); round++) {
        for (const q of queues) { if (q[round] && out.length < limit) out.push(q[round]); }
    }
    return out;
}

/** Build the catalog once per process (and per test boot), at `now`. */
function createCatalog({ now = () => Date.now() } = {}) {
    const sites = buildSites();
    const byId = new Map(sites.map((s) => [s.id, s]));
    const { articles, bySite } = buildArticles(sites);
    const byArticle = new Map(articles.map((a) => [`${a.site}/${a.slug}`, a]));
    const byPath = new Map(articles.map((a) => [a.path, a]));
    return {
        generatedAt: new Date(now()).toISOString(),
        source: SOURCE,
        sites,
        byId,
        articles,
        bySite,
        byArticle,
        byPath,
        popular: popularQuestions(sites, articles),
        /** A site id a caller may pass: the domain, exactly as the catalog lists it. */
        get: (id) => byId.get(String(id || '')) || null,
        article: (site, slug) => byArticle.get(`${String(site || '')}/${String(slug || '')}`) || null,
    };
}

module.exports = { createCatalog, SOURCE, siteDomain };
