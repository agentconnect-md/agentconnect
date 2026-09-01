import { describe, expect, it } from 'vitest'
import type { AgentApprovalRoute } from '@agentconnect.md/protocol'
import type { SlackIdentity } from '../github/logto-identity.js'
import type {
  AgentRecord,
  BotRecord,
  IntegrationRecord,
  OrgMemberRecord,
  SessionMetaRecord
} from '../persistence/ports.js'
import { resolveApprovalRoute, type ApprovalRouteDeps } from './approvalRoute.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_A = '33333333-3333-4333-8333-333333333333'
const INTEGRATION_B = '44444444-4444-4444-8444-444444444444'
const ORG = 'org-1'
const TEAM_A = 'T0AAA'
const TEAM_B = 'T0BBB'

interface World {
  agent?: Partial<AgentRecord>
  members?: Array<Partial<OrgMemberRecord> & { userId: string }>
  session?: Partial<SessionMetaRecord> | null
  // consoleUserId → linked Slack identity (null ⇒ unlinked)
  links?: Record<string, SlackIdentity | null>
  integrations?: Array<{ id: string; botId: string; platform?: string }>
  bots?: Record<string, Partial<BotRecord>>
  identityAbsent?: boolean
}

function deps(world: World): ApprovalRouteDeps {
  const agent = {
    id: AGENT_ID,
    orgId: ORG,
    visibility: 'org',
    sharedWith: [],
    createdByUserId: null,
    ...world.agent
  } as AgentRecord
  const members = (world.members ?? []).map(
    (m) => ({ role: 'collaborator', displayName: null, email: null, ...m }) as OrgMemberRecord
  )
  const integrations = (world.integrations ?? [{ id: INTEGRATION_A, botId: 'bot-a' }]).map(
    (i) => ({ orgId: ORG, agentId: AGENT_ID, platform: 'slack', ...i }) as unknown as IntegrationRecord
  )
  const bots: Record<string, Partial<BotRecord>> = world.bots ?? { 'bot-a': { teamId: TEAM_A, revokedAt: null } }
  return {
    agent: { getUnscoped: async (id) => (String(id) === AGENT_ID ? agent : null) },
    session: {
      getUnscoped: async () =>
        world.session === null || world.session === undefined
          ? null
          : ({ id: 'sess-1', agentId: AGENT_ID, ownerIdentity: null, ...world.session } as SessionMetaRecord)
    },
    integration: { activeForAgents: async () => integrations },
    bot: {
      get: async (_org, botId) => {
        const bot = bots[String(botId)]
        return bot ? ({ platform: 'slack', revokedAt: null, ...bot } as BotRecord) : null
      }
    },
    users: {
      listMembers: async () => members,
      getOidcSubject: async (userId) => `sub:${userId}`
    },
    ...(world.identityAbsent
      ? {}
      : { identity: { slackIdentityFor: async (sub) => world.links?.[sub.slice(4)] ?? null } })
  }
}

function routeReq(over: Partial<AgentApprovalRoute> = {}): AgentApprovalRoute {
  return { agentId: AGENT_ID, requestId: REQUEST_ID, integrationIds: [INTEGRATION_A], ...over }
}

const linked = (userId: string, teamId = TEAM_A): SlackIdentity => ({ teamId, userId })

describe('resolveApprovalRoute — route form', () => {
  it('rung 1: the turn owner wins when linked and an editor', async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ requesterId: 'U0OWNER' }),
      deps({
        members: [
          { userId: 'u-other', displayName: 'Other' },
          { userId: 'u-owner', displayName: 'Owner' }
        ],
        links: { 'u-other': linked('U0OTHER'), 'u-owner': linked('U0OWNER') }
      })
    )
    expect(routed.target).toMatchObject({
      integrationId: INTEGRATION_A,
      teamId: TEAM_A,
      userId: 'U0OWNER',
      consoleUserId: 'u-owner',
      displayName: 'Owner'
    })
  })

  it('rung 2: a slack session owner wins only in the matching workspace', async () => {
    const world: World = {
      members: [{ userId: 'u-owner' }],
      links: { 'u-owner': linked('U0OWNER') },
      session: { ownerIdentity: `slack:${TEAM_A}:U0OWNER` }
    }
    const hit = await resolveApprovalRoute(routeReq({ sessionId: 'sess-1' }), deps(world))
    expect(hit.target?.userId).toBe('U0OWNER')
    const mismatch = await resolveApprovalRoute(
      routeReq({ sessionId: 'sess-1' }),
      deps({ ...world, session: { ownerIdentity: `slack:${TEAM_B}:U0OWNER` } })
    )
    expect(mismatch.target).toBeUndefined()
  })

  it('rung 2: a console-user session owner resolves through their own link', async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ sessionId: 'sess-1' }),
      deps({
        members: [{ userId: 'u-web' }],
        links: { 'u-web': linked('U0WEB') },
        session: { ownerIdentity: 'user:u-web' }
      })
    )
    expect(routed.target).toMatchObject({ userId: 'U0WEB', consoleUserId: 'u-web' })
  })

  it('rung 3: restricted audience picks in sharedWith order, skipping the unlinked', async () => {
    const routed = await resolveApprovalRoute(
      routeReq(),
      deps({
        agent: { visibility: 'restricted', sharedWith: ['u-first', 'u-second'] },
        members: [{ userId: 'u-second', displayName: 'Second' }, { userId: 'u-first' }],
        links: { 'u-second': linked('U0SECOND') }
      })
    )
    expect(routed.target).toMatchObject({ userId: 'U0SECOND', consoleUserId: 'u-second' })
  })

  it('rung 4: the creator wins only as an ordinary editor', async () => {
    const world: World = {
      agent: { visibility: 'restricted', sharedWith: ['u-creator'], createdByUserId: 'u-creator' },
      members: [{ userId: 'u-creator' }],
      links: { 'u-creator': linked('U0CREATOR') }
    }
    expect((await resolveApprovalRoute(routeReq(), deps(world))).target?.userId).toBe('U0CREATOR')
    // Creator dropped from sharedWith ⇒ no implicit right, no DM.
    const unshared = deps({ ...world, agent: { ...world.agent, sharedWith: [] } })
    expect((await resolveApprovalRoute(routeReq(), unshared)).target).toBeUndefined()
  })

  it('a viewer never receives the DM', async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ requesterId: 'U0VIEWER' }),
      deps({ members: [{ userId: 'u-viewer', role: 'viewer' }], links: { 'u-viewer': linked('U0VIEWER') } })
    )
    expect(routed.target).toBeUndefined()
  })

  it('a token-installed bot anchors on its reported workspaceId — teamId is platform-app-only', async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ requesterId: 'U0OWNER' }),
      deps({
        members: [{ userId: 'u-owner', displayName: 'Owner' }],
        links: { 'u-owner': linked('U0OWNER') },
        bots: { 'bot-a': { teamId: null, workspaceId: TEAM_A } }
      })
    )
    expect(routed.target).toMatchObject({ teamId: TEAM_A, userId: 'U0OWNER', consoleUserId: 'u-owner' })
    // …and with neither, the integration is skipped fail-closed.
    const anchorless = await resolveApprovalRoute(
      routeReq({ requesterId: 'U0OWNER' }),
      deps({
        members: [{ userId: 'u-owner' }],
        links: { 'u-owner': linked('U0OWNER') },
        bots: { 'bot-a': { teamId: null, workspaceId: null } }
      })
    )
    expect(anchorless.target).toBeUndefined()
  })

  it('an identity linked to another workspace never matches', async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ requesterId: 'U0OWNER' }),
      deps({ members: [{ userId: 'u-owner' }], links: { 'u-owner': linked('U0OWNER', TEAM_B) } })
    )
    expect(routed.target).toBeUndefined()
  })

  it('over the audience cap, Slack-id rungs are skipped but the creator still resolves', async () => {
    const members = Array.from({ length: 201 }, (_, i) => ({ userId: `u-${i}` }))
    const world: World = {
      agent: { createdByUserId: 'u-7' },
      members,
      links: { 'u-0': linked('U0ZERO'), 'u-7': linked('U0CREATOR') }
    }
    const viaTurnOwner = await resolveApprovalRoute(routeReq({ requesterId: 'U0ZERO' }), deps({ ...world, agent: {} }))
    expect(viaTurnOwner.target).toBeUndefined()
    const viaCreator = await resolveApprovalRoute(routeReq(), deps(world))
    expect(viaCreator.target).toMatchObject({ userId: 'U0CREATOR', consoleUserId: 'u-7' })
  })

  it('walks workspaces in the given order and takes the first hit', async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ requesterId: 'U0B', integrationIds: [INTEGRATION_A, INTEGRATION_B] }),
      deps({
        members: [{ userId: 'u-b' }],
        links: { 'u-b': linked('U0B', TEAM_B) },
        integrations: [
          { id: INTEGRATION_A, botId: 'bot-a' },
          { id: INTEGRATION_B, botId: 'bot-b' }
        ],
        bots: { 'bot-a': { teamId: TEAM_A }, 'bot-b': { teamId: TEAM_B } }
      })
    )
    expect(routed.target).toMatchObject({ integrationId: INTEGRATION_B, teamId: TEAM_B, userId: 'U0B' })
  })

  it('fails closed: no sign-in, unknown agent, revoked bot, foreign integration', async () => {
    const base: World = { members: [{ userId: 'u-owner' }], links: { 'u-owner': linked('U0OWNER') } }
    const req = routeReq({ requesterId: 'U0OWNER' })
    expect((await resolveApprovalRoute(req, deps({ ...base, identityAbsent: true }))).target).toBeUndefined()
    expect((await resolveApprovalRoute({ ...req, agentId: REQUEST_ID }, deps(base))).target).toBeUndefined()
    expect(
      (await resolveApprovalRoute(req, deps({ ...base, bots: { 'bot-a': { teamId: TEAM_A, revokedAt: new Date() } } })))
        .target
    ).toBeUndefined()
    expect(
      (await resolveApprovalRoute(routeReq({ requesterId: 'U0OWNER', integrationIds: [INTEGRATION_B] }), deps(base)))
        .target
    ).toBeUndefined()
    expect((await resolveApprovalRoute(req, deps(base), 'org-other')).target).toBeUndefined()
  })
})

describe('resolveApprovalRoute — verify form', () => {
  const verifyReq = (consoleUserId = 'u-owner', userId = 'U0OWNER', teamId = TEAM_A) =>
    routeReq({ verify: { integrationId: INTEGRATION_A, teamId, userId, consoleUserId } })

  it('allows a still-eligible editor whose link matches the actor pair', async () => {
    const routed = await resolveApprovalRoute(
      verifyReq(),
      deps({ members: [{ userId: 'u-owner', displayName: 'Owner' }], links: { 'u-owner': linked('U0OWNER') } })
    )
    expect(routed).toMatchObject({ allowed: true, displayName: 'Owner' })
  })

  it('refuses when the member left, was demoted, unlinked, or the pair moved', async () => {
    const worlds: World[] = [
      { members: [], links: { 'u-owner': linked('U0OWNER') } },
      { members: [{ userId: 'u-owner', role: 'viewer' }], links: { 'u-owner': linked('U0OWNER') } },
      { members: [{ userId: 'u-owner' }], links: {} },
      { members: [{ userId: 'u-owner' }], links: { 'u-owner': linked('U0OTHER') } },
      { members: [{ userId: 'u-owner' }], links: { 'u-owner': linked('U0OWNER', TEAM_B) } }
    ]
    for (const world of worlds) {
      expect((await resolveApprovalRoute(verifyReq(), deps(world))).allowed).toBe(false)
    }
  })

  it('allows through a token-installed bot anchored on workspaceId', async () => {
    const routed = await resolveApprovalRoute(
      verifyReq(),
      deps({
        members: [{ userId: 'u-owner' }],
        links: { 'u-owner': linked('U0OWNER') },
        bots: { 'bot-a': { teamId: null, workspaceId: TEAM_A } }
      })
    )
    expect(routed.allowed).toBe(true)
  })

  it('refuses a workspace that does not match the integration bot', async () => {
    const routed = await resolveApprovalRoute(
      verifyReq('u-owner', 'U0OWNER', TEAM_B),
      deps({ members: [{ userId: 'u-owner' }], links: { 'u-owner': linked('U0OWNER') } })
    )
    expect(routed.allowed).toBe(false)
  })
})
