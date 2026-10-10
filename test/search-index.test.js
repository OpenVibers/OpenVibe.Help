'use strict';
/**
 * Help's articles in OpenVibe.Search (server/search-index.js): a sweep puts every catalog article in the outbox as one
 * help.index_document.upserted, exactly the contract, with the article's own page as its URL and the Contracts package
 * as provenance; a second sweep sends nothing; an article the catalog no longer has becomes a tombstone.
 */
const assert = require('assert');
const contracts = require('openvibe-contracts');
const { boot, check, done } = require('./helpers/boot');
const { createSearchIndex, articleId } = require('../server/search-index');

(async () => {
    const t = await boot();
    const { s, catalog, searchIndex } = t.ctx;
    const outbox = async () => (await s.db.many('SELECT envelope FROM event_outbox ORDER BY id')).map((r) => r.envelope);
    const valid = (env) => {
        assert.ok(contracts.validate('events.event-envelope@1', env).valid, 'envelope');
        const p = contracts.validate(env.event_type, env.payload);
        assert.ok(p.valid, `${env.event_type}: ${JSON.stringify(p.errors)} ${JSON.stringify(env.payload).slice(0, 200)}`);
        assert.strictEqual(env.source, 'help');
        return env;
    };

    try {
        await check('a sweep sends every article once, as the contract says, and the page it names answers', async () => {
            assert.ok(catalog.articles.length > 10, 'the catalog has articles');
            const res = await searchIndex.sweep();
            assert.deepStrictEqual(res.article, { seen: catalog.articles.length, sent: catalog.articles.length, removed: 0, failed: 0 });
            const envs = (await outbox()).map(valid);
            assert.strictEqual(envs.length, catalog.articles.length);
            const a = catalog.articles[0];
            const doc = envs.find((e) => e.payload.id === articleId(a)).payload;
            assert.strictEqual(doc.title, a.question);
            assert.strictEqual(doc.canonical_url, `https://openvibe.help${a.path}`);
            assert.ok(doc.body.includes(a.answer.slice(0, 40)), 'the answer, verbatim');
            assert.strictEqual(doc.facets.site, a.site);
            assert.strictEqual(doc.provenance[0].service, 'help');
            assert.strictEqual(doc.provenance[0].type, 'manifest');
            const page = await t.get(a.path);
            assert.strictEqual(page.status, 200, a.path);
        });

        await check('a second sweep sends nothing', async () => {
            const before = (await outbox()).length;
            assert.strictEqual((await searchIndex.sweep()).article.sent, 0);
            assert.strictEqual((await outbox()).length, before);
        });

        await check('an article the catalog dropped becomes a tombstone, once', async () => {
            const dropped = catalog.articles[1];
            const smaller = { ...catalog, articles: catalog.articles.filter((x) => x !== dropped) };
            const other = createSearchIndex({ config: t.config, s, catalog: smaller, outbox: searchIndex.outbox, log: { log() {}, warn() {} } });
            const res = await other.sweep();
            assert.strictEqual(res.article.removed, 1);
            const env = valid((await outbox()).pop());
            assert.strictEqual(env.event_type, 'help.index_document.deleted');
            assert.deepStrictEqual(env.payload, { type: 'article', id: articleId(dropped), revision: 2 });
            assert.strictEqual((await other.sweep()).article.removed, 0);
        });
    } finally {
        await done(t);
    }
})();
