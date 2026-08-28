import { describe, expect, it, vi } from 'vitest'
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
    const addReaction = vi.fn(async () => {})
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
