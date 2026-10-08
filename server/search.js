'use strict';

/**
 * Search for /search and GET /api/v1/articles?q=, in two halves:
 *
 *   searchArticles(catalog, q)   the help centre's own articles — a small, explainable score over the question,
 *                                the answer and the site's own text (name, one line, keywords). No index, no
 *                                stemming, no ranking claim: the same query always answers the same order.
 *   createNetworkSearch(...)     OpenVibe.Search's public API (GET {HELP_SEARCH_URL}/api/v1/search?q=&limit=),
 *                                the network's own index of streams, clips, pastes, posts and wiki pages.
 *
 * Only the fixed host named by config.search.url is ever fetched, never a URL a person typed; the call carries a
 * User-Agent, a timeout, and a 5-minute in-memory cache of the answers. A failure is reported as a failure, and
 * the page shows the articles alone.
 */
const { html } = require('./render/html');

/** Lower-case, accent-folded, punctuation-free — the text both sides of a comparison are reduced to. */
function norm(text) {
    return String(text == null ? '' : text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'in', 'on', 'and', 'or', 'is', 'it', 'for', 'with', 'my', 'your', 'you', 'do', 'does', 'can', 'i', 'we', 'at', 'by', 'from', 'that', 'this', 'be', 'as', 'if']);
const isTerm = (t) => t.length >= 2 && !STOP.has(t);
const termList = (q) => [...new Set((norm(q).match(/[a-z0-9]+/g) || []).filter(isTerm))];
const phraseOf = (q) => norm(q).replace(/\s+/g, ' ').trim();

/** The site's own words, as one haystack: what /sites shows of it. */
const siteText = (site) => [site.name, site.oneLine, site.tagline, site.keywords, site.domain].filter(Boolean).join(' ');

/**
 * How well one article answers `q`. Phrase hits beat term hits, the question beats the answer, the answer beats
 * the site's blurb. Every rule is here, so a surprising order can be explained rather than tuned.
 */
function scoreArticle(article, q) {
    const phrase = phraseOf(q);
    const terms = termList(q);
    if (!terms.length) return 0;
    const question = norm(article.question);
    const answer = norm(article.answer);
    const site = norm(article.siteText || '');
    let score = 0;
    if (phrase.length >= 3) {
        if (question.includes(phrase)) score += 10;
        if (answer.includes(phrase)) score += 5;
        if (site.includes(phrase)) score += 3;
    }
    let inQuestion = 0;
    for (const t of terms) {
        if (question.includes(t)) { score += 3; inQuestion++; }
        if (answer.includes(t)) score += 2;
        if (site.includes(t)) score += 1;
    }
    // Every term in the question itself: this is the question they meant to ask.
    if (inQuestion === terms.length && terms.length > 1) score += 4;
    return score;
}

/**
 * The best window of `text` around the first term, for the result list. Plain text: the page escapes it, and
 * highlights with `markTerms` (which escapes too).
 */
function snippetOf(text, terms, max = 220) {
    const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    const hay = norm(s);
    let at = -1;
    for (const t of terms) { const i = hay.indexOf(t); if (i !== -1 && (at === -1 || i < at)) at = i; }
    if (at === -1) return `${s.slice(0, max - 1).replace(/[\s,;:.]$/, '')}…`;
    const start = Math.max(0, at - Math.floor(max / 3));
    const end = Math.min(s.length, start + max);
    return `${start ? '…' : ''}${s.slice(start, end).replace(/^[\s,;:.]|[\s,;:.]$/g, '')}${end < s.length ? '…' : ''}`;
}

/** Rank the catalog's articles for `q` (an empty query ranks nothing). */
function searchArticles(catalog, q, { limit = 20 } = {}) {
    const terms = termList(q);
    if (!terms.length) return [];
    const out = [];
    for (const article of catalog.articles) {
        const site = catalog.byId.get(article.site);
        const withSite = site ? { ...article, siteText: siteText(site) } : article;
        const score = scoreArticle(withSite, q);
        if (score <= 0) continue;
        out.push({ article, score, snippet: snippetOf(article.answer, terms) });
    }
    return out
        .sort((a, b) => (b.score - a.score)
            || String(a.article.siteName).localeCompare(String(b.article.siteName))
            || String(a.article.slug).localeCompare(String(b.article.slug)))
        .slice(0, limit);
}

/** Wrap the query's terms in <mark> — the text is matched raw and escaped piece by piece, never concatenated. */
function markTerms(text, q) {
    const terms = termList(q).sort((a, b) => b.length - a.length);
    if (!terms.length) return html`${text}`;
    const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
    const parts = String(text == null ? '' : text).split(re);
    return html`${parts.map((p, i) => (i % 2 ? html`<mark>${p}</mark>` : p))}`;
}

const str = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
/** Only an absolute http(s) URL becomes a link — never javascript:, data:, or a relative guess. */
function safeHttp(url) {
    try {
        const u = new URL(String(url));
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch { return null; }
}

/** One OpenVibe.Search result, as its API defines it, with anything unexpected dropped. */
function pickResult(x) {
    if (!x || typeof x !== 'object') return null;
    const title = str(x.title, 200);
    const url = safeHttp(x.canonical_url);
    if (!title || !url) return null;
    return { title, url, summary: str(x.summary, 400) || '', type: str(x.type, 40) || null, owner: str(x.owner, 60) || null };
}

/**
 * OpenVibe.Search's public query API, cached. Returns { ok, results, cached } or { ok: false, reason } — the reason
 * is shown to the reader, so it never pretends a failure was an empty index.
 */
function createNetworkSearch({ config, fetchImpl = globalThis.fetch, log = console, now = () => Date.now() }) {
    const cache = new Map();
    const url = String(config.search.url || '').replace(/\/+$/, '');
    const ua = `OpenVibeHelp/0.1 (+${config.baseUrl})`;
    const limit = config.search.limit;

    async function fetchResults(q) {
        const target = new URL(`${url}/api/v1/search`);
        target.searchParams.set('q', q);
        target.searchParams.set('limit', String(limit));
        let res;
        try {
            res = await fetchImpl(target.toString(), {
                headers: { accept: 'application/json', 'user-agent': ua },
                signal: AbortSignal.timeout(config.search.timeoutMs),
            });
        } catch (err) {
            const reason = err && err.name === 'TimeoutError' ? 'timed out' : 'did not answer';
            throw Object.assign(new Error(`OpenVibe.Search ${reason}`), { reason });
        }
        if (!res.ok) throw Object.assign(new Error(`OpenVibe.Search answered ${res.status}`), { reason: `answered ${res.status}` });
        const data = await res.json().catch(() => null);
        if (!data || !Array.isArray(data.results)) throw Object.assign(new Error('OpenVibe.Search sent no result list'), { reason: 'sent no result list' });
        return data.results.map(pickResult).filter(Boolean).slice(0, limit);
    }

    /** Search the network; a hit is cached for the cache window, a failure is never cached as a hit. */
    async function search(q) {
        const query = String(q == null ? '' : q).trim().slice(0, 200);
        if (!query || !url) return { ok: false, reason: 'not configured', results: [] };
        const key = `${query.toLowerCase()}|${limit}`;
        const hit = cache.get(key);
        if (hit && now() - hit.at < config.search.cacheMs) return { ok: true, cached: true, results: hit.results };
        try {
            const results = await fetchResults(query);
            cache.set(key, { at: now(), results });
            if (cache.size > 500) cache.delete(cache.keys().next().value);
            return { ok: true, cached: false, results };
        } catch (err) {
            log.warn(`[OpenVibe.Help] search: ${err && err.reason ? err.reason : 'failed'} (OpenVibe.Search at ${url})`);
            return { ok: false, reason: (err && err.reason) || 'failed', results: [] };
        }
    }

    return { search, url };
}

module.exports = { searchArticles, scoreArticle, markTerms, termList, createNetworkSearch };
