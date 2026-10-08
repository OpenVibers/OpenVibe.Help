'use strict';
/**
 * A stand-in for OpenVibe.Search's public query API, in one local HTTP server:
 *
 *   GET /api/v1/search?q=&limit=  → { results: [{ title, summary, canonical_url, type, owner }] }
 *
 * Behaviour is set per test on `s.state`:
 *   results  what to answer with (default: one stream and one wiki page)
 *   fail     null (answer) | 'error' (HTTP 500) | 'timeout' (never answers) | 'garbage' (not JSON, no results)
 * `s.requests` lists { query, limit, userAgent } for every call, so a test can prove what was asked, how often
 * (the 5-minute cache), and with which User-Agent. Tests never call the real search.openvibe.network.
 */
const http = require('http');

const DEFAULT_RESULTS = [
    { title: 'OpenVibe.Actor explained', summary: 'A stream on how a task is routed and checked.', canonical_url: 'https://openvibe.live/@openvibe/actor-explained', type: 'stream', owner: 'openvibe' },
    { title: 'Agent', summary: 'What an agent is on OpenVibe, and how grants bound it.', canonical_url: 'https://openvibe.wiki/agent', type: 'wiki', owner: 'openvibe' },
];

async function startSearch({ results = DEFAULT_RESULTS, fail = null } = {}) {
    const state = { results: [...results], fail };
    const requests = [];
    const hanging = new Set();

    const server = http.createServer((req, res) => {
        const url = new URL(req.url, 'http://x');
        if (url.pathname !== '/api/v1/search') { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{}'); }
        requests.push({ query: url.searchParams.get('q'), limit: url.searchParams.get('limit'), userAgent: req.headers['user-agent'] || null });
        if (state.fail === 'error') { res.writeHead(500, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'index unavailable' })); }
        if (state.fail === 'garbage') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ note: 'no results key at all' })); }
        if (state.fail === 'timeout') { hanging.add(res); return undefined; }
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ query: url.searchParams.get('q'), results: state.results }));
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    return {
        url, state, requests,
        env: { HELP_SEARCH_URL: url, HELP_SEARCH_TIMEOUT_MS: '500' },
        close: () => new Promise((r) => { for (const res of hanging) { try { res.destroy(); } catch { /* gone */ } } server.close(r); }),
    };
}

module.exports = { startSearch };
