'use strict';
/**
 * ADR-033: Help's part of an account export (the tickets a person opened and their messages) and of an account
 * deletion, applied through the service's own /internal/events route with a stand-in Network. Real rows are made
 * through the service's ticket store (server/tickets/store.js), the signed delivery is answered by
 * openvibe-sdk/account-data, and the part only ever carries person A's rows. On deletion the person's own ticket
 * (and every message under it, by the ON DELETE CASCADE) goes, their staff reply in someone else's ticket keeps its
 * body and is anonymized, a redelivery erases nothing twice, and the route refuses a bad signature and a forwarded
 * request.
 */
const assert = require('assert');
const http = require('http');
const { boot, check, done } = require('./helpers/boot');
const { createNetworkSender } = require('openvibe-sdk/account-data');
const { signDeliveryHeaders } = require('openvibe-sdk/events');
const helpStore = require('../server/tickets/store');

const A = 'usr_01JZ0000000000000000000AAA';
const B = 'usr_01JZ0000000000000000000BBB';
const OLD = 'usr_01JZ0000000000000000000MRG';
const EXP = 'exp_01JZ0000000000000000000EXP';
const DEL = 'del_01JZ0000000000000000000DEX';
// Fixture secrets, built so they never look like a real key to a scanner.
const SECRET = `whsec_${'fixture'.repeat(6)}`;
const WRONG = `whsec_${'mismatch'.repeat(5)}`;

const exportEvent = { event_id: 'evt_01JZ0000000000000000000E01', event_type: 'network.account.export_requested', source: 'network', payload: { export_id: EXP, subject: A } };
const deleteEvent = { event_id: 'evt_01JZ0000000000000000000D01', event_type: 'network.account.deleted', source: 'network', payload: { deletion_id: DEL, subject: A, aliases: [OLD] } };
const bodyOf = (ev) => JSON.stringify({ event: ev, seq: 1 });

/** A stand-in for Network's internal routes: the token endpoint, the export part and the deletion confirmation. */
async function startNetworkStub({ partStatus = 201, confirmStatus = 201 } = {}) {
    const calls = [];
    const statusOf = (v) => (typeof v === 'function' ? v() : v);
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            const raw = Buffer.concat(chunks);
            const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
            if (req.url === '/oauth/token') return json(200, { access_token: 'tok_help', token_type: 'Bearer', expires_in: 300, scope: 'openvibe.network' });
            calls.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw.toString() || 'null') });
            return json(req.url.includes('/parts') ? statusOf(partStatus) : statusOf(confirmStatus), {});
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${server.address().port}`, calls, close: () => new Promise((r) => server.close(r)) };
}

/**
 * Make the rows through the store the API writes with (server/tickets/store.js): A opens a ticket, B opens one,
 * A is staff and replies in B's ticket, and B replies in A's ticket. Returns both ticket ids.
 */
async function makeRows(t) {
    const s = t.ctx.s;
    const aTicket = await helpStore.create(s, { requester: `user:${A}`, site: '', subject: 'a', body: 'a needs help' });
    const bTicket = await helpStore.create(s, { requester: `user:${B}`, site: '', subject: 'b', body: 'b needs help' });
    await helpStore.addMessage(s, bTicket.id, { author: `user:${A}`, role: 'staff', body: 'ask again' });
    await helpStore.addMessage(s, aTicket.id, { author: `user:${B}`, role: 'person', body: 'b replies here' });
    return { aTicket, bTicket };
}

(async () => {
    await check('an export part carries only the person\'s tickets and messages, and no secret', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'help', clientSecret: 'help-secret' });
        const t = await boot({ env: { HELP_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            await makeRows(t);

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'exported');

            const part = stub.calls.find((c) => c.url === `/internal/account-exports/${EXP}/parts`);
            assert.ok(part, 'the part was pushed to Network');
            assert.strictEqual(part.auth, 'Bearer tok_help', 'with this service\'s own token');
            assert.strictEqual(part.body.subject, A);
            assert.deepStrictEqual(part.body.files.map((f) => f.name).sort(), ['messages.json', 'tickets.json']);
            const tickets = part.body.files.find((f) => f.name === 'tickets.json').content;
            assert.strictEqual(tickets.length, 1, 'only the person\'s own ticket');
            assert.strictEqual(tickets[0].subject, 'a');
            assert.strictEqual(tickets[0].requester, `user:${A}`);
            // A's messages: the opening message of their own ticket AND their staff reply in B's ticket.
            const messages = part.body.files.find((f) => f.name === 'messages.json').content;
            assert.deepStrictEqual(messages.map((m) => m.body).sort(), ['a needs help', 'ask again']);
            assert.ok(!JSON.stringify(part.body).includes('b needs help'), 'nobody else\'s ticket');
            assert.ok(!JSON.stringify(part.body).includes('b replies here'), 'nobody else\'s message');
            assert.ok(!/token|secret|password/i.test(JSON.stringify(part.body)), 'no secret is exported');
        } finally { await t.close(); await stub.close(); }
    });

    await check('a deletion erases the person\'s own ticket (its messages cascade), anonymizes their staff reply elsewhere, and confirms with counts', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'help', clientSecret: 'help-secret' });
        const t = await boot({ env: { HELP_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const { aTicket, bTicket } = await makeRows(t);
            const s = t.ctx.s;
            const ticketsForA = () => s.db.value('SELECT count(*)::int FROM help_tickets WHERE requester = $1', [`user:${A}`]);

            const res = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.json().outcome, 'erased');
            assert.strictEqual(await ticketsForA(), 0, 'the person\'s own ticket is gone');
            assert.strictEqual((await helpStore.messages(s, aTicket.id)).length, 0, 'every message under it cascaded away, from either side');
            assert.ok(await helpStore.get(s, bTicket.id), 'someone else\'s ticket stays');

            // Their staff reply in B's ticket is anonymized (author NULL) and keeps its body, so B still reads it.
            const reply = await s.db.maybe("SELECT author, body FROM help_messages WHERE ticket_id = $1 AND body = 'ask again'", [bTicket.id]);
            assert.deepStrictEqual(reply, { author: null, body: 'ask again' }, 'the staff reply is anonymized, not deleted');
            const conversation = await helpStore.messages(s, bTicket.id);
            assert.strictEqual(conversation.length, 2, 'B\'s ticket is still readable');
            assert.ok(conversation.some((m) => m.body === 'ask again'), 'B can still read the reply');

            const confirmation = stub.calls.find((c) => c.url === `/internal/account-deletions/${DEL}/confirmations`);
            assert.ok(confirmation, 'the confirmation was sent');
            // The person's own ticket is erased; its messages went with it by the ON DELETE CASCADE, so they are not
            // counted separately. The staff reply that survived in someone else's ticket is a tombstone.
            assert.deepStrictEqual(confirmation.body.erased, { help_tickets: 1 });
            assert.deepStrictEqual(confirmation.body.retained, { tombstones: 1 });
            assert.ok(!Number.isNaN(Date.parse(confirmation.body.completed_at)));

            // A redelivery must not erase again: a ticket A opens after the deletion stays.
            await helpStore.create(s, { requester: `user:${A}`, site: '', subject: 'written-later', body: 'later' });
            const again = await t.get('/internal/events', { method: 'POST', body: bodyOf(deleteEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(deleteEvent), SECRET) } });
            assert.strictEqual(again.status, 200);
            assert.strictEqual(again.json().outcome, 'unchanged');
            assert.strictEqual(await ticketsForA(), 1, 'nothing was erased twice');
        } finally { await t.close(); await stub.close(); }
    });

    await check('the internal route refuses a bad signature (401) and a forwarded request (403)', async () => {
        const stub = await startNetworkStub();
        const sender = createNetworkSender({ networkInternalUrl: stub.url, clientId: 'help', clientSecret: 'help-secret' });
        const t = await boot({ env: { HELP_EVENTS_SECRET: SECRET }, accountSend: sender });
        try {
            const bad = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', ...signDeliveryHeaders(bodyOf(exportEvent), WRONG) } });
            assert.strictEqual(bad.status, 401);

            const forwarded = await t.get('/internal/events', { method: 'POST', body: bodyOf(exportEvent), headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '203.0.113.9', ...signDeliveryHeaders(bodyOf(exportEvent), SECRET) } });
            assert.strictEqual(forwarded.status, 403);
        } finally { await t.close(); await stub.close(); }
    });

    done();
})();
