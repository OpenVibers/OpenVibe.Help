'use strict';
// What openvibe.help tells an agent about itself (openvibe-shared/agent-layer): /.well-known/agent.json.
// Every field is something this host really serves: the public help centre (one page per site, its questions as
// articles, search and the update log), the JSON API under /api/v1, llms.txt and the sitemap. Support tickets are a
// person's own and are never public. No OpenAPI document or MCP endpoint is published here, so none is named.
module.exports = {
    id: 'help',
    name: 'OpenVibe.Help',
    purpose: 'The help and support centre for every OpenVibe site: the answers each site gives about itself, quoted from its manifest, search over those and over the network index, and a support ticket that stays one conversation.',
    home: 'https://openvibe.help',
    site: 'openvibe.help',
    api: '/api/v1',
    policy: {
        auth: ['none', 'Network OIDC'],
        rateLimit: 'Pages and /api/v1 are limited per address to 300 and 240 requests a minute; opening a ticket and answering one are limited per caller',
    },
};
