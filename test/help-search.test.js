'use strict';
/**
 * /search and GET /api/v1/articles?q=: the help centre's own articles ranked by a fixed, explainable score, and
 * OpenVibe.Search's public API for the "From across OpenVibe" half. The network half is a local stand-in
 * (test/helpers/search-provider.js) — the real search.openvibe.network is never called from a test — and its
 * failure is shown as a failure, with the articles still there.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');
const { startSearch } = require('./helpers/search-provider');
const { searchArticles, scoreArticle, termList } = require('../server/search');
const { createCatalog } = require('../server/catalog');

/** A tiny catalog with known overlaps, for the scoring rules themselves. */
const FIXTURE = (() => {
    const mk = (site, siteName, slug, question, answer) => ({ site, siteName, slug, question, answer, path: `/a/${site}/${slug}` });
    const articles = [
        mk('s', 'Stream', 'go-live', 'Can I go live from a browser?', 'Yes. Press Go Live and allow your camera and microphone.'),
        mk('s', 'Stream', 'restream', 'Can I restream to Twitch and YouTube?', 'Yes, ingest once and send the stream to every platform at once.'),
        mk('o', 'Other', 'price', 'What does it cost?', 'It is free within the published limits.'),
    ];
    return {
        articles,
        byId: new Map([['s', { id: 's', name: 'Stream', oneLine: 'Streams, clips and chat', tagline: 'Streams', keywords: 'live stream', domain: 's.example' }], ['o', { id: 'o', name: 'Other', oneLine: 'Something else', tagline: '', keywords: '', domain: 'o.example' }]]),
    };
})();

(async () => {
    const search = await startSearch();
    let clock = Date.UTC(2026, 9, 8, 12, 0, 0);
    const t = await boot({ env: search.env, now: () => clock });

    await check('the score: the question beats the answer, the answer beats the site blurb, and nothing unrelated', () => {
        assert.deepStrictEqual(termList('a b of the restream'), ['restream'], 'one-letter words and stop words are not terms');
        assert.deepStrictEqual(termList('Restream restream RESTREAM'), ['restream'], 'the same word counts once');
        const onQuestion = scoreArticle({ question: 'Can I restream?', answer: '', siteText: '' }, 'restream');
        const onAnswer = scoreArticle({ question: 'Can I do it?', answer: 'You can restream.', siteText: '' }, 'restream');
        const onSite = scoreArticle({ question: 'What is this?', answer: 'It is a tool.', siteText: 'OpenVibe.Restream' }, 'restream');
        assert.ok(onQuestion > onAnswer && onAnswer > onSite, `${onQuestion} ${onAnswer} ${onSite}`);
        assert.strictEqual(scoreArticle({ question: 'What is this?', answer: 'It is a tool.', siteText: '' }, 'banana'), 0);
        assert.strictEqual(scoreArticle({ question: 'What is this?', answer: '', siteText: '' }, 'a'), 0, 'a one-letter query ranks nothing');
        const phrase = scoreArticle({ question: 'Can I go live from a browser?', answer: '', siteText: '' }, 'go live from a browser');
        const terms = scoreArticle({ question: 'Can I go live from a browser?', answer: '', siteText: '' }, 'go browser live');
        assert.ok(phrase > terms, 'a phrase hit is worth more than the same words scattered');
    });

    await check('the ranking over the fixture: the best question first, and only matches', () => {
        const hits = searchArticles(FIXTURE, 'restream twitch', { limit: 10 });
        assert.deepStrictEqual(hits.map((h) => h.article.slug), ['restream'], 'the wrong article matched');
        // "live" is in the Stream site's own keywords, so both of its questions match and the unrelated site does not.
        const live = searchArticles(FIXTURE, 'live', { limit: 10 });
        assert.deepStrictEqual(live.map((h) => h.article.site), ['s', 's']);
        assert.deepStrictEqual(searchArticles(FIXTURE, 'zzz', { limit: 10 }), []);
        assert.deepStrictEqual(searchArticles(FIXTURE, '', { limit: 10 }), [], 'an empty query ranks nothing');
    });

    await check('the ranking over the real catalog: a real question comes back with a snippet', () => {
        const catalog = createCatalog({ now: () => clock });
        const hits = searchArticles(catalog, 'take control of my computer', { limit: 5 });
        assert.ok(hits.length > 0, 'no hits for a real question');
        assert.match(hits[0].article.question, /control/i);
        assert.ok(hits[0].snippet.length > 0 && hits[0].snippet.length <= 240);
    });

    await check('/search?q= shows both sections: the help articles and, through the stand-in, OpenVibe.Search', async () => {
        search.requests.length = 0;
        const r = await t.get('/search?q=agent');
        assert.strictEqual(r.status, 200, r.text.slice(0, 200));
        assert.ok(r.text.includes('Help articles'), 'no help-articles section');
        assert.ok(r.text.includes('From across OpenVibe'), 'no network section');
        assert.ok(r.text.includes('/a/openvibe.actor/'), 'no article link in the results');
        assert.ok(r.text.includes('https://openvibe.live/@openvibe/actor-explained'), 'the network result is missing');
        assert.ok(r.text.includes('OpenVibe.Actor explained'), 'the network result title is missing');
        assert.ok(r.text.includes('<mark>agent</mark>') || /<mark>Agent<\/mark>/.test(r.text), 'the query is not marked in the results');
        assert.strictEqual(search.requests.length, 1, 'the stand-in was called once');
        assert.strictEqual(search.requests[0].query, 'agent');
        assert.strictEqual(search.requests[0].limit, '8');
        assert.strictEqual(search.requests[0].userAgent, 'OpenVibeHelp/0.1 (+https://openvibe.help)');
    });

    await check('the network answer is cached for five minutes: the same query is asked once', async () => {
        search.requests.length = 0;
        await t.get('/search?q=agent');
        assert.strictEqual(search.requests.length, 0, 'a cached query called the network again');
        clock += 4 * 60_000;
        await t.get('/search?q=agent');
        assert.strictEqual(search.requests.length, 0, 'the cache expired early');
        clock += 2 * 60_000;
        await t.get('/search?q=agent');
        assert.strictEqual(search.requests.length, 1, 'the cache did not expire after five minutes');
    });

    await check('a query with no article match still shows the network section, and says so honestly', async () => {
        search.requests.length = 0;
        const r = await t.get('/search?q=fluxcapacitor');
        assert.strictEqual(r.status, 200);
        assert.ok(r.text.includes('No article matches'), 'the articles section did not say it found nothing');
        assert.ok(r.text.includes('OpenVibe.Actor explained'), 'the network section is missing');
    });

    await check('OpenVibe.Search failing degrades to the articles alone, and the page says what happened', async () => {
        search.state.fail = 'error';
        try {
            const r = await t.get('/search?q=computer');
            assert.strictEqual(r.status, 200, 'a failed network search must not fail the page');
            assert.ok(r.text.includes('Help articles'), 'the articles are gone');
            assert.ok(r.text.includes('/a/openvibe.actor/'), 'no article results');
            assert.ok(!r.text.includes('OpenVibe.Actor explained'), 'a stale network result was shown');
            assert.ok(/could not be reached|answered 500/.test(r.text), 'the page does not say the network search failed');
        } finally { search.state.fail = null; }
        const back = await t.get('/search?q=computer');
        assert.ok(back.text.includes('OpenVibe.Actor explained'), 'the network did not recover');
    });

    await check('a timeout is a failure too, not a hang', async () => {
        search.state.fail = 'timeout';
        try {
            const r = await t.get('/search?q=browser');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('Help articles'));
            assert.ok(/could not be reached/.test(r.text), 'no failure notice');
        } finally { search.state.fail = null; }
    });

    await check('an answer without a results list is treated as a failure, not as an empty index', async () => {
        search.state.fail = 'garbage';
        try {
            const r = await t.get('/search?q=stream');
            assert.ok(/could not be reached/.test(r.text), 'a malformed answer was shown as "nothing found"');
        } finally { search.state.fail = null; }
    });

    await check('an empty search asks nobody, and reflects the query escaped', async () => {
        search.requests.length = 0;
        const empty = await t.get('/search');
        assert.strictEqual(empty.status, 200);
        assert.strictEqual(search.requests.length, 0, 'an empty query still called the network');
        assert.ok(!empty.text.includes('From across OpenVibe'), 'sections rendered without a query');
        const nasty = await t.get(`/search?q=${encodeURIComponent('"<script>alert(1)</script>')}`);
        assert.strictEqual(nasty.status, 200);
        assert.ok(!nasty.text.includes('<script>alert(1)</script>'), 'the query was reflected raw');
    });

    await check('GET /api/v1/articles?q= answers the same ranking as JSON', async () => {
        const r = await t.get('/api/v1/articles?q=computer');
        assert.strictEqual(r.status, 200);
        const body = r.json();
        assert.ok(body.count > 0 && body.articles.every((a) => a.snippet && a.url.startsWith('/a/')));
        assert.ok(body.articles[0].score >= (body.articles[1] ? body.articles[1].score : 0));
    });

    await t.close();
    await search.close();
    done();
})().catch(async (err) => { console.error(err); try { await search.close(); } catch { /* gone */ } process.exit(1); });
