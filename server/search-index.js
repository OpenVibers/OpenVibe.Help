'use strict';

/**
 * Help's article pages in OpenVibe.Search (openvibe-publishing/search-feed): one search.index-document@1 per article
 * (/a/<domain>/<slug>, id <domain>:<slug>), sent as help.index_document.upserted|deleted through this service's events
 * outbox. An article is one question from a product manifest's FAQ with its answer, quoted verbatim from
 * OpenVibe.Contracts (server/catalog.js); the document names the manifest's package as provenance.
 *
 * The catalog is built at boot, so a sweep a minute after boot and every six hours is all it takes: a new Contracts
 * pin that adds, rewords or drops a question is a document, a new revision or a tombstone (help_index_revisions is
 * the sequencer), and a quiet boot sends nothing.
 *
 *   const search = createSearchIndex({ config, s, catalog, log });
 *   search.start(); search.sweep(); search.stop();
 */
const { createServiceOutbox } = require('openvibe-sdk/events');
const { createSearchFeed } = require('openvibe-publishing/search-feed');

const EVENT_TYPES = ['help.index_document.upserted', 'help.index_document.deleted'];
const START_DELAY_MS = 60_000;
const INTERVAL_MS = 6 * 3_600_000;

const articleId = (a) => `${a.site}:${a.slug}`;

/** One catalog article → what its page shows, as search-feed's document description. */
function describe(article, catalog) {
    const site = catalog.get(article.site);
    return {
        id: articleId(article),
        title: article.question,
        summary: String(article.answer || '').slice(0, 300),
        body: [article.question, article.answer, article.siteName].filter(Boolean).join('\n'),
        facets: { site: article.site, kind: (site && site.kind) || null, state: article.siteState || null },
        authorship: { mode: 'human' },
        provenance: [{ service: 'help', type: 'manifest', id: article.site, label: catalog.source.name, url: catalog.source.url }],
        updatedAt: catalog.generatedAt,
    };
}

function createSearchIndex({ config, s, catalog, log = console, outbox = null }) {
    const out = outbox || createServiceOutbox({
        db: s.db, source: 'help', eventsUrl: config.events.url || null, networkInternalUrl: config.networkInternalUrl,
        clientId: config.oauth.clientId, clientSecret: config.oauth.clientSecret, log, eventTypes: EVENT_TYPES,
    });
    // The catalog in id order once: rows() pages through it like a table.
    const ordered = catalog.articles.map((a) => ({ ...a, id: articleId(a) })).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const ids = new Set(ordered.map((a) => a.id));
    const feed = createSearchFeed({
        owner: 'help', db: s.db, outbox: out, baseUrl: config.baseUrl, now: s.now, log,
        types: {
            article: {
                page: (a) => a.path,
                document: (a) => describe(a, catalog),
                rows: async (after, limit) => ordered.filter((a) => a.id > after).slice(0, limit),
                exists: async (list) => list.filter((id) => ids.has(id)),
            },
        },
    });
    const timers = [];

    async function sweep() {
        const res = await feed.sweep();
        const a = res.article;
        if (a.sent || a.removed || a.failed) log.log(`[Search] articles: ${a.sent} sent, ${a.removed} removed, ${a.failed} failed of ${a.seen}`);
        if (out.kick) out.kick().catch(() => {});
        return res;
    }
    const quietly = () => { sweep().catch((err) => log.warn(`[Search] sweep failed: ${(err && err.message) || err}`)); };

    function start() {
        if (timers.length) return false;
        out.start();
        const kick = setTimeout(quietly, START_DELAY_MS);
        if (kick.unref) kick.unref();
        const tick = setInterval(quietly, INTERVAL_MS);
        if (tick.unref) tick.unref();
        timers.push(kick, tick);
        return true;
    }

    function stop() {
        for (const t of timers.splice(0)) { clearTimeout(t); clearInterval(t); }
        out.stop();
    }

    return { feed, outbox: out, describe: (a) => describe(a, catalog), sweep, start, stop, status: () => out.status() };
}

module.exports = { createSearchIndex, describe, articleId, EVENT_TYPES };
