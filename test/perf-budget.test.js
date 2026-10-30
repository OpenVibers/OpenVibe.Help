'use strict';
// Size budgets for openvibe.help's home page (roadmap WS-T task 1, openvibe-shared/perf-budget): the
// server as it runs (a fresh database), measured without a browser. Budgets sit about 10% above the
// 2026-10-08 measurement (see below); raising one is a decision to state in the commit.
//   node test/perf-budget.test.js
const assert = require('assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { measure, check, format } = require('openvibe-shared/perf-budget');

// Budgets are set from the numbers measured on 2026-10-08 (the real ones, fresh database), rounded up with about 10%
// headroom; file counts are the measured counts and external files stay at 0.
//
// The CSS budget moved with the product: the home page is now the help centre (a search box, the questions the
// sites answer, the site grid, the ticket form), so app.css grew by the styles those need — 6.0 KB of app.css
// against 11.6 KB of the shared showcase.css. Raised 2026-10-08 from 16.5/4.1 to 18.5/4.5 for a measured
// 17.5/4.3. The HTML budget did NOT move: those pages fit in the skeleton home page's 24.9 KB budget with room.
const BUDGETS = {
    htmlRawKB: 56,   // 55.6 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 50.5 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); measured 45.7 on 2026-10-22: the 12 popular questions now carry their answers inline (and as FAQPage data), plus the hero's figures; 35.7 with 40 sites in the catalog (contracts 0.186.0, 2026-10-15); 32.6 on 2026-10-08 (the home page: hero, search, popular questions, the site cards with one line each, contact)
    htmlBrotliKB: 12,   // 11 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); 9.7 on 2026-10-22 (answers inline); 8.3 with 40 sites (2026-10-15); 7.3
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell)
    jsRawKB: 322,   // 321.1 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 318.1 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 315.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 307.8 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 300.5 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 293 openvibe-shared 4.22.0: the navbar's magnifier search button and More dropdown (search.js and loading.js load only when used); 287.2 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 273.2 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 264.3 with Shared 4.13.0 (2026-10-26: account links); 239.8
    jsBrotliKB: 79,   // 78.2 with openvibe-shared 4.52.0: the Dock's loader and its Chats tab (2026-10-30); 77.6 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 76.1 with openvibe-shared 4.43.0 (room.css carries the kit tokens, 4.39.1; the kit's 4.39.0 rules); 74.2 openvibe-shared 4.25.0: the menu's orb beside the brand, both balances on phones, messages, the account sheet on phones and the bar stepping away on phones; 70.5 Shared 4.17.0: OpenCoins and Vibes chips (wallet: true) in the navbar; 67.9 openvibe-shared 4.15 footer: the compact footer opens into the whole one, and the pulse line; 65.3 Shared 4.12.0: the light/dark switch, the seasonal mark and the theme pairs; 56.5
    cssFiles: 2,   // 2 (app.css + the cached /shared/showcase.css)
    cssRawKB: 39,   // 38 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 32.4 openvibe-shared 4.26.1 (hero visual); 26.9 with Shared 4.13.0 (2026-10-26: account links); 19.3
    cssBrotliKB: 8.4,     // 8.2 with openvibe-shared 4.48.0 (the site switcher on the mark, the menu's Start tab and quick tools; Kit's touch hit areas and the phone navbar fix, 4.44-4.47.3); 7.8 the home's phone layout (2026-10-29); 6 with Shared 4.13.0 (2026-10-26: account links); 4.6 // raised 7 -> 8 for the openvibe-shared Kit 2 pin (kit.css grew) // back to the pre-Kit 2 value: Kit 2 has its own files (kit-data.css) since openvibe-shared v4.37.0, so kit.css weighs what it did // back to the pre-Kit 2 value: Kit 2 has its own files (kit-data.css) since openvibe-shared v4.37.0, so kit.css weighs what it did
    externalFiles: 0,   // 0
};

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

(async () => {
    // A database of its own (not the shared dev PGlite in data/pglite, and not whatever the caller's
    // DATABASE_URL names), so the measurement is the server on a fresh database and the run leaves nothing.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ov-budget-'));
    const pgliteDir = path.join(dir, 'pglite');
    const port = await freePort();
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'test',
            DATABASE_URL: '', DATABASE_DIRECT_URL: '', VALKEY_URL: '', HELP_PGLITE_DIR: pgliteDir,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    const base = `http://127.0.0.1:${port}`;
    try {
        let up = false;
        for (let i = 0; i < 600 && !up; i++) {
            up = await fetch(`${base}/api/health`).then((r) => r.ok).catch(() => false);
            if (!up) await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(up, `the server did not start:\n${stderr}`);
        assert.ok(fs.existsSync(pgliteDir), 'the server did not use the isolated database (HELP_PGLITE_DIR)');
        const m = await measure({ base });
        const over = check(m, BUDGETS);
        assert.deepStrictEqual(over, [], format(m, over));
        console.log(format(m));
        console.log('perf budget: all checks passed');
    } finally {
        child.kill();
        fs.rmSync(dir, { recursive: true, force: true });
    }
})().catch((err) => { console.error(err); process.exitCode = 1; });
