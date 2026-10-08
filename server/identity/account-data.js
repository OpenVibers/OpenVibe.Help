'use strict';

/**
 * Account export and deletion → Help (ADR-033; openvibe-sdk/account-data). Help holds two things a person wrote:
 * a support ticket they opened and every message in the conversations they took part in. Both key the subject the
 * same way — `user:usr_…` (server/http/principal.js builds the requester that way, server/tickets/store.js writes
 * it into help_tickets.requester and help_messages.author).
 *
 *   network.account.export_requested  the person's tickets (tickets.json) and messages (messages.json), newest first,
 *                                     pushed to Network (POST /internal/account-exports/:id/parts) with this
 *                                     service's own token.
 *   network.account.deleted           the person's own tickets go (with every message under them), their replies in
 *                                     other people's tickets are anonymized, and Help confirms with counts.
 *
 * The order matters. help_messages.ticket_id REFERENCES help_tickets(id) ON DELETE CASCADE, so help_tickets is erased
 * FIRST: deleting the person's own tickets takes every message under them with it, from either side. What is left
 * authored by this person is then only their replies in OTHER people's tickets (a staff reply). Those keep their body
 * — the ticket's owner still has to read their own conversation — but the author is anonymized to NULL (an empty
 * `{ anonymize: {} }` sets the subject column NULL and changes nothing else). Nothing here is a secret: no token, key
 * or credential is stored, so every column of both tables may be exported.
 */
const { createAccountData, TOPICS } = require('openvibe-sdk/account-data');

/**
 * The tables that hold a person's rows, with the value the subject column really stores. Both store `user:usr_…`
 * (server/tickets/store.js takes the author straight from the principal's requester).
 *
 * help_tickets comes before help_messages on purpose (the ON DELETE CASCADE on help_messages.ticket_id): the person's
 * own tickets — and every message under them — are deleted first, and only the surviving staff replies they wrote in
 * someone else's ticket are anonymized.
 */
const TABLES = [
    { table: 'help_tickets', subject: 'requester', value: (usr) => `user:${usr}`, file: 'tickets.json', erase: 'delete' },
    { table: 'help_messages', subject: 'author', value: (usr) => `user:${usr}`, file: 'messages.json', erase: { anonymize: {} } },
];

/** The account-data handle for Help's store (server/db.js createStore). */
function create({ db, note = 'A page URL in a ticket is stored as text and never fetched.', log = console } = {}) {
    return createAccountData({ db, service: 'help', tables: TABLES, note, log });
}

module.exports = { create, TABLES, TOPICS };
