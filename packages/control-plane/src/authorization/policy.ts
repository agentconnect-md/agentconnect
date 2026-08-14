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
 * widens visibility. Restricted resources are visible only to the current
 * organization members in their explicit `sharedWith` audience.
 */
import type { SessionExternalAccessSnapshot, SessionVisibility, Shareable, ViewCtx } from '../persistence/ports.js'

export type { Shareable, ViewCtx } from '../persistence/ports.js'

export const AuthorizationAction = {
  OrganizationWrite: 'organization.write',
  OrganizationManage: 'organization.manage',
  OrganizationMembershipRemove: 'organization.membership.remove',
  ResourceView: 'resource.view',
  ResourceEdit: 'resource.edit',
  ResourceManageSharing: 'resource.sharing.manage',
  SessionView: 'session.view',
  SessionChangeVisibility: 'session.visibility.change',
  SessionContinue: 'session.continue'
} as const

export type AuthorizationAction = (typeof AuthorizationAction)[keyof typeof AuthorizationAction]

/** The visibility-bearing session fields needed by the policy. */
export interface SessionViewable {
  visibility: SessionVisibility
  ownerIdentity: string | null
  externalProvider?: string | null
  externalScopeId?: string | null
  externalResolution?: 'pending' | 'settled' | 'invalid' | null
  classifiedPolicyRev?: bigint | null
}

export type AuthorizationRequest =
  | {
      action: typeof AuthorizationAction.OrganizationWrite | typeof AuthorizationAction.OrganizationManage
    }
  | {
      action: typeof AuthorizationAction.OrganizationMembershipRemove
      targetUserId: string
    }
  | {
      action:
        | typeof AuthorizationAction.ResourceView
        | typeof AuthorizationAction.ResourceEdit
        | typeof AuthorizationAction.ResourceManageSharing
      resource: Shareable
    }
  | {
      action:
        | typeof AuthorizationAction.SessionView
        | typeof AuthorizationAction.SessionChangeVisibility
        | typeof AuthorizationAction.SessionContinue
      resource: SessionViewable
      identitySet: ReadonlySet<string>
      externalAccess?: SessionExternalAccessSnapshot
    }

function resourceIsVisible(resource: Shareable, principal: ViewCtx): boolean {
  return resource.visibility === 'org' || resource.sharedWith.includes(principal.userId)
}

function resourceIsEditable(resource: Shareable, principal: ViewCtx): boolean {
  return principal.role !== 'viewer' && resourceIsVisible(resource, principal)
}

function identityOwnsSession(resource: SessionViewable, identitySet: ReadonlySet<string>): boolean {
  return resource.ownerIdentity !== null && identitySet.has(resource.ownerIdentity)
}

function externalSessionIsVisible(
  resource: SessionViewable,
  snapshot: SessionExternalAccessSnapshot | undefined
): boolean {
  const provider = resource.externalProvider
  if (!provider || !snapshot) return false
  const policy = snapshot.policies.find((candidate) => candidate.provider === provider)
  // A supported candidate with no durable policy is never the disabled baseline.
  if (!policy) return false
  if (
    resource.visibility === 'org' &&
    policy.readFenceRev !== null &&
    (resource.classifiedPolicyRev == null || resource.classifiedPolicyRev < policy.readFenceRev)
  ) {
    return false
  }
  if (resource.visibility === 'org') return true
  if (resource.visibility !== 'external' || resource.externalResolution !== 'settled' || !resource.externalScopeId) {
    return false
  }
  return snapshot.allowedScopes.some((scope) => scope.id === resource.externalScopeId)
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
    case AuthorizationAction.OrganizationMembershipRemove:
      return principal.userId === request.targetUserId || principal.role === 'owner'
    case AuthorizationAction.ResourceView:
      return resourceIsVisible(request.resource, principal)
    case AuthorizationAction.ResourceEdit:
      return resourceIsEditable(request.resource, principal)
    case AuthorizationAction.ResourceManageSharing:
      return resourceIsEditable(request.resource, principal)
    case AuthorizationAction.SessionView:
      return request.resource.externalProvider
        ? request.resource.visibility === 'private'
          ? identityOwnsSession(request.resource, request.identitySet)
          : externalSessionIsVisible(request.resource, request.externalAccess)
        : request.resource.visibility === 'org' || identityOwnsSession(request.resource, request.identitySet)
    // Re-classification (§4.3) is owner-only: identity match with the recorded
    // owner, roles grant nothing in either direction — an org owner pulling
    // someone's published session back to private is as much an intrusion on
    // the owner's decision as reading their DM would be (mirroring
    // `session.view`). A row with no recorded owner is re-classifiable by no
    // one. Deliberately NOT the role-based edit guard: the grant follows
    // OWNERSHIP, so a viewer-role member keeps control of their own DM.
    case AuthorizationAction.SessionChangeVisibility:
      return !request.resource.externalProvider && identityOwnsSession(request.resource, request.identitySet)
    // Continuation is an organization WRITE riding on view (webchat-cross-
    // integration-continuation.md §5.1): viewing a transcript is not authority
    // to make the bot speak in an external system, so the viewer role is
    // refused UNIFORMLY — even for a private session the viewer owns (unlike
    // `session.visibility.change`, this posts through the org's bot). Private
    // sessions additionally stay owner-only; role never widens that audience.
    case AuthorizationAction.SessionContinue:
      if (principal.role === 'viewer') return false
      if (request.resource.visibility === 'private') {
        return identityOwnsSession(request.resource, request.identitySet)
      }
      return can(principal, {
        action: AuthorizationAction.SessionView,
        resource: request.resource,
        identitySet: request.identitySet,
        ...(request.externalAccess ? { externalAccess: request.externalAccess } : {})
      })
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

/** The BASE identity set — the console identity every caller carries. The BFF
 *  grows it with the caller's verified platform identities before matching
 *  through Session-access plugins; that expansion needs I/O, so it stays out of
 *  this pure policy module. */
export function identitySetOf(principal: ViewCtx): Set<string> {
  return new Set([`user:${principal.userId}`])
}

export function canViewSession(
  resource: SessionViewable,
  principal: ViewCtx,
  identitySet: ReadonlySet<string>,
  externalAccess?: SessionExternalAccessSnapshot
): boolean {
  return can(principal, {
    action: AuthorizationAction.SessionView,
    resource,
    identitySet,
    ...(externalAccess ? { externalAccess } : {})
  })
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

export function canContinueSession(
  resource: SessionViewable,
  principal: ViewCtx,
  identitySet: ReadonlySet<string>,
  externalAccess?: SessionExternalAccessSnapshot
): boolean {
  return can(principal, {
    action: AuthorizationAction.SessionContinue,
    resource,
    identitySet,
    ...(externalAccess ? { externalAccess } : {})
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
    OR: [{ visibility: 'org' as const }, { sharedWith: { has: principal.userId } }]
  }
}
