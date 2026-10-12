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
const ORG = 'org-1'

const PLATFORMS = buildCpPlatformRegistry([createSlackCpProvider({}), createFeishuCpProvider({})])

function deps(
  over: { links?: Record<string, LinkedChatIdentity[]>; members?: string[]; identityAbsent?: boolean } = {}
) {
  const integrations = [
    { id: SLACK, botId: 'bot-slack', platform: 'slack' },
    { id: TELEGRAM, botId: 'bot-tg', platform: 'telegram' }
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
            'bot-tg': { platform: 'telegram' }
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
      visibleSessionIds: ['visible-1']
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
      visibleSessionIds: ['visible-1']
    })
    expect(sessionsVisible.mock.calls[0]![0]).toEqual({ orgId: ORG, userId: 'user-p', role: 'collaborator' })
    // An empty session list only asks who the asker is.
    expect(await resolveReadAccess(ask({ integrationId: SLACK, memberId: 'U_P' }, []), d, ORG)).toEqual({
      asker: 'linked',
      visibleSessionIds: []
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

  it('refuses to answer rather than call someone unlinked when the organization is too large to scan', async () => {
    const many = deps({ members: Array.from({ length: 201 }, (_, i) => `user-${i}`) })
    await expect(resolveReadAccess(ask({ integrationId: SLACK, memberId: 'U_P' }), many.deps, ORG)).rejects.toThrow(
      /too large/
    )
  })
})
