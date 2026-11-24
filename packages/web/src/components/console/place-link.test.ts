import { describe, expect, it } from 'vitest'
import { conversationUrl, resolveThreadServerUrl, rowUrl, sessionPlaceLink, type PlaceDirectory } from './place-link'
import type { IntegrationChannelRow } from '@/lib/data'

describe('rowUrl', () => {
  const row = (over: Partial<IntegrationChannelRow>): IntegrationChannelRow => ({
    channelId: 'C0EXAMPLE',
    name: 'general',
    trigger: 'mention',
    ...over
  })

  it('opens a Slack conversation of any kind under the bot workspace, and nowhere without one', () => {
    const bot = { workspaceId: 'T0EXAMPLE' }
    expect(rowUrl(row({}), 'slack', bot)).toBe('https://app.slack.com/client/T0EXAMPLE/C0EXAMPLE')
    expect(rowUrl(row({ channelId: 'D0EXAMPLE', kind: 'im' }), 'slack', bot)).toBe(
      'https://app.slack.com/client/T0EXAMPLE/D0EXAMPLE'
    )
    expect(rowUrl(row({}), 'slack', undefined)).toBeUndefined()
  })

  it('opens a Discord channel under its server and a DM under @me', () => {
    const channel = row({ channelId: '200000000000000002', spaceId: '100000000000000001' })
    expect(rowUrl(channel, 'discord', undefined)).toBe(
      'https://discord.com/channels/100000000000000001/200000000000000002'
    )
    expect(rowUrl(row({ channelId: '300000000000000003', kind: 'im' }), 'discord', undefined)).toBe(
      'https://discord.com/channels/@me/300000000000000003'
    )
    // A channel whose server has not resolved yet has no page to open.
    expect(rowUrl(row({ channelId: '200000000000000002' }), 'discord', undefined)).toBeUndefined()
  })

  it('opens a Google Chat space by room and a DM by dm', () => {
    expect(rowUrl(row({ channelId: 'spaces/AAAAexample' }), 'googlechat', undefined)).toBe(
      'https://chat.google.com/room/AAAAexample'
    )
    expect(rowUrl(row({ channelId: 'spaces/BBBBexample', kind: 'im' }), 'googlechat', undefined)).toBe(
      'https://chat.google.com/dm/BBBBexample'
    )
  })

  it('opens a Lark group on the bot cloud, Feishu when the bot predates the region axis', () => {
    const group = row({ channelId: 'oc_example' })
    expect(rowUrl(group, 'feishu', { feishuRegion: 'lark' })).toBe(
      'https://applink.larksuite.com/client/chat/open?openChatId=oc_example'
    )
    expect(rowUrl(group, 'feishu', { feishuRegion: null })).toBe(
      'https://applink.feishu.cn/client/chat/open?openChatId=oc_example'
    )
    expect(rowUrl(row({ channelId: 'oc_example', kind: 'im' }), 'feishu', undefined)).toBeUndefined()
  })

  it('prefers the page the daemon reported, and links nothing on a platform without pages', () => {
    const team = row({ channelId: 'team-1', url: 'https://linear.example.test/acme/team/ENG' })
    expect(rowUrl(team, 'linear', undefined)).toBe('https://linear.example.test/acme/team/ENG')
    expect(rowUrl(row({ channelId: '-100123' }), 'telegram', undefined)).toBeUndefined()
  })
})

// One org's directory: a Slack bot in two rooms, a Discord bot in one server channel, a Google Chat app in a DM.
const directory: PlaceDirectory = {
  bots: [
    { id: 'bot_slack', workspaceId: 'T0EXAMPLE' },
    { id: 'bot_discord', workspaceId: null },
    { id: 'bot_chat', workspaceId: null }
  ],
  integrations: [
    {
      id: 'int_slack',
      agentId: 'agent-1',
      botId: 'bot_slack',
      platform: 'slack',
      channels: [
        { channelId: 'C0EXAMPLE', name: 'general', trigger: 'mention' },
        { channelId: 'D0EXAMPLE', name: '@Sam', kind: 'im', trigger: 'any' }
      ]
    },
    {
      id: 'int_discord',
      agentId: 'agent-1',
      botId: 'bot_discord',
      platform: 'discord',
      channels: [{ channelId: '200000000000000002', spaceId: '100000000000000001', name: 'general', trigger: 'any' }]
    },
    {
      id: 'int_chat',
      agentId: 'agent-2',
      botId: 'bot_chat',
      platform: 'googlechat',
      channels: [{ channelId: 'spaces/BBBBexample', name: 'Sam', kind: 'im', trigger: 'any' }]
    }
  ]
}
const none: PlaceDirectory = { bots: [], integrations: [] }

describe('a Teams place', () => {
  const channel = '19:exampleChannelId@thread.tacv2'
  const encoded = '19%3AexampleChannelId%40thread.tacv2'
  const tenant = '00000000-0000-4000-8000-000000000001'

  it('opens a team channel and a group chat by the id alone, under the tenant when one is known', () => {
    expect(conversationUrl({ platform: 'msteams', channelId: channel }, none)).toBe(
      `https://teams.microsoft.com/l/channel/${encoded}/channel`
    )
    expect(conversationUrl({ platform: 'msteams', channelId: channel, workspaceId: tenant }, none)).toBe(
      `https://teams.microsoft.com/l/channel/${encoded}/channel?tenantId=${tenant}`
    )
    expect(conversationUrl({ platform: 'msteams', channelId: '19:exampleChatId@thread.v2' }, none)).toBe(
      'https://teams.microsoft.com/l/chat/19%3AexampleChatId%40thread.v2/conversations'
    )
    // A bot's 1:1 conversation id is no chat id Teams can open.
    expect(conversationUrl({ platform: 'msteams', channelId: 'a:exampleBotConversation' }, none)).toBeUndefined()
  })

  it('opens a channel thread at its root post, and a coordinator in its channel', () => {
    const session = { platform: 'msteams', channelId: channel, workspaceId: tenant }
    expect(sessionPlaceLink({ ...session, thread: '1700000000000' }, none)).toEqual({
      url: `https://teams.microsoft.com/l/message/${encoded}/1700000000000?tenantId=${tenant}&parentMessageId=1700000000000&createdTime=1700000000000`,
      opens: 'thread'
    })
    expect(sessionPlaceLink({ ...session, thread: 'append:coordinator-1700000000000' }, none)).toEqual({
      url: `https://teams.microsoft.com/l/channel/${encoded}/channel?tenantId=${tenant}`,
      opens: 'conversation'
    })
  })
})

describe('conversationUrl', () => {
  it('opens a conversation by its directory row, under the bot that holds it', () => {
    expect(conversationUrl({ platform: 'slack', channelId: 'C0EXAMPLE' }, directory)).toBe(
      'https://app.slack.com/client/T0EXAMPLE/C0EXAMPLE'
    )
    expect(conversationUrl({ platform: 'discord', channelId: '200000000000000002' }, directory)).toBe(
      'https://discord.com/channels/100000000000000001/200000000000000002'
    )
    // The row says this space is a DM, which the ids alone do not.
    expect(conversationUrl({ platform: 'googlechat', channelId: 'spaces/BBBBexample' }, directory)).toBe(
      'https://chat.google.com/dm/BBBBexample'
    )
  })

  it('reads only the named integration, and links nothing when it does not hold the conversation', () => {
    const place = { platform: 'slack', channelId: 'C0EXAMPLE' }
    expect(conversationUrl({ ...place, integrationId: 'int_slack' }, directory)).toBeDefined()
    expect(conversationUrl({ ...place, integrationId: 'int_gone' }, directory)).toBeUndefined()
  })

  it('builds a conversation no row lists from its own ids, only where they settle the page', () => {
    expect(conversationUrl({ platform: 'slack', channelId: 'C0LEFT', workspaceId: 'T0EXAMPLE' }, none)).toBe(
      'https://app.slack.com/client/T0EXAMPLE/C0LEFT'
    )
    expect(conversationUrl({ platform: 'slack', channelId: 'C0LEFT' }, none)).toBeUndefined()
    // A room or a DM: without a row these cannot be told apart, and each opens on a different page.
    expect(conversationUrl({ platform: 'googlechat', channelId: 'spaces/AAAAexample' }, none)).toBeUndefined()
    expect(conversationUrl({ platform: 'feishu', channelId: 'oc_example' }, none)).toBeUndefined()
    expect(conversationUrl({ platform: 'discord', channelId: '200000000000000002' }, none)).toBeUndefined()
    expect(conversationUrl({ platform: 'webchat', channelId: 'conv-1' }, none)).toBeUndefined()
  })
})

describe('sessionPlaceLink', () => {
  const slack = { platform: 'slack', channelId: 'C0EXAMPLE', workspaceId: 'T0EXAMPLE' }

  it('opens the thread its daemon reported before anything it could build', () => {
    expect(
      sessionPlaceLink({ ...slack, thread: '1700000000.000100', threadUrl: 'https://example.test/t/1' }, directory)
    ).toEqual({ url: 'https://example.test/t/1', opens: 'thread' })
  })

  it('builds a platform thread\u2019s page when no link was reported', () => {
    expect(sessionPlaceLink({ ...slack, thread: '1700000000.000100' }, none)).toEqual({
      url: 'https://app.slack.com/client/T0EXAMPLE/C0EXAMPLE/thread/C0EXAMPLE-1700000000.000100',
      opens: 'thread'
    })
  })

  it('opens the conversation for a session that runs in no platform thread', () => {
    const channel = { url: 'https://app.slack.com/client/T0EXAMPLE/C0EXAMPLE', opens: 'conversation' }
    // A coordinator, a whole-conversation session, a task, and a session rooted at the channel itself.
    for (const thread of ['append:coordinator-1700000000000', 'append:1700000000000', 'subsession:d-1', 'C0EXAMPLE'])
      expect(sessionPlaceLink({ ...slack, thread }, directory)).toEqual(channel)
    expect(sessionPlaceLink({ ...slack, thread: null }, none)).toEqual(channel)
  })

  it('links nothing without a conversation, or on a platform with no page for one', () => {
    expect(sessionPlaceLink({ platform: 'slack', thread: '1700000000.000100' }, directory)).toBeUndefined()
    expect(
      sessionPlaceLink({ platform: 'webchat', channelId: 'conv-1', thread: 'append:1' }, directory)
    ).toBeUndefined()
    expect(sessionPlaceLink({ platform: 'slack', channelId: 'cron:sched-1' }, directory)).toBeUndefined()
  })

  it('resolves Mattermost thread links from bot platformConfig.serverUrl when threadUrl is absent', () => {
    const mmRoot = 'a1b2c3d4e5f6g7h8i9j0k1l2m3'
    const mmDirectory: PlaceDirectory = {
      bots: [
        {
          id: 'bot_mm',
          workspaceId: null,
          externalAppId: 'mm-0123456789abcdef',
          platformConfig: { serverUrl: 'https://mm.example.com/team' }
        }
      ],
      integrations: [
        {
          id: 'int_mm',
          agentId: 'agent-1',
          botId: 'bot_mm',
          platform: 'mattermost',
          channels: [{ channelId: 'ch123456789012345678901234', name: 'town-square', trigger: 'mention' }]
        }
      ]
    }
    expect(
      sessionPlaceLink(
        {
          platform: 'mattermost',
          channelId: 'ch123456789012345678901234',
          thread: mmRoot,
          workspaceId: 'mm-0123456789abcdef'
        },
        mmDirectory
      )
    ).toEqual({
      url: `https://mm.example.com/team/_redirect/pl/${mmRoot}`,
      opens: 'thread'
    })

    const multiServerDirectory: PlaceDirectory = {
      bots: [
        {
          id: 'bot_mm_first',
          workspaceId: null,
          externalAppId: 'mm-1111111111111111',
          platformConfig: { serverUrl: 'https://mm-one.example.com' }
        },
        {
          id: 'bot_mm_second',
          workspaceId: null,
          externalAppId: 'mm-2222222222222222',
          platformConfig: { serverUrl: 'https://mm-two.example.com' }
        }
      ],
      integrations: [
        {
          id: 'int_mm_first',
          agentId: 'agent-1',
          botId: 'bot_mm_first',
          platform: 'mattermost',
          channels: [{ channelId: 'ch123456789012345678901234', name: 'town-square', trigger: 'mention' }]
        },
        {
          id: 'int_mm_second',
          agentId: 'agent-1',
          botId: 'bot_mm_second',
          platform: 'mattermost',
          channels: [{ channelId: 'ch123456789012345678901234', name: 'town-square', trigger: 'mention' }]
        }
      ]
    }
    expect(
      sessionPlaceLink(
        {
          platform: 'mattermost',
          channelId: 'ch123456789012345678901234',
          thread: mmRoot,
          agentId: 'agent-1',
          workspaceId: 'mm-2222222222222222'
        },
        multiServerDirectory
      )
    ).toEqual({
      url: `https://mm-two.example.com/_redirect/pl/${mmRoot}`,
      opens: 'thread'
    })
    expect(
      resolveThreadServerUrl(multiServerDirectory, {
        platform: 'mattermost',
        tenantScope: 'mm-2222222222222222',
        agentId: 'agent-1',
        channelId: 'ch123456789012345678901234'
      })
    ).toBe('https://mm-two.example.com')
    expect(
      resolveThreadServerUrl(multiServerDirectory, {
        platform: 'mattermost',
        tenantScope: 'mm-unknown-tenant',
        agentId: 'agent-1',
        channelId: 'ch123456789012345678901234'
      })
    ).toBeNull()
  })

  it('rejects non-http(s) and userinfo URLs in threadUrl, channel url, and serverUrl', () => {
    const mmRoot = 'p1234567890123456789012345'
    for (const unsafe of ['javascript:alert(1)', 'data:text/html,x', 'https://user:pass@evil.example']) {
      expect(
        sessionPlaceLink(
          {
            platform: 'slack',
            channelId: 'C1',
            workspaceId: 'T1',
            thread: '1700000000.000100',
            threadUrl: unsafe
          },
          {
            bots: [{ id: 'b1', platform: 'slack', workspaceId: 'T1', externalAppId: null, platformConfig: null }],
            integrations: [
              {
                id: 'i1',
                agentId: 'a1',
                botId: 'b1',
                platform: 'slack',
                channels: [{ channelId: 'C1', name: 'general', trigger: 'mention', url: unsafe }]
              }
            ]
          }
        )
      ).toEqual({
        url: 'https://app.slack.com/client/T1/C1/thread/C1-1700000000.000100',
        opens: 'thread'
      })

      expect(
        conversationUrl(
          { platform: 'linear', channelId: 'ENG' },
          {
            bots: [],
            integrations: [
              {
                id: 'i2',
                agentId: 'a1',
                botId: 'b2',
                platform: 'linear',
                channels: [{ channelId: 'ENG', name: 'ENG', trigger: 'mention', url: unsafe }]
              }
            ]
          }
        )
      ).toBeUndefined()

      expect(
        sessionPlaceLink(
          {
            platform: 'mattermost',
            channelId: 'ch123456789012345678901234',
            thread: mmRoot,
            workspaceId: 'mm-unsafe'
          },
          {
            bots: [
              {
                id: 'b_mm',
                workspaceId: null,
                externalAppId: 'mm-unsafe',
                platformConfig: { serverUrl: unsafe }
              }
            ],
            integrations: [
              {
                id: 'i_mm',
                agentId: 'a1',
                botId: 'b_mm',
                platform: 'mattermost',
                channels: [{ channelId: 'ch123456789012345678901234', name: 'town-square', trigger: 'mention' }]
              }
            ]
          }
        )
      ).toBeUndefined()
    }
  })
})
