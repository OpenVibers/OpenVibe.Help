'use strict';
/**
 * Outcome 7: every answer page and the ticket pages fit a phone screen. A real Chrome measures the document's
 * scrollWidth for every generated answer at 390 px (the required check), the longest at 320 px (the narrower
 * case), the ticket start, list and one signed-in conversation at both widths, and the not-serving site page.
 * The pages load with JavaScript off, so this is the server-rendered layout and its stylesheet before the shared
 * Frame's scripts run — the part this service owns and the part a crawler sees. External Frame hosts are blocked
 * too, so a slow font or navbar cannot hold the check. Chrome is optional: the suite reports the file skipped when
 * there is none (openvibe-shared/test-runner counts a skip, not a pass).
 */
const assert = require('assert');
const harness = require('openvibe-shared/browser-harness');
const { boot, check, done } = require('./helpers/boot');
const store = require('../server/tickets/store');

const BLOCK = ['https://openvibe.network/*', 'https://static.cloudflareinsights.com/*', 'https://fonts.googleapis.com/*',
    'https://fonts.gstatic.com/*', 'https://cdnjs.cloudflare.com/*'];

const READ_WIDTH = `(() => {
    const de = document.documentElement;
    const vw = de.clientWidth;
    const scrollWidth = Math.max(de.scrollWidth, document.body ? document.body.scrollWidth : 0);
    const x0 = window.scrollX; window.scrollTo(100000, window.scrollY); const scrollX = window.scrollX; window.scrollTo(x0, window.scrollY);
    const offenders = [];
    if (scrollX > 0 || scrollWidth > vw + 1) {
        for (const e of document.body ? document.body.getElementsByTagName('*') : []) {
            if (offenders.length >= 5) break;
            const r = e.getBoundingClientRect();
            if (!r.width || r.right <= vw + 1) continue;
            const cs = getComputedStyle(e);
            if (cs.position === 'fixed' || cs.visibility === 'hidden') continue;
            const cls = typeof e.className === 'string' && e.className.trim() ? '.' + e.className.trim().split(/\\s+/)[0] : '';
            offenders.push(e.tagName.toLowerCase() + (e.id ? '#' + e.id : cls) + ' (right ' + Math.round(r.right) + 'px)');
        }
    }
    return { vw, scrollWidth, scrollX, offenders };
})()`;

(async () => {
    if (!harness.findChrome()) {
        // boot.js captures console.*; the runner reads skips from the test's own stdout.
        process.stdout.write('phone clipping: skipped (no Chrome)\n');
        return done();
    }
    const t = await boot();
    let browser = null;
    try {
        const articles = t.ctx.catalog.articles;
        assert.ok(articles.length >= 20, `only ${articles.length} answer pages`);

        // Every catalog site is live today: the not-serving page is exercised with one constructed entry whose only
        // difference is its state, so its one-line status link is measured at both widths like a real page.
        const model = t.ctx.catalog.sites.find((s) => s.live);
        const coming = { ...model, id: 'openvibe.not-serving', name: 'OpenVibe.NotServing', state: 'coming', live: false, service: 'help' };
        t.ctx.catalog.byId.set(coming.id, coming);

        const writer = t.network.addUser('width-writer');
        const ticket = await store.create(t.ctx.s, {
            requester: `user:${writer.subject}`, site: 'openvibe.live', subject: 'A page that must fit a phone',
            pageUrl: null, body: 'The whole conversation has to stay inside the screen, including a very long word: ' + 'x'.repeat(120),
        });

        browser = await harness.launch();
        const context = await browser.newContext();
        const phone = await harness.openPage(browser, context, { width: 390, height: 900, js: false, block: BLOCK });
        // The signed-in ticket page is read with the same session cookie the site sets at sign-in (both tabs share
        // the browser context, so setting it on one covers the other).
        await phone.send('Network.setCookie', { name: 'help_at', value: t.network.userToken(writer), url: t.base }).catch(() => {});
        const narrow = await harness.openPage(browser, context, { width: 320, height: 800, js: false, block: BLOCK });
        // Four tabs share the 160 answer pages: the same browser context, so the cookie and the block list apply,
        // and the test stays well inside the runner's per-file timeout on a loaded CI machine.
        const extra = await Promise.all([0, 1, 2].map(() => harness.openPage(browser, context, { width: 390, height: 900, js: false, block: BLOCK })));
        const answerPages = [phone, ...extra];
        const failures = [];
        const visit = async (page, width, path, expectStatus = 200) => {
            await page.goto(t.base + path, { quietMs: 20, maxMs: 1500, minMs: 30 });
            const read = await page.evaluate(READ_WIDTH);
            const status = page.state.doc && page.state.doc.status;
            if (status !== expectStatus || read.scrollWidth > read.vw + 1 || read.scrollX > 0) {
                failures.push({ path, width, status, expectStatus, vw: read.vw, scrollWidth: read.scrollWidth, scrollX: read.scrollX, offenders: read.offenders });
            }
        };

        // Every answer page at 390 px, and the longest titles and answers again at 320 px.
        await Promise.all(answerPages.map(async (pg, i) => {
            for (let j = i; j < articles.length; j += answerPages.length) await visit(pg, 390, articles[j].path);
        }));
        const longest = [...articles].sort((a, b) => (b.question.length + b.answer.length) - (a.question.length + a.answer.length)).slice(0, 6);
        for (const article of longest) await visit(narrow, 320, article.path);
        await visit(narrow, 320, '/');
        await visit(narrow, 320, '/sites');

        // The ticket flow: start, list, and one conversation, all signed in through the cookie above.
        let primary = null;
        for (const page of [phone, narrow]) {
            const width = page === phone ? 390 : 320;
            // Signed in through the cookie above: all four are the real pages a reader sees, not the 401 prompts.
            await visit(page, width, '/tickets/new', 200);
            if (width === 390) {
                primary = await page.evaluate(`(() => {
                    const b = document.querySelector('form.ticket-form button[type="submit"]');
                    if (!b) return null;
                    const r = b.getBoundingClientRect();
                    return { width: r.width, height: r.height };
                })()`);
            }
            await visit(page, width, '/tickets', 200);
            await visit(page, width, `/tickets/${ticket.id}`, 200);
            await visit(page, width, `/sites/${coming.id}`, 200);
        }
        if (!primary || primary.height < 44 || primary.width < 300) failures.push({ path: '/tickets/new', width: 390, control: 'primary submit', primary });

        await check('every answer page fits 390 px, the ticket submit is 44 px and full width, and the ticket and down-site pages fit 320 px', () => {
            assert.deepStrictEqual(failures, [], `${failures.length} page(s) do not fit:\n${JSON.stringify(failures.slice(0, 10), null, 2)}`);
        });
        for (const pg of extra) await pg.close();
        await phone.close();
        await narrow.close();
    } finally {
        if (browser) await browser.close();
        await t.close();
    }
    done();
})().catch((err) => { console.error(err); process.exit(1); });
