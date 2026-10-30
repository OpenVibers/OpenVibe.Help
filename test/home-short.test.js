'use strict';
/**
 * The home on a phone (the owner's short-pages rule, 2026-10-30): the site list is one pick block, a row of chips
 * picks one site, and the parts a reader rarely needs are folds. Radio inputs and :has(), no script for the chips;
 * every site stays in the page for crawlers; a wider screen shows them all and no chips.
 */
const assert = require('assert');
const { boot, check, done } = require('./helpers/boot');

(async () => {
    const t = await boot();
    try {
        await check('the home is one pick block: a chip per site, the first picked, every site in the page', async () => {
            const r = await t.get('/');
            assert.strictEqual(r.status, 200, r.text);
            const page = r.text;
            const start = page.indexOf('<div class="pick" id="pick-sites">');
            assert.ok(start > 0, 'the pick block is on the home');
            const block = page.slice(start, page.indexOf('<details class="hp-fold hp-fold-block" id="popular"'));
            assert.match(block, /<div class="pick-row" role="radiogroup" aria-label="Browse by site">/);
            const chips = [...block.matchAll(/<input type="radio" name="pick-sites" id="pk-sites-(\d+)" value="\1"( checked)?><label for="pk-sites-\1">([^<]+)<\/label>/g)];
            assert.ok(chips.length >= 3, `a chip per site (${chips.length})`);
            assert.deepStrictEqual(chips.filter((m) => m[2]).map((m) => m[1]), [chips[0][1]], 'the first site is picked');
            // Every site card stays in the page, with the index its chip picks.
            const cards = [...block.matchAll(/<li data-i="(\d+)"><a class="site-card/g)];
            assert.strictEqual(cards.length, chips.length, 'every site is in the page');
            assert.deepStrictEqual(cards.map((m) => m[1]), chips.map((m) => m[1]), 'each site knows its chip');
        });

        await check('the CSS guard: the chips are hidden and the sites all show until 640 px and where :has() is understood', async () => {
            const r = await t.get('/');
            const page = r.text;
            assert.match(page, /<style>@supports selector\(:has\(\*\)\)\{@media \(max-width:640px\)\{\.pick#pick-sites:has\(#pk-sites-0:checked\) \.pick-list>li\[data-i="0"\]\{display:block\}/, 'the rule that shows the picked site');
            const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'css', 'app.css'), 'utf8');
            assert.match(css, /\.pick-row \{ display: none; \}/, 'the chips are hidden by default');
            assert.match(css, /@supports selector\(:has\(\*\)\) \{ @media \(max-width: 640px\) \{/, 'the phone rules are under :has() and 640 px');
            assert.match(css, /\.pick-row label \{[^}]*min-height: 44px/, 'a chip is a 44 px target');
            assert.match(css, /\.pick \.pick-list > li \{ display: none; \}/, 'the sites are hidden on a phone');
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
