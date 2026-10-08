'use strict';

/**
 * Per-caller rate limits at OpenVibe.Help's API (openvibe-sdk/limits). The per-address limits in app.js stay; these
 * count requests by who makes them:
 *
 *   a person               user:usr_… (a Bearer token or this site's session)
 *   an app, agent, service app:app_… / agent:agt_… / service:<slug>
 *   anyone else            ip:<address>
 *
 * Past a limit the route answers 429 problem+json `rate_limited` with Retry-After before it does any work; the
 * refusal is logged once and counted in help_rate_limited_total{limit,window}. Reads take HELP_LIMITS_MINUTE /
 * HELP_LIMITS_HOUR (120 and 3000); the product's expensive routes get their own numbers in BUDGETS below.
 * Counters live in this process unless VALKEY_URL is set.
 *
 * Never limited here: /api/health, /api/ready, /release.json, /metrics, sign-in and the pages.
 */
const { createActorLimiter, createValkeyLimitStore } = require('openvibe-sdk/limits');

function caller(req) {
    const p = req.principal;
    if (p && p.requester) return p.requester;
    const v = req.viewer;
    if (v && v.kind === 'user' && v.subject) return `user:${v.subject}`;
    return `ip:${req.ip || (req.socket && req.socket.remoteAddress) || 'unknown'}`;
}

/**
 * The product's writes, each with its numbers per caller (a minute, an hour). A route takes its entry with
 * `limits.budget('<name>')`; an unknown name throws, so a route can never be counted by a budget that was not
 * declared here.
 *
 *   help.ticket.create    a ticket is an email to a person: a handful an hour is plenty, and the first one is
 *                         the one that matters
 *   help.ticket.message   replies are cheap but a conversation can be long, so this is the looser number
 *
 * Staff use the same routes (their role, not a different budget, is what they get); a support queue run by a
 * handful of people should never be throttled into silence, which is why the numbers are per caller, not global.
 */
const BUDGETS = {
    'help.ticket.create': { minute: 6, hour: 60 },
    'help.ticket.message': { minute: 30, hour: 300 },
};

function createCallerLimits({ config, now = () => Date.now(), registry = null, log = console, enabled = true, valkey = null }) {
    const refused = registry
        ? registry.counter({ name: 'help_rate_limited_total', help: 'Requests refused 429 by a per-caller limit, by limit name and window', labelNames: ['limit', 'window'] })
        : null;
    const limiter = createActorLimiter({
        limits: { minute: config.limits.minute, hour: config.limits.hour },
        actor: enabled ? caller : () => null,
        now,
        ...(valkey ? { store: createValkeyLimitStore(valkey) } : {}),
        onLimited(e) {
            // The caller is a subject, a principal or an address, never a token.
            log.warn(`[Limits] ${e.name}: ${e.actor} refused, over ${e.limit} per ${e.window}`);
            if (refused) refused.inc({ limit: e.name, window: e.window });
        },
    });
    limiter.reads = (name) => {
        const limit = limiter(name);
        return (req, res, next) => (req.method === 'GET' || req.method === 'HEAD' ? limit(req, res, next) : next());
    };
    const budgets = new Map(Object.entries(BUDGETS).map(([name, own]) => [name, limiter(name, own)]));
    limiter.budget = (name) => {
        const m = budgets.get(name);
        if (!m) throw new Error(`limits: no budget named ${name}`);
        return m;
    };
    return limiter;
}

module.exports = { createCallerLimits, caller, BUDGETS };
