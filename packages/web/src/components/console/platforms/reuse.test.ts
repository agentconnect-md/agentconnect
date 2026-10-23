// @vitest-environment happy-dom

// Check each platform's bot reuse rules and the input submitted by its wizard.

import { createTranslator } from 'next-intl'
import { describe, expect, it } from 'vitest'
import english from '../../../../messages/en.json'
import chinese from '../../../../messages/zh-CN.json'
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
  it('registers exactly the nine chat platforms, in picker order', () => {
    const ids = ['slack', 'telegram', 'discord', 'feishu', 'linear', 'qq', 'googlechat', 'dingtalk', 'msteams']
    expect(platformRegistry.ids()).toEqual(ids)
    expect(platformRegistry.all().map((m) => m.platformId)).toEqual(ids)
  })

  it('does not register the core trigger kinds — those are chassis fragments', () => {
    expect(platformRegistry.get('webhook')).toBeUndefined()
    expect(platformRegistry.get('github')).toBeUndefined()
  })
})

describe('freeBotFilter', () => {
  it('slack permits an unshared workspace install only after its agent disconnects', () => {
    // An unshared workspace install can reconnect, but cannot serve a second agent.
    expect(
      wizardOf('slack').freeBotFilter(
        bot({ teamId: 'T0EXAMPLE1', shareable: false, agentIds: ['existing-agent'] }),
        ctx()
      )
    ).toBe(false)
    expect(wizardOf('slack').freeBotFilter(bot({ teamId: 'T0EXAMPLE1', shareable: false, agentIds: [] }), ctx())).toBe(
      true
    )
    expect(
      wizardOf('slack').freeBotFilter(
        bot({ teamId: 'T0EXAMPLE1', shareable: true, agentIds: ['existing-agent'] }),
        ctx()
      )
    ).toBe(true)
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
      labels: { socket: 'Platforms.slack.transport.socket', http: 'Platforms.slack.transport.http' },
      httpByDefaultWhenRelayAvailable: true
    })
    expect(wizardOf('feishu').affordances.transport).toEqual({
      labels: { socket: 'Platforms.feishu.transport.socket', http: 'Platforms.feishu.transport.http' },
      httpByDefaultWhenRelayAvailable: false
    })
    // A SINGLE FIXED transport is the absent member, not a one-armed choice:
    // Linear is http-only and Telegram/Discord socket-only.
    for (const id of ['telegram', 'discord', 'linear']) {
      expect(wizardOf(id).affordances.transport, id).toBeUndefined()
    }
  })

  it('slack and linear offer multi-agent bots, nobody else does — and differ in how', () => {
    // Slack's is an opt-in the operator makes; Linear's is structural, stamped by the
    // provider on every connected workspace, so no surface offers a control for it.
    expect(wizardOf('slack').affordances.share).toBe(true)
    expect(wizardOf('linear').affordances.share).toBe('fixed')
    for (const id of ['telegram', 'discord', 'feishu']) {
      expect(wizardOf(id).affordances.share, id).toBeUndefined()
    }
  })
})

describe('region-parameterised copy', () => {
  it('feishu rebrands its mode cards and invite hint per cloud', () => {
    const feishu = wizardOf('feishu')
    expect(feishu.identityCards('lark')).toEqual({
      create: 'Integrations.dialog.identityCards.feishuLark.create',
      existing: 'Integrations.dialog.identityCards.feishuLark.existing'
    })
    expect(feishu.identityCards('feishu')).toEqual({
      create: 'Integrations.dialog.identityCards.feishuFeishu.create',
      existing: 'Integrations.dialog.identityCards.feishuFeishu.existing'
    })
    expect(feishu.inviteHint('lark')).toEqual({
      key: 'Integrations.dialog.platformHints.mention',
      values: { target: 'Integrations.dialog.platformHints.targets.group', platform: 'Platforms.feishu.brand.lark' }
    })
    expect(feishu.inviteHint('feishu')).toEqual({
      key: 'Integrations.dialog.platformHints.mention',
      values: { target: 'Integrations.dialog.platformHints.targets.group', platform: 'Platforms.feishu.brand.feishu' }
    })
  })

  it('the regionless platforms ignore the region argument', () => {
    expect(wizardOf('slack').inviteHint(undefined)).toEqual({
      key: 'Integrations.dialog.platformHints.listen',
      values: { target: 'Integrations.dialog.platformHints.targets.channel', platform: 'Platforms.slack.brand' }
    })
    expect(wizardOf('telegram').inviteHint(undefined)).toEqual({
      key: 'Integrations.dialog.platformHints.listen',
      values: { target: 'Integrations.dialog.platformHints.targets.group', platform: 'Platforms.telegram.brand' }
    })
    expect(wizardOf('discord').inviteHint(undefined)).toEqual({
      key: 'Integrations.dialog.platformHints.listen',
      values: { target: 'Integrations.dialog.platformHints.targets.channel', platform: 'Platforms.discord.brand' }
    })
    expect(wizardOf('slack').identityCards(undefined)).toEqual({
      create: 'Integrations.dialog.identityCards.slack.create',
      existing: 'Integrations.dialog.identityCards.slack.existing'
    })
    // Linear's mode cards name a workspace, not a bot: create CONNECTS one and
    // existing joins one the org already holds.
    expect(wizardOf('linear').identityCards(undefined)).toEqual({
      create: 'Integrations.dialog.identityCards.linear.create',
      existing: 'Integrations.dialog.identityCards.linear.existing'
    })
    expect(wizardOf('linear').inviteHint(undefined)).toEqual({
      key: 'Integrations.dialog.platformHints.mention',
      values: { target: 'Integrations.dialog.platformHints.targets.issue', platform: 'Platforms.linear.brand' }
    })
  })
})

describe('invite hint copy', () => {
  // Resolved the way the Add integration dialog's footer resolves it: the sentence, then its two keyed values.
  const render = (locale: 'en' | 'zh-CN', id: string, region?: string) => {
    const t = createTranslator({ locale, messages: locale === 'en' ? english : chinese })
    const hint = wizardOf(id).inviteHint(region)
    return t(hint.key, { target: t(hint.values.target), platform: t(hint.values.platform) })
  }
  const cases: [string, string | undefined, string, string][] = [
    [
      'slack',
      undefined,
      'invite the bot to any channel in Slack and it starts listening there.',
      '把机器人拉进Slack的任意频道，它就会开始接收消息。'
    ],
    [
      'telegram',
      undefined,
      'invite the bot to any group in Telegram and it starts listening there.',
      '把机器人拉进Telegram的任意群，它就会开始接收消息。'
    ],
    [
      'discord',
      undefined,
      'invite the bot to any channel in Discord and it starts listening there.',
      '把机器人拉进Discord的任意频道，它就会开始接收消息。'
    ],
    [
      'msteams',
      undefined,
      'invite the bot to any channel in Microsoft Teams and it starts listening there.',
      '把机器人拉进Microsoft Teams的任意频道，它就会开始接收消息。'
    ],
    [
      'feishu',
      'lark',
      'invite the bot to any group in Lark and @-mention it to start.',
      '把机器人拉进Lark的任意群，并 @ 它即可开始使用。'
    ],
    [
      'feishu',
      'feishu',
      'invite the bot to any group in Feishu and @-mention it to start.',
      '把机器人拉进飞书的任意群，并 @ 它即可开始使用。'
    ],
    [
      'dingtalk',
      undefined,
      'invite the bot to any group in DingTalk and @-mention it to start.',
      '把机器人拉进钉钉的任意群，并 @ 它即可开始使用。'
    ],
    [
      'qq',
      undefined,
      'invite the bot to any group in QQ and @-mention it to start.',
      '把机器人拉进QQ的任意群，并 @ 它即可开始使用。'
    ],
    [
      'googlechat',
      undefined,
      'invite the bot to any space in Google Chat and @-mention it to start.',
      '把机器人拉进Google Chat的任意空间，并 @ 它即可开始使用。'
    ],
    [
      'linear',
      undefined,
      'invite the bot to any issue in Linear and @-mention it to start.',
      '把机器人拉进Linear的任意议题，并 @ 它即可开始使用。'
    ]
  ]

  it.each(cases)('%s (%s) names its brand and room in each locale', (id, region, en, zh) => {
    expect(render('en', id, region)).toBe(en)
    expect(render('zh-CN', id, region)).toBe(zh)
  })

  it('covers every chat module', () => {
    expect(new Set(cases.map(([id]) => id))).toEqual(new Set(platformRegistry.ids()))
  })
})
