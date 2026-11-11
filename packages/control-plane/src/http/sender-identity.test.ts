import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../test/fakes/fake-clock.js'
import { AgentId, BotId, OrgId } from '../domain/ids.js'
import type { LinkedChatIdentity } from '../github/logto-identity.js'
import type { BotRecord, IntegrationRecord, OrgMemberRecord } from '../persistence/ports.js'
import { SenderIdentityService, withSenderIdentity, type SenderIdentityDeps } from './sender-identity.js'

const ORG = OrgId('org-1')
const WORKSPACE = 'T0EXAMPLE'

const member = (userId: string): OrgMemberRecord =>
  ({ userId, email: `${userId}@example.test`, displayName: userId, role: 'collaborator' }) as OrgMemberRecord

const bot = (id: string, platform: string, fields: Partial<BotRecord> = {}): BotRecord =>
  ({ id: BotId(id), orgId: ORG, platform, revokedAt: null, teamId: null, botUserId: null, ...fields }) as BotRecord

const integration = (botId: string, agentId: string, platform: string): IntegrationRecord =>
  ({ botId: BotId(botId), agentId: AgentId(agentId), platform, status: 'active' }) as IntegrationRecord

function fixture(
  options: {
    members?: OrgMemberRecord[]
    bots?: BotRecord[]
    integrations?: IntegrationRecord[]
    links?: Record<string, LinkedChatIdentity[]>
    botsFail?: boolean
  } = {}
) {
  const links = options.links ?? {}
  const chatIdentitiesFor = vi.fn(async (sub: string) => links[sub] ?? [])
  const deps: SenderIdentityDeps = {
    clock: new FakeClock(Date.UTC(2026, 0, 1)),
    bots: {
      listForOrg: async () => {
        if (options.botsFail) throw new Error('database unavailable')
        return options.bots ?? [bot('bot-slack', 'slack', { teamId: WORKSPACE })]
      }
    },
    integrations: { listForOrg: async () => options.integrations ?? [] },
    users: {
      listMembers: async () => options.members ?? [member('user-me'), member('user-dana')],
      getOidcSubject: async (userId) => `sub-${userId}`
    },
    // Slack matches members under the bot's workspace, every other platform here under one global tenant.
    chatMemberTenant: (platform) => (b) => (platform === 'slack' ? b.teamId : 'global'),
    identity: { chatIdentitiesFor }
  }
  const viewer = { userId: 'user-me', oidcSubject: 'sub-user-me', canSeeAgent: async () => true }
  return { service: new SenderIdentityService(deps), viewer, chatIdentitiesFor }
}

const slack = (memberId: string, tenant = WORKSPACE): LinkedChatIdentity => ({ platform: 'slack', tenant, memberId })

describe('SenderIdentityService', () => {
  it('names the reader and another member by the chat accounts they linked', async () => {
    const { service, viewer } = fixture({
      links: { 'sub-user-me': [slack('U0ME')], 'sub-user-dana': [slack('U0DANA')] }
    })
    const who = await service.resolve(ORG, 'slack', ['U0ME', 'U0DANA', 'U0STRANGER'], viewer)
    expect(Object.fromEntries(who)).toEqual({ U0ME: { userId: 'user-me' }, U0DANA: { userId: 'user-dana' } })
  })

  it('matches every platform by its own tenant, not one platform alone', async () => {
    const teams = '00000000-0000-4000-8000-000000000001'
    const { service, viewer } = fixture({
      bots: [bot('bot-teams', 'msteams'), bot('bot-slack', 'slack', { teamId: WORKSPACE })],
      links: { 'sub-user-me': [{ platform: 'msteams', tenant: 'global', memberId: teams }, slack('U0ME')] }
    })
    expect((await service.resolve(ORG, 'msteams', [teams], viewer)).get(teams)).toEqual({ userId: 'user-me' })
    // An id linked on one platform says nothing about a sender on another.
    expect((await service.resolve(ORG, 'msteams', ['U0ME'], viewer)).size).toBe(0)
  })

  it('leaves out an account linked under a workspace the organization has no bot in', async () => {
    const { service, viewer } = fixture({ links: { 'sub-user-me': [slack('U0ME', 'T0ELSEWHERE')] } })
    expect((await service.resolve(ORG, 'slack', ['U0ME'], viewer)).size).toBe(0)
  })

  it('names the agent a bot speaks for, and none for a bot several agents share', async () => {
    const { service, viewer } = fixture({
      bots: [
        bot('bot-own', 'slack', { teamId: WORKSPACE, botUserId: 'U0OWNBOT' }),
        bot('bot-shared', 'slack', { teamId: WORKSPACE, botUserId: 'U0SHAREDBOT' })
      ],
      integrations: [
        integration('bot-own', 'agent-a', 'slack'),
        integration('bot-shared', 'agent-b', 'slack'),
        integration('bot-shared', 'agent-c', 'slack')
      ]
    })
    const who = await service.resolve(ORG, 'slack', ['U0OWNBOT', 'U0SHAREDBOT'], viewer)
    expect(Object.fromEntries(who)).toEqual({ U0OWNBOT: { agentId: 'agent-a' } })
  })

  it('never names an agent the reader may not see', async () => {
    const { service, viewer } = fixture({
      bots: [bot('bot-own', 'slack', { teamId: WORKSPACE, botUserId: 'U0OWNBOT' })],
      integrations: [integration('bot-own', 'agent-a', 'slack')]
    })
    const who = await service.resolve(ORG, 'slack', ['U0OWNBOT'], { ...viewer, canSeeAgent: async () => false })
    expect(who.size).toBe(0)
  })

  it('names nobody by an account two members linked', async () => {
    const { service } = fixture({
      links: { 'sub-user-dana': [slack('U0SHARED')], 'sub-user-eli': [slack('U0SHARED')] },
      members: [member('user-dana'), member('user-eli')]
    })
    const viewer = { userId: 'user-me', canSeeAgent: async () => true }
    expect((await service.resolve(ORG, 'slack', ['U0SHARED'], viewer)).size).toBe(0)
  })

  it('still names the reader in an organization too large to scan', async () => {
    const { service, viewer, chatIdentitiesFor } = fixture({
      members: Array.from({ length: 201 }, (_, i) => member(`user-${i}`)),
      links: { 'sub-user-me': [slack('U0ME')] }
    })
    expect((await service.resolve(ORG, 'slack', ['U0ME'], viewer)).get('U0ME')).toEqual({ userId: 'user-me' })
    expect(chatIdentitiesFor).toHaveBeenCalledTimes(1)
  })

  it('reads the members once for repeated pages', async () => {
    const { service, viewer, chatIdentitiesFor } = fixture({ links: { 'sub-user-dana': [slack('U0DANA')] } })
    await service.resolve(ORG, 'slack', ['U0DANA'], viewer)
    const calls = chatIdentitiesFor.mock.calls.length
    await service.resolve(ORG, 'slack', ['U0DANA'], viewer)
    // The second page reads only the reader's own link again.
    expect(chatIdentitiesFor.mock.calls.length).toBe(calls + 1)
  })

  it('lists the chat accounts a member is filed under, for the trigger filter', async () => {
    const teams = '00000000-0000-4000-8000-000000000002'
    const { service } = fixture({
      bots: [bot('bot-teams', 'msteams'), bot('bot-slack', 'slack', { teamId: WORKSPACE })],
      links: {
        'sub-user-dana': [slack('U0DANA'), { platform: 'msteams', tenant: 'global', memberId: teams }]
      }
    })
    expect((await service.sendersOf(ORG, 'user-dana')).sort()).toEqual([teams, 'U0DANA'].sort())
  })

  it('answers with nobody rather than fail the read it decorates', async () => {
    const { service, viewer } = fixture({ botsFail: true })
    expect((await service.resolve(ORG, 'slack', ['U0ME'], viewer)).size).toBe(0)
  })
})

describe('withSenderIdentity', () => {
  it('adds who a sender is and leaves an unknown sender as it was', () => {
    const who = new Map([
      ['U0ME', { userId: 'user-me' }],
      ['U0BOT', { agentId: 'agent-a' }]
    ])
    expect(withSenderIdentity({ sender: 'U0ME', text: 'hi' }, who)).toEqual({
      sender: 'U0ME',
      text: 'hi',
      senderUserId: 'user-me'
    })
    expect(withSenderIdentity({ sender: 'U0BOT' }, who)).toEqual({ sender: 'U0BOT', senderAgentId: 'agent-a' })
    const stranger = { sender: 'U0STRANGER' }
    expect(withSenderIdentity(stranger, who)).toBe(stranger)
  })
})
