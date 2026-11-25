import { describe, expect, it } from 'vitest'
import {
  ArtifactAction,
  agentCanReachArtifact,
  artifactAudienceFromSession,
  canActOnArtifact,
  canViewArtifact,
  isArtifactOwner,
  type ArtifactAudience,
  type ArtifactInitiator,
  type ArtifactOriginSession,
  type ArtifactReachSession,
  type ArtifactViewer
} from './artifact-policy.js'
import type { SessionExternalAccessSnapshot } from '../persistence/ports.js'

const ORG = 'org_1'
const OTHER_ORG = 'org_2'
const A1 = 'a1a1a1a1-1111-4111-8111-111111111111'
const A2 = 'a2a2a2a2-2222-4222-8222-222222222222'
const GONE = 'a9a9a9a9-9999-4999-8999-999999999999'
const S1 = '51515151-1111-4111-8111-111111111111'

const slackAccess = (allowed: string[]): SessionExternalAccessSnapshot => ({
  policies: [{ provider: 'slack', readFenceRev: null }],
  allowedScopes: allowed.map((id) => ({ id, aclRevision: 0n })),
  decisionAt: new Date(0)
})

// alice links a Slack identity; bob is in the channel and edits A1; vera has the viewer role; olga owns the organization.
const viewers = {
  alice: {
    orgId: ORG,
    principal: { userId: 'alice', role: 'collaborator' },
    identitySet: new Set(['user:alice', 'slack:T1:UA']),
    externalAccess: slackAccess([]),
    editableAgentIds: new Set()
  },
  bob: {
    orgId: ORG,
    principal: { userId: 'bob', role: 'collaborator' },
    identitySet: new Set(['user:bob']),
    externalAccess: slackAccess([S1]),
    editableAgentIds: new Set([A1])
  },
  vera: {
    orgId: ORG,
    principal: { userId: 'vera', role: 'viewer' },
    identitySet: new Set(['user:vera']),
    editableAgentIds: new Set()
  },
  olga: {
    orgId: ORG,
    principal: { userId: 'olga', role: 'owner' },
    identitySet: new Set(['user:olga']),
    externalAccess: slackAccess([]),
    editableAgentIds: new Set([A1, A2])
  },
  // Another organization's owner carrying alice's identity: the organization boundary still holds.
  mallory: {
    orgId: OTHER_ORG,
    principal: { userId: 'alice', role: 'owner' },
    identitySet: new Set(['user:alice']),
    externalAccess: slackAccess([S1]),
    editableAgentIds: new Set([A1])
  }
} satisfies Record<string, ArtifactViewer>
type ViewerName = keyof typeof viewers
const VIEWERS = Object.keys(viewers) as ViewerName[]

const audience = (patch: Partial<ArtifactAudience>): ArtifactAudience => ({
  orgId: ORG,
  visibility: 'org',
  ownerIdentity: null,
  externalProvider: null,
  externalScopeId: null,
  editorsAgentId: null,
  ...patch
})

const artifacts = {
  privateAlice: audience({ visibility: 'private', ownerIdentity: 'user:alice' }),
  privateTuple: audience({ visibility: 'private', ownerIdentity: 'slack:T1:UA' }),
  privateOwnerless: audience({ visibility: 'private' }),
  orgAlice: audience({ visibility: 'org', ownerIdentity: 'user:alice' }),
  orgVera: audience({ visibility: 'org', ownerIdentity: 'user:vera' }),
  orgOwnerless: audience({ visibility: 'org' }),
  externalAlice: audience({
    visibility: 'external',
    ownerIdentity: 'user:alice',
    externalProvider: 'slack',
    externalScopeId: S1
  }),
  externalNoPolicy: audience({ visibility: 'external', externalProvider: 'github', externalScopeId: S1 }),
  editorsA1: audience({ visibility: 'editors', editorsAgentId: A1 }),
  editorsGone: audience({ visibility: 'editors', editorsAgentId: GONE })
}
type ArtifactName = keyof typeof artifacts

describe('canViewArtifact (artifacts.md §6)', () => {
  // Each row lists exactly the viewers who see the artifact.
  const table: Record<ArtifactName, ViewerName[]> = {
    privateAlice: ['alice'],
    privateTuple: ['alice'],
    privateOwnerless: ['olga'],
    orgAlice: ['alice', 'bob', 'vera', 'olga'],
    orgVera: ['alice', 'bob', 'vera', 'olga'],
    orgOwnerless: ['alice', 'bob', 'vera', 'olga'],
    externalAlice: ['bob'],
    externalNoPolicy: [],
    editorsA1: ['bob', 'olga'],
    editorsGone: ['olga']
  }
  for (const [name, seen] of Object.entries(table) as Array<[ArtifactName, ViewerName[]]>) {
    it(`${name} is visible to ${seen.join(', ') || 'no one'}`, () => {
      for (const viewer of VIEWERS) {
        expect(canViewArtifact(artifacts[name], viewers[viewer]), viewer).toBe(seen.includes(viewer))
      }
    })
  }

  it('denies external and editors artifacts when the decision inputs were not read', () => {
    const bare: ArtifactViewer = {
      orgId: ORG,
      principal: { userId: 'bob', role: 'collaborator' },
      identitySet: new Set()
    }
    expect(canViewArtifact(artifacts.externalAlice, bare)).toBe(false)
    expect(canViewArtifact(artifacts.editorsA1, bare)).toBe(false)
    expect(canViewArtifact(artifacts.orgOwnerless, bare)).toBe(true)
  })
})

describe('canActOnArtifact (artifacts.md §6.3)', () => {
  const ACTIONS = [
    ArtifactAction.View,
    ArtifactAction.ShareOrg,
    ArtifactAction.SharePublic,
    ArtifactAction.Rename,
    ArtifactAction.ChangeAudience,
    ArtifactAction.RevokeShare,
    ArtifactAction.Delete
  ] as const
  // One letter per action in ACTIONS order: view, org share, public share, rename, audience, revoke, delete.
  const table: Array<[ArtifactName, ViewerName, string]> = [
    ['privateAlice', 'alice', 'TTTTTTT'],
    ['privateTuple', 'alice', 'TTTTTTT'],
    // An organization owner who cannot view keeps only moderation.
    ['privateAlice', 'olga', 'FFFFFTT'],
    ['privateAlice', 'bob', 'FFFFFFF'],
    ['privateOwnerless', 'olga', 'TTTTTTT'],
    ['privateOwnerless', 'alice', 'FFFFFFF'],
    ['orgAlice', 'bob', 'TTFFFFF'],
    ['orgAlice', 'vera', 'TTFFFFF'],
    ['orgAlice', 'olga', 'TTTTTTT'],
    // Ownership, not role: a viewer-role owner keeps owner rights.
    ['orgVera', 'vera', 'TTTTTTT'],
    ['orgOwnerless', 'alice', 'TTFFFFF'],
    ['orgOwnerless', 'olga', 'TTTTTTT'],
    // The owner keeps owner rights without channel access; only private and org audiences change.
    ['externalAlice', 'alice', 'FFTTFTT'],
    ['externalAlice', 'bob', 'TTFFFFF'],
    ['externalAlice', 'olga', 'FFFFFTT'],
    ['editorsA1', 'olga', 'TTTTFTT'],
    ['editorsA1', 'bob', 'TTFFFFF'],
    ['editorsGone', 'olga', 'TTTTFTT'],
    ['editorsGone', 'bob', 'FFFFFFF'],
    ['privateAlice', 'mallory', 'FFFFFFF'],
    ['orgOwnerless', 'mallory', 'FFFFFFF']
  ]
  it.each(table)('%s as %s is %s', (name, viewer, expected) => {
    const actual = ACTIONS.map((action) => (canActOnArtifact(action, artifacts[name], viewers[viewer]) ? 'T' : 'F'))
    expect(actual.join('')).toBe(expected)
  })

  it('names the owner by identity-set membership only', () => {
    expect(isArtifactOwner(artifacts.privateTuple, viewers.alice.identitySet)).toBe(true)
    expect(isArtifactOwner(artifacts.privateOwnerless, viewers.olga.identitySet)).toBe(false)
  })
})

describe('agentCanReachArtifact (artifacts.md §7.2)', () => {
  const session = (patch: Partial<ArtifactReachSession>): ArtifactReachSession => ({
    orgId: ORG,
    agentId: A1,
    visibility: 'org',
    externalProvider: null,
    externalScopeId: null,
    externalResolution: null,
    ...patch
  })
  const settledS1 = { visibility: 'external', externalProvider: 'slack', externalScopeId: S1 } as const
  const table: Array<[string, ArtifactReachSession, ArtifactViewer | undefined, ArtifactName[]]> = [
    [
      'a private session reaches what its owner can view',
      session({ visibility: 'private' }),
      viewers.alice,
      ['privateAlice', 'privateTuple', 'orgAlice', 'orgVera', 'orgOwnerless']
    ],
    [
      "an organization owner's private session reaches what they can view",
      session({ visibility: 'private' }),
      viewers.olga,
      ['privateOwnerless', 'orgAlice', 'orgVera', 'orgOwnerless', 'editorsA1', 'editorsGone']
    ],
    ['a private session with no member owner reaches nothing', session({ visibility: 'private' }), undefined, []],
    [
      "a private session never borrows another organization's owner",
      session({ visibility: 'private' }),
      viewers.mallory,
      []
    ],
    ['an org session reaches org artifacts', session({}), undefined, ['orgAlice', 'orgVera', 'orgOwnerless']],
    [
      'an editors session reaches org artifacts and its own agent’s editors artifacts',
      session({ visibility: 'editors' }),
      undefined,
      ['orgAlice', 'orgVera', 'orgOwnerless', 'editorsA1']
    ],
    [
      'an editors session of another agent reaches only org artifacts',
      session({ visibility: 'editors', agentId: A2 }),
      undefined,
      ['orgAlice', 'orgVera', 'orgOwnerless']
    ],
    [
      'an external session reaches only its own scope',
      session({ ...settledS1, externalResolution: 'settled' }),
      undefined,
      ['externalAlice']
    ],
    [
      'an unresolved external session reaches nothing',
      session({ ...settledS1, externalResolution: 'pending' }),
      undefined,
      []
    ],
    ["another organization's session reaches nothing", session({ orgId: OTHER_ORG }), undefined, []]
  ]
  it.each(table)('%s', (_label, reach, owner, expected) => {
    const reached = (Object.keys(artifacts) as ArtifactName[]).filter((name) =>
      agentCanReachArtifact(artifacts[name], reach, owner)
    )
    expect(reached).toEqual(expected)
  })
})

describe('artifactAudienceFromSession (artifacts.md §6.1)', () => {
  const origin = (patch: Partial<ArtifactOriginSession>): ArtifactOriginSession => ({
    orgId: ORG,
    agentId: A1,
    visibility: 'org',
    ownerIdentity: null,
    externalProvider: null,
    externalScopeId: null,
    externalResolution: null,
    ...patch
  })
  const member: ArtifactInitiator = { kind: 'member', userId: 'alice' }
  const nonMember: ArtifactInitiator = { kind: 'nonMember' }
  const targeted = (createdByUserId: string | null): ArtifactInitiator => ({
    kind: 'trigger',
    createdByUserId,
    headless: false
  })
  const headless = (createdByUserId: string | null): ArtifactInitiator => ({
    kind: 'trigger',
    createdByUserId,
    headless: true
  })
  const external = (resolution: 'settled' | 'pending') =>
    origin({ visibility: 'external', externalProvider: 'slack', externalScopeId: S1, externalResolution: resolution })
  const slackScope = { externalProvider: 'slack', externalScopeId: S1 }
  const table: Array<[string, ArtifactOriginSession, ArtifactInitiator, Partial<ArtifactAudience>]> = [
    [
      'a private session keeps its owner, linked or not',
      origin({ visibility: 'private', ownerIdentity: 'slack:T1:UA' }),
      nonMember,
      { visibility: 'private', ownerIdentity: 'slack:T1:UA' }
    ],
    [
      'a private session with no owner leaves organization owners',
      origin({ visibility: 'private' }),
      member,
      { visibility: 'private' }
    ],
    ['an org session started by a member', origin({}), member, { visibility: 'org', ownerIdentity: 'user:alice' }],
    ['an org session started by a non-member has no owner', origin({}), nonMember, { visibility: 'org' }],
    [
      'an external session copies its scope',
      external('settled'),
      member,
      { visibility: 'external', ownerIdentity: 'user:alice', ...slackScope }
    ],
    [
      'an external session started by a guest has no owner',
      external('settled'),
      nonMember,
      { visibility: 'external', ...slackScope }
    ],
    [
      'an unresolved external session narrows to the owner',
      external('pending'),
      member,
      { visibility: 'private', ownerIdentity: 'user:alice' }
    ],
    [
      'an unresolved external session with no owner leaves organization owners',
      external('pending'),
      nonMember,
      { visibility: 'private' }
    ],
    [
      'an editors session records its agent and no owner',
      origin({ visibility: 'editors', ownerIdentity: 'email:outside@example.test' }),
      member,
      { visibility: 'editors', editorsAgentId: A1 }
    ],
    [
      'a targeted trigger is owned by its creator',
      origin({}),
      targeted('u1'),
      { visibility: 'org', ownerIdentity: 'user:u1' }
    ],
    ['a targeted trigger whose creator is gone has no owner', origin({}), targeted(null), { visibility: 'org' }],
    [
      'a targeted trigger into an external conversation copies the scope',
      external('settled'),
      targeted('u1'),
      { visibility: 'external', ownerIdentity: 'user:u1', ...slackScope }
    ],
    [
      'a trigger delivered into a private conversation follows that session',
      origin({ visibility: 'private', ownerIdentity: 'user:dm-owner' }),
      targeted('u1'),
      { visibility: 'private', ownerIdentity: 'user:dm-owner' }
    ],
    [
      'a headless trigger is private to its creator',
      origin({}),
      headless('u1'),
      { visibility: 'private', ownerIdentity: 'user:u1' }
    ],
    [
      'a headless trigger whose creator is gone leaves organization owners',
      origin({}),
      headless(null),
      { visibility: 'private' }
    ]
  ]
  it.each(table)('%s', (_label, session, initiator, expected) => {
    expect(artifactAudienceFromSession(session, initiator)).toEqual(audience(expected))
  })

  it('leaves an artifact with no owner and no copyable audience to organization owners only', () => {
    const derived = artifactAudienceFromSession(origin({}), headless(null))
    expect(VIEWERS.filter((viewer) => canViewArtifact(derived, viewers[viewer]))).toEqual(['olga'])
  })
})
