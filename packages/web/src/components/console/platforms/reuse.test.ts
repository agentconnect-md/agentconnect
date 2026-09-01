// @vitest-environment happy-dom

// The pure half of the wizard facet: which free bots a platform will let you
// reuse, and the create input that reuse commits. Both moved out of one
// `submit()` switch in AddIntegrationModal and into per-platform modules, and
// both are exactly where a silent behavior change would hide — nothing renders
// them, so only these assertions notice if an arm drifts.

import { describe, expect, it } from 'vitest'
import type { BotDto } from '@/lib/api'
import type { WizardReuseContext } from './contract'
import { platformRegistry } from './registry'

function bot(over: Partial<BotDto> = {}): BotDto {
  return {
    id: 'bot-1',
    name: 'support',
    platform: 'slack',
    prebuilt: false,
    slackAppId: null,
    discordAppId: null,
    createdBy: null,
    transport: 'socket',
    shareable: false,
    inUseByAgentId: null,
    agentIds: [],
    lastUsedAt: null,
    freedFromAgent: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

function ctx(over: Partial<WizardReuseContext> = {}): WizardReuseContext {
  return { agentId: 'agent-1', shared: false, ...over }
}

const wizardOf = (id: string) => {
  const module = platformRegistry.get(id)
  if (!module) throw new Error(`no module registered for ${id}`)
  return module.wizard
}

describe('platform registry', () => {
  it('registers exactly the five chat platforms, in picker order', () => {
    const ids = ['slack', 'telegram', 'discord', 'feishu', 'linear']
    expect(platformRegistry.ids()).toEqual(ids)
    expect(platformRegistry.all().map((m) => m.platformId)).toEqual(ids)
  })

  it('does not register the core trigger kinds — those are chassis fragments', () => {
    expect(platformRegistry.get('webhook')).toBeUndefined()
    expect(platformRegistry.get('github')).toBeUndefined()
  })
})

describe('freeBotFilter', () => {
  it('slack refuses a workspace install that has not been flipped shareable', () => {
    // A platform-app install (`teamId`) serves one agent per workspace until the
    // owner shares it; the CP 409s the reuse, so the list must not offer it.
    expect(wizardOf('slack').freeBotFilter(bot({ teamId: 'T0EXAMPLE1', shareable: false }), ctx())).toBe(false)
    expect(wizardOf('slack').freeBotFilter(bot({ teamId: 'T0EXAMPLE1', shareable: true }), ctx())).toBe(true)
    expect(wizardOf('slack').freeBotFilter(bot({ shareable: false }), ctx())).toBe(true)
  })

  it('feishu offers only bots of the region the wizard is on', () => {
    const feishu = wizardOf('feishu')
    expect(feishu.freeBotFilter(bot({ platform: 'feishu', feishuRegion: 'lark' }), ctx({ region: 'lark' }))).toBe(true)
    expect(feishu.freeBotFilter(bot({ platform: 'feishu', feishuRegion: 'feishu' }), ctx({ region: 'lark' }))).toBe(
      false
    )
    expect(feishu.freeBotFilter(bot({ platform: 'feishu', feishuRegion: 'feishu' }), ctx({ region: 'feishu' }))).toBe(
      true
    )
  })

  it('feishu reads a legacy region-less bot as Feishu', () => {
    const feishu = wizardOf('feishu')
    expect(feishu.freeBotFilter(bot({ platform: 'feishu', feishuRegion: null }), ctx({ region: 'feishu' }))).toBe(true)
    expect(feishu.freeBotFilter(bot({ platform: 'feishu' }), ctx({ region: 'lark' }))).toBe(false)
  })

  it('linear offers every connected workspace, unfenced', () => {
    // The Bot row IS the workspace and `shareable: true` is structural on it, so
    // adding a member needs no reuse fence — the CP refuses nothing the list shows.
    const linear = wizardOf('linear')
    expect(linear.freeBotFilter(bot({ platform: 'linear', transport: 'http', shareable: true }), ctx())).toBe(true)
    expect(linear.freeBotFilter(bot({ platform: 'linear', transport: 'http', agentIds: ['a', 'b'] }), ctx())).toBe(true)
    // Not even the Slack-shaped disqualifier: `teamId` is a Slack platform-app column.
    expect(linear.freeBotFilter(bot({ platform: 'linear', teamId: 'T0EXAMPLE1' }), ctx())).toBe(true)
  })

  it('telegram and discord add nothing to the chassis predicate', () => {
    for (const id of ['telegram', 'discord']) {
      expect(wizardOf(id).freeBotFilter(bot({ platform: id }), ctx())).toBe(true)
      // Not even the Slack-shaped disqualifiers: only the Slack platform-app
      // install ever persists a teamId.
      expect(wizardOf(id).freeBotFilter(bot({ platform: id, teamId: 'T0EXAMPLE1' }), ctx())).toBe(true)
    }
  })
})

describe('buildReuseInput', () => {
  it('slack carries the reused bot’s own transport', () => {
    expect(wizardOf('slack').buildReuseInput(bot({ id: 'b-http', transport: 'http' }), ctx())).toEqual({
      platform: 'slack',
      agentId: 'agent-1',
      botId: 'b-http',
      transport: 'http'
    })
    expect(wizardOf('slack').buildReuseInput(bot({ id: 'b-socket', transport: 'socket' }), ctx())).toEqual({
      platform: 'slack',
      agentId: 'agent-1',
      botId: 'b-socket',
      transport: 'socket'
    })
  })

  it('slack attaches shareable only when the effective opt-in is on', () => {
    const shared = wizardOf('slack').buildReuseInput(bot({ transport: 'http' }), ctx({ shared: true }))
    expect(shared).toEqual({
      platform: 'slack',
      agentId: 'agent-1',
      botId: 'bot-1',
      transport: 'http',
      shareable: true
    })
    // Absent, not `false`: the CP reads a missing key as "leave it alone".
    expect(wizardOf('slack').buildReuseInput(bot({ transport: 'http' }), ctx())).not.toHaveProperty('shareable')
  })

  it('slack falls back to socket when an older CP omitted the transport', () => {
    const legacy = bot()
    delete (legacy as { transport?: unknown }).transport
    expect(wizardOf('slack').buildReuseInput(legacy, ctx())).toMatchObject({ transport: 'socket' })
  })

  it('feishu carries the transport but never shareable', () => {
    expect(
      wizardOf('feishu').buildReuseInput(bot({ platform: 'feishu', transport: 'http' }), ctx({ shared: true }))
    ).toEqual({ platform: 'feishu', agentId: 'agent-1', botId: 'bot-1', transport: 'http' })
  })

  it('linear pins http and never asks for shareable', () => {
    // Linear has no dial-out transport, so a workspace bot is only ever http; and
    // the provider stamps `shareable` structurally, so the caller never sends it.
    expect(wizardOf('linear').buildReuseInput(bot({ id: 'ws-1', platform: 'linear' }), ctx({ shared: true }))).toEqual({
      platform: 'linear',
      agentId: 'agent-1',
      botId: 'ws-1',
      transport: 'http'
    })
  })

  it('telegram and discord carry neither transport nor shareable', () => {
    for (const id of ['telegram', 'discord']) {
      expect(wizardOf(id).buildReuseInput(bot({ id: 'b-2', platform: id }), ctx({ shared: true }))).toEqual({
        platform: id,
        agentId: 'agent-1',
        botId: 'b-2'
      })
    }
  })
})

describe('affordances', () => {
  it('only slack and feishu offer a transport choice, with their own default rule', () => {
    expect(wizardOf('slack').affordances.transport).toEqual({
      labels: { socket: 'Socket Mode', http: 'HTTP (Events API)' },
      httpByDefaultWhenRelayAvailable: true
    })
    expect(wizardOf('feishu').affordances.transport).toEqual({
      labels: { socket: 'Long connection', http: 'HTTP callbacks' },
      httpByDefaultWhenRelayAvailable: false
    })
    // A SINGLE FIXED transport is the absent member, not a one-armed choice:
    // Linear is http-only and Telegram/Discord socket-only.
    for (const id of ['telegram', 'discord', 'linear']) {
      expect(wizardOf(id).affordances.transport, id).toBeUndefined()
    }
  })

  it('slack and linear offer multi-agent bots, nobody else does', () => {
    for (const id of ['slack', 'linear']) expect(wizardOf(id).affordances.share, id).toBe(true)
    for (const id of ['telegram', 'discord', 'feishu']) {
      expect(wizardOf(id).affordances.share, id).toBeUndefined()
    }
  })
})

describe('region-parameterised copy', () => {
  it('feishu rebrands its mode cards and invite hint per cloud', () => {
    const feishu = wizardOf('feishu')
    expect(feishu.identityCards('lark')).toEqual({
      create: 'Create with one-click Lark setup',
      existing: 'An unused Lark bot'
    })
    expect(feishu.identityCards('feishu')).toEqual({
      create: 'Create with one-click Feishu setup',
      existing: 'An unused Feishu bot'
    })
    expect(feishu.inviteHint('lark')).toBe('invite the bot to any group in Lark and @-mention it to start.')
    expect(feishu.inviteHint('feishu')).toBe('invite the bot to any group in Feishu and @-mention it to start.')
  })

  it('the regionless platforms ignore the region argument', () => {
    expect(wizardOf('slack').inviteHint(undefined)).toBe(
      'invite the bot to any channel in Slack and it starts listening there.'
    )
    expect(wizardOf('telegram').inviteHint(undefined)).toBe(
      'invite the bot to any group in Telegram and it starts listening there.'
    )
    expect(wizardOf('discord').inviteHint(undefined)).toBe(
      'invite the bot to any channel in Discord and it starts listening there.'
    )
    expect(wizardOf('slack').identityCards(undefined)).toEqual({
      create: 'Create with a Slack manifest',
      existing: 'An unused Slack app'
    })
    // Linear's mode cards name a workspace, not a bot: create CONNECTS one and
    // existing joins one the org already holds.
    expect(wizardOf('linear').identityCards(undefined)).toEqual({
      create: 'Connect a Linear workspace',
      existing: 'A connected Linear workspace'
    })
    expect(wizardOf('linear').inviteHint(undefined)).toBe(
      'delegate an issue to the app in Linear, or mention it to reach one agent by name.'
    )
  })
})
