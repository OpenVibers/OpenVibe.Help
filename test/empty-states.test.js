'use strict';
/** Owner ask 81: the no-such-question page, the empty help search and a person's empty ticket list use the kit. */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        const kim = t.network.addUser('empty-help');
        await check('a question that does not exist draws the kit empty state', async () => {
            const r = await t.get('/a/no-site/no-question');
            assert.strictEqual(r.status, 404);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No such question'));
            assert.ok(r.text.includes('See every site'));
            assert.match(r.text, /kit\.css/);
        });
        await check('a help search with no article draws the kit empty state', async () => {
            const r = await t.get('/search?q=zzzznotahelpword');
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No article matches'));
            assert.ok(r.text.includes('Browse the sites'));
            assert.match(r.text, /kit\.css/);
        });
        await check("a person's empty ticket list draws the kit empty state", async () => {
            const r = await t.get('/tickets', { as: kim });
            assert.strictEqual(r.status, 200);
            assert.ok(r.text.includes('class="ovk-empty"'));
            assert.ok(r.text.includes('No tickets yet'));
            assert.ok(r.text.includes('Open a ticket'));
            assert.match(r.text, /kit\.css/);
        });
    } finally { await t.close(); }
    done();
})();
