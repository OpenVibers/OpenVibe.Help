'use strict';
/**
 * Support tickets end to end, through the API and through the pages' plain forms: a signed-in person opens one and
 * it is a single conversation (migrations/0002_tickets.sql); only they (and staff) can read it; anyone else gets
 * 404; anonymous is refused; a write made with the session cookie must come from openvibe.help itself; staff read
 * the queue and set the state; bodies are escaped and capped at 10 000 characters; opening tickets is limited per
 * caller. Tokens are never in a response, and a page URL is stored as text and never fetched.
 */
const assert = require('assert');
const { signJwt } = require('./helpers/mocks');
const { boot, check, done } = require('./helpers/boot');

const SAME = { 'sec-fetch-site': 'same-origin' };
const TKT = /^tkt_[0-9A-HJKMNP-TV-Z]{26}$/;
const SUBJECT = 'Nothing happens when I press Go Live';

(async () => {
    const t = await boot();
    const kim = t.network.addUser('kim');
    const lee = t.network.addUser('lee');
    const ada = t.network.addUser('ada', { role: 'admin' });
    const gil = t.network.addUser('gil', { role: 'global_mod' });
    const sam = t.network.addUser('sam', { role: 'streamer' });

    const create = (body, o = {}) => t.get('/api/v1/tickets', { as: o.as || kim, json: body, headers: { ...SAME, ...(o.headers || {}) } });
    /** Every write from this site: the session cookie is only accepted for a same-origin request. */
    const write = (path, body, o = {}) => t.get(path, { as: o.as || kim, json: body || {}, headers: { ...SAME, ...(o.headers || {}) } });
    const ticket = { subject: SUBJECT, message: 'I press Go Live on OpenVibe.Live and nothing happens.', site: 'openvibe.live', page_url: 'https://openvibe.live/broadcast' };
    let id = null;

    await check('a signed-in person opens a ticket; its description is the first message of one conversation', async () => {
        const r = await create(ticket);
        assert.strictEqual(r.status, 201, r.text);
        const made = r.json();
        assert.match(made.id, TKT);
        id = made.id;
        assert.strictEqual(r.headers.get('location'), `/api/v1/tickets/${id}`);
        assert.strictEqual(made.state, 'open');
        assert.strictEqual(made.site, 'openvibe.live');
        assert.strictEqual(made.page_url, 'https://openvibe.live/broadcast');
        assert.strictEqual(made.requester.type, 'user');
        assert.ok(!('messages' in made), 'the create answer stays small');
        const got = (await t.get(`/api/v1/tickets/${id}`, { as: kim })).json();
        assert.strictEqual(got.subject, SUBJECT);
        assert.strictEqual(got.messages.length, 1, 'a ticket is never empty');
        assert.strictEqual(got.messages[0].role, 'person');
        assert.strictEqual(got.messages[0].body, ticket.message);
        assert.strictEqual(got.messages[0].author.type, 'user');
    });

    await check('a ticket is private: another person gets 404, staff may read it', async () => {
        assert.strictEqual((await t.get(`/api/v1/tickets/${id}`, { as: lee })).status, 404);
        assert.strictEqual((await t.get(`/api/v1/tickets/${id}`, { as: lee })).json().code, 'ticket.not_found');
        assert.strictEqual((await t.get(`/api/v1/tickets/${id}`, { as: ada })).status, 200, 'an admin reads it');
        assert.strictEqual((await t.get(`/api/v1/tickets/${id}`, { as: gil })).status, 200, 'a global mod reads it');
        const deep = (await t.get('/api/v1/tickets?limit=100', { as: lee })).json();
        assert.ok(!deep.tickets.some((x) => x.id === id), "lee's list carries kim's ticket");
        const mine = (await t.get('/api/v1/tickets', { as: kim })).json();
        assert.ok(mine.tickets.some((x) => x.id === id), 'kim cannot see her own ticket');
    });

    await check('anonymous is refused on every ticket route; a non-staff role is not staff', async () => {
        assert.strictEqual((await t.get('/api/v1/tickets')).status, 401);
        assert.strictEqual((await t.get('/api/v1/tickets')).json().code, 'token.required');
        assert.strictEqual((await t.get('/api/v1/tickets', { json: ticket })).status, 401);
        assert.strictEqual((await t.get(`/api/v1/tickets/${id}`)).status, 401);
        assert.strictEqual((await t.get(`/api/v1/tickets/${id}/messages`, { json: { message: 'hello' } })).status, 401);
        assert.strictEqual((await t.get('/api/v1/staff/tickets')).status, 401);
        assert.strictEqual((await t.get('/api/v1/staff/tickets', { as: sam })).status, 403, 'a streamer is not staff');
        assert.strictEqual((await t.get('/api/v1/staff/tickets', { as: sam })).json().code, 'staff.forbidden');
        assert.strictEqual((await write(`/api/v1/tickets/${id}/state`, { state: 'solved' }, { as: sam })).status, 403);
    });

    await check('an app token cannot act as a person', async () => {
        const now = Math.floor(Date.now() / 1000);
        const app = signJwt({
            iss: t.network.url, sub: 'app:app_01JABCDEFGHJKMNPQRSTVWXYZ0', actor_type: 'app', aud: ['openvibe.help'],
            cap: ['help.ticket.create'], project_id: 'prj_01JABCDEFGHJKMNPQRSTVWXYZ0', env: 'production', jti: 'tok_test_app',
            iat: now, exp: now + 300,
        }, t.network.privatePem);
        const r = await t.get('/api/v1/tickets', { bearer: app, json: ticket });
        assert.strictEqual(r.status, 403, r.text);
        assert.strictEqual(r.json().code, 'help.person_required');
        assert.strictEqual((await t.get('/api/v1/tickets', { bearer: app })).status, 403);
    });

    await check('a session write must come from this site; a Bearer write need not', async () => {
        const cross = await t.get('/api/v1/tickets', { as: kim, json: ticket, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 403);
        assert.strictEqual(cross.json().code, 'request.cross_site');
        const bare = await t.get('/api/v1/tickets', { as: kim, json: ticket });
        assert.strictEqual(bare.status, 403, 'no fetch metadata and no Origin: refused, as for every other write here');
        const before = (await t.get('/api/v1/tickets?limit=100', { as: kim })).json().tickets.length;
        const bearer = await t.get('/api/v1/tickets', { bearer: t.network.userToken(kim), json: { ...ticket, subject: 'Through a Bearer token' } });
        assert.strictEqual(bearer.status, 201, bearer.text);
        assert.strictEqual((await t.get('/api/v1/tickets?limit=100', { as: kim })).json().tickets.length, before + 1);
        // A GET never needs the same-origin header: nothing changes.
        assert.strictEqual((await t.get('/api/v1/tickets', { as: kim })).status, 200);
    });

    await check('replying: the person, staff, and nobody else', async () => {
        const mine = await write(`/api/v1/tickets/${id}/messages`, { message: 'It happens in Chrome and Firefox both.' });
        assert.strictEqual(mine.status, 201, mine.text);
        assert.strictEqual(mine.json().messages.length, 2);
        assert.strictEqual(mine.json().messages[1].role, 'person');
        const theirs = await write(`/api/v1/tickets/${id}/messages`, { message: 'me too' }, { as: lee });
        assert.strictEqual(theirs.status, 404, 'a stranger cannot reply');
        const staff = await write(`/api/v1/tickets/${id}/messages`, { message: 'Which browser version?' }, { as: ada });
        assert.strictEqual(staff.status, 201, staff.text);
        assert.strictEqual(staff.json().messages[2].role, 'staff', 'a staff reply is marked as staff');
        const after = (await t.get(`/api/v1/tickets/${id}`, { as: kim })).json();
        assert.strictEqual(after.messages.length, 3);
        assert.ok(after.updated_at >= after.created_at);
    });

    await check('a body is plain text: capped at 10 000 characters, and empty is refused', async () => {
        const long = await create({ ...ticket, subject: 'x'.repeat(161) });
        assert.strictEqual(long.status, 422);
        assert.match(long.json().detail, /subject/);
        const huge = await create({ subject: 'Big', message: 'x'.repeat(10_001) });
        assert.strictEqual(huge.status, 422);
        assert.match(huge.json().detail, /message/);
        const empty = await create({ subject: 'Empty', message: '   ' });
        assert.strictEqual(empty.status, 422);
        const tooLongReply = await write(`/api/v1/tickets/${id}/messages`, { message: 'y'.repeat(10_001) });
        assert.strictEqual(tooLongReply.status, 422);
        const exactly = await create({ subject: 'Exactly ten thousand', message: 'z'.repeat(10_000) });
        assert.strictEqual(exactly.status, 201, 'exactly the limit is allowed');
        assert.strictEqual((await t.get('/api/v1/sites/not-a-site', { as: kim })).status, 404);
        const unknownSite = await create({ ...ticket, site: 'evil.example' });
        assert.strictEqual(unknownSite.status, 422, 'a site must come from the catalog');
        assert.match(unknownSite.json().detail, /site/);
    });

    await check('staff set the state and read the queue, filtered', async () => {
        const bad = await write(`/api/v1/tickets/${id}/state`, { state: 'closed' }, { as: ada });
        assert.strictEqual(bad.status, 422);
        const solved = await write(`/api/v1/tickets/${id}/state`, { state: 'solved' }, { as: ada });
        assert.strictEqual(solved.status, 200);
        assert.strictEqual(solved.json().state, 'solved');
        const open = (await t.get('/api/v1/staff/tickets?state=open', { as: ada })).json();
        assert.ok(!open.tickets.some((x) => x.id === id), 'a solved ticket is not in the open queue');
        assert.deepStrictEqual(open.filter, { site: null, state: 'open' });
        assert.ok(open.counts.all >= open.counts.open + open.counts.solved, JSON.stringify(open.counts));
        const all = (await t.get('/api/v1/staff/tickets?state=all', { as: ada })).json();
        assert.ok(all.tickets.some((x) => x.id === id && x.state === 'solved'));
        const bySite = (await t.get('/api/v1/staff/tickets?state=all&site=openvibe.live', { as: gil })).json();
        assert.ok(bySite.tickets.length > 0 && bySite.tickets.every((x) => x.site === 'openvibe.live'));
        const nobody = (await t.get('/api/v1/staff/tickets?state=all&site=openvibe.food', { as: gil })).json();
        assert.deepStrictEqual(nobody.tickets, []);
    });

    await check('the pages: /tickets lists yours only, /staff is for staff, /tickets/:id is the conversation', async () => {
        const mine = await t.get('/tickets', { as: kim });
        assert.strictEqual(mine.status, 200);
        assert.ok(mine.text.includes(SUBJECT), 'the ticket is not in the list');
        const theirs = await t.get('/tickets', { as: lee });
        assert.ok(!theirs.text.includes(SUBJECT), "lee's page shows kim's ticket");
        assert.strictEqual((await t.get(`/tickets/${id}`)).status, 401, 'anonymous');
        assert.strictEqual((await t.get(`/tickets/${id}`, { as: lee })).status, 404);
        const conversation = await t.get(`/tickets/${id}`, { as: kim });
        assert.strictEqual(conversation.status, 200);
        assert.ok(conversation.text.includes('I press Go Live'), 'the description is not on the page');
        assert.ok(conversation.text.includes('Which browser version?'), 'the staff reply is not on the page');
        assert.strictEqual((await t.get('/staff', { as: ada })).status, 200);
        assert.strictEqual((await t.get('/staff', { as: kim })).status, 403);
        assert.strictEqual((await t.get('/staff')).status, 401);
        const queue = await t.get('/staff?state=all&site=openvibe.live', { as: gil });
        assert.ok(queue.text.includes(`/tickets/${id}`), 'the queue does not link the ticket');
    });

    await check('the page form opens a ticket and lands on it; a cross-site form does not', async () => {
        const form = await t.get('/tickets/new', { as: kim });
        assert.strictEqual(form.status, 200);
        assert.ok(form.text.includes('<select id="site" name="site"'), 'no site picker');
        for (const site of t.ctx.catalog.sites.slice(0, 5)) assert.ok(form.text.includes(`value="${site.id}"`), `${site.id} is not in the picker`);
        const made = await t.get('/tickets', { as: kim, form: { site: 'openvibe.wiki', subject: 'A wiki question', message: 'How do I cite a source?', page_url: '' }, headers: SAME });
        assert.strictEqual(made.status, 303, made.text.slice(0, 200));
        assert.match(made.headers.get('location'), /^\/tickets\/tkt_/);
        const created = await t.get(made.headers.get('location'), { as: kim });
        assert.ok(created.text.includes('How do I cite a source?'));
        const cross = await t.get('/tickets', { as: kim, form: { subject: 'From elsewhere', message: 'nope' }, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 403);
        const bad = await t.get('/tickets', { as: kim, form: { subject: '', message: '' }, headers: SAME });
        assert.strictEqual(bad.status, 422);
        assert.ok(bad.text.includes('<select id="site" name="site"'), 'the form is not shown again');
    });

    await check('a reply from the page goes back to the ticket, and only from this site', async () => {
        const r = await t.get(`/tickets/${id}`, { as: kim, form: { message: 'Still happening today.' }, headers: SAME });
        assert.strictEqual(r.status, 303);
        assert.strictEqual(r.headers.get('location'), `/tickets/${id}`);
        assert.ok((await t.get(`/tickets/${id}`, { as: kim })).text.includes('Still happening today.'));
        const cross = await t.get(`/tickets/${id}`, { as: kim, form: { message: 'x' }, headers: { 'sec-fetch-site': 'cross-site' } });
        assert.strictEqual(cross.status, 403);
        assert.strictEqual((await t.get(`/tickets/${id}`, { as: lee, form: { message: 'x' }, headers: SAME })).status, 404);
        const state = await t.get(`/tickets/${id}/state`, { as: ada, form: { state: 'waiting' }, headers: SAME });
        assert.strictEqual(state.status, 303);
        assert.strictEqual((await t.get(`/api/v1/tickets/${id}`, { as: kim })).json().state, 'waiting');
    });

    await check('a body is rendered escaped, with its line breaks kept', async () => {
        const nasty = 'First line\n\n<script>alert(1)</script> & <b>bold</b>';
        const r = await create({ subject: 'Escaping <script>', message: nasty });
        assert.strictEqual(r.status, 201, r.text);
        const page = await t.get(`/tickets/${r.json().id}`, { as: kim });
        assert.ok(!page.text.includes('<script>alert(1)</script>'), 'the body was rendered raw');
        assert.ok(page.text.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the body is not shown escaped');
        assert.ok(page.text.includes('&amp; &lt;b&gt;bold&lt;/b&gt;'), 'ampersands and tags');
        assert.ok(!page.text.includes('<h1>Escaping <script>'), 'the subject was rendered raw');
        assert.ok(page.text.includes('&lt;script&gt;</h1>'), 'the subject is not shown escaped');
        assert.strictEqual(r.json().subject, 'Escaping <script>', 'the stored text is what was typed');
        assert.ok((await t.get(`/api/v1/tickets/${r.json().id}`, { as: kim })).json().messages[0].body.includes('First line\n\n<script>'), 'the stored body lost its line breaks');
    });

    await check('a page URL is stored and shown as text; only http(s) becomes a link', async () => {
        const r = await create({ subject: 'With a strange page URL', message: 'Where I was.', page_url: 'javascript:alert(1)' });
        assert.strictEqual(r.status, 201);
        const stored = (await t.get(`/api/v1/tickets/${r.json().id}`, { as: kim })).json();
        assert.strictEqual(stored.page_url, 'javascript:alert(1)', 'the text is kept as typed');
        const page = await t.get(`/tickets/${r.json().id}`, { as: kim });
        assert.ok(page.text.includes('javascript:alert(1)'), 'the text is not shown');
        assert.ok(!page.text.includes('href="javascript:'), 'a javascript: URL became a link');
        const good = await create({ subject: 'With a real page URL', message: 'Where I was.', page_url: 'https://openvibe.help/sites' });
        const goodPage = await t.get(`/tickets/${good.json().id}`, { as: kim });
        assert.ok(goodPage.text.includes('href="https://openvibe.help/sites"'), 'an https URL is not a link');
    });

    await check('no token ever comes back on a ticket page or in the database', async () => {
        const token = t.network.userToken(kim);
        const page = await t.get(`/tickets/${id}`, { as: kim });
        assert.ok(!page.text.includes(token) && !page.text.includes('eyJ'), 'a token is on the page');
        const dump = await t.dbDump();
        assert.ok(!dump.includes(token), 'a token is in the database');
    });

    await check('the tables are help_tickets and help_messages, with tkt_ and msg_ ids', async () => {
        const tables = (await t.ctx.s.db.many("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()")).map((r) => r.name);
        for (const name of ['help_tickets', 'help_messages']) assert.ok(tables.includes(name), `${name} is missing (have ${tables.join(', ')})`);
        const rows = await t.ctx.s.db.many('SELECT * FROM help_tickets WHERE subject = $1', [SUBJECT]);
        assert.strictEqual(rows.length, 1);
        assert.deepStrictEqual(Object.keys(rows[0]).sort(), ['created_at', 'id', 'page_url', 'requester', 'site', 'state', 'subject', 'updated_at']);
        assert.match(rows[0].id, TKT);
        assert.match(rows[0].requester, /^user:usr_/);
        assert.ok(['open', 'waiting', 'solved'].includes(rows[0].state), `unexpected state ${rows[0].state}`);
        const msgs = await t.ctx.s.db.many('SELECT id, role FROM help_messages WHERE ticket_id = $1 ORDER BY id', [rows[0].id]);
        assert.ok(msgs.length >= 4, `only ${msgs.length} messages`);
        assert.ok(msgs.every((m) => /^msg_[0-9A-HJKMNP-TV-Z]{26}$/.test(m.id)), 'a message id is not msg_<ULID>');
        assert.deepStrictEqual([...new Set(msgs.map((m) => m.role))].sort(), ['person', 'staff']);
    });

    await check('opening tickets is limited per caller: 6 a minute, then 429 with Retry-After', async () => {
        let clock = Date.UTC(2026, 9, 8, 9, 0, 15);
        const tl = await boot({ callerLimits: true, limitsNow: () => clock });
        const rosa = tl.network.addUser('rosa');
        const sam2 = tl.network.addUser('sam2');
        try {
            for (let i = 0; i < 6; i++) {
                const r = await tl.get('/api/v1/tickets', { as: rosa, json: { subject: `One ${i}`, message: 'body' }, headers: SAME });
                assert.strictEqual(r.status, 201, `request ${i + 1}: ${r.text.slice(0, 120)}`);
            }
            const over = await tl.get('/api/v1/tickets', { as: rosa, json: { subject: 'Seven', message: 'body' }, headers: SAME });
            assert.strictEqual(over.status, 429);
            assert.strictEqual(over.json().code, 'rate_limited');
            assert.ok(Number(over.headers.get('retry-after')) > 0, 'no Retry-After');
            assert.ok(over.json().detail.includes('help.ticket.create'), over.json().detail);
            assert.strictEqual((await tl.get('/api/v1/tickets', { as: sam2, json: { subject: 'Mine', message: 'body' }, headers: SAME })).status, 201, 'another person still opens one');
            // The page form is the same action through another door: it shares the counter and answers HTML.
            const form = await tl.get('/tickets', { as: rosa, form: { subject: 'From the form', message: 'body' }, headers: SAME });
            assert.strictEqual(form.status, 429, 'the form is a way round the limit');
            assert.match(form.headers.get('content-type'), /^text\/html/);
            assert.ok(form.text.includes('Too many requests'), 'the form got JSON instead of a page');
            clock += 60_000;
            assert.strictEqual((await tl.get('/api/v1/tickets', { as: rosa, json: { subject: 'Next minute', message: 'body' }, headers: SAME })).status, 201);
        } finally { await tl.close(); }
    });

    await t.close();
    done();
})().catch((err) => { console.error(err); process.exit(1); });
