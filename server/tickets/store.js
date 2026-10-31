'use strict';

/**
 * Tickets and their conversation in OpenVibe.Help's own database (migrations/0002_tickets.sql). Every function
 * takes the store (server/db.js createStore) first, so the clock and the id generator are the store's.
 *
 * A ticket is one conversation: it is created with its first message, and every later message is a reply.
 * `updated_at` moves on a reply, so a list can be read as "what is waiting on us".
 */

const { DEFAULT_STATE } = require('./tickets');

const LIMIT_MAX = 100;
const clampLimit = (n, def = 20) => Math.min(LIMIT_MAX, Math.max(1, Number.parseInt(n, 10) || def));

const COLS = 'id, requester, site, subject, state, page_url, created_at, updated_at';

/** Create a ticket and its first message in one transaction: a ticket is never empty. */
async function create(s, { requester, site, subject, pageUrl, body, role = 'person' }) {
    return s.tx(async () => {
        const at = s.iso();
        const id = s.newId('tkt');
        await s.db.query(
            `INSERT INTO help_tickets (id, requester, site, subject, state, page_url, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
            [id, requester, site || '', subject, DEFAULT_STATE, pageUrl || null, at]);
        await s.db.query(
            'INSERT INTO help_messages (id, ticket_id, author, role, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [s.newId('msg'), id, requester, role, body, at]);
        return get(s, id);
    });
}

const get = (s, id) => s.db.maybe(`SELECT ${COLS} FROM help_tickets WHERE id = $1`, [String(id)]);

/** One page of one person's tickets, newest first. */
async function listForRequester(s, requester, { limit = 20, before = null } = {}) {
    const n = clampLimit(limit);
    const rows = before
        ? await s.db.many(`SELECT ${COLS}, (SELECT count(*) FROM help_messages m WHERE m.ticket_id = help_tickets.id) AS message_count FROM help_tickets WHERE requester = $1 AND id < $2 ORDER BY id DESC LIMIT $3`, [requester, before, n + 1])
        : await s.db.many(`SELECT ${COLS}, (SELECT count(*) FROM help_messages m WHERE m.ticket_id = help_tickets.id) AS message_count FROM help_tickets WHERE requester = $1 ORDER BY id DESC LIMIT $2`, [requester, n + 1]);
    const page = rows.slice(0, n);
    return { rows: page, next: rows.length > n ? page[page.length - 1].id : null };
}

/** Staff: every ticket, optionally one site and/or one state, newest first (state 'all' means no filter). */
async function listForStaff(s, { site = null, state = null, limit = 20, before = null } = {}) {
    const n = clampLimit(limit);
    const where = [];
    const args = [];
    if (site) { args.push(site); where.push(`site = $${args.length}`); }
    if (state && state !== 'all') { args.push(state); where.push(`state = $${args.length}`); }
    if (before) { args.push(before); where.push(`id < $${args.length}`); }
    const rows = await s.db.many(
        `SELECT ${COLS}, (SELECT count(*) FROM help_messages m WHERE m.ticket_id = help_tickets.id) AS message_count
         FROM help_tickets ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${args.length + 1}`,
        [...args, n + 1]);
    const page = rows.slice(0, n);
    return { rows: page, next: rows.length > n ? page[page.length - 1].id : null };
}

/** What staff are looking at: how many tickets are open, waiting or solved per state (and in total). */
async function staffCounts(s) {
    const rows = await s.db.many('SELECT state, count(*) AS n FROM help_tickets GROUP BY state');
    const out = { open: 0, waiting: 0, solved: 0, all: 0 };
    for (const r of rows) { out[r.state] = Number(r.n); out.all += Number(r.n); }
    return out;
}

/**
 * How long a first staff reply has actually taken: the median over the most recent answered tickets, from this
 * service's own help_messages rows. It is a measurement, not a promise: when no ticket has had a staff reply yet
 * there is no number, and the page says that instead of guessing. A ticket's first person message is its
 * creation, so the clock starts there.
 */
async function replyStats(s, { sample = 200 } = {}) {
    const n = Math.min(500, Math.max(1, Number.parseInt(sample, 10) || 200));
    // The latest answered tickets, not the latest tickets: an old reply still counts even if the queue's newest
    // tickets are unanswered, so "not measured" can only mean no ticket ever had a staff reply.
    const rows = await s.db.many(
        `SELECT (EXTRACT(EPOCH FROM (r.replied_at::timestamptz - a.asked_at::timestamptz)) * 1000) AS ms
         FROM (SELECT ticket_id, MIN(created_at) AS asked_at
               FROM help_messages WHERE role = 'person' GROUP BY ticket_id) a
         JOIN (SELECT ticket_id, MIN(created_at) AS replied_at
               FROM help_messages WHERE role = 'staff' GROUP BY ticket_id) r
           ON r.ticket_id = a.ticket_id
         WHERE r.replied_at >= a.asked_at
         ORDER BY a.asked_at DESC LIMIT $1`, [n]);
    const durations = rows.map((row) => Number(row.ms)).filter((ms) => Number.isFinite(ms) && ms >= 0);
    if (!durations.length) return { answered: 0, medianMs: null };
    durations.sort((a, b) => a - b);
    const mid = Math.floor(durations.length / 2);
    const medianMs = durations.length % 2 ? durations[mid] : Math.round((durations[mid - 1] + durations[mid]) / 2);
    return { answered: durations.length, medianMs };
}

const messages = (s, ticketId) => s.db.many('SELECT id, author, role, body, created_at FROM help_messages WHERE ticket_id = $1 ORDER BY id', [String(ticketId)]);

/** Append a reply and move updated_at. `role` is person or staff, decided by the caller's session. */
async function addMessage(s, ticketId, { author, role, body }) {
    return s.tx(async () => {
        const at = s.iso();
        await s.db.query(
            'INSERT INTO help_messages (id, ticket_id, author, role, body, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
            [s.newId('msg'), ticketId, author, role, body, at]);
        await s.db.query('UPDATE help_tickets SET updated_at = $2 WHERE id = $1', [ticketId, at]);
        return get(s, ticketId);
    });
}

/** Staff set the state (open | waiting | solved). Returns the ticket, or null when it is gone. */
async function setState(s, ticketId, state) {
    const at = s.iso();
    await s.db.query('UPDATE help_tickets SET state = $2, updated_at = $3 WHERE id = $1', [ticketId, state, at]);
    return get(s, ticketId);
}

module.exports = { create, get, listForRequester, listForStaff, staffCounts, replyStats, messages, addMessage, setState };
