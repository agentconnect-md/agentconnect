/**
 * `http/visibility.ts` — per-resource visibility predicates
 * (docs/designs/resource-visibility.md).
 *
 * Fastify-free PURE functions so they unit-test like `orchestrator/fencing.ts`
 * (colocated `visibility.test.ts`, `test:unit`, zero I/O). This module is the
 * SINGLE policy source: the route guards use `canView`/`canEdit` here and the repo
 * WHERE builders use `visibilityWhere` (defined next to the records in
 * `persistence/ports.ts`, re-exported below), so the SQL filter and the in-app
 * checks can never diverge.
 *
 * Access DERIVES FROM THE ORG ROLE — sharing controls only WHO can SEE a resource;
 * whether they may edit follows their existing role (viewer read-only,
 * collaborator/owner edit). Owners have a governance override (see + edit
 * everything). `canManageSharing` is relaxed to `=== canEdit` (decision §13.3):
 * anyone who can edit a resource can also change who it is shared with.
 */
import type { SessionVisibility, Shareable, ViewCtx } from '../persistence/ports.js'

// Re-export the shared visibility primitives so route code has a single import
// site (`http/visibility.js`) while the repo layer imports them from `ports.js`.
export { visibilityWhere } from '../persistence/ports.js'
export type { Shareable, ViewCtx } from '../persistence/ports.js'

/** Can this caller SEE the resource? Any one arm suffices. */
export function canView(r: Shareable, c: ViewCtx): boolean {
  return (
    c.role === 'owner' || // governance override — owners see everything
    r.createdByUserId === c.userId || // creator forever
    r.visibility === 'org' || // default: visible to all org members
    r.sharedWith.includes(c.userId) // explicitly shared
  )
}

/** Can this caller EDIT the resource's content? Viewer never (preserves the
 *  `denyViewerWrite` invariant); owner always; collaborator iff they can see it. */
export function canEdit(r: Shareable, c: ViewCtx): boolean {
  if (c.role === 'viewer') return false
  return c.role === 'owner' || canView(r, c)
}

/** Can this caller change WHO the resource is shared with (its `visibility` /
 *  `sharedWith`)? Relaxed (§13.3) to exactly the content-edit gate: if you can
 *  edit it, you can re-share it. Only viewers (read-only) are excluded. */
export const canManageSharing = canEdit

// ── session visibility (docs/designs/session-visibility.md §5) ──────────────
// Sessions are deliberately NOT `Shareable`: their owner is a namespaced
// identity string (`user:<id>` | `<platform>:<scope>:<uid>`, §2) matched
// against the viewer's identity set — not a creator FK — and they carry no
// `sharedWith`. The repo WHERE arm (session.repo.ts `pageWhereSql` viewer
// predicate) must stay the SQL mirror of `canViewSession`.

/** The visibility-bearing fields of a session row the predicate needs. */
export interface SessionViewable {
  visibility: SessionVisibility
  ownerIdentity: string | null
}

/** The viewer's identity set (§2): today just their console identity; identity
 *  linking (§7) will add verified platform identities, lighting owner-orphan DM
 *  sessions up retroactively — the stored `ownerIdentity` is already correct. */
export function identitySetOf(ctx: ViewCtx): Set<string> {
  return new Set([`user:${ctx.userId}`])
}

/** Can this caller SEE the session? Any one arm suffices. An unowned private
 *  session (`ownerIdentity` null — an owner-orphan) is visible to org owners
 *  only: fail closed, never widen because ownership could not be resolved. */
export function canViewSession(s: SessionViewable, ctx: ViewCtx, identitySet: ReadonlySet<string>): boolean {
  return (
    ctx.role === 'owner' || // governance override — owners see everything
    s.visibility === 'org' || // default: visible to whoever can view the agent
    (s.ownerIdentity != null && identitySet.has(s.ownerIdentity)) // private: owner match
  )
}
