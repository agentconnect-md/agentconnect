import { describe, expect, it, vi } from 'vitest'
import type { AgentReadAccess } from '@agentconnect.md/protocol'
import type { LinkedChatIdentity } from '../github/logto-identity.js'
import { createFeishuCpProvider } from '../platforms/feishu/provider.js'
import { buildCpPlatformRegistry } from '../platforms/registry.js'
import { createSlackCpProvider } from '../platforms/slack/provider.js'
import type { AgentRecord, BotRecord, IntegrationRecord, OrgMemberRecord } from '../persistence/ports.js'
import { resolveReadAccess, type ReadAccessDeps } from './readAccess.js'

const AGENT_ID = '11111111-1111-4111-8111-111111111111'
const SLACK = '33333333-3333-4333-8333-333333333333'
const TELEGRAM = '44444444-4444-4444-8444-444444444444'
const LARK = '55555555-5555-4555-8555-555555555555'
const ORG = 'org-1'

const PLATFORMS = buildCpPlatformRegistry([createSlackCpProvider({}), createFeishuCpProvider({})])

function deps(
  over: { links?: Record<string, LinkedChatIdentity[]>; members?: string[]; identityAbsent?: boolean } = {}
) {
  const integrations = [
    { id: SLACK, botId: 'bot-slack', platform: 'slack' },
    { id: TELEGRAM, botId: 'bot-tg', platform: 'telegram' },
    { id: LARK, botId: 'bot-lark', platform: 'feishu' }
  ].map((i) => ({ orgId: ORG, agentId: AGENT_ID, ...i }) as unknown as IntegrationRecord)
  const links = over.links ?? {
    'user-p': [{ platform: 'slack', tenant: 'T0AAA', memberId: 'U_P' }],
    'user-q': [{ platform: 'slack', tenant: 'T0OTHER', memberId: 'U_P' }]
  }
  const members = over.members ?? ['user-p', 'user-q', 'user-r']
  const sessionsVisible = vi.fn(async (_viewer: unknown, _agent: string, ids: readonly string[]) =>
    ids.filter((id) => id.startsWith('visible'))
  )
  const built: ReadAccessDeps = {
    agent: {
      getUnscoped: async (id) => (String(id) === AGENT_ID ? ({ id: AGENT_ID, orgId: ORG } as AgentRecord) : null)
    },
    integration: { activeForAgents: async () => integrations },
    bot: {
      get: async (_org, botId) =>
        (
          ({
            'bot-slack': { platform: 'slack', teamId: 'T0AAA', revokedAt: null },
            'bot-tg': { platform: 'telegram' },
            'bot-lark': { platform: 'feishu', feishuRegion: 'lark', revokedAt: null }
          }) as Record<string, Partial<BotRecord>>
        )[String(botId)] as BotRecord
    },
    org: { roleOf: async (_org, userId) => (members.includes(userId) ? 'viewer' : null) },
    users: {
      listMembers: async () => members.map((userId) => ({ userId, role: 'collaborator' }) as OrgMemberRecord),
      getOidcSubject: async (userId) => `sub:${userId}`
    },
    platforms: PLATFORMS,
    ...(over.identityAbsent
      ? {}
      : { identity: { chatIdentitiesFor: async (sub: string) => links[sub.slice(4)] ?? [] } }),
    sessionsVisible
  }
  return { deps: built, sessionsVisible }
}

const ask = (asker: AgentReadAccess['asker'], sessionIds = ['visible-1', 'hidden-1']): AgentReadAccess => ({
  agentId: AGENT_ID,
  asker,
  sessionIds
})

describe('resolveReadAccess', () => {
  it("answers for a console user of the agent's organization with the console's own visibility", async () => {
    const { deps: d, sessionsVisible } = deps()
    expect(await resolveReadAccess(ask({ consoleUserId: 'user-r' }), d, ORG)).toEqual({
      asker: 'linked',
      visibleSessionIds: ['visible-1'],
      consoleUserId: 'user-r'
    })
    expect(sessionsVisible).toHaveBeenCalledWith(
      { orgId: ORG, userId: 'user-r', role: 'viewer' },
      AGENT_ID,
      ['visible-1', 'hidden-1'],
      false
    )
    // A DM or webchat source asks for the asker's own sessions only.
    await resolveReadAccess({ ...ask({ consoleUserId: 'user-r' }), ownerOnly: true }, d, ORG)
    expect(sessionsVisible).toHaveBeenLastCalledWith(
      { orgId: ORG, userId: 'user-r', role: 'viewer' },
      AGENT_ID,
      ['visible-1', 'hidden-1'],
      true
    )
    expect(await resolveReadAccess(ask({ consoleUserId: 'user-x' }), d, ORG)).toEqual({
      asker: 'unidentifiable',
      visibleSessionIds: []
    })
  })

  it('resolves a chat member to the one member who linked that identity under the bot workspace', async () => {
    const { deps: d, sessionsVisible } = deps()
    expect(await resolveReadAccess(ask({ integrationId: SLACK, memberId: 'U_P' }), d, ORG)).toEqual({
      asker: 'linked',
      visibleSessionIds: ['visible-1'],
      consoleUserId: 'user-p'
    })
    expect(sessionsVisible.mock.calls[0]![0]).toEqual({ orgId: ORG, userId: 'user-p', role: 'collaborator' })
    // An empty session list only asks who the asker is, which keys their memory layer.
    expect(await resolveReadAccess(ask({ integrationId: SLACK, memberId: 'U_P' }, []), d, ORG)).toEqual({
      asker: 'linked',
      visibleSessionIds: [],
      consoleUserId: 'user-p'
    })
  })

  it('tells an unlinked chat member from one on a platform that cannot match members', async () => {
    const { deps: d, sessionsVisible } = deps()
    expect(await resolveReadAccess(ask({ integrationId: SLACK, memberId: 'U_NOBODY' }), d, ORG)).toEqual({
      asker: 'unlinked',
      visibleSessionIds: []
    })
    expect(await resolveReadAccess(ask({ integrationId: TELEGRAM, memberId: '42' }), d, ORG)).toEqual({
      asker: 'unidentifiable',
      visibleSessionIds: []
    })
    const twice = deps({
      links: {
        'user-p': [{ platform: 'slack', tenant: 'T0AAA', memberId: 'U_P' }],
        'user-q': [{ platform: 'slack', tenant: 'T0AAA', memberId: 'U_P' }]
      }
    })
    expect((await resolveReadAccess(ask({ integrationId: SLACK, memberId: 'U_P' }), twice.deps, ORG)).asker).toBe(
      'unidentifiable'
    )
    expect(sessionsVisible).not.toHaveBeenCalled()
  })

  it("answers nothing for another organization's agent, and identifies nobody without sign-in", async () => {
    expect(await resolveReadAccess(ask({ consoleUserId: 'user-p' }), deps().deps, 'org-2')).toEqual({
      asker: 'unidentifiable',
      visibleSessionIds: []
    })
    expect(
      (
        await resolveReadAccess(
          ask({ integrationId: SLACK, memberId: 'U_P' }),
          deps({ identityAbsent: true }).deps,
          ORG
        )
      ).asker
    ).toBe('unidentifiable')
  })

  it("answers the chat identity a console user linked in the bot's workspace, and none in any other", async () => {
    const { deps: d } = deps({
      links: {
        'user-p': [
          { platform: 'slack', tenant: 'T0AAA', memberId: 'U_P' },
          { platform: 'feishu', tenant: 'lark', memberId: 'on_p' }
        ],
        'user-q': [{ platform: 'slack', tenant: 'T0OTHER', memberId: 'U_Q' }]
      }
    })
    const on = (userId: string, linkedOn = SLACK): AgentReadAccess => ({
      ...ask({ consoleUserId: userId }, []),
      linkedOn
    })
    expect(await resolveReadAccess(on('user-p'), d, ORG)).toEqual({
      asker: 'linked',
      visibleSessionIds: [],
      consoleUserId: 'user-p',
      linkedMemberId: 'U_P'
    })
    // Feishu/Lark matches its union_id under the bot's region.
    expect((await resolveReadAccess(on('user-p', LARK), d, ORG)).linkedMemberId).toBe('on_p')
    // Linked only in another Slack workspace, or not at all.
    expect((await resolveReadAccess(on('user-q'), d, ORG)).linkedMemberId).toBeNull()
    expect((await resolveReadAccess(on('user-r'), d, ORG)).linkedMemberId).toBeNull()
    // A platform that cannot match members, a bot that is not the agent's, and a deployment without sign-in.
    expect((await resolveReadAccess(on('user-p', TELEGRAM), d, ORG)).linkedMemberId).toBeNull()
    expect((await resolveReadAccess(on('user-p', AGENT_ID), d, ORG)).linkedMemberId).toBeNull()
    expect((await resolveReadAccess(on('user-p'), deps({ identityAbsent: true }).deps, ORG)).linkedMemberId).toBeNull()
    // Someone outside the organization is linked to nothing; a request without `linkedOn` gets no such field.
    expect(await resolveReadAccess(on('user-x'), d, ORG)).toEqual({
      asker: 'unidentifiable',
      visibleSessionIds: [],
      linkedMemberId: null
    })
    expect(await resolveReadAccess(ask({ consoleUserId: 'user-p' }, []), d, ORG)).not.toHaveProperty('linkedMemberId')
  })

  it("answers for a chat member the identity their console user linked in another bot's workspace", async () => {
    const { deps: d } = deps({
      links: {
        'user-p': [
          { platform: 'slack', tenant: 'T0AAA', memberId: 'U_P' },
          { platform: 'feishu', tenant: 'lark', memberId: 'on_p' }
        ]
      }
    })
    const on = (asker: AgentReadAccess['asker']): AgentReadAccess => ({ ...ask(asker, []), linkedOn: LARK })
    // A Slack member linked to user-p is judged on the Feishu/Lark bot as the union_id user-p linked there.
    expect(await resolveReadAccess(on({ integrationId: SLACK, memberId: 'U_P' }), d, ORG)).toEqual({
      asker: 'linked',
      visibleSessionIds: [],
      consoleUserId: 'user-p',
      linkedMemberId: 'on_p'
    })
    // An unlinked chat member, and one on a platform that cannot be matched, have none.
    expect(await resolveReadAccess(on({ integrationId: SLACK, memberId: 'U_NOBODY' }), d, ORG)).toEqual({
      asker: 'unlinked',
      visibleSessionIds: [],
      linkedMemberId: null
    })
    expect(await resolveReadAccess(on({ integrationId: TELEGRAM, memberId: '42' }), d, ORG)).toEqual({
      asker: 'unidentifiable',
      visibleSessionIds: [],
      linkedMemberId: null
    })
  })

  it('refuses to answer when a console user linked two identities in one workspace', async () => {
    const twice = deps({
      links: {
        'user-p': [
          { platform: 'slack', tenant: 'T0AAA', memberId: 'U_P' },
          { platform: 'slack', tenant: 'T0AAA', memberId: 'U_P2' }
        ]
      }
    })
    await expect(
      resolveReadAccess({ ...ask({ consoleUserId: 'user-p' }, []), linkedOn: SLACK }, twice.deps, ORG)
    ).rejects.toThrow(/several linked chat identities/)
  })

  it('refuses to answer rather than call someone unlinked when the organization is too large to scan', async () => {
    const many = deps({ members: Array.from({ length: 201 }, (_, i) => `user-${i}`) })
    await expect(resolveReadAccess(ask({ integrationId: SLACK, memberId: 'U_P' }), many.deps, ORG)).rejects.toThrow(
      /too large/
    )
  })
})
