'use strict';

/**
 * What a ticket is, on both sides of the wire — the rules shared by the pages (http/pages.js) and the API
 * (http/api.js), so a form and a POST cannot disagree:
 *
 *   id         tkt_<ULID>   (msg_<ULID> for a message)
 *   state      open | waiting | solved
 *   role       person | staff   — which side of the conversation wrote a message
 *   body       plain text, at most 10 000 characters, shown escaped with its line breaks
 *
 * A page URL a person pastes is kept as text only: this service never fetches it (a caller's URL must never
 * decide what this service requests). It is shown as a link only when it parses as http(s).
 */

const STATES = ['open', 'waiting', 'solved'];
const DEFAULT_STATE = 'open';

const LIMITS = { subject: 160, body: 10000, pageUrl: 500, site: 120 };

const TICKET_ID = /^tkt_[0-9A-HJKMNP-TV-Z]{26}$/;

const isTicketId = (id) => TICKET_ID.test(String(id || ''));

/** Plain text as it will be stored: CRLF normalised, no control characters (keeping tab and newline), trimmed. */
function cleanText(value, max) {
    const s = String(value == null ? '' : value)
        .replace(/\r\n?/g, '\n')
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
        .trim();
    return max != null ? s.slice(0, max) : s;
}

/**
 * Check a new ticket. Answers { ok, fields } or { ok: false, code, detail } — one shape for the form (which
 * re-renders with the message) and the API (which sends it as problem+json).
 */
function validateNew({ site, subject, message, pageUrl }, { sites = null } = {}) {
    const fields = {
        site: cleanText(site, LIMITS.site),
        subject: cleanText(subject, LIMITS.subject + 1),
        message: cleanText(message, LIMITS.body + 1),
        pageUrl: cleanText(pageUrl, LIMITS.pageUrl + 1),
    };
    if (fields.subject.length > LIMITS.subject) return { ok: false, code: 'ticket.invalid', detail: `subject: at most ${LIMITS.subject} characters` };
    if (!fields.subject) return { ok: false, code: 'ticket.invalid', detail: 'subject: what is this about? (1 to 160 characters)' };
    if (fields.message.length > LIMITS.body) return { ok: false, code: 'ticket.invalid', detail: `message: at most ${LIMITS.body} characters` };
    if (!fields.message) return { ok: false, code: 'ticket.invalid', detail: 'message: tell us what happened (1 to 10000 characters)' };
    if (fields.pageUrl.length > LIMITS.pageUrl) return { ok: false, code: 'ticket.invalid', detail: `page_url: at most ${LIMITS.pageUrl} characters` };
    if (sites && fields.site && !sites.has(fields.site)) return { ok: false, code: 'ticket.invalid', detail: 'site: pick one of the OpenVibe sites, or leave it empty' };
    fields.pageUrl = fields.pageUrl || null;
    return { ok: true, fields };
}

/** Check a reply. `role` is decided by the server (staff or person), never by the caller. */
function validateMessage({ message }) {
    const body = cleanText(message, LIMITS.body + 1);
    if (body.length > LIMITS.body) return { ok: false, code: 'ticket.invalid', detail: `message: at most ${LIMITS.body} characters` };
    if (!body) return { ok: false, code: 'ticket.invalid', detail: 'message: write something first (1 to 10000 characters)' };
    return { ok: true, fields: { body } };
}

const isState = (s) => STATES.includes(String(s || ''));

/** This service's own view of the page URL: a link only when it is an absolute http(s) URL (never javascript:). */
function pageLink(pageUrl) {
    try {
        const u = new URL(String(pageUrl));
        return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
    } catch { return null; }
}

const subjectRef = (requester) => {
    const i = String(requester).indexOf(':');
    return { type: requester.slice(0, i), id: requester.slice(i + 1) };
};

/** A ticket row → the JSON the API answers with. Messages are only included when they were asked for. */
function toWire(row, { messages = null } = {}) {
    if (!row) return null;
    const ticket = {
        id: row.id,
        requester: subjectRef(row.requester),
        site: row.site || null,
        subject: row.subject,
        state: row.state,
        page_url: row.page_url || null,
        created_at: row.created_at,
        updated_at: row.updated_at,
    };
    if (row.message_count != null) ticket.message_count = Number(row.message_count);
    if (messages) ticket.messages = messages;
    return ticket;
}

const toWireMessage = (row) => ({
    id: row.id,
    author: subjectRef(row.author),
    role: row.role,
    body: row.body,
    created_at: row.created_at,
});

module.exports = { STATES, DEFAULT_STATE, LIMITS, isTicketId, cleanText, validateNew, validateMessage, isState, pageLink, toWire, toWireMessage };
