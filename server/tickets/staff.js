'use strict';

/**
 * Who is staff at OpenVibe.Help: the Network role claim on the person's session (server/auth/sso.js
 * viewerFromClaims puts `role` on req.viewer, and http/principal.js puts it on req.principal). The roles are
 * OpenVibe.Network's (manifests/policy/staff-roles.json): `global_mod` and `admin` may read the support queue.
 *
 * When the Network issues the staff capability claims it already defines (`staff.console.access` covers the staff
 * console for both roles), this is where `contracts.staff.can(claims, …)` replaces the role comparison — one place
 * decides staff, so the pages and the API cannot drift apart.
 */
const STAFF_ROLES = ['admin', 'global_mod'];

const roleOf = (who) => (typeof who === 'string' ? who : (who && typeof who.role === 'string' ? who.role : null));

/** Is this viewer/principal a member of staff? Anonymous, an app token and an unlisted role are not. */
function isStaff(who) {
    if (who && typeof who === 'object' && who.kind && who.kind !== 'user') return false;
    return STAFF_ROLES.includes(roleOf(who));
}

module.exports = { isStaff, STAFF_ROLES };
