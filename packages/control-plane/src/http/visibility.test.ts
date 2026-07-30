import { describe, it, expect } from 'vitest'
import {
  canView,
  canEdit,
  canManageSharing,
  canViewSession,
  identitySetOf,
  visibilityWhere,
  type SessionViewable,
  type Shareable,
  type ViewCtx
} from './visibility.js'
import type { OrgMemberRole } from '../persistence/ports.js'

// ── fixtures ──────────────────────────────────────────────────────────────────
const CREATOR = 'user_creator'
const GRANTEE = 'user_grantee'
const OTHER = 'user_other'

const ctx = (userId: string, role: OrgMemberRole): ViewCtx => ({ userId, role })

const orgVisible: Shareable = { createdByUserId: CREATOR, visibility: 'org', sharedWith: [] }
const restricted: Shareable = { createdByUserId: CREATOR, visibility: 'restricted', sharedWith: [GRANTEE] }
// A restricted resource whose creator's user row was SetNull-deleted (createdByUserId null).
const orphaned: Shareable = { createdByUserId: null, visibility: 'restricted', sharedWith: [] }

describe('canView', () => {
  it('org-visible resource is visible to every role, granted or not', () => {
    expect(canView(orgVisible, ctx(OTHER, 'viewer'))).toBe(true)
    expect(canView(orgVisible, ctx(OTHER, 'collaborator'))).toBe(true)
    expect(canView(orgVisible, ctx(OTHER, 'owner'))).toBe(true)
  })

  it('restricted resource hides from a non-creator, non-grantee, non-owner', () => {
    expect(canView(restricted, ctx(OTHER, 'collaborator'))).toBe(false)
    expect(canView(restricted, ctx(OTHER, 'viewer'))).toBe(false)
  })

  it('restricted resource is visible to the creator (creator forever)', () => {
    expect(canView(restricted, ctx(CREATOR, 'collaborator'))).toBe(true)
  })

  it('restricted resource is visible to a shared member (any role)', () => {
    expect(canView(restricted, ctx(GRANTEE, 'collaborator'))).toBe(true)
    expect(canView(restricted, ctx(GRANTEE, 'viewer'))).toBe(true)
  })

  it('restricted resource is visible to any owner — governance override', () => {
    expect(canView(restricted, ctx(OTHER, 'owner'))).toBe(true)
    expect(canView(orphaned, ctx(OTHER, 'owner'))).toBe(true)
  })

  it('an orphaned restricted resource is invisible to every non-owner', () => {
    expect(canView(orphaned, ctx(OTHER, 'collaborator'))).toBe(false)
    expect(canView(orphaned, ctx(GRANTEE, 'collaborator'))).toBe(false)
  })
})

describe('canEdit', () => {
  it('viewer never edits — even when the resource is visible to them', () => {
    expect(canEdit(orgVisible, ctx(OTHER, 'viewer'))).toBe(false)
    expect(canEdit(restricted, ctx(GRANTEE, 'viewer'))).toBe(false) // visible but read-only
  })

  it('owner edits anything, including a restricted resource never granted to them', () => {
    expect(canEdit(restricted, ctx(OTHER, 'owner'))).toBe(true)
  })

  it('collaborator edits iff they can view', () => {
    expect(canEdit(orgVisible, ctx(OTHER, 'collaborator'))).toBe(true)
    expect(canEdit(restricted, ctx(GRANTEE, 'collaborator'))).toBe(true)
    expect(canEdit(restricted, ctx(CREATOR, 'collaborator'))).toBe(true)
    expect(canEdit(restricted, ctx(OTHER, 'collaborator'))).toBe(false) // can't even see it
  })
})

describe('canManageSharing (relaxed to === canEdit, §13.3)', () => {
  it('is identical to canEdit across the whole matrix', () => {
    const resources = [orgVisible, restricted, orphaned]
    const roles: OrgMemberRole[] = ['owner', 'collaborator', 'viewer']
    const users = [CREATOR, GRANTEE, OTHER]
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
})

describe('identitySetOf', () => {
  it('is exactly the console identity today (identity linking grows it later)', () => {
    expect(identitySetOf(ctx(OTHER, 'collaborator'))).toEqual(new Set([`user:${OTHER}`]))
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

  it('private session hides from a non-matching non-owner', () => {
    const s = owned('private', `user:${CREATOR}`)
    expect(canViewSession(s, ctx(OTHER, 'collaborator'), idsOf(ctx(OTHER, 'collaborator')))).toBe(false)
    expect(canViewSession(s, ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')))).toBe(false)
  })

  it('private session is visible to any org owner — governance override', () => {
    const s = owned('private', `user:${CREATOR}`)
    expect(canViewSession(s, ctx(OTHER, 'owner'), idsOf(ctx(OTHER, 'owner')))).toBe(true)
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

  it('an owner-orphan private session (ownerIdentity null) is owner-role-only — fail closed', () => {
    const s = owned('private', null)
    expect(canViewSession(s, ctx(CREATOR, 'collaborator'), idsOf(ctx(CREATOR, 'collaborator')))).toBe(false)
    expect(canViewSession(s, ctx(OTHER, 'viewer'), idsOf(ctx(OTHER, 'viewer')))).toBe(false)
    expect(canViewSession(s, ctx(OTHER, 'owner'), idsOf(ctx(OTHER, 'owner')))).toBe(true)
  })
})

describe('visibilityWhere', () => {
  it('is empty (unfiltered) for an owner — governance override', () => {
    expect(visibilityWhere(ctx(OTHER, 'owner'))).toEqual({})
  })

  it('is empty (unfiltered) for an undefined viewer — internal / daemon-facing callers', () => {
    expect(visibilityWhere(undefined)).toEqual({})
  })

  it('is the canView disjunction for a non-owner', () => {
    expect(visibilityWhere(ctx(GRANTEE, 'collaborator'))).toEqual({
      OR: [{ visibility: 'org' }, { createdByUserId: GRANTEE }, { sharedWith: { has: GRANTEE } }]
    })
    // viewers filter identically to collaborators — the row filter is view-based
    expect(visibilityWhere(ctx(GRANTEE, 'viewer'))).toEqual({
      OR: [{ visibility: 'org' }, { createdByUserId: GRANTEE }, { sharedWith: { has: GRANTEE } }]
    })
  })
})
