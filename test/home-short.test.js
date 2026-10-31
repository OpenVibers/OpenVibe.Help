'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30; revised 2026-10-31): the site list is one list of
 * links, not a chip row plus a second copy of the first site. On a phone it is a two-column grid of site names, and
 * the parts a reader rarely needs are folds whose heading is the control (no lone disclosure triangle).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('the home site list is one list: a link per site, with a name not a host', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            assert.ok(!page.includes('pick-sites'), 'the old pick block is still on the home');
            assert.strictEqual((page.match(/id="h-sites"/g) || []).length, 1, 'one Browse by site heading');
            const start = page.indexOf('<ul class="site-cards">');
            assert.ok(start > 0, 'the site list is on the home');
            const block = page.slice(start, page.indexOf('</ul>', start));
            const cards = [...block.matchAll(/<a class="site-card[^"]*" href="\/sites\/([^"]+)"><span class="site-card-top"><b>([^<]+)<\/b>/g)];
            assert.strictEqual(cards.length, t.ctx.catalog.sites.length, 'every site is in the one list');
            const nameOf = (id) => (cards.find((c) => c[1] === id) || [])[2];
            assert.strictEqual(nameOf('ai.openvibe.services'), 'AI', 'the AI site shows its name, not its host');
            assert.strictEqual(nameOf('openvibe.blog'), 'Blog');
            assert.ok(cards.every(([, , name]) => !name.includes('.')), 'a host is shown as a name');
            assert.ok(!page.includes('name="pick-sites"'), 'a chip row still sits above the list');
        });

        await check('on a phone the one list is two columns of names, and the fold heading hides its marker', async () => {
            const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
            assert.match(css, /\.site-cards \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); gap: 8px; \}/, 'the phone site list is two columns');
            assert.match(css, /\.site-card-line, \.site-card-count, \.site-card:not\(\.coming\) \.site-state \{ display: none; \}/, 'a phone shows the name only');
            assert.match(css, /\.hp-fold-block > summary \{ display: block; list-style: none; padding: 0; \}/, 'the summary marker is gone');
            assert.match(css, /\.hp-fold-block > summary::marker \{ content: ''; \}/, 'the standard marker is empty');
            assert.match(css, /\.hp-fold-block > summary::-webkit-details-marker \{ display: none; \}/, 'the WebKit marker is hidden');
        });

        await check('the parts a reader rarely needs are folds, open in the page and closed on a phone', async () => {
            const r = await t.get('/');
            const page = r.text;
            for (const id of ['popular', 'network', 'shipped']) {
                assert.ok(page.includes(`<details class="hp-fold hp-fold-block" id="${id}" open>`), `${id} is a fold, open in the page`);
                assert.ok(page.includes(`document.getElementById("${id}")`), `${id} has the script that closes it on a phone`);
            }
            // The content of the folds stays in the page.
            assert.match(page, /<h2 id="h-popular">Popular questions<\/h2>/);
            assert.match(page, /<h2 id="h-network">Part of OpenVibe<\/h2>/);
            assert.match(page, /<h2 id="h-shipped">Recently shipped on OpenVibe.Help<\/h2>/);
        });
    } finally {
        await done(t);
    }
})().catch((e) => { console.error(e); process.exit(1); });
