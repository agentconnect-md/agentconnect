import { describe, expect, it } from 'vitest'
import type { AgentApprovalRoute } from '@agentconnect.md/protocol'
import type { FeishuIdentity, LinkedChatIdentity, SlackIdentity } from '../github/logto-identity.js'
import { createFeishuCpProvider } from '../platforms/feishu/provider.js'
import { buildCpPlatformRegistry } from '../platforms/registry.js'
import { createSlackCpProvider } from '../platforms/slack/provider.js'
import { createGoogleChatCpProvider } from '../platforms/googlechat/provider.js'
import { createMsTeamsCpProvider } from '../platforms/msteams/provider.js'
import { ComputerPolicySchema } from '@agentconnect.md/protocol'
import type {
  AgentRecord,
  BotRecord,
  ComputerRecord,
  IntegrationRecord,
  OrgMemberRecord,
  SessionMetaRecord
} from '../persistence/ports.js'
import { OrgId } from '../domain/ids.js'
import { resolveApprovalRoute, type ApprovalRouteDeps } from './approvalRoute.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_A = '33333333-3333-4333-8333-333333333333'
const INTEGRATION_B = '44444444-4444-4444-8444-444444444444'
const ORG = 'org-1'
const TEAM_A = 'T0AAA'
const TEAM_B = 'T0BBB'
const COMPUTER_ID = '55555555-5555-4555-8555-555555555555'

const PLATFORMS = buildCpPlatformRegistry([
  createSlackCpProvider({}),
  createFeishuCpProvider({}),
  createGoogleChatCpProvider(),
  createMsTeamsCpProvider()
])

interface World {
  agent?: Partial<AgentRecord>
  members?: Array<Partial<OrgMemberRecord> & { userId: string }>
  session?: Partial<SessionMetaRecord> | null
  // consoleUserId → linked Slack identity (null ⇒ unlinked)
  links?: Record<string, SlackIdentity | null>
  integrations?: Array<{ id: string; botId: string; platform?: string }>
  bots?: Record<string, Partial<BotRecord>>
  identityAbsent?: boolean
  // consoleUserId → linked Feishu/Lark identities
  feishuLinks?: Record<string, FeishuIdentity[]>
  computer?: Partial<ComputerRecord>
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
    platforms: PLATFORMS,
    computer: {
      getUnscoped: async (id) =>
        world.computer && String(id) === COMPUTER_ID
          ? ({
              id: COMPUTER_ID,
              orgId: ORG,
              ownerUserId: 'u-owner',
              revokedAt: null,
              ...world.computer
            } as ComputerRecord)
          : null
    },
    ...(world.identityAbsent
      ? {}
      : { identity: { chatIdentitiesFor: async (sub: string) => chatIdentities(world, sub) } })
  }
}

/** A member's linked chat identities, as the sign-in provider reports them: the world's Slack link and Feishu links. */
function chatIdentities(world: World, sub: string): LinkedChatIdentity[] {
  const slack = world.links?.[sub.slice(4)]
  const feishu = world.feishuLinks?.[sub.slice(4)] ?? []
  return [
    ...(slack ? [{ platform: 'slack', tenant: slack.teamId, memberId: slack.userId }] : []),
    ...feishu.map((f) => ({ platform: 'feishu', tenant: f.region, memberId: f.unionId }))
  ]
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

  it.each([
    { requesterId: 'U0OWNER', ownerIdentity: null },
    { requesterId: undefined, ownerIdentity: `slack:${TEAM_A}:U0OWNER` },
    { requesterId: undefined, ownerIdentity: 'user:u-owner' }
  ])(
    'routes to an unselected organization owner through requester/session ownership: %j',
    async ({ requesterId, ownerIdentity }) => {
      const routed = await resolveApprovalRoute(
        routeReq({ requesterId, sessionId: 'sess-1' }),
        deps({
          agent: { visibility: 'restricted', sharedWith: ['u-selected'] },
          members: [{ userId: 'u-owner', role: 'owner' }, { userId: 'u-selected' }],
          links: { 'u-owner': linked('U0OWNER'), 'u-selected': linked('U0SELECTED') },
          session: { ownerIdentity }
        })
      )
      expect(routed.target).toMatchObject({ userId: 'U0OWNER', consoleUserId: 'u-owner' })
    }
  )

  it.each([true, false])(
    'never uses an unrelated owner as a fallback (selected member linked: %s)',
    async (selectedLinked) => {
      const routed = await resolveApprovalRoute(
        routeReq(),
        deps({
          agent: { visibility: 'restricted', sharedWith: ['u-selected'] },
          members: [{ userId: 'u-owner', role: 'owner' }, { userId: 'u-selected' }],
          links: { 'u-owner': linked('U0OWNER'), 'u-selected': selectedLinked ? linked('U0SELECTED') : null }
        })
      )
      expect(routed.target?.consoleUserId).toBe(selectedLinked ? 'u-selected' : undefined)
    }
  )

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

describe('resolveApprovalRoute — one named console user', () => {
  const world: World = {
    members: [
      { userId: 'u-creator', displayName: 'Creator' },
      { userId: 'u-named', displayName: 'Named' }
    ],
    agent: { createdByUserId: 'u-creator' },
    links: { 'u-creator': linked('U0CREATOR'), 'u-named': linked('U0NAMED', TEAM_B) },
    integrations: [
      { id: INTEGRATION_A, botId: 'bot-a' },
      { id: INTEGRATION_B, botId: 'bot-b' }
    ],
    bots: { 'bot-a': { teamId: TEAM_A }, 'bot-b': { teamId: TEAM_B } }
  }

  it('routes to that user in the workspace their link names, never down the chain', async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ consoleUserId: 'u-named', integrationIds: [INTEGRATION_A, INTEGRATION_B], requesterId: 'U0CREATOR' }),
      deps(world)
    )
    expect(routed.target).toEqual({
      integrationId: INTEGRATION_B,
      teamId: TEAM_B,
      userId: 'U0NAMED',
      consoleUserId: 'u-named',
      displayName: 'Named'
    })
  })

  it('answers nobody for a user who is unlinked there, not an editor, or not a member', async () => {
    const onlyA = routeReq({ consoleUserId: 'u-named', integrationIds: [INTEGRATION_A] })
    expect((await resolveApprovalRoute(onlyA, deps(world))).target).toBeUndefined()
    const restricted = deps({ ...world, agent: { visibility: 'restricted', sharedWith: ['u-creator'] } })
    expect(
      (await resolveApprovalRoute(routeReq({ consoleUserId: 'u-named', integrationIds: [INTEGRATION_B] }), restricted))
        .target
    ).toBeUndefined()
    expect(
      (await resolveApprovalRoute(routeReq({ consoleUserId: 'u-gone', integrationIds: [INTEGRATION_A] }), deps(world)))
        .target
    ).toBeUndefined()
  })
})

// assistant-mode.md §5.1: the creator while they may edit the agent, else the editor who joined first, else nobody.
describe('resolveApprovalRoute — the derived responsible user', () => {
  const joined = (day: number) => new Date(Date.UTC(2026, 0, day))
  const world: World = {
    members: [
      { userId: 'u-late', displayName: 'Late', joinedAt: joined(9) },
      { userId: 'u-creator', displayName: 'Creator', joinedAt: joined(5) },
      { userId: 'u-early', displayName: 'Early', joinedAt: joined(1) }
    ],
    agent: { createdByUserId: 'u-creator' },
    links: { 'u-late': linked('U0LATE'), 'u-creator': linked('U0CREATOR'), 'u-early': linked('U0EARLY') }
  }
  const responsible = async (w: World) =>
    (await resolveApprovalRoute(routeReq({ responsible: true, requesterId: 'U0LATE' }), deps(w))).target

  it('is the creator while they may edit the agent, never the requester or the chain', async () => {
    expect(await responsible(world)).toMatchObject({ userId: 'U0CREATOR', consoleUserId: 'u-creator' })
  })

  it('is the editor who joined first once the creator left or may no longer edit, whatever the list order', async () => {
    const left = { ...world, members: world.members!.filter((m) => m.userId !== 'u-creator') }
    expect(await responsible(left)).toMatchObject({ userId: 'U0EARLY', consoleUserId: 'u-early' })
    const demoted = {
      ...world,
      members: world.members!.map((m) => (m.userId === 'u-creator' ? { ...m, role: 'viewer' as const } : m))
    }
    expect(await responsible(demoted)).toMatchObject({ consoleUserId: 'u-early' })
    const notShared = { ...world, agent: { ...world.agent, visibility: 'restricted' as const, sharedWith: ['u-late'] } }
    expect(await responsible(notShared)).toMatchObject({ consoleUserId: 'u-late' })
  })

  it('answers nobody when that person is unlinked there, or no member may edit the agent', async () => {
    expect(await responsible({ ...world, links: { ...world.links, 'u-creator': null } })).toBeUndefined()
    const viewers = { ...world, members: world.members!.map((m) => ({ ...m, role: 'viewer' as const })) }
    expect(await responsible(viewers)).toBeUndefined()
  })
})

describe('resolveApprovalRoute — verify form', () => {
  it('matches Google Chat actors only to linked Agent editors', async () => {
    const d = deps({
      integrations: [{ id: INTEGRATION_A, botId: 'google-bot', platform: 'googlechat' }],
      bots: { 'google-bot': { platform: 'googlechat', revokedAt: null } },
      members: [
        { userId: 'u-editor', displayName: 'Editor' },
        { userId: 'u-viewer', role: 'viewer' }
      ]
    })
    d.identity = {
      chatIdentitiesFor: async (sub) => [
        { platform: 'googlechat', tenant: 'global', memberId: sub === 'sub:u-editor' ? 'users/123' : 'users/456' }
      ]
    }
    const check = (userId: string) =>
      resolveApprovalRoute(routeReq({ verify: { integrationId: INTEGRATION_A, userId } }), d)
    expect(await check('users/123')).toMatchObject({ allowed: true, displayName: 'Editor' })
    expect(await check('users/456')).toMatchObject({ allowed: false, linked: true })
    expect(await check('users/789')).toMatchObject({ allowed: false, linked: false })
  })

  it('routes a Teams turn to the editor linked by Microsoft account, and rechecks that pair', async () => {
    const asker = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    const editor = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    const d = deps({
      integrations: [{ id: INTEGRATION_A, botId: 'teams-bot', platform: 'msteams' }],
      bots: { 'teams-bot': { platform: 'msteams', revokedAt: null } },
      agent: { createdByUserId: 'u-editor' },
      members: [
        { userId: 'u-asker', role: 'viewer' },
        { userId: 'u-editor', displayName: 'Editor' }
      ]
    })
    d.identity = {
      chatIdentitiesFor: async (sub) => [
        { platform: 'msteams', tenant: 'global', memberId: sub === 'sub:u-editor' ? editor : asker }
      ]
    }
    // The asker may not edit, so the chain falls through to the creator, linked by their Entra object id.
    const routed = await resolveApprovalRoute(routeReq({ requesterId: asker }), d)
    expect(routed.target).toEqual({
      integrationId: INTEGRATION_A,
      teamId: 'global',
      userId: editor,
      consoleUserId: 'u-editor',
      displayName: 'Editor'
    })
    const verify = (userId: string) =>
      resolveApprovalRoute(
        routeReq({ verify: { integrationId: INTEGRATION_A, teamId: 'global', userId, consoleUserId: 'u-editor' } }),
        d
      )
    expect(await verify(editor)).toMatchObject({ allowed: true, displayName: 'Editor' })
    expect(await verify(asker)).toMatchObject({ allowed: false })
  })

  const verifyReq = (consoleUserId = 'u-owner', userId = 'U0OWNER', teamId = TEAM_A) =>
    routeReq({ verify: { integrationId: INTEGRATION_A, teamId, userId, consoleUserId } })

  it.each(['collaborator', 'owner'] as const)(
    'allows a still-eligible %s whose link matches the actor pair',
    async (role) => {
      const routed = await resolveApprovalRoute(
        verifyReq(),
        deps({
          agent: { visibility: 'restricted', sharedWith: role === 'owner' ? ['u-selected'] : ['u-owner'] },
          members: [{ userId: 'u-owner', role, displayName: 'Owner' }],
          links: { 'u-owner': linked('U0OWNER') }
        })
      )
      expect(routed).toMatchObject({ allowed: true, displayName: 'Owner' })
    }
  )

  it('refuses when the member left, was demoted, unlinked, or the pair moved', async () => {
    const worlds: World[] = [
      { members: [], links: { 'u-owner': linked('U0OWNER') } },
      { members: [{ userId: 'u-owner', role: 'viewer' }], links: { 'u-owner': linked('U0OWNER') } },
      { members: [{ userId: 'u-owner', role: 'collaborator' }], links: { 'u-owner': linked('U0OWNER') } },
      { members: [{ userId: 'u-owner', role: 'owner' }], links: {} },
      { members: [{ userId: 'u-owner', role: 'owner' }], links: { 'u-owner': linked('U0OTHER') } },
      { members: [{ userId: 'u-owner', role: 'owner' }], links: { 'u-owner': linked('U0OWNER', TEAM_B) } }
    ]
    for (const world of worlds) {
      const current = deps({ ...world, agent: { visibility: 'restricted', sharedWith: ['u-selected'] } })
      expect((await resolveApprovalRoute(verifyReq(), current)).allowed).toBe(false)
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

describe('resolveApprovalRoute — a chat member, named by no console user (chat-actor-v1)', () => {
  const actorReq = (userId: string, teamId?: string) =>
    routeReq({ verify: { integrationId: INTEGRATION_A, userId, ...(teamId ? { teamId } : {}) } })
  const world: World = {
    members: [
      { userId: 'u-editor', displayName: 'Editor' },
      { userId: 'u-viewer', role: 'viewer' }
    ],
    links: { 'u-editor': linked('U0EDITOR'), 'u-viewer': linked('U0VIEWER'), 'u-gone': linked('U0GONE') }
  }

  it('allows an editor’s linked pair in the integration’s own workspace, naming them', async () => {
    await expect(resolveApprovalRoute(actorReq('U0EDITOR'), deps(world))).resolves.toEqual({
      requestId: REQUEST_ID,
      allowed: true,
      displayName: 'Editor'
    })
    expect((await resolveApprovalRoute(actorReq('U0EDITOR', TEAM_A), deps(world))).allowed).toBe(true)
    expect((await resolveApprovalRoute(actorReq('U0EDITOR', TEAM_B), deps(world))).allowed).toBe(false)
  })

  it('refuses anyone else, saying whether they are linked to a member at all', async () => {
    await expect(resolveApprovalRoute(actorReq('U0VIEWER'), deps(world))).resolves.toEqual({
      requestId: REQUEST_ID,
      allowed: false,
      linked: true
    })
    // Linked to someone who is no longer a member, or to no one: not linked as far as this organization knows.
    for (const user of ['U0GONE', 'U0NOBODY'])
      expect(await resolveApprovalRoute(actorReq(user), deps(world))).toEqual({
        requestId: REQUEST_ID,
        allowed: false,
        linked: false
      })
    // A link in another workspace is not this pair.
    const elsewhere = deps({ ...world, links: { 'u-editor': linked('U0EDITOR', TEAM_B) } })
    expect((await resolveApprovalRoute(actorReq('U0EDITOR'), elsewhere)).allowed).toBe(false)
  })

  it('refuses over the editor cap, and leaves "linked" unsaid when only the editors could be scanned', async () => {
    const editors = Array.from({ length: 201 }, (_, i) => ({ userId: `u-${i}` }))
    const overCap = deps({ members: editors, links: { 'u-3': linked('U0THREE') } })
    expect(await resolveApprovalRoute(actorReq('U0THREE'), overCap)).toEqual({ requestId: REQUEST_ID, allowed: false })
    const viewers = Array.from({ length: 201 }, (_, i) => ({ userId: `v-${i}`, role: 'viewer' as const }))
    const manyMembers = deps({
      members: [{ userId: 'u-editor' }, ...viewers],
      links: { 'u-editor': linked('U0EDITOR'), 'v-1': linked('U0VIEWER') }
    })
    expect((await resolveApprovalRoute(actorReq('U0EDITOR'), manyMembers)).allowed).toBe(true)
    expect(await resolveApprovalRoute(actorReq('U0VIEWER'), manyMembers)).toEqual({
      requestId: REQUEST_ID,
      allowed: false
    })
  })

  it('fails closed without sign-in or for an integration with no workspace', async () => {
    expect((await resolveApprovalRoute(actorReq('U0EDITOR'), deps({ ...world, identityAbsent: true }))).allowed).toBe(
      false
    )
    const unanchored = deps({ ...world, bots: { 'bot-a': { teamId: null, workspaceId: null } } })
    expect((await resolveApprovalRoute(actorReq('U0EDITOR'), unanchored)).allowed).toBe(false)
  })

  it('still needs the workspace for a verify that names a console user', async () => {
    const named = routeReq({ verify: { integrationId: INTEGRATION_A, userId: 'U0EDITOR', consoleUserId: 'u-editor' } })
    expect((await resolveApprovalRoute(named, deps(world))).allowed).toBe(false)
  })
})

describe('resolveApprovalRoute — a Feishu/Lark chat member, matched by union_id (chat-actor-v1)', () => {
  const actorReq = (unionId: string) => routeReq({ verify: { integrationId: INTEGRATION_A, userId: unionId } })
  const feishuWorld = (over: Partial<World> = {}): World => ({
    integrations: [{ id: INTEGRATION_A, botId: 'bot-f', platform: 'feishu' }],
    bots: { 'bot-f': { platform: 'feishu', feishuRegion: 'feishu', teamId: null, revokedAt: null } },
    members: [
      { userId: 'u-editor', displayName: 'Editor' },
      { userId: 'u-viewer', role: 'viewer' }
    ],
    feishuLinks: {
      'u-editor': [{ region: 'feishu', unionId: 'on_editor' }],
      'u-viewer': [{ region: 'feishu', unionId: 'on_viewer' }]
    },
    ...over
  })

  it('allows an editor whose linked union_id is the clicker’s, naming them', async () => {
    await expect(resolveApprovalRoute(actorReq('on_editor'), deps(feishuWorld()))).resolves.toEqual({
      requestId: REQUEST_ID,
      allowed: true,
      displayName: 'Editor'
    })
  })

  it('refuses a linked member who is not an editor, and says whether anyone is linked at all', async () => {
    expect(await resolveApprovalRoute(actorReq('on_viewer'), deps(feishuWorld()))).toEqual({
      requestId: REQUEST_ID,
      allowed: false,
      linked: true
    })
    expect(await resolveApprovalRoute(actorReq('on_nobody'), deps(feishuWorld()))).toEqual({
      requestId: REQUEST_ID,
      allowed: false,
      linked: false
    })
  })

  it('matches only within the bot’s region', async () => {
    const lark = feishuWorld({ feishuLinks: { 'u-editor': [{ region: 'lark', unionId: 'on_editor' }] } })
    expect(await resolveApprovalRoute(actorReq('on_editor'), deps(lark))).toEqual({
      requestId: REQUEST_ID,
      allowed: false,
      linked: false
    })
    const larkBot = feishuWorld({
      bots: { 'bot-f': { platform: 'feishu', feishuRegion: 'lark', teamId: null, revokedAt: null } },
      feishuLinks: { 'u-editor': [{ region: 'lark', unionId: 'on_editor' }] }
    })
    expect((await resolveApprovalRoute(actorReq('on_editor'), deps(larkBot))).allowed).toBe(true)
  })

  it('fails closed over the editor cap, without sign-in, and for a revoked bot', async () => {
    const editors = Array.from({ length: 201 }, (_, i) => ({ userId: `u-${i}` }))
    const overCap = feishuWorld({
      members: editors,
      feishuLinks: { 'u-3': [{ region: 'feishu', unionId: 'on_three' }] }
    })
    expect(await resolveApprovalRoute(actorReq('on_three'), deps(overCap))).toEqual({
      requestId: REQUEST_ID,
      allowed: false
    })
    expect(
      (await resolveApprovalRoute(actorReq('on_editor'), deps(feishuWorld({ identityAbsent: true })))).allowed
    ).toBe(false)
    const revoked = feishuWorld({
      bots: { 'bot-f': { platform: 'feishu', feishuRegion: 'feishu', revokedAt: new Date() } }
    })
    expect((await resolveApprovalRoute(actorReq('on_editor'), deps(revoked))).allowed).toBe(false)
  })

  it('never matches a Slack link against a Feishu member, or a platform its provider cannot match', async () => {
    const slackOnly = feishuWorld({ feishuLinks: {}, links: { 'u-editor': linked('on_editor') } })
    expect((await resolveApprovalRoute(actorReq('on_editor'), deps(slackOnly))).allowed).toBe(false)
    const telegram = feishuWorld({ integrations: [{ id: INTEGRATION_A, botId: 'bot-f', platform: 'telegram' }] })
    expect((await resolveApprovalRoute(actorReq('on_editor'), deps(telegram))).allowed).toBe(false)
  })
})

describe('resolveApprovalRoute — a computer-use approval (computer-use.md §4.2)', () => {
  const world: World = {
    // A restricted agent nobody here was given: only the organization owner may edit it.
    agent: { visibility: 'restricted', sharedWith: [] },
    members: [
      { userId: 'u-owner', displayName: 'Owner' },
      { userId: 'u-member', displayName: 'Member' },
      { userId: 'u-admin', displayName: 'Admin', role: 'owner' }
    ],
    links: { 'u-owner': linked('U0OWNER'), 'u-member': linked('U0MEMBER'), 'u-admin': linked('U0ADMIN') },
    computer: { policy: ComputerPolicySchema.parse({ allowedMembers: ['u-member'] }) }
  }
  const verify = (userId: string, consoleUserId?: string) => ({
    integrationId: INTEGRATION_A,
    teamId: TEAM_A,
    userId,
    ...(consoleUserId ? { consoleUserId } : {})
  })

  it("takes the Computer's allowed members and its owner as the approvers, in place of the agent's editors", async () => {
    const as = async (userId: string, consoleUserId?: string, computerId: string | null = COMPUTER_ID) =>
      (
        await resolveApprovalRoute(
          routeReq({ verify: verify(userId, consoleUserId), ...(computerId ? { computerId } : {}) }),
          deps(world)
        )
      ).allowed
    expect(await as('U0MEMBER', 'u-member')).toBe(true)
    expect(await as('U0OWNER', 'u-owner')).toBe(true)
    expect(await as('U0ADMIN', 'u-admin')).toBe(false)
    expect(await as('U0MEMBER')).toBe(true)
    expect(await as('U0ADMIN')).toBe(false)
    // Without the Computer, the agent's editors decide as before.
    expect(await as('U0MEMBER', 'u-member', null)).toBe(false)
    expect(await as('U0ADMIN', 'u-admin', null)).toBe(true)
  })

  it("routes to the Computer's owner, and refuses a Computer of another organization or a revoked one", async () => {
    const routed = await resolveApprovalRoute(
      routeReq({ computerId: COMPUTER_ID, consoleUserId: 'u-owner' }),
      deps(world)
    )
    expect(routed.target).toMatchObject({ userId: 'U0OWNER', consoleUserId: 'u-owner' })
    for (const computer of [{ orgId: OrgId('org-2') }, { revokedAt: new Date() }]) {
      const other = { ...world, computer: { ...world.computer, ...computer } }
      const refused = await resolveApprovalRoute(
        routeReq({ computerId: COMPUTER_ID, verify: verify('U0MEMBER', 'u-member') }),
        deps(other)
      )
      expect(refused.allowed).toBe(false)
    }
  })
})
