import { describe, expect, it, vi } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'
import { SLACK_SESSION_TOOLS } from '../src/platforms/slack/agent-tools.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { slackThreadUrl } from '../src/platforms/slack/permalink.js'

const ctx: SessionContext = {
  agentId: 'a1',
  agentName: 'Agent',
  platform: 'slack',
  integrationId: 'i1',
  channel: 'C1',
  thread: '1.001',
  deliveryThread: '1.001',
  isDm: false,
  tools: []
}

async function fixture(code = true) {
  const app = fakeSlackAppFactory()({} as never)
  const post = vi.spyOn(app.client.chat, 'postMessage')
  const info = vi.spyOn(app.client.conversations, 'info').mockResolvedValue({
    channel: {
      id: 'C1',
      properties: code
        ? {
            record_channel: { record_type: 'agent_channel' },
            agent_session: { encoded_agent_bot_user_ids: ['U_FAKE_BOT'] }
          }
        : {}
    }
  })
  const api = {
    create: vi.fn(async (_args: unknown) => ({ channel_id: 'C2' })),
    setView: vi.fn(async (_args: unknown) => ({})),
    setProperties: vi.fn(async (_args: unknown) => ({})),
    archive: vi.fn(async (_args: unknown) => ({})),
    listViews: vi.fn(async (_args: unknown) => ({})),
    removeView: vi.fn(async (_args: unknown) => ({}))
  }
  Object.assign(app.client.agents, { conversations: api })
  const conn = new SlackConnection(
    {
      group: { appToken: 'xapp', botToken: 'xoxb', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      sendIntervalMs: 0
    },
    () => app
  )
  await conn.start()
  const judgeWrite = vi.fn(async () => undefined)
  const recordPost = vi.fn(async (_text: string, _ts: string) => undefined)
  const env = {
    connection: conn,
    deliveryThread: ctx.deliveryThread,
    originMsgId: 'slack:C1:1.002',
    judgeWrite,
    recordPost,
    postIdentity: () => ({ agentAuthorId: ctx.agentId, username: ctx.agentName })
  }
  return { conn, app, post, info, api, env, judgeWrite }
}

describe('Slack native surfaces', () => {
  it('posts native containers and numeric table cells in the current delivery thread', async () => {
    const f = await fixture()
    await SLACK_SESSION_TOOLS.execute(
      'presentSlackReport',
      ctx,
      {
        title: 'Results',
        sections: [{ title: 'Details', text: '*Passed*' }],
        table: {
          caption: 'Counts',
          columns: ['Name', 'Count'],
          rows: [
            ['A', 10],
            ['B', 2]
          ]
        }
      },
      f.env
    )
    expect(f.judgeWrite).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', kind: 'conversation' }))
    const sent = f.post.mock.calls[0]![0] as Record<string, unknown>
    expect(sent.thread_ts).toBe('1.001')
    expect(f.env.recordPost).toHaveBeenCalledWith(expect.stringContaining('Results'), expect.any(String))
    expect(sent.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'container', is_collapsible: true, default_collapsed: true }),
        expect.objectContaining({
          type: 'data_table',
          rows: expect.arrayContaining([
            [
              { type: 'raw_text', text: 'A' },
              { type: 'raw_number', text: '10', value: 10 }
            ]
          ])
        })
      ])
    )
    await f.conn.stop()
  })

  it('refuses malformed table dimensions before posting and preserves write refusals', async () => {
    const f = await fixture()
    await expect(
      SLACK_SESSION_TOOLS.execute(
        'presentSlackReport',
        ctx,
        { title: 'Bad', table: { caption: 'Bad', columns: ['A'], rows: [['a', 'b']] } },
        f.env
      )
    ).rejects.toThrow('column count')
    f.judgeWrite.mockRejectedValueOnce(new Error('refused'))
    await expect(SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, f.env)).rejects.toThrow(
      'refused'
    )
    expect(f.post).not.toHaveBeenCalled()
    expect(f.api.create).not.toHaveBeenCalled()
    await f.conn.stop()
  })

  it('keeps creation idempotent and origin privacy under Slack control', async () => {
    const f = await fixture()
    await SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, f.env)
    await SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, f.env)
    expect(f.api.create.mock.calls[0]).toEqual(f.api.create.mock.calls[1])
    expect(f.api.create.mock.calls[0]).toEqual([
      expect.objectContaining({ origin_channel_id: 'C1', origin_message_ts: '1.002' })
    ])
    expect(f.api.create.mock.calls[0]![0]).not.toHaveProperty('is_private')
    await f.conn.stop()
  })

  it('canonicalizes consecutive messages and omits thread timestamps on channel lifecycle and replies', async () => {
    const f = await fixture()
    const status = vi.spyOn(f.app.client.agents.sessions, 'setStatus')
    const rename = vi.spyOn(f.app.client.agents.sessions, 'rename')
    const first = { channel: 'C1', thread: '1.001', isDm: false } as NormalizedMessage
    const next = { ...first, thread: '1.002' }
    await f.conn.prepareInboundMessage(first)
    await f.conn.prepareInboundMessage(next)
    expect(first.thread).toBe('C1')
    expect(next.thread).toBe(first.thread)
    expect(slackThreadUrl('https://workspace.example.test', 'C1', next.thread!)).toBe(
      'https://workspace.example.test/archives/C1'
    )
    expect(next.conversationBotId).toBe('U_FAKE_BOT')
    expect(f.info).toHaveBeenCalledOnce()
    await f.conn.setStatus('C1', first.thread!, 'Working')
    await f.conn.setTitle('C1', first.thread!, 'Task')
    await f.conn.postMessage('C1', 'Done', first.thread)
    for (const call of [status.mock.calls[0], rename.mock.calls[0], f.post.mock.calls[0]])
      expect(call![0]).not.toHaveProperty('thread_ts')
    await f.conn.stop()
  })

  it('leaves ordinary threads intact and refuses code tools on ordinary channels', async () => {
    const f = await fixture(false)
    const msg = { channel: 'C1', thread: '1.001', isDm: false } as NormalizedMessage
    await f.conn.prepareInboundMessage(msg)
    expect(msg.thread).toBe('1.001')
    await expect(
      SLACK_SESSION_TOOLS.execute('setSlackCodeView', ctx, { type: 'diff', content: 'diff --git a/a b/a' }, f.env)
    ).rejects.toThrow('does not own')
    expect(f.api.setView).not.toHaveBeenCalled()
    await f.conn.stop()
  })

  it('retains inbound coordinates when channel discovery fails, including trusted relay hints', async () => {
    const f = await fixture()
    f.info.mockRejectedValue(new Error('lookup unavailable'))
    const ordinary = { channel: 'C1', thread: '1.001', isDm: false } as NormalizedMessage
    const relayed = { ...ordinary, thread: 'C1', conversationBotId: 'U_FAKE_BOT' }
    await expect(f.conn.prepareInboundMessage(ordinary)).resolves.toBeUndefined()
    await expect(f.conn.prepareInboundMessage(relayed)).resolves.toBeUndefined()
    expect(ordinary).toMatchObject({ channel: 'C1', thread: '1.001' })
    expect(relayed).toMatchObject({ channel: 'C1', thread: 'C1', conversationBotId: 'U_FAKE_BOT' })
    await f.conn.stop()
  })

  it('backfills code channels from chronological channel history without calling thread replies', async () => {
    const f = await fixture()
    const replies = vi.spyOn(f.app.client.conversations, 'replies')
    const history = vi.spyOn(f.app.client.conversations, 'history').mockResolvedValue({
      messages: [
        { ts: '2.002', user: 'U1', text: 'Second' },
        { ts: '2.001', user: 'U1', text: 'First' }
      ]
    })
    expect((await f.conn.getThreadReplies('C1', 'C1')).map((m) => m.text)).toEqual(['First', 'Second'])
    expect(history).toHaveBeenCalledWith(expect.not.objectContaining({ ts: expect.anything() }))
    expect(replies).not.toHaveBeenCalled()
    await f.conn.stop()
  })

  it('rejects oversized UTF-8 views before writing and publishes supported native views', async () => {
    const f = await fixture()
    await expect(
      SLACK_SESSION_TOOLS.execute(
        'setSlackCodeView',
        ctx,
        { type: 'html', viewKey: 'preview', content: '界'.repeat(340000) },
        f.env
      )
    ).rejects.toThrow('UTF-8')
    expect(f.api.setView).not.toHaveBeenCalled()
    const diff = 'diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n+  \n'
    await SLACK_SESSION_TOOLS.execute('setSlackCodeView', ctx, { type: 'diff', content: diff }, f.env)
    expect(f.api.setView).toHaveBeenCalledWith(
      expect.objectContaining({ channel_id: 'C1', type: 'diff', content: diff })
    )
    await f.conn.stop()
  })
})
