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
// 2026-11-08: openvibe-shared v4.152.0; CI measured JS 356.6 KB raw / 85.0 KB brotli.
// 2026-11-08: openvibe-shared v4.150.0; CI measured JS 353.9 KB raw / 84.4 KB brotli.
// 2026-11-08: openvibe-shared v4.149.0; CI measured JS 352.9 KB raw / 84.2 KB brotli.
const BUDGETS = {
    htmlRawKB: 71,   // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 65.6 with the short home (2026-10-30: the site list is one pick block, a chip per site, and the parts a reader rarely needs are folds); 55.6 with openvibe-shared 4.53.0: the footer's columns fold on phones (2026-10-30); 50.5 with the Part of OpenVibe section (Shared 4.13, 2026-10-26); measured 45.7 on 2026-10-22: the 12 popular questions now carry their answers inline (and as FAQPage data), plus the hero's figures; 35.7 with 40 sites in the catalog (contracts 0.186.0, 2026-10-15); 32.6 on 2026-10-08 (the home page: hero, search, popular questions, the site cards with one line each, contact)
    htmlBrotliKB: 15, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 14.7: measured 14.2 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsFiles: 5,   // 5 (theme-loader, web-runtime, navbar, footer, boost: openvibe-shared/shell)
    jsRawKB: 393, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 376.4: measured 376.3 KB raw with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 375.1: measured 367.1 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    jsBrotliKB: 94, // 2026-11-11: openvibe-shared 4.190.0 (the site name's dropdown, the footer's online strip, the balances pill); 89.8: measured 89.7 KB brotli with openvibe-shared 4.186.0 (2026-11-10: the mark's Working and Thinking states, the Dock and the menu as one sheet, bare controls styled by the loader); 89.5: measured 87.5 with openvibe-shared 4.163.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssFiles: 2,   // 2 (app.css + the cached /shared/showcase.css)
    cssRawKB: 48.7, // 48.7: measured 43.7 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
    cssBrotliKB: 10.6, // 10.6: measured 9.4 with openvibe-shared 4.161.0, plus room for 4.162.0–4.163.0, 2026-11-09
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
