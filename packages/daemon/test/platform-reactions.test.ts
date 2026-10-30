import { describe, expect, it, vi } from 'vitest'
import { Routes } from 'discord.js'
import { SlackConnection } from '../src/slack/connection.js'
import { TelegramConnection, type TelegramApi, type TelegramBotHandle } from '../src/telegram/connection.js'
import { DiscordConnection } from '../src/discord/connection.js'
import { FeishuConnection, type ConsolidatedFeishuGroup, type FeishuClientHandle } from '../src/feishu/connection.js'

// Each platform is asked for the SAME intent and must answer in its own alphabet — Slack a
// shortcode, Telegram and Discord a literal emoji, Lark an `emoji_type` key. These tests pin
// the four mappings, because core can no longer see them.
describe('turn-start reactions', () => {
  it('slack takes the emoji shortcode, addressed by channel + ts', async () => {
    const add = vi.fn(async () => ({ ok: true }))
    const conn = new SlackConnection(
      {
        group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
        onMessage: () => {},
        newTraceId: () => 't'
      } as never,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: {
            auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
            chat: { postMessage: async () => ({}) },
            reactions: { add }
          },
          start: async () => {},
          stop: async () => {}
        }) as never
    )

    await conn.react('C1', '1720000000.000100', 'seen')
    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '1720000000.000100', name: 'eyes' })
  })

  it('slack swallows a workspace that never granted reactions:write', async () => {
    const conn = new SlackConnection(
      {
        group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
        onMessage: () => {},
        newTraceId: () => 't'
      } as never,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: {
            auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
            chat: { postMessage: async () => ({}) },
            reactions: {
              add: async () => {
                throw Object.assign(new Error('missing_scope'), { data: { needed: 'reactions:write' } })
              }
            }
          },
          start: async () => {},
          stop: async () => {}
        }) as never
    )

    await expect(conn.react('C1', '1.1', 'seen')).resolves.toBeUndefined()
  })

  it('telegram sends one allowed emoji reaction, with the chat id and a numeric message id', async () => {
    const setMessageReaction = vi.fn(async () => true)
    const api = { setMessageReaction, setMyCommands: vi.fn(async () => true) } as unknown as TelegramApi
    const conn = new TelegramConnection(
      { group: { botToken: 'tok', integrations: [] }, onMessage: () => {}, newTraceId: () => 't' } as never,
      () =>
        ({
          api,
          init: async () => {},
          botInfo: { id: 99 },
          on: () => {},
          start: () => {},
          stop: async () => {}
        }) as unknown as TelegramBotHandle
    )

    await conn.react('-1002233', '87', 'seen')
    expect(setMessageReaction).toHaveBeenCalledWith('-1002233', 87, [{ type: 'emoji', emoji: '👀' }])
  })

  it('telegram sends nothing for a message id that is not a number', async () => {
    const setMessageReaction = vi.fn(async () => true)
    const api = { setMessageReaction, setMyCommands: vi.fn(async () => true) } as unknown as TelegramApi
    const conn = new TelegramConnection(
      { group: { botToken: 'tok', integrations: [] }, onMessage: () => {}, newTraceId: () => 't' } as never,
      () =>
        ({
          api,
          init: async () => {},
          botInfo: { id: 99 },
          on: () => {},
          start: () => {},
          stop: async () => {}
        }) as unknown as TelegramBotHandle
    )

    await conn.react('-1002233', 'om_not_a_number', 'seen')
    expect(setMessageReaction).not.toHaveBeenCalled()
  })

  it('discord reacts on the message inside the container it was given, not a parent', async () => {
    const react = vi.fn(async () => ({}))
    const conn = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      sendIntervalMs: 0
    })
    const fetchMessage = vi.fn(async () => ({ react }))
    const fetchChannel = vi.fn(async () => ({ messages: { fetch: fetchMessage } }))
    ;(conn as unknown as { client: unknown }).client = { channels: { fetch: fetchChannel } }

    await conn.react('THREAD', '11223344', 'seen')
    expect(fetchChannel).toHaveBeenCalledWith('THREAD')
    expect(fetchMessage).toHaveBeenCalledWith('11223344')
    expect(react).toHaveBeenCalledWith('👀')
  })

  it('discord swallows an install whose invite predates ADD_REACTIONS', async () => {
    const conn = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      sendIntervalMs: 0
    })
    ;(conn as unknown as { client: unknown }).client = {
      channels: {
        fetch: async () => ({
          messages: {
            fetch: async () => ({
              react: async () => {
                throw new Error('Missing Permissions')
              }
            })
          }
        })
      }
    }

    await expect(conn.react('C1', '1', 'seen')).resolves.toBeUndefined()
  })

  it('lark takes its own emoji_type key, addressed by message id alone', async () => {
    const addReaction = vi.fn(async () => ({}))
    const handle = {
      api: { addReaction, getBotInfo: async () => ({}) },
      startWs: async () => {},
      close: () => {}
    } as unknown as FeishuClientHandle
    const group: ConsolidatedFeishuGroup = {
      appId: 'cli_reactions',
      appSecret: 'secret',
      mode: 'direct',
      region: 'lark',
      integrations: []
    }
    const conn = new FeishuConnection(
      { group, onMessage: () => {}, newTraceId: () => 'trace', sendIntervalMs: 0 } as never,
      () => handle
    )

    await conn.react('oc_abc', 'om_xyz', 'seen')
    expect(addReaction).toHaveBeenCalledWith('om_xyz', 'GLANCE')
  })
})

// auto-session-mode.md §4.4: 🤔 shows while a coordinator turn decides a message and goes when it ends.
describe('the triaging reaction', () => {
  it('slack places and removes :thinking_face:', async () => {
    const add = vi.fn(async () => ({ ok: true }))
    const remove = vi.fn(async () => ({ ok: true }))
    const conn = new SlackConnection(
      {
        group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
        onMessage: () => {},
        newTraceId: () => 't'
      } as never,
      () =>
        ({
          message() {},
          event() {},
          action() {},
          shortcut() {},
          client: {
            auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
            chat: { postMessage: async () => ({}) },
            reactions: { add, remove }
          },
          start: async () => {},
          stop: async () => {}
        }) as never
    )

    await conn.react('C1', '1.1', 'triaging')
    await conn.unreact('C1', '1.1', 'triaging')
    expect(add).toHaveBeenCalledWith({ channel: 'C1', timestamp: '1.1', name: 'thinking_face' })
    expect(remove).toHaveBeenCalledWith({ channel: 'C1', timestamp: '1.1', name: 'thinking_face' })
  })

  it('telegram clears its one reaction only while that reaction is still 🤔', async () => {
    const setMessageReaction = vi.fn(async () => true)
    const api = { setMessageReaction, setMyCommands: vi.fn(async () => true) } as unknown as TelegramApi
    const conn = new TelegramConnection(
      { group: { botToken: 'tok', integrations: [] }, onMessage: () => {}, newTraceId: () => 't' } as never,
      () =>
        ({
          api,
          init: async () => {},
          botInfo: { id: 99 },
          on: () => {},
          start: () => {},
          stop: async () => {}
        }) as unknown as TelegramBotHandle
    )

    await conn.react('-100', '7', 'triaging')
    await conn.unreact('-100', '7', 'triaging')
    expect(setMessageReaction.mock.calls).toEqual([
      ['-100', 7, [{ type: 'emoji', emoji: '🤔' }]],
      ['-100', 7, []]
    ])
    setMessageReaction.mockClear()
    // A task's 👀 replaced it: a bot shows one reaction per message, and that one stays.
    void conn.react('-100', '8', 'triaging')
    void conn.react('-100', '8', 'seen')
    await conn.unreact('-100', '8', 'triaging')
    expect(setMessageReaction.mock.calls).toEqual([
      ['-100', 8, [{ type: 'emoji', emoji: '🤔' }]],
      ['-100', 8, [{ type: 'emoji', emoji: '👀' }]]
    ])
  })

  it('discord reacts 🤔 and removes only its own reaction', async () => {
    const react = vi.fn(async () => ({}))
    const del = vi.fn(async () => undefined)
    const conn = new DiscordConnection({
      group: { botToken: 'token', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      sendIntervalMs: 0
    })
    ;(conn as unknown as { client: unknown }).client = {
      channels: { fetch: async () => ({ messages: { fetch: async () => ({ react }) } }) },
      rest: { delete: del }
    }

    await conn.react('THREAD', '11223344', 'triaging')
    await conn.unreact('THREAD', '11223344', 'triaging')
    expect(react).toHaveBeenCalledWith('🤔')
    expect(del).toHaveBeenCalledWith(Routes.channelMessageOwnReaction('THREAD', '11223344', encodeURIComponent('🤔')))
  })

  it('lark takes back the THINKING reaction by the id its create returned', async () => {
    const addReaction = vi.fn(async () => ({ reactionId: 'r-1' }))
    const deleteReaction = vi.fn(async () => {})
    const handle = {
      api: { addReaction, deleteReaction, getBotInfo: async () => ({}) },
      startWs: async () => {},
      close: () => {}
    } as unknown as FeishuClientHandle
    const group: ConsolidatedFeishuGroup = {
      appId: 'cli_reactions',
      appSecret: 'secret',
      mode: 'direct',
      region: 'lark',
      integrations: []
    }
    const conn = new FeishuConnection(
      { group, onMessage: () => {}, newTraceId: () => 'trace', sendIntervalMs: 0 } as never,
      () => handle
    )

    await conn.unreact('oc_abc', 'om_xyz', 'triaging')
    expect(deleteReaction).not.toHaveBeenCalled()
    await conn.react('oc_abc', 'om_xyz', 'triaging')
    expect(addReaction).toHaveBeenCalledWith('om_xyz', 'THINKING')
    await conn.unreact('oc_abc', 'om_xyz', 'triaging')
    await conn.unreact('oc_abc', 'om_xyz', 'triaging')
    expect(deleteReaction.mock.calls).toEqual([['om_xyz', 'r-1']])
  })
})
