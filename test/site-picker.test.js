'use strict';
/**
 * The "Which site is this about?" picker on /tickets/new, in a real Chrome at 390 px (the owner's phone, 2026-11-14):
 * every row is the shared app icon, the one OpenVibe.<Name> style and the domain under it; the search finds a site
 * by its domain; a pick leaves the same icon and name in the field. The page is server-rendered, so the markup is
 * checked from the HTML and the search and the live field from Chrome. Chrome is optional: the file reports a skip
 * when there is none (openvibe-shared/test-runner counts a skip, not a pass).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const harness = require('openvibe-shared/browser-harness');
const pages = require('../server/http/pages');
const { boot, check, done } = require('./helpers/boot');

const BLOCK = ['https://openvibe.network/*', 'https://openvibe.chat/*', 'https://fonts.googleapis.com/*',
    'https://fonts.gstatic.com/*', 'https://cdnjs.cloudflare.com/*', 'https://static.cloudflareinsights.com/*'];

(async () => {
    if (!harness.findChrome()) {
        // boot.js captures console.*; the runner reads skips from the test's own stdout.
        process.stdout.write('site picker: skipped (no Chrome)\n');
        return done();
    }
    const t = await boot();
    let browser = null;
    try {
        const user = t.network.addUser('picker-reader');
        await check('the site picker: one icon and OpenVibe.<Name> per row, a domain search, and the picked site in the field', async () => {
            const form = await t.get('/tickets/new', { as: user });
            assert.strictEqual(form.status, 200);

            // The server-rendered sheet: every site row is the same shape, and the search can see the domain.
            const rows = [...form.text.matchAll(/<label class="site-pick-row" data-site="([^"]+)" data-search="([^"]*)">([\s\S]*?)<\/label>/g)]
                .map((m) => ({ id: m[1], search: m[2], body: m[3] }));
            assert.strictEqual(rows.length, t.ctx.catalog.sites.length, 'a catalog site is missing from the picker');
            const order = rows.map((row) => t.ctx.catalog.byId.get(row.id).fullName);
            assert.deepStrictEqual(order, [...order].sort((a, b) => a.localeCompare(b)), 'the sites are not sorted by name');
            for (const row of rows) {
                const site = t.ctx.catalog.byId.get(row.id);
                assert.ok(site, `${row.id} is not a catalog site`);
                assert.match(row.body, /class="ov-appicon"[^>]*>/, `${row.id} has no app icon`);
                assert.match(row.body, new RegExp(`class="site-pick-name">${site.fullName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<`), `${row.id} is not named ${site.fullName}`);
                assert.match(row.body, /class="site-pick-domain">[a-z0-9.-]+</, `${row.id} has no domain under its name`);
                assert.ok(row.search.includes(row.id), `${row.id} cannot be found by its domain`);
                assert.ok(row.search.includes(site.shortName.toLowerCase()), `${row.id} cannot be found by its name`);
            }
            assert.match(form.text, /<span class="site-pick-name">OpenVibe\.Locker<\/span>/, 'Locker is not OpenVibe.Locker');
            assert.match(form.text, /<span class="site-pick-name">OpenRestream<\/span>/, 'OpenRestream is not shown as itself');
            assert.ok(form.text.includes('id="site-search"'), 'the picker has no search box');
            assert.ok(form.text.includes('src="/site-picker.js?v='), 'the picker has no script');
            assert.strictEqual(typeof pages.createPageRoutes, 'function', 'the ticket pages are not built by server/http/pages.js');

            // The script that turns the plain sheet into a search and a live field, served from public/.
            const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'site-picker.js'), 'utf8');
            assert.match(script, /site-pick-row/, 'the picker script does not hide the non-matching rows');
            assert.match(script, /data-search/, 'the picker script does not search the name and the domain');
            const asset = await t.get('/site-picker.js');
            assert.strictEqual(asset.status, 200);
            assert.match(String(asset.headers.get('content-type')), /javascript/, 'the picker script is served with the wrong type');

            browser = await harness.launch();
            const context = await browser.newContext();
            const page = await harness.openPage(browser, context, { width: 390, height: 900, js: true, block: BLOCK });
            await page.send('Network.setCookie', { name: 'help_at', value: t.network.userToken(user), url: t.base }).catch(() => {});
            await page.goto(`${t.base}/tickets/new`);

            const measure = await page.evaluate(`(() => {
                const rows = [...document.querySelectorAll('.site-pick-row')];
                const icon = document.querySelector('.site-pick-row .ov-appicon');
                const r = icon && icon.getBoundingClientRect();
                return {
                    rows: rows.length,
                    minRow: Math.min(...rows.map((x) => x.getBoundingClientRect().height)),
                    icon: r ? { w: r.width, h: r.height } : null,
                    sweep: document.documentElement.scrollWidth,
                };
            })()`);
            assert.strictEqual(measure.rows, t.ctx.catalog.sites.length);
            assert.ok(measure.minRow >= 52, `a site row is ${measure.minRow} px tall`);
            assert.deepStrictEqual(measure.icon, { w: 32, h: 32 }, 'the app icon is not 32 px');
            assert.strictEqual(measure.sweep, 390, 'the ticket form scrolls sideways at 390 px');

            await page.evaluate(`document.querySelector('.site-pick-summary').click(); true`);
            await page.evaluate(`(() => {
                const input = document.querySelector('#site-search');
                input.value = 'openvibe.locker';
                input.dispatchEvent(new Event('input', { bubbles: true }));
                return true;
            })()`);
            await page.evaluate(`new Promise((r) => setTimeout(r, 60))`);
            const found = await page.evaluate(`(() => {
                const visible = [...document.querySelectorAll('.site-pick-row:not([hidden])')];
                const list = document.querySelector('.site-pick-list');
                const search = document.querySelector('.site-pick-search');
                const top = search.getBoundingClientRect().top;
                list.scrollTop = 400;
                return { sites: visible.map((r) => r.dataset.site), searchTop: top, searchAfter: search.getBoundingClientRect().top, empty: document.querySelector('.site-pick-empty').hidden };
            })()`);
            assert.deepStrictEqual(found.sites, ['openvibe.locker'], `a domain search found ${JSON.stringify(found.sites)}`);
            assert.strictEqual(found.empty, true, 'the empty message shows when a site did match');
            assert.strictEqual(found.searchAfter, found.searchTop, 'the search box scrolled away with the list');

            await page.evaluate(`document.querySelector('.site-pick-row[data-site="openvibe.locker"]').click(); true`);
            const picked = await page.evaluate(`(() => ({
                open: document.querySelector('.site-pick').open,
                name: document.querySelector('[data-site-name]').textContent,
                domain: document.querySelector('[data-site-domain]').textContent,
                icon: document.querySelector('.site-pick-current-icon .ov-appicon')?.dataset.icon,
                checked: document.querySelector('.site-pick-row input:checked')?.value,
            }))()`);
            assert.deepStrictEqual(picked, { open: false, name: 'OpenVibe.Locker', domain: 'openvibe.locker', icon: 'lock', checked: 'openvibe.locker' });
        });
    } finally {
        if (browser) await browser.close();
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
