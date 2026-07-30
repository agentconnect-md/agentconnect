/**
 * OSS authorization policy for human Control Plane requests.
 *
 * Authentication, organization membership, credential scopes, and tenant
 * selection are resolved before this layer. This module owns the remaining
 * role and resource decisions so HTTP guards, point reads, and SQL list
 * projections share one policy seam.
 *
 * Organization roles control what a visible resource may be used for:
 * viewers are read-only, while collaborators and owners may edit. A role never
 * widens visibility. Restricted resources are visible only to their current
 * ownership arm (`ownerUserId`, independent from immutable creation
 * attribution) and explicitly shared members.
 */
import type { SessionVisibility, Shareable, ViewCtx } from '../persistence/ports.js'

export type { Shareable, ViewCtx } from '../persistence/ports.js'

export const AuthorizationAction = {
  OrganizationWrite: 'organization.write',
  OrganizationManage: 'organization.manage',
  ResourceView: 'resource.view',
  ResourceEdit: 'resource.edit',
  ResourceManageSharing: 'resource.sharing.manage',
  SessionView: 'session.view',
  SessionChangeVisibility: 'session.visibility.change'
} as const

export type AuthorizationAction = (typeof AuthorizationAction)[keyof typeof AuthorizationAction]

/** The visibility-bearing session fields needed by the policy. */
export interface SessionViewable {
  visibility: SessionVisibility
  ownerIdentity: string | null
}

export type AuthorizationRequest =
  | {
      action: typeof AuthorizationAction.OrganizationWrite | typeof AuthorizationAction.OrganizationManage
    }
  | {
      action:
        | typeof AuthorizationAction.ResourceView
        | typeof AuthorizationAction.ResourceEdit
        | typeof AuthorizationAction.ResourceManageSharing
      resource: Shareable
    }
  | {
      action: typeof AuthorizationAction.SessionView | typeof AuthorizationAction.SessionChangeVisibility
      resource: SessionViewable
      identitySet: ReadonlySet<string>
    }

function resourceIsVisible(resource: Shareable, principal: ViewCtx): boolean {
  return (
    resource.ownerUserId === principal.userId ||
    resource.visibility === 'org' ||
    resource.sharedWith.includes(principal.userId)
  )
}

function resourceIsEditable(resource: Shareable, principal: ViewCtx): boolean {
  return principal.role !== 'viewer' && resourceIsVisible(resource, principal)
}

function identityOwnsSession(resource: SessionViewable, identitySet: ReadonlySet<string>): boolean {
  return resource.ownerIdentity !== null && identitySet.has(resource.ownerIdentity)
}

/**
 * The single in-memory authorization decision point.
 *
 * The action vocabulary is intentionally small because these are the distinct
 * OSS policies today. New OSS roles or capabilities can add finer-grained
 * actions without changing callers' principal/resource shapes.
 */
export function can(principal: ViewCtx, request: AuthorizationRequest): boolean {
  switch (request.action) {
    case AuthorizationAction.OrganizationWrite:
      return principal.role !== 'viewer'
    case AuthorizationAction.OrganizationManage:
      return principal.role === 'owner'
    case AuthorizationAction.ResourceView:
      return resourceIsVisible(request.resource, principal)
    case AuthorizationAction.ResourceEdit:
      return resourceIsEditable(request.resource, principal)
    case AuthorizationAction.ResourceManageSharing:
      // Ownerless org-visible resources may still be edited, but cannot be
      // pulled restricted: there is no identity that could later reopen them.
      return request.resource.ownerUserId !== null && resourceIsEditable(request.resource, principal)
    case AuthorizationAction.SessionView:
      return request.resource.visibility === 'org' || identityOwnsSession(request.resource, request.identitySet)
    // Re-classification (§4.3) is owner-only: identity match with the recorded
    // owner, roles grant nothing in either direction — an org owner pulling
    // someone's published session back to private is as much an intrusion on
    // the owner's decision as reading their DM would be (mirroring
    // `session.view`). A row with no recorded owner is re-classifiable by no
    // one. Deliberately NOT the role-based edit guard: the grant follows
    // OWNERSHIP, so a viewer-role member keeps control of their own DM.
    case AuthorizationAction.SessionChangeVisibility:
      return identityOwnsSession(request.resource, request.identitySet)
  }
}

/** Readability adapters used by resource-oriented routes. */
export function canView(resource: Shareable, principal: ViewCtx): boolean {
  return can(principal, { action: AuthorizationAction.ResourceView, resource })
}

export function canEdit(resource: Shareable, principal: ViewCtx): boolean {
  return can(principal, { action: AuthorizationAction.ResourceEdit, resource })
}

export function canManageSharing(resource: Shareable, principal: ViewCtx): boolean {
  return can(principal, { action: AuthorizationAction.ResourceManageSharing, resource })
}

/** The viewer's verified identity set; social identity linking may grow it. */
export function identitySetOf(principal: ViewCtx): Set<string> {
  return new Set([`user:${principal.userId}`])
}

export function canViewSession(
  resource: SessionViewable,
  principal: ViewCtx,
  identitySet: ReadonlySet<string>
): boolean {
  return can(principal, { action: AuthorizationAction.SessionView, resource, identitySet })
}

export function canChangeSessionVisibility(
  resource: SessionViewable,
  principal: ViewCtx,
  identitySet: ReadonlySet<string>
): boolean {
  return can(principal, {
    action: AuthorizationAction.SessionChangeVisibility,
    resource,
    identitySet
  })
}

/**
 * Prisma list projection of `resource.view`.
 *
 * An undefined principal is reserved for internal daemon/orchestration reads
 * and remains deliberately unfiltered. Every human role, including owner, uses
 * the same resource-visibility predicate.
 */
export function visibilityWhere(principal?: ViewCtx) {
  if (!principal) return {}
  return {
    OR: [{ visibility: 'org' as const }, { ownerUserId: principal.userId }, { sharedWith: { has: principal.userId } }]
  }
}
