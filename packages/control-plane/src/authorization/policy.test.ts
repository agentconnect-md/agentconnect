import { describe, it, expect } from 'vitest'
import {
  AuthorizationAction,
  can,
  canView,
  canEdit,
  canManageSharing,
  canChangeSessionVisibility,
  canViewSession,
  identitySetOf,
  visibilityWhere,
  type SessionViewable,
  type Shareable,
  type ViewCtx
} from './policy.js'
import type { OrgMemberRole } from '../persistence/ports.js'

// ── fixtures ──────────────────────────────────────────────────────────────────
const CREATOR = 'user_creator'
const GRANTEE = 'user_grantee'
const OTHER = 'user_other'

const ctx = (userId: string, role: OrgMemberRole): ViewCtx => ({ userId, role })

const orgVisible: Shareable = { visibility: 'org', sharedWith: [] }
const restricted: Shareable = { visibility: 'restricted', sharedWith: [GRANTEE] }
const emptyRestricted: Shareable = { visibility: 'restricted', sharedWith: [] }

describe('canView', () => {
  it('org-visible resource is visible to every role, granted or not', () => {
    expect(canView(orgVisible, ctx(OTHER, 'viewer'))).toBe(true)
    expect(canView(orgVisible, ctx(OTHER, 'collaborator'))).toBe(true)
    expect(canView(orgVisible, ctx(OTHER, 'owner'))).toBe(true)
  })

  it('restricted resource hides from every non-grantee, regardless of role', () => {
    expect(canView(restricted, ctx(OTHER, 'collaborator'))).toBe(false)
    expect(canView(restricted, ctx(OTHER, 'viewer'))).toBe(false)
    expect(canView(restricted, ctx(OTHER, 'owner'))).toBe(false)
  })

  it('restricted resource is visible to a shared member (any role)', () => {
    expect(canView(restricted, ctx(GRANTEE, 'collaborator'))).toBe(true)
    expect(canView(restricted, ctx(GRANTEE, 'viewer'))).toBe(true)
  })

  it('an invalid empty restricted resource fails closed for every role', () => {
    expect(canView(emptyRestricted, ctx(OTHER, 'collaborator'))).toBe(false)
    expect(canView(emptyRestricted, ctx(GRANTEE, 'collaborator'))).toBe(false)
    expect(canView(emptyRestricted, ctx(OTHER, 'owner'))).toBe(false)
  })
})

describe('canEdit', () => {
  it('viewer never edits — even when the resource is visible to them', () => {
    expect(canEdit(orgVisible, ctx(OTHER, 'viewer'))).toBe(false)
    expect(canEdit(restricted, ctx(GRANTEE, 'viewer'))).toBe(false) // visible but read-only
  })

  it('owner edit rights never widen resource visibility', () => {
    expect(canEdit(orgVisible, ctx(OTHER, 'owner'))).toBe(true)
    expect(canEdit(restricted, ctx(GRANTEE, 'owner'))).toBe(true)
    expect(canEdit(restricted, ctx(OTHER, 'owner'))).toBe(false)
  })

  it('collaborator edits iff they can view', () => {
    expect(canEdit(orgVisible, ctx(OTHER, 'collaborator'))).toBe(true)
    expect(canEdit(restricted, ctx(GRANTEE, 'collaborator'))).toBe(true)
    expect(canEdit(restricted, ctx(OTHER, 'collaborator'))).toBe(false) // can't even see it
  })
})

describe('canManageSharing (§13.3)', () => {
  it('is identical to canEdit', () => {
    const resources = [orgVisible, restricted]
    const roles: OrgMemberRole[] = ['owner', 'collaborator', 'viewer']
    const users = [GRANTEE, OTHER]
    for (const r of resources) {
      for (const role of roles) {
        for (const u of users) {
          const c = ctx(u, role)
          expect(canManageSharing(r, c)).toBe(canEdit(r, c))
        }
      }
    }
  })

  it('lets a shared collaborator re-share, but never a viewer', () => {
    expect(canManageSharing(restricted, ctx(GRANTEE, 'collaborator'))).toBe(true)
    expect(canManageSharing(restricted, ctx(GRANTEE, 'viewer'))).toBe(false)
    expect(canManageSharing(orgVisible, ctx(OTHER, 'collaborator'))).toBe(true)
  })

  it('lets a collaborator manage sharing for an org-visible resource', () => {
    const collaborator = ctx(OTHER, 'collaborator')
    expect(canEdit(orgVisible, collaborator)).toBe(true)
    expect(canManageSharing(orgVisible, collaborator)).toBe(true)
  })
})

describe('identitySetOf', () => {
  it('is exactly the console identity today (identity linking grows it later)', () => {
    expect(identitySetOf(ctx(OTHER, 'collaborator'))).toEqual(new Set([`user:${OTHER}`]))
  })
})

describe('can — organization role actions', () => {
  it('keeps ordinary writes available to collaborators and owners but not viewers', () => {
    expect(can(ctx(OTHER, 'viewer'), { action: AuthorizationAction.OrganizationWrite })).toBe(false)
    expect(can(ctx(OTHER, 'collaborator'), { action: AuthorizationAction.OrganizationWrite })).toBe(true)
    expect(can(ctx(OTHER, 'owner'), { action: AuthorizationAction.OrganizationWrite })).toBe(true)
  })

  it('keeps organization governance owner-only', () => {
    expect(can(ctx(OTHER, 'viewer'), { action: AuthorizationAction.OrganizationManage })).toBe(false)
    expect(can(ctx(OTHER, 'collaborator'), { action: AuthorizationAction.OrganizationManage })).toBe(false)
    expect(can(ctx(OTHER, 'owner'), { action: AuthorizationAction.OrganizationManage })).toBe(true)
  })

  it('lets every role leave while keeping removal of another member owner-only', () => {
    for (const role of ['viewer', 'collaborator', 'owner'] as const) {
      expect(
        can(ctx(OTHER, role), {
          action: AuthorizationAction.OrganizationMembershipRemove,
          targetUserId: OTHER
        })
      ).toBe(true)
    }
    expect(
      can(ctx(OTHER, 'viewer'), {
        action: AuthorizationAction.OrganizationMembershipRemove,
        targetUserId: CREATOR
      })
    ).toBe(false)
    expect(
      can(ctx(OTHER, 'owner'), {
        action: AuthorizationAction.OrganizationMembershipRemove,
        targetUserId: CREATOR
      })
    ).toBe(true)
  })
})

describe('canViewSession (session-visibility.md §5)', () => {
  const owned = (visibility: SessionViewable['visibility'], ownerIdentity: string | null): SessionViewable => ({
    visibility,
    ownerIdentity
  })
  const idsOf = (c: ViewCtx) => identitySetOf(c)

  it('org session is visible to every role, owner-match or not', () => {
    const s = owned('org', `user:${CREATOR}`)
    expect(canViewSession(s, ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')))).toBe(true)
    expect(canViewSession(s, ctx(OTHER, 'collaborator'), idsOf(ctx(OTHER, 'collaborator')))).toBe(true)
    expect(canViewSession(s, ctx(OTHER, 'owner'), idsOf(ctx(OTHER, 'owner')))).toBe(true)
  })

  it('org session with no recorded owner (automation) stays org-visible', () => {
    expect(canViewSession(owned('org', null), ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')))).toBe(true)
  })

  it('private session is visible to its identity-matched owner, any role', () => {
    const s = owned('private', `user:${CREATOR}`)
    expect(canViewSession(s, ctx(CREATOR, 'collaborator'), idsOf(ctx(CREATOR, 'collaborator')))).toBe(true)
    expect(canViewSession(s, ctx(CREATOR, 'viewer'), idsOf(ctx(CREATOR, 'viewer')))).toBe(true)
  })

  it('private session hides from every non-matching viewer — org owners included', () => {
    // A private session is a DM-grade transcript, and role grants no access.
    const s = owned('private', `user:${CREATOR}`)
    expect(canViewSession(s, ctx(OTHER, 'collaborator'), idsOf(ctx(OTHER, 'collaborator')))).toBe(false)
    expect(canViewSession(s, ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')))).toBe(false)
    expect(canViewSession(s, ctx(OTHER, 'owner'), idsOf(ctx(OTHER, 'owner')))).toBe(false)
  })

  it('matches a linked platform identity once the identity set carries it', () => {
    const s = owned('private', 'slack:T024BE7LD:U0123ABCD')
    const c = ctx(OTHER, 'collaborator')
    // Pre-linking: the platform owner is an owner-orphan for this viewer.
    expect(canViewSession(s, c, idsOf(c))).toBe(false)
    // Post-linking (§7): the set grows; the stored ownerIdentity already matches.
    const linked = new Set([...idsOf(c), 'slack:T024BE7LD:U0123ABCD'])
    expect(canViewSession(s, c, linked)).toBe(true)
  })

  it('a null-owner private session is visible to no one — fail closed', () => {
    // Unlike a §2 owner-orphan (a stored-but-unmatched platform tuple, which
    // identity linking §7 lights up retroactively), a null owner has nothing
    // to match — no role, org owners included, can read it without a
    // repair/backfill first.
    const s = owned('private', null)
    expect(canViewSession(s, ctx(CREATOR, 'collaborator'), idsOf(ctx(CREATOR, 'collaborator')))).toBe(false)
    expect(canViewSession(s, ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')))).toBe(false)
    expect(canViewSession(s, ctx(OTHER, 'owner'), idsOf(ctx(OTHER, 'owner')))).toBe(false)
  })

  it('uses the fixed external scope and current provider decision without an owner bypass', () => {
    const s: SessionViewable = {
      visibility: 'external',
      ownerIdentity: null,
      externalProvider: 'slack',
      externalScopeId: 'scope-1',
      externalResolution: 'settled',
      classifiedPolicyRev: 3n
    }
    const externalAccess = {
      policies: [{ provider: 'slack', readFenceRev: 3n }],
      allowedScopes: [{ id: 'scope-1', aclRevision: 1n }],
      decisionAt: new Date()
    }
    expect(canViewSession(s, ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')), externalAccess)).toBe(true)
    expect(
      canViewSession(s, ctx(OTHER, 'owner'), idsOf(ctx(OTHER, 'owner')), {
        ...externalAccess,
        allowedScopes: []
      })
    ).toBe(false)
  })

  it('keeps a provider-bound p2p session owner-only through exact identity or live chat proof', () => {
    const owner = ctx(CREATOR, 'collaborator')
    const session: SessionViewable = {
      visibility: 'private',
      ownerIdentity: 'feishu:lark:cli_custom:ou_owner',
      externalProvider: 'feishu',
      externalScopeId: 'scope-1',
      externalResolution: 'settled'
    }
    expect(canViewSession(session, owner, new Set([...idsOf(owner), session.ownerIdentity!]))).toBe(true)
    expect(canViewSession(session, ctx(OTHER, 'owner'), idsOf(ctx(OTHER, 'owner')))).toBe(false)
    expect(
      canViewSession(session, ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')), {
        policies: [{ provider: 'feishu', readFenceRev: null }],
        allowedScopes: [{ id: 'scope-1', aclRevision: 1n }],
        decisionAt: new Date()
      })
    ).toBe(true)
  })

  it('fails closed for unresolved external rows and pre-fence candidates', () => {
    const principal = ctx(OTHER, 'collaborator')
    const snapshot = {
      policies: [{ provider: 'slack', readFenceRev: 4n }],
      allowedScopes: [{ id: 'scope-1', aclRevision: 1n }],
      decisionAt: new Date()
    }
    expect(
      canViewSession(
        {
          visibility: 'external',
          ownerIdentity: null,
          externalProvider: 'slack',
          externalScopeId: 'scope-1',
          externalResolution: 'pending',
          classifiedPolicyRev: 4n
        },
        principal,
        idsOf(principal),
        snapshot
      )
    ).toBe(false)
    expect(
      canViewSession(
        {
          visibility: 'org',
          ownerIdentity: null,
          externalProvider: 'slack',
          externalScopeId: null,
          externalResolution: 'pending',
          classifiedPolicyRev: 3n
        },
        principal,
        idsOf(principal),
        snapshot
      )
    ).toBe(false)
  })
})

describe('canChangeSessionVisibility', () => {
  const session = (visibility: SessionViewable['visibility'], ownerIdentity: string | null): SessionViewable => ({
    visibility,
    ownerIdentity
  })

  it('denies an organization owner reclassifying a session they do not own, org-visible or not', () => {
    const owner = ctx(OTHER, 'owner')
    expect(canChangeSessionVisibility(session('org', `user:${CREATOR}`), owner, identitySetOf(owner))).toBe(false)
    expect(canChangeSessionVisibility(session('private', `user:${CREATOR}`), owner, identitySetOf(owner))).toBe(false)
  })

  it('follows identity ownership for every role', () => {
    for (const role of ['owner', 'collaborator', 'viewer'] as const) {
      const principal = ctx(CREATOR, role)
      expect(
        canChangeSessionVisibility(session('private', `user:${CREATOR}`), principal, identitySetOf(principal))
      ).toBe(true)
      expect(canChangeSessionVisibility(session('org', `user:${CREATOR}`), principal, identitySetOf(principal))).toBe(
        true
      )
    }
  })

  it('a null-owner session is re-classifiable by no one — fail closed', () => {
    const owner = ctx(OTHER, 'owner')
    expect(canChangeSessionVisibility(session('org', null), owner, identitySetOf(owner))).toBe(false)
    expect(canChangeSessionVisibility(session('private', null), owner, identitySetOf(owner))).toBe(false)
  })

  it('never lets a human rewrite an externally bound audience', () => {
    const principal = ctx(CREATOR, 'owner')
    expect(
      canChangeSessionVisibility(
        {
          visibility: 'external',
          ownerIdentity: `user:${CREATOR}`,
          externalProvider: 'slack',
          externalScopeId: 'scope-1',
          externalResolution: 'settled'
        },
        principal,
        identitySetOf(principal)
      )
    ).toBe(false)
  })
})

describe('visibilityWhere', () => {
  it('filters owners through the same resource-visibility projection as every human role', () => {
    expect(visibilityWhere(ctx(OTHER, 'owner'))).toEqual({
      OR: [{ visibility: 'org' }, { sharedWith: { has: OTHER } }]
    })
  })

  it('is empty (unfiltered) for an undefined viewer — internal / daemon-facing callers', () => {
    expect(visibilityWhere(undefined)).toEqual({})
  })

  it('is the canView disjunction for collaborators and viewers', () => {
    expect(visibilityWhere(ctx(GRANTEE, 'collaborator'))).toEqual({
      OR: [{ visibility: 'org' }, { sharedWith: { has: GRANTEE } }]
    })
    // viewers filter identically to collaborators — the row filter is view-based
    expect(visibilityWhere(ctx(GRANTEE, 'viewer'))).toEqual({
      OR: [{ visibility: 'org' }, { sharedWith: { has: GRANTEE } }]
    })
  })
})
