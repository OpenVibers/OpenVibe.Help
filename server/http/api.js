'use strict';

/**
 * /api/v1 — OpenVibe.Help's API.
 *
 *   GET  /sites                    public   every OpenVibe site the catalog knows, with its state
 *   GET  /sites/:id                public   one site: its pillars, its FAQ (as articles), where it lives
 *   GET  /articles?q=              public   the generated articles; ?q= ranks them
 *   POST /tickets                  person   open a ticket (its first message is the description)
 *   GET  /tickets                  person   your tickets, newest first
 *   GET  /tickets/:id              person   one ticket with its conversation (staff may read any)
 *   POST /tickets/:id/messages     person   reply (staff reply on any ticket, as staff)
 *   GET  /staff/tickets            staff    the queue, filtered by site and state
 *   POST /tickets/:id/state        staff    set open | waiting | solved
 *
 * A ticket belongs to the person who opened it: anyone else gets 404 — the same as a ticket that does not exist —
 * unless they are staff by their Network role claim. Writes made with the session cookie must come from
 * openvibe.help itself (same-origin), so another site cannot make a signed-in person open or answer a ticket.
 *
 * No route names a capability: openvibe-contracts declares none for help.* yet, and every route here is a person
 * acting for themself (see CAPABILITIES in ./principal.js).
 */
const express = require('express');
const contracts = require('openvibe-contracts');
const { asyncRouter } = require('./router');
const { sameOrigin } = require('./principal');
const tickets = require('../tickets/tickets');
const store = require('../tickets/store');
const { isStaff } = require('../tickets/staff');
const { searchArticles } = require('../search');

function createApi(ctx) {
    const { config, s, catalog, principal, limits } = ctx;
    const r = asyncRouter();
    const problem = (req, res, status, code, detail) => contracts.http.sendProblem(res, status, code, { detail, ctx: req.ov });

    r.use(express.json({ limit: '64kb' }));
    r.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
    r.use(principal.middleware);

    // Liveness: public, and counted per caller with the default read numbers.
    r.get('/ping', limits.reads('help.api.read'), (_req, res) => res.json({ ok: true, service: config.service }));

    // ── The catalog (public) ────────────────────────────────
    const siteWire = (site) => {
        const articles = catalog.bySite.get(site.id) || [];
        return {
            id: site.id,
            name: site.name,
            tagline: site.tagline,
            what: site.oneLine,
            description: site.description,
            state: site.state,
            url: site.url,
            updates_url: site.updatesUrl,
            pillars: site.pillars.map((p) => ({ title: p.title, text: p.text })),
            faq: articles.map((a) => ({ question: a.question, answer: a.answer, url: a.path, anchor: a.anchor })),
            article_count: articles.length,
            source: { name: site.provenance.source, url: site.provenance.url, manifests: site.provenance.manifests },
        };
    };

    r.get('/sites', limits.reads('help.site.read'), (_req, res) => res.json({
        generated_at: catalog.generatedAt,
        source: { name: catalog.source.name, url: catalog.source.url },
        count: catalog.sites.length,
        sites: catalog.sites.map(siteWire),
    }));

    r.get('/sites/:id', limits.reads('help.site.read'), (req, res) => {
        const site = catalog.get(req.params.id);
        if (!site) return problem(req, res, 404, 'help.site.not_found', `No site "${String(req.params.id).slice(0, 80)}" in the catalog; GET /api/v1/sites lists them.`);
        res.json(siteWire(site));
    });

    // ── The articles ────────────────────────────────────────
    r.get('/articles', limits.reads('help.article.read'), (req, res) => {
        const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
        const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
        if (!q) {
            const all = catalog.articles.slice(0, limit);
            return res.json({ query: '', count: all.length, articles: all.map((a) => ({ question: a.question, answer: a.answer, site: a.site, site_name: a.siteName, url: a.path })) });
        }
        const hits = searchArticles(catalog, q, { limit });
        return res.json({
            query: q,
            count: hits.length,
            articles: hits.map((h) => ({ question: h.article.question, answer: h.article.answer, snippet: h.snippet, score: h.score, site: h.article.site, site_name: h.article.siteName, url: h.article.path })),
            note: 'Ranked by a fixed score over the question, the answer and the site\'s own text; see the source field of each article.',
        });
    });

    // ── Who may act ─────────────────────────────────────────
    /**
     * A person, signed in. An app or service token is refused: a ticket is somebody's private conversation with
     * support, and no app acts for a person here. A session write must come from this site.
     */
    function requirePerson(req, res) {
        const p = req.principal;
        if (p.kind === 'anonymous') {
            problem(req, res, 401, 'token.required', 'Sign in at openvibe.help, or send a person\'s Network token as a Bearer.');
            return false;
        }
        if (p.kind !== 'user') {
            problem(req, res, 403, 'help.person_required', 'A ticket belongs to a person; an app, agent or service token cannot open or answer one.');
            return false;
        }
        if (p.viaSession && req.method !== 'GET' && !sameOrigin(req, config.baseUrl)) {
            problem(req, res, 403, 'request.cross_site', 'A signed-in request that changes something must come from openvibe.help itself.');
            return false;
        }
        return true;
    }
    function requireStaff(req, res) {
        if (!requirePerson(req, res)) return false;
        if (!isStaff(req.principal)) {
            problem(req, res, 403, 'staff.forbidden', 'The support queue is for OpenVibe staff (a Network role of admin or global_mod).');
            return false;
        }
        return true;
    }
    const person = (req, res, next) => (requirePerson(req, res) ? next() : undefined);
    const staff = (req, res, next) => (requireStaff(req, res) ? next() : undefined);

    // ── Tickets ─────────────────────────────────────────────
    const sites = new Set(catalog.sites.map((x) => x.id));
    const page = (query, def = 20) => ({
        limit: Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || def)),
        before: typeof query.before === 'string' && tickets.isTicketId(query.before) ? query.before : null,
    });

    /** One ticket, only for the person it belongs to (staff may read any) — otherwise 404, as if it did not exist. */
    async function load(req, res) {
        const id = String(req.params.id || '');
        const row = tickets.isTicketId(id) ? await store.get(s, id) : null;
        const mine = row && row.requester === req.principal.requester;
        if (!row || (!mine && !isStaff(req.principal))) {
            problem(req, res, 404, 'ticket.not_found', 'No such ticket.');
            return null;
        }
        return row;
    }

    r.post('/tickets', person, limits.budget('help.ticket.create'), async (req, res) => {
        const b = req.body || {};
        const check = tickets.validateNew({ site: b.site, subject: b.subject, message: b.message, pageUrl: b.page_url }, { sites });
        if (!check.ok) return problem(req, res, 422, check.code, check.detail);
        const row = await store.create(s, {
            requester: req.principal.requester,
            site: check.fields.site, subject: check.fields.subject,
            // Text only: this service never fetches a URL a caller sent.
            pageUrl: check.fields.pageUrl, body: check.fields.message,
        });
        res.set('Location', `/api/v1/tickets/${row.id}`);
        return res.status(201).json(tickets.toWire(row));
    });

    r.get('/tickets', person, limits.reads('help.ticket.list'), async (req, res) => {
        const pageOpts = page(req.query);
        const out = await store.listForRequester(s, req.principal.requester, pageOpts);
        res.json({ tickets: out.rows.map((row) => tickets.toWire(row)), next: out.next });
    });

    r.get('/tickets/:id', person, limits.reads('help.ticket.read'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        const messages = (await store.messages(s, row.id)).map(tickets.toWireMessage);
        return res.json(tickets.toWire(row, { messages }));
    });

    r.post('/tickets/:id/messages', person, limits.budget('help.ticket.message'), async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        const check = tickets.validateMessage(req.body || {});
        if (!check.ok) return problem(req, res, 422, check.code, check.detail);
        const staffWriter = isStaff(req.principal);
        const after = await store.addMessage(s, row.id, { author: req.principal.requester, role: staffWriter ? 'staff' : 'person', body: check.fields.body });
        res.set('Location', `/api/v1/tickets/${row.id}`);
        return res.status(201).json(tickets.toWire(after, { messages: (await store.messages(s, row.id)).map(tickets.toWireMessage) }));
    });

    // ── Staff ───────────────────────────────────────────────
    r.get('/staff/tickets', staff, limits.reads('help.ticket.staff'), async (req, res) => {
        const state = typeof req.query.state === 'string' && (tickets.isState(req.query.state) || req.query.state === 'all') ? req.query.state : tickets.DEFAULT_STATE;
        const site = typeof req.query.site === 'string' && sites.has(req.query.site) ? req.query.site : null;
        const out = await store.listForStaff(s, { site, state, ...page(req.query, 50) });
        res.json({ filter: { site, state }, counts: await store.staffCounts(s), tickets: out.rows.map((row) => tickets.toWire(row)), next: out.next });
    });

    r.post('/tickets/:id/state', staff, async (req, res) => {
        const row = await load(req, res);
        if (!row) return undefined;
        const state = (req.body || {}).state;
        if (!tickets.isState(state)) return problem(req, res, 422, 'ticket.invalid', `state: one of ${tickets.STATES.join(', ')}`);
        const after = await store.setState(s, row.id, state);
        return res.json(tickets.toWire(after));
    });

    return r;
}

module.exports = { createApi };
