import { describe, expect, it, vi } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'

const deps = () => ({
  group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
  onMessage: () => {},
  newTraceId: () => 't'
})

function fakeApp(listed: object[], info: (a: { channel: string }) => Promise<unknown>) {
  return {
    message() {},
    event() {},
    action() {},
    shortcut() {},
    view() {},
    client: {
      auth: { test: async () => ({ user_id: 'U1' }) },
      users: { conversations: async () => ({ channels: listed }) },
      conversations: { info: vi.fn(info) }
    },
    start: async () => {},
    stop: async () => {}
  }
}

// assistant-mode.md §5.5: a private channel is read only from itself, and Slack says which ones are private.
describe('SlackConnection.isPrivateConversation', () => {
  it('answers from the membership listing it already made, without another call', async () => {
    const app = fakeApp(
      [
        { id: 'C1', name: 'deploys' },
        { id: 'C2', name: 'leadership', is_private: true }
      ],
      async () => ({ channel: {} })
    )
    const conn = new SlackConnection(deps() as any, () => app as any)
    await conn.listBotChannels()
    expect(await conn.isPrivateConversation('C1')).toBe(false)
    expect(await conn.isPrivateConversation('C2')).toBe(true)
    expect(app.client.conversations.info).not.toHaveBeenCalled()
  })

  it('asks conversations.info once per conversation and counts DMs and group DMs as private', async () => {
    const info: Record<string, object> = {
      C3: { id: 'C3' },
      D1: { id: 'D1', is_im: true },
      G1: { id: 'G1', is_mpim: true, is_private: true }
    }
    const app = fakeApp([], async ({ channel }) => ({ channel: info[channel] }))
    const conn = new SlackConnection(deps() as any, () => app as any)
    expect(await conn.isPrivateConversation('C3')).toBe(false)
    expect(await conn.isPrivateConversation('C3')).toBe(false)
    expect(await conn.isPrivateConversation('D1')).toBe(true)
    expect(await conn.isPrivateConversation('G1')).toBe(true)
    expect(app.client.conversations.info).toHaveBeenCalledTimes(3)
  })

  it('throws when Slack cannot say, so the caller refuses', async () => {
    const app = fakeApp([], async () => {
      throw Object.assign(new Error('channel_not_found'), { data: { error: 'channel_not_found' } })
    })
    const conn = new SlackConnection(deps() as any, () => app as any)
    await expect(conn.isPrivateConversation('C9')).rejects.toThrow('channel_not_found')
  })
})
