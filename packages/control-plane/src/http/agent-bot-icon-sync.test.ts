import { describe, expect, it, vi } from 'vitest'
import type { Platform } from '@agentconnect.md/protocol'
import { AgentId, BotId, IntegrationId, OrgId } from '../domain/ids.js'
import type { AgentRecord, BotRecord, IntegrationRecord } from '../persistence/ports.js'
import type { BotProfileIconAgent } from './bot-profile-icon.js'
import { syncAgentBotIcons } from './agent-bot-icon-sync.js'

const ORG_ID = OrgId('org_test')
const AGENT_ID = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

const agent: BotProfileIconAgent = {
  id: AGENT_ID,
  icon: { kind: 'glyph', glyph: 'bot', color: '#2563eb' },
  runtime: 'codex'
}

function agentRecord(icon: AgentRecord['icon'], lastModifiedAt = new Date(1)): AgentRecord {
  return {
    ...agent,
    orgId: ORG_ID,
    lastModifiedAt,
    icon
  } as AgentRecord
}

function integration(botId: string, platform: Platform, agentId = AGENT_ID): IntegrationRecord {
  return {
    id: IntegrationId(`10000000-0000-4000-8000-${botId.slice(-12)}`),
    orgId: ORG_ID,
    agentId,
    botId: BotId(botId),
    platform,
    name: platform,
    status: 'active',
    createdAt: new Date(0)
  }
}

function bot(
  id: string,
  platform: Platform,
  options: { shareable?: boolean; revoked?: boolean; feishuAppId?: string; feishuRegion?: 'feishu' | 'lark' } = {}
): BotRecord {
  return {
    id: BotId(id),
    orgId: ORG_ID,
    platform,
    name: platform,
    prebuilt: false,
    slackAppId: null,
    teamId: null,
    workspaceId: null,
    workspaceName: null,
    botUserId: null,
    revokedAt: options.revoked ? new Date(0) : null,
    credentialRevision: 1,
    credentialInstalledAt: new Date(0),
    discordAppId: null,
    feishuAppId: options.feishuAppId ?? null,
    feishuRegion: options.feishuRegion ?? null,
    shareable: options.shareable ?? false,
    transport: 'socket',
    createdBy: null,
    lastUsedAt: null,
    lastAgentName: null,
    agentIds: [AGENT_ID],
    inUseByAgentId: options.shareable ? null : AGENT_ID,
    createdAt: new Date(0)
  }
}

describe('syncAgentBotIcons', () => {
  it('syncs each dedicated Telegram/Discord/Feishu bot once and isolates cosmetic failures', async () => {
    const telegramId = '00000000-0000-4000-8000-000000000001'
    const discordId = '00000000-0000-4000-8000-000000000002'
    const sharedId = '00000000-0000-4000-8000-000000000003'
    const revokedId = '00000000-0000-4000-8000-000000000004'
    const slackId = '00000000-0000-4000-8000-000000000005'
    const feishuId = '00000000-0000-4000-8000-000000000006'
    const bots = new Map([
      [telegramId, bot(telegramId, 'telegram')],
      [discordId, bot(discordId, 'discord')],
      [sharedId, bot(sharedId, 'telegram', { shareable: true })],
      [revokedId, bot(revokedId, 'discord', { revoked: true })],
      [slackId, bot(slackId, 'slack')],
      [feishuId, bot(feishuId, 'feishu', { feishuAppId: 'cli_feishu', feishuRegion: 'lark' })]
    ])
    const integrations = [
      integration(telegramId, 'telegram'),
      integration(telegramId, 'telegram'),
      integration(discordId, 'discord'),
      integration(sharedId, 'telegram'),
      integration(revokedId, 'discord'),
      integration(slackId, 'slack'),
      integration(feishuId, 'feishu')
    ]
    const telegramSync = vi.fn(async () => {
      throw new Error('rate limited')
    })
    const discordSync = vi.fn(async () => {})
    const feishuSync = vi.fn(async () => {})
    const secretGets: string[] = []
    const warn = vi.fn()
    const currentAgent = agentRecord(agent.icon)

    await expect(
      syncAgentBotIcons(
        {
          repos: {
            agent: { get: async () => currentAgent },
            integration: {
              listForAgent: async () => integrations,
              listForBot: async (id) => {
                const membership = integrations.find((item) => item.botId === id)
                return membership ? [membership] : []
              }
            },
            bot: { get: async (id) => bots.get(id) ?? null },
            botSecret: {
              get: async (id) => {
                secretGets.push(id)
                return {
                  botToken: `token-${id}`,
                  appToken: id === feishuId ? 'cli_secret_fallback' : null,
                  signingSecret: null
                }
              }
            }
          },
          syncTelegramBotIcon: telegramSync,
          syncDiscordBotProfile: discordSync,
          syncFeishuAppIcon: feishuSync
        },
        agent,
        { warn }
      )
    ).resolves.toBeUndefined()

    expect(telegramSync).toHaveBeenCalledOnce()
    expect(telegramSync).toHaveBeenCalledWith(`token-${telegramId}`, expect.objectContaining(agent))
    expect(discordSync).toHaveBeenCalledOnce()
    expect(discordSync).toHaveBeenCalledWith(`token-${discordId}`, expect.objectContaining(agent))
    expect(feishuSync).toHaveBeenCalledOnce()
    expect(feishuSync).toHaveBeenCalledWith(
      'cli_secret_fallback',
      `token-${feishuId}`,
      'lark',
      expect.objectContaining(agent)
    )
    expect(secretGets.sort()).toEqual([telegramId, discordId, feishuId].sort())
    expect(warn).toHaveBeenCalledOnce()
  })

  it('repairs a delayed stale write with the latest Agent icon', async () => {
    const discordId = '00000000-0000-4000-8000-000000000011'
    const membership = integration(discordId, 'discord')
    const discordBot = bot(discordId, 'discord')
    const oldAgent = agentRecord({ kind: 'glyph', glyph: 'bot', color: '#111111' }, new Date(1))
    const newAgent = agentRecord({ kind: 'glyph', glyph: 'bot', color: '#222222' }, new Date(2))
    let currentAgent = oldAgent
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const applied: string[] = []
    let calls = 0
    const discordSync = vi.fn(async (_token: string, snapshot: BotProfileIconAgent) => {
      calls += 1
      if (calls === 1) {
        firstStarted()
        await firstBlocked
      }
      applied.push(snapshot.icon?.kind === 'glyph' ? snapshot.icon.color : 'other')
    })
    const deps = {
      repos: {
        agent: { get: async () => currentAgent },
        integration: {
          listForAgent: async () => [membership],
          listForBot: async () => [membership]
        },
        bot: { get: async () => discordBot },
        botSecret: {
          get: async () => ({ botToken: 'discord-token', appToken: null, signingSecret: null })
        }
      },
      syncDiscordBotProfile: discordSync
    }
    const warn = vi.fn()

    const stale = syncAgentBotIcons(deps, oldAgent, { warn })
    await firstStartedPromise
    currentAgent = newAgent
    const latest = syncAgentBotIcons(deps, newAgent, { warn })
    await vi.waitFor(() => expect(applied).toEqual(['#222222']))
    releaseFirst()
    await Promise.all([stale, latest])

    expect(applied).toEqual(['#222222', '#111111', '#222222'])
    expect(warn).not.toHaveBeenCalled()
  })

  it('repairs delayed image writes when two uploads share a timestamp', async () => {
    const discordId = '00000000-0000-4000-8000-000000000012'
    const membership = integration(discordId, 'discord')
    const discordBot = bot(discordId, 'discord')
    const timestamp = new Date(1)
    const oldAgent = agentRecord({ kind: 'image', generation: 'old-upload' }, timestamp)
    const newAgent = agentRecord({ kind: 'image', generation: 'new-upload' }, timestamp)
    let currentAgent = oldAgent
    let releaseFirst!: () => void
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstStarted!: () => void
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve
    })
    const applied: string[] = []
    let calls = 0
    const discordSync = vi.fn(async (_token: string, snapshot: BotProfileIconAgent) => {
      const generation = snapshot.icon?.kind === 'image' ? snapshot.icon.generation : undefined
      calls += 1
      if (calls === 1) {
        firstStarted()
        await firstBlocked
      }
      applied.push(generation ?? 'legacy')
    })
    const deps = {
      repos: {
        agent: { get: async () => currentAgent },
        integration: {
          listForAgent: async () => [membership],
          listForBot: async () => [membership]
        },
        bot: { get: async () => discordBot },
        botSecret: {
          get: async () => ({ botToken: 'discord-token', appToken: null, signingSecret: null })
        }
      },
      syncDiscordBotProfile: discordSync
    }
    const warn = vi.fn()

    const stale = syncAgentBotIcons(deps, oldAgent, { warn })
    await firstStartedPromise
    currentAgent = newAgent
    const latest = syncAgentBotIcons(deps, newAgent, { warn })
    await vi.waitFor(() => expect(applied).toEqual(['new-upload']))
    releaseFirst()
    await Promise.all([stale, latest])

    expect(applied).toEqual(['new-upload', 'old-upload', 'new-upload'])
    expect(warn).not.toHaveBeenCalled()
  })
})
