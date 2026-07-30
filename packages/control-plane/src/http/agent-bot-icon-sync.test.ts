import { describe, expect, it, vi } from 'vitest'
import type { Platform } from '@agentconnect.md/protocol'
import { AgentId, BotId, IntegrationId, OrgId } from '../domain/ids.js'
import type { BotRecord, IntegrationRecord } from '../persistence/ports.js'
import type { BotProfileIconAgent } from './bot-profile-icon.js'
import { syncAgentBotIcons } from './agent-bot-icon-sync.js'

const ORG_ID = OrgId('org_test')
const AGENT_ID = AgentId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')

const agent: BotProfileIconAgent = {
  id: AGENT_ID,
  icon: { kind: 'glyph', glyph: 'bot', color: '#2563eb' },
  runtime: 'codex'
}

function integration(botId: string, platform: Platform): IntegrationRecord {
  return {
    id: IntegrationId(`10000000-0000-4000-8000-${botId.slice(-12)}`),
    orgId: ORG_ID,
    agentId: AGENT_ID,
    botId: BotId(botId),
    platform,
    name: platform,
    status: 'active',
    createdAt: new Date(0)
  }
}

function bot(id: string, platform: Platform, options: { shareable?: boolean; revoked?: boolean } = {}): BotRecord {
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
    feishuAppId: null,
    feishuRegion: null,
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
  it('syncs each dedicated Telegram/Discord bot once and isolates cosmetic failures', async () => {
    const telegramId = '00000000-0000-4000-8000-000000000001'
    const discordId = '00000000-0000-4000-8000-000000000002'
    const sharedId = '00000000-0000-4000-8000-000000000003'
    const revokedId = '00000000-0000-4000-8000-000000000004'
    const slackId = '00000000-0000-4000-8000-000000000005'
    const bots = new Map([
      [telegramId, bot(telegramId, 'telegram')],
      [discordId, bot(discordId, 'discord')],
      [sharedId, bot(sharedId, 'telegram', { shareable: true })],
      [revokedId, bot(revokedId, 'discord', { revoked: true })],
      [slackId, bot(slackId, 'slack')]
    ])
    const integrations = [
      integration(telegramId, 'telegram'),
      integration(telegramId, 'telegram'),
      integration(discordId, 'discord'),
      integration(sharedId, 'telegram'),
      integration(revokedId, 'discord'),
      integration(slackId, 'slack')
    ]
    const telegramSync = vi.fn(async () => {
      throw new Error('rate limited')
    })
    const discordSync = vi.fn(async () => {})
    const secretGets: string[] = []
    const warn = vi.fn()

    await expect(
      syncAgentBotIcons(
        {
          repos: {
            integration: { listForAgent: async () => integrations },
            bot: { get: async (id) => bots.get(id) ?? null },
            botSecret: {
              get: async (id) => {
                secretGets.push(id)
                return { botToken: `token-${id}`, appToken: null, signingSecret: null }
              }
            }
          },
          syncTelegramBotIcon: telegramSync,
          syncDiscordBotIcon: discordSync
        },
        agent,
        { warn }
      )
    ).resolves.toBeUndefined()

    expect(telegramSync).toHaveBeenCalledOnce()
    expect(telegramSync).toHaveBeenCalledWith(`token-${telegramId}`, agent)
    expect(discordSync).toHaveBeenCalledOnce()
    expect(discordSync).toHaveBeenCalledWith(`token-${discordId}`, agent)
    expect(secretGets.sort()).toEqual([telegramId, discordId].sort())
    expect(warn).toHaveBeenCalledOnce()
  })
})
