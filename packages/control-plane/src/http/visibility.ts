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
import type { Shareable, ViewCtx } from '../persistence/ports.js'

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
