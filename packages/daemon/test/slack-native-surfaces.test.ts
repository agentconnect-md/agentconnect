import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { normalizeSlackMessage } from '@agentconnect.md/message'
import { SLACK_CODE_MODEL_KEY, SLACK_CODE_CONTEXT_KEY } from '@agentconnect.md/protocol'
import { SlackConnection } from '../src/slack/connection.js'
import { SLACK_SESSION_TOOLS } from '../src/platforms/slack/agent-tools.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { slackThreadUrl } from '../src/platforms/slack/permalink.js'
import { gitFor } from '../src/workspace/git-injection.js'
import { LocalGitRunner } from '../src/workspace/git-runner.js'
import { openTaskDiff } from '../src/workspace/task-diff.js'
import { planCanvasMarkdown } from '../src/slack/render.js'
import { SLACK_CODE_CHANNEL_CONTEXT, SLACK_CONVERSATION_CONTEXT } from '../src/platforms/slack/standing-context.js'
import {
  applySlackAction,
  startSlackCodeDiff,
  type SlackTurn,
  type SlackTurnState
} from '../src/platforms/slack/turn-output.js'

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

async function fixture(code = true, deps: Record<string, unknown> = {}) {
  const app = fakeSlackAppFactory()({} as never)
  const handlers = new Map<string, (a: { event: unknown }) => unknown>()
  const commands = new Map<string, Parameters<typeof app.command>[1]>()
  app.command = (name, handler) => void commands.set(name, handler)
  app.event = ((type: string, h: (a: { event: unknown }) => unknown) => void handlers.set(type, h)) as typeof app.event
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
    listViews: vi.fn(
      async (_args: unknown): Promise<{ views?: { view_id?: string; view_key?: string; file_id?: string }[] }> => ({})
    ),
    setCanvasContent: vi.fn(async (_args: unknown) => ({})),
    removeView: vi.fn(async (_args: unknown) => ({}))
  }
  Object.assign(app.client.agents, { conversations: api })
  const conn = new SlackConnection(
    {
      group: { appToken: 'xapp', botToken: 'xoxb', integrations: [] },
      onMessage: () => {},
      newTraceId: () => 'trace',
      sendIntervalMs: 0,
      ...deps
    },
    () => app
  )
  await conn.start()
  const judgeWrite = vi.fn(async () => undefined)
  const recordPost = vi.fn(async (_text: string, _ts: string) => undefined)
  const env = {
    connection: conn,
    deliveryChannel: ctx.channel,
    deliveryThread: ctx.deliveryThread,
    originMsgId: 'slack:C1:1.002',
    judgeWrite,
    recordPost,
    postIdentity: () => ({ agentAuthorId: ctx.agentId, username: ctx.agentName })
  }
  return { conn, app, post, info, api, env, judgeWrite, handlers, commands }
}

describe('Slack native surfaces', () => {
  it('publishes Tasks for its owned code channel and stops reading on archive', async () => {
    const onCodeTasks = vi.fn(async () => ({
      tasks: [],
      truncated: false,
      runtime: { agentId: 'a1', sessionId: 's1', tracked: true, truncated: false, tasks: [] }
    }))
    const f = await fixture(true, { onCodeTasks })
    try {
      await f.conn.setStatus('C1', 'C1', 'Working', { sessionKey: 'key' })
      await vi.waitFor(() =>
        expect(f.api.setView).toHaveBeenCalledWith(
          expect.objectContaining({
            channel_id: 'C1',
            type: 'block_kit',
            view_key: 'agentconnect-tasks',
            name: 'Tasks'
          })
        )
      )
      expect(onCodeTasks).toHaveBeenCalledWith('C1', 'key')
      f.conn.codeChannelArchived('C1')
      await f.conn.setStatus('C1', '1700.001', 'Working', { sessionKey: 'thread' })
      expect(onCodeTasks).toHaveBeenCalledTimes(1)
    } finally {
      await f.conn.stop()
    }
  })

  it('does not read Tasks when another bot owns the code channel', async () => {
    const onCodeTasks = vi.fn()
    const f = await fixture(true, { onCodeTasks })
    f.info.mockResolvedValue({
      channel: {
        properties: {
          record_channel: { record_type: 'agent_channel' },
          agent_session: { encoded_agent_bot_user_ids: ['U_OTHER'] }
        }
      }
    })
    try {
      await f.conn.setStatus('C1', 'C1', 'Working', { sessionKey: 'key' })
      await f.conn.setStatus('C1', 'C1', '')
      expect(onCodeTasks).not.toHaveBeenCalled()
      expect(f.api.setView).not.toHaveBeenCalled()
    } finally {
      await f.conn.stop()
    }
  })

  it('keeps header-free controls and informational links intact across usage and tool updates', async () => {
    const f = await fixture()
    let items: { key: string; label: string; icon?: string; item_type?: string }[] = [
      { key: 'repo', label: 'example-repo', icon: 'branch' }
    ]
    f.info.mockImplementation(async () => ({
      channel: {
        properties: {
          record_channel: { record_type: 'agent_channel' },
          agent_session: { encoded_agent_bot_user_ids: ['U_FAKE_BOT'] },
          code_channel: { context_bar_items: items }
        }
      }
    }))
    f.api.setProperties.mockImplementation(async (args) => {
      items = (args as { code_channel: { context_bar_items: typeof items } }).code_channel.context_bar_items
      return {}
    })
    const info = { model: 'gpt-6-sol', effort: 'high', contextUsed: 42000, contextSize: 200000, totalTokens: 900000 }
    const turn = {
      conn: f.conn,
      chrome: {},
      reply: {},
      plan: {
        platform: 'slack',
        channel: 'C1',
        sessionThread: 'C1',
        statusThread: 'C1',
        sessionKey: 'session',
        isDm: false
      }
    } as SlackTurn
    const host = {
      recordReplySegment: vi.fn(),
      appendTranscript: vi.fn(),
      getStatusBarTs: vi.fn(async () => undefined),
      setStatusBarTs: vi.fn(),
      clearStatusBarTs: vi.fn(),
      monotonicTs: () => '',
      debug: vi.fn()
    }
    try {
      await applySlackAction(host, turn, {}, { kind: 'clear-status-bar', info })
      expect(f.post).not.toHaveBeenCalled()
      expect(items).toEqual([
        { key: SLACK_CODE_MODEL_KEY, label: 'gpt-6-sol · high', icon: 'code', item_type: 'action' },
        { key: SLACK_CODE_CONTEXT_KEY, label: '42k/200k', icon: 'terminal', item_type: 'action' },
        expect.objectContaining({ key: 'repo', icon: 'branch' })
      ])
      await Promise.all([
        f.conn.updateCodeContext('C1', { info: { ...info, contextUsed: 84000 } }),
        SLACK_SESSION_TOOLS.execute(
          'manageSlackCodeChannel',
          ctx,
          {
            action: 'context',
            items: [
              { key: 'repo', label: 'example-repo', icon: 'branch' },
              {
                key: 'pr',
                label: 'PR #42',
                status: 'failed',
                url: 'https://github.com/example-org/example-repo/pull/42'
              }
            ]
          },
          f.env
        )
      ])
      expect(items.map((item) => item.label)).toEqual(['gpt-6-sol · high', '84k/200k', 'example-repo', '✕ PR #42'])
      expect(items.at(-1)).not.toHaveProperty('icon', 'link')
      const calls = f.api.setProperties.mock.calls.length
      await f.conn.updateCodeContext('C1', { info: { ...info, contextUsed: 84000, totalTokens: 999999 } })
      expect(f.api.setProperties).toHaveBeenCalledTimes(calls)
      await SLACK_SESSION_TOOLS.execute('manageSlackCodeChannel', ctx, { action: 'context', items: [] }, f.env)
      expect(items.map((item) => item.key)).toEqual([SLACK_CODE_MODEL_KEY, SLACK_CODE_CONTEXT_KEY])
      await f.conn.updateCodeContext('C1', { info: { model: 'gpt-6-sol', contextUsed: 42000 } })
      expect(items[1]?.label).toBe('42k')
      await f.conn.updateCodeContext('C1', { info: { model: 'gpt-6-sol', totalTokens: 900000 } })
      expect(items.map((item) => item.key)).toEqual([SLACK_CODE_MODEL_KEY])
    } finally {
      await f.conn.stop()
    }
  })

  it.each([true, false])('opens only the owned code channel session from a native action (code=%s)', async (code) => {
    const onMessageShortcut = vi.fn(async () => 'code-session')
    const f = await fixture(code, {
      onMessageShortcut,
      onStatusInfo: async () => ({ info: { model: 'gpt-6-sol', outputMode: 'medium' } })
    })
    const open = vi.spyOn(f.app.client.views, 'open')
    const ack = vi.fn(async () => {})
    try {
      for (const key of [SLACK_CODE_MODEL_KEY, SLACK_CODE_CONTEXT_KEY]) {
        await f.commands.get(`/${key}`)!({ ack, command: { channel_id: 'C1', user_id: 'U1', trigger_id: 'trigger' } })
      }
      expect(ack).toHaveBeenCalledTimes(2)
      if (code) {
        expect(onMessageShortcut).toHaveBeenCalledWith({ channel: 'C1', thread: 'C1', userId: 'U1' })
        expect(open).toHaveBeenCalledWith(
          expect.objectContaining({ view: expect.objectContaining({ private_metadata: 'code-session' }) })
        )
        expect(JSON.stringify(open.mock.calls[0])).toContain('Output')
      } else {
        expect(onMessageShortcut).not.toHaveBeenCalled()
        expect(JSON.stringify(open.mock.calls[0])).toContain('No AgentConnect session')
      }
    } finally {
      await f.conn.stop()
    }
  })

  it('drops a queued diff when Stop arrives before Slack can send it', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const started = new Promise<void>((done) => {
      entered = done
    })
    f.api.setView.mockImplementationOnce(async () => {
      entered()
      await new Promise<void>((done) => {
        release = done
      })
      return {}
    })
    const first = f.conn.codeChannelApi('setView', { channel_id: 'C1', type: 'diff', content: 'first' })
    await started
    const abort = new AbortController()
    const queued = f.conn.codeChannelApi(
      'setView',
      { channel_id: 'C1', type: 'diff', content: 'stopped' },
      abort.signal
    )
    const rejected = expect(queued).rejects.toThrow()
    abort.abort()
    release()
    try {
      await first
      await rejected
      expect(f.api.setView).toHaveBeenCalledTimes(1)
    } finally {
      await f.conn.stop()
    }
  })

  it('publishes a task’s diff in the code channel it made against the start it kept in its thread (auto-session-mode.md §6.8)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'task-channel-diff-'))
    const git = (args: string[]) =>
      execFileSync('git', args, {
        cwd: root,
        env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_COMMITTER_NAME: 'Test' },
        encoding: 'utf8'
      })
    git(['init', '--initial-branch=main'])
    git(['config', 'user.email', 'test@example.test'])
    writeFileSync(join(root, 'app.js'), 'export const count = 1\n')
    git(['add', '.'])
    git(['commit', '-m', 'initial'])
    const sources = [
      { git: new LocalGitRunner(gitFor(root), root, (env) => gitFor(root, undefined, env)), name: 'repo' }
    ]
    const thread = await fixture(false)
    const channel = await fixture(true)
    try {
      // Its first turn, in the thread it was opened in, publishes nothing and keeps the task's start.
      const keepStart = vi.fn(async () => void (await openTaskDiff(sources, 'task-key', true)))
      const origin = {
        conn: thread.conn,
        plan: { channel: 'C1', sessionThread: '1.001', statusThread: '1.001', isDm: false }
      } as SlackTurn
      const host = {
        authorize: async () => {},
        active: () => true,
        mask: (text: string) => text,
        notice: async () => {},
        debug: () => {}
      }
      expect(
        await startSlackCodeDiff(
          origin,
          {},
          { ...host, open: () => openTaskDiff(sources, 'task-key', false), keepStart }
        )
      ).toBeUndefined()
      expect(keepStart).toHaveBeenCalledOnce()
      expect(thread.api.setView).not.toHaveBeenCalled()
      writeFileSync(join(root, 'app.js'), 'export const count = 2\n')
      // A later turn in the code channel it holds, keyed on the same session, diffs against that start.
      const state: SlackTurnState = {}
      const held = {
        conn: channel.conn,
        plan: { channel: 'C2', sessionThread: '1.001', statusThread: 'C2', isDm: false }
      } as SlackTurn
      expect(
        await startSlackCodeDiff(held, state, { ...host, open: () => openTaskDiff(sources, 'task-key', false) })
      ).toContain('platform maintains')
      await state.codeDiff!.settle()
      state.codeDiff!.stop()
      expect(channel.api.setView).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel_id: 'C2',
          type: 'diff',
          content: expect.stringContaining('+export const count = 2')
        })
      )
    } finally {
      await thread.conn.stop()
      await channel.conn.stop()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('updates the owned channel through the authorized platform output without a model tool call', async () => {
    const f = await fixture()
    const state: SlackTurnState = {}
    const authorize = vi.fn(async () => {})
    let content = 'diff --git a/a b/a\n'
    const turn = {
      conn: f.conn,
      plan: { channel: 'C1', sessionThread: 'C1', statusThread: 'C1', isDm: false }
    } as SlackTurn
    const context = await startSlackCodeDiff(turn, state, {
      authorize,
      open: async () => ({ read: async () => content }),
      active: () => true,
      mask: (text) => text,
      notice: async () => {},
      debug: () => {}
    })
    try {
      expect(context).toContain('platform maintains')
      await state.codeDiff!.settle()
      expect(authorize).toHaveBeenCalledTimes(2)
      expect(f.api.setView).toHaveBeenCalledExactlyOnceWith({
        channel_id: 'C1',
        type: 'diff',
        content: 'diff --git a/a b/a\n',
        base_branch: 'Task start',
        head_branch: 'Current workspace'
      })
      f.api.listViews.mockResolvedValue({ views: [{ view_id: 'code' }] })
      content = ''
      await startSlackCodeDiff(turn, state, {
        authorize,
        open: async () => ({ read: async () => content }),
        active: () => true,
        mask: (text) => text,
        notice: async () => {},
        debug: () => {}
      })
      await state.codeDiff!.settle()
      expect(f.api.removeView).toHaveBeenCalledExactlyOnceWith({ channel_id: 'C1', view_id: 'code' })
    } finally {
      state.codeDiff?.stop()
      await f.conn.stop()
    }
  })

  it('does not open workspaces or publish in an ordinary channel', async () => {
    const f = await fixture(false)
    const open = vi.fn()
    try {
      expect(
        await startSlackCodeDiff(
          { conn: f.conn, plan: { channel: 'C1', sessionThread: 'C1', isDm: false } } as SlackTurn,
          {},
          {
            open,
            authorize: async () => {},
            active: () => true,
            mask: (text) => text,
            notice: async () => {},
            debug: () => {}
          }
        )
      ).toBeUndefined()
      expect(open).not.toHaveBeenCalled()
      expect(f.api.setView).not.toHaveBeenCalled()
    } finally {
      await f.conn.stop()
    }
  })

  it('posts summary columns, collapsible details and numeric table cells in the current delivery thread', async () => {
    const f = await fixture()
    await SLACK_SESSION_TOOLS.execute(
      'presentSlackReport',
      ctx,
      {
        title: 'Results',
        summary: ['*Status*\nPassed', '*Checks*\n12', '*Duration*\n3 minutes', '*Next*\nReview'],
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
    expect(sent.text).toContain('*Status*\nPassed')
    expect(sent.text).toContain('*Next*\nReview')
    expect(f.env.recordPost).toHaveBeenCalledWith(expect.stringContaining('Results'), expect.any(String))
    expect(sent.blocks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'layout',
          label: 'Results',
          rows: [
            { items: [expect.any(Object), expect.any(Object), expect.any(Object)] },
            { items: [{ block: { type: 'section', text: { type: 'mrkdwn', text: '*Next*\nReview' } } }] }
          ],
          fallback: expect.arrayContaining([
            { type: 'section', text: { type: 'mrkdwn', text: '*Status*\nPassed' } },
            { type: 'section', text: { type: 'mrkdwn', text: '*Next*\nReview' } }
          ])
        }),
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

  it('accepts a summary without requiring details or a table', async () => {
    const f = await fixture()
    await SLACK_SESSION_TOOLS.execute(
      'presentSlackReport',
      ctx,
      { title: 'Overview', summary: ['*Status*\nReady', '*Owner*\nTeam'] },
      f.env
    )
    expect(f.post.mock.calls[0]![0]).toMatchObject({
      text: expect.stringContaining('*Owner*\nTeam'),
      blocks: expect.arrayContaining([expect.objectContaining({ type: 'layout' })])
    })
    await f.conn.stop()
  })

  it('refuses malformed table dimensions before posting and preserves write refusals', async () => {
    const f = await fixture(false)
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
    const f = await fixture(false)
    await SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, f.env)
    await SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, f.env)
    expect(f.api.create.mock.calls[0]).toEqual(f.api.create.mock.calls[1])
    expect(f.api.create.mock.calls[0]).toEqual([
      expect.objectContaining({ origin_channel_id: 'C1', origin_message_ts: '1.002' })
    ])
    expect(f.api.create.mock.calls[0]![0]).not.toHaveProperty('is_private')
    await f.conn.stop()
  })

  it('hands the channel it makes to the session as a room keyed on the channel (auto-session-mode.md §6.8)', async () => {
    const f = await fixture(false)
    const rooms: unknown[] = []
    const makeRoom = async <T>(make: () => Promise<{ result: T; room?: { channel: string; thread: string } }>) => {
      const { result, room } = await make()
      rooms.push(room)
      return result
    }
    const result = await SLACK_SESSION_TOOLS.execute(
      'createSlackCodeChannel',
      ctx,
      { name: 'Flaky test' },
      { ...f.env, makeRoom }
    )
    expect(result).toMatchObject({ channel_id: 'C2' })
    expect(rooms).toEqual([{ channel: 'C2', thread: 'C2' }])
    expect(f.api.create.mock.calls[0]![0]).toMatchObject({ origin_channel_id: 'C1', origin_message_ts: '1.002' })
    await f.conn.stop()
  })

  it('hands no room for a channel it is already in, nor when Slack refuses', async () => {
    const inside = await fixture(true)
    const rooms: unknown[] = []
    const makeRoom = async <T>(make: () => Promise<{ result: T; room?: { channel: string; thread: string } }>) => {
      const { result, room } = await make()
      rooms.push(room)
      return result
    }
    await SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, { ...inside.env, makeRoom })
    expect(rooms).toEqual([undefined])
    expect(inside.api.create).not.toHaveBeenCalled()
    await inside.conn.stop()
    const refused = await fixture(false)
    refused.api.create.mockRejectedValueOnce(
      Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope' } })
    )
    await expect(
      SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, { ...refused.env, makeRoom })
    ).rejects.toThrow()
    expect(rooms).toEqual([undefined])
    await refused.conn.stop()
  })

  it('acts in the turn’s own channel when a task answers there from a session kept elsewhere', async () => {
    const f = await fixture(true)
    // A task's session lives in its origin thread of C0EXAMPLE1, and this turn runs in the code channel C1 it holds.
    const task = { ...ctx, channel: 'C0EXAMPLE1', thread: '1.001' }
    const env = { ...f.env, deliveryChannel: 'C1', deliveryThread: 'C1', originMsgId: 'slack:C1:1.003' }
    expect(await SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', task, { name: 'Task' }, env)).toMatchObject({
      channel_id: 'C1',
      already_exists: true
    })
    await SLACK_SESSION_TOOLS.execute('manageSlackCodeChannel', task, { action: 'listViews' }, env)
    expect(f.api.listViews).toHaveBeenCalledWith({ channel_id: 'C1' })
    await f.conn.stop()
  })

  it('reuses the code channel when Slack delivers the copied origin as a new request', async () => {
    const f = await fixture()
    const msg = { channel: 'C1', thread: '1.002', isDm: false } as NormalizedMessage
    await f.conn.prepareInboundMessage(msg)
    const result = await SLACK_SESSION_TOOLS.execute(
      'createSlackCodeChannel',
      { ...ctx, thread: msg.thread! },
      { name: 'Task' },
      f.env
    )
    expect(result).toMatchObject({ channel_id: 'C1', already_exists: true })
    expect(msg.standingContext).toBe(SLACK_CODE_CHANNEL_CONTEXT)
    expect(f.api.create).not.toHaveBeenCalled()
    expect(f.judgeWrite).not.toHaveBeenCalled()
    await f.conn.stop()
  })

  it('allows DM creation without requiring conversation discovery scopes', async () => {
    const f = await fixture(false)
    f.info.mockRejectedValue(new Error('missing_scope'))
    const msg = { channel: 'D1', thread: '1.001', isDm: true } as NormalizedMessage
    await f.conn.prepareInboundMessage(msg)
    await SLACK_SESSION_TOOLS.execute(
      'createSlackCodeChannel',
      { ...ctx, channel: 'D1', isDm: true },
      { name: 'Task' },
      { ...f.env, deliveryChannel: 'D1', originMsgId: 'slack:D1:1.002' }
    )
    expect(msg.standingContext).toBe(SLACK_CONVERSATION_CONTEXT)
    expect(f.info).not.toHaveBeenCalled()
    expect(f.api.create).toHaveBeenCalledOnce()
    await f.conn.stop()
  })

  it('canonicalizes consecutive messages and omits thread timestamps on channel lifecycle and replies', async () => {
    const f = await fixture()
    const status = vi.spyOn(f.app.client.agents.sessions, 'setStatus')
    const rename = vi.spyOn(f.app.client.agents.sessions, 'rename')
    const first = normalizeSlackMessage({ type: 'message', channel: 'C1', ts: '1.001', user: 'U1', text: 'Start' })!
    const next = normalizeSlackMessage({ type: 'message', channel: 'C1', ts: '1.002', user: 'U1', text: 'Continue' })!
    const reply = normalizeSlackMessage({
      type: 'message',
      channel: 'C1',
      ts: '1.003',
      thread_ts: '1.001',
      user: 'U1',
      text: 'Question'
    })!
    await f.conn.prepareInboundMessage(first)
    await f.conn.prepareInboundMessage(next)
    await f.conn.prepareInboundMessage(reply)
    expect(first.thread).toBe('C1')
    expect(next.thread).toBe(first.thread)
    expect(reply).toMatchObject({ thread: 'C1', replyThread: '1.001' })
    expect(first.replyThread).toBeUndefined()
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
    await f.conn.postMessage('C1', 'Thread answer', reply.replyThread)
    expect(f.post).toHaveBeenLastCalledWith(expect.objectContaining({ thread_ts: '1.001' }))
    await f.conn.stop()
  })

  it('lists Code sessions separately and excludes archived memberships', async () => {
    const f = await fixture()
    vi.spyOn(f.app.client.users, 'conversations').mockResolvedValue({
      channels: [
        { id: 'C1', properties: { record_channel: { record_type: 'agent_channel' } } },
        { id: 'C2' },
        { id: 'C3', is_archived: true, properties: { record_channel: { record_type: 'agent_channel' } } }
      ]
    })
    expect(await f.conn.listBotChannels()).toEqual([
      expect.objectContaining({ id: 'C1', isCodeSession: true }),
      expect.objectContaining({ id: 'C2', isCodeSession: false })
    ])
    await f.conn.stop()
  })

  it('leaves ordinary threads intact and refuses code tools on ordinary channels', async () => {
    const f = await fixture(false)
    const msg = { channel: 'C1', thread: '1.001', isDm: false } as NormalizedMessage
    await f.conn.prepareInboundMessage(msg)
    expect(msg.thread).toBe('1.001')
    expect(msg.standingContext).toBe(SLACK_CONVERSATION_CONTEXT)
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
    const relayed: NormalizedMessage = { ...ordinary, thread: 'C1', conversationBotId: 'U_FAKE_BOT' }
    await expect(f.conn.prepareInboundMessage(ordinary)).resolves.toBeUndefined()
    await expect(f.conn.prepareInboundMessage(relayed)).resolves.toBeUndefined()
    expect(ordinary).toMatchObject({ channel: 'C1', thread: '1.001' })
    expect(relayed).toMatchObject({ channel: 'C1', thread: 'C1', conversationBotId: 'U_FAKE_BOT' })
    expect(relayed.standingContext).toBe(SLACK_CODE_CHANNEL_CONTEXT)
    await expect(SLACK_SESSION_TOOLS.execute('createSlackCodeChannel', ctx, { name: 'Task' }, f.env)).rejects.toThrow(
      'lookup unavailable'
    )
    expect(f.api.create).not.toHaveBeenCalled()
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

  it('renders the plan as a canvas checklist with the step in progress in bold', () => {
    expect(
      planCanvasMarkdown([
        { content: 'Read the code', status: 'completed' },
        { content: 'Fix  the\nbug', status: 'in_progress' },
        { content: 'Open a PR', status: 'pending' }
      ] as never)
    ).toBe('# Plan\n\n- [x] Read the code\n- [ ] **Fix the bug**\n- [ ] Open a PR')
  })

  it('attaches the plan as a comment-only Plan tab once, then rewrites only its newest content', async () => {
    const f = await fixture()
    const create = vi.spyOn(f.app.client.canvases, 'create')
    f.conn.writePlanCanvas('C1', '# Plan\n\n- [ ] one')
    await vi.waitFor(() => expect(f.api.setView).toHaveBeenCalled())
    expect(create).toHaveBeenCalledWith({
      title: 'Plan',
      document_content: { type: 'markdown', markdown: '# Plan\n\n- [ ] one' }
    })
    expect(f.api.setView).toHaveBeenCalledWith({
      channel_id: 'C1',
      type: 'canvas',
      view_key: 'plan',
      name: 'Plan',
      canvas_id: 'F_FAKE_CANVAS',
      access_level: 'comment'
    })
    f.conn.writePlanCanvas('C1', 'two')
    f.conn.writePlanCanvas('C1', 'three')
    f.conn.writePlanCanvas('C1', 'four')
    await vi.waitFor(() =>
      expect(f.api.setCanvasContent).toHaveBeenLastCalledWith({
        channel: 'C1',
        canvas_id: 'F_FAKE_CANVAS',
        content: 'four'
      })
    )
    expect(f.api.setCanvasContent.mock.calls.length).toBeLessThan(3)
    expect(create).toHaveBeenCalledOnce()
    await f.conn.stop()
  })

  it('reuses the Plan tab a restarted daemon attached earlier, and writes nothing in a channel it does not own', async () => {
    const f = await fixture()
    f.api.listViews.mockResolvedValue({ views: [{ view_key: 'plan', file_id: 'F_EARLIER' }] })
    f.conn.writePlanCanvas('C1', 'plan')
    await vi.waitFor(() =>
      expect(f.api.setCanvasContent).toHaveBeenCalledWith({ channel: 'C1', canvas_id: 'F_EARLIER', content: 'plan' })
    )
    expect(f.api.setView).not.toHaveBeenCalled()
    await f.conn.stop()

    const other = await fixture(false)
    other.conn.writePlanCanvas('C1', 'plan')
    await vi.waitFor(() => expect(other.info).toHaveBeenCalled())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(other.api.listViews).not.toHaveBeenCalled()
    expect(other.api.setView).not.toHaveBeenCalled()
    await other.conn.stop()
  })

  it('marks the session Done before the agent archives its code channel', async () => {
    const f = await fixture()
    const status = vi.spyOn(f.app.client.agents.sessions, 'setStatus')
    await SLACK_SESSION_TOOLS.execute(
      'manageSlackCodeChannel',
      ctx,
      { action: 'archive', summaryMessageTs: '1.003' },
      f.env
    )
    expect(status).toHaveBeenCalledWith({ channel_id: 'C1', status: 'closed' })
    expect(status.mock.invocationCallOrder[0]!).toBeLessThan(f.api.archive.mock.invocationCallOrder[0]!)
    expect(f.api.archive).toHaveBeenCalledWith({ channel_id: 'C1', summary_message_ts: '1.003' })
    await f.conn.stop()
  })

  it('closes the task a code channel holds when the agent archives it', async () => {
    const onPlaceClosed = vi.fn()
    const f = await fixture(true, { onPlaceClosed })
    await SLACK_SESSION_TOOLS.execute('manageSlackCodeChannel', ctx, { action: 'archive' }, f.env)
    expect(onPlaceClosed).toHaveBeenCalledWith({ channel: 'C1', thread: 'C1' })
    await f.conn.stop()
  })

  it('spares the turn that archived its own code channel, and still stops the others', async () => {
    const actions: unknown[] = []
    const f = await fixture(true, {
      onThreadSessions: async () => ['slack:C1:C1:a1', 'slack:C1:C1:a2'],
      onStatusAction: (a: unknown) => void actions.push(a)
    })
    const own = { ...ctx, thread: 'C1', deliveryThread: 'C1' }
    await SLACK_SESSION_TOOLS.execute('manageSlackCodeChannel', own, { action: 'archive' }, f.env)
    await f.handlers.get('channel_archive')!({ event: { channel: 'C1', user: 'U_FAKE_BOT' } })
    expect(actions).toEqual([{ kind: 'cancel', sessionKey: 'slack:C1:C1:a2', actor: { userId: 'U_FAKE_BOT' } }])
    // Only that archive's event spares it.
    actions.length = 0
    await f.handlers.get('channel_archive')!({ event: { channel: 'C1', user: 'U1' } })
    expect(actions).toHaveLength(2)
    await f.conn.stop()
  })

  it('names a code channel as the thread its root posts belong to, and no other channel', async () => {
    const f = await fixture()
    expect(await f.conn.roomThread('C1')).toBe('C1')
    const ordinary = await fixture(false)
    expect(await ordinary.conn.roomThread('C1')).toBeUndefined()
    await f.conn.stop()
    await ordinary.conn.stop()
  })

  it.each(['channel_archive', 'group_archive'] as const)(
    '%s stops every channel session and delegated task',
    async (type) => {
      const actions: unknown[] = []
      const closed: unknown[] = []
      const deps = {
        onThreadSessions: async () => ['slack:C1:C1:a1', 'slack:C1:C1:a2'],
        onStopThreadTasks: () => ['slack:C1:task:a1', 'slack:C1:C1:a2'],
        onStatusAction: (a: unknown) => void actions.push(a),
        onPlaceClosed: (a: unknown) => void closed.push(a)
      }
      const f = await fixture(true, deps)
      await f.conn.setStatus('C1', 'C1', 'working', { sessionKey: 'slack:C1:C1:a2' })
      await f.handlers.get(type)!({ event: { channel: 'C1', user: 'U1' } })
      expect(actions).toEqual([
        { kind: 'cancel', sessionKey: 'slack:C1:C1:a1', actor: { userId: 'U1' } },
        { kind: 'cancel', sessionKey: 'slack:C1:C1:a2', actor: { userId: 'U1' } },
        { kind: 'cancel', sessionKey: 'slack:C1:task:a1', actor: { userId: 'U1' } }
      ])
      // The task the channel holds closes too (auto-session-mode.md §6.8).
      expect(closed).toEqual([{ channel: 'C1', thread: 'C1' }])
      await f.conn.stop()

      const ordinary = await fixture(false, deps)
      actions.length = 0
      closed.length = 0
      await ordinary.handlers.get(type)!({ event: { channel: 'C1', user: 'U1' } })
      expect(actions).toEqual([])
      expect(closed).toEqual([])
      await ordinary.conn.stop()
    }
  )

  it('closes the channel’s task on a relayed archive, and on no native Stop', async () => {
    const onPlaceClosed = vi.fn()
    const f = await fixture(true, { sendOnly: true, onThreadSessions: async () => [], onPlaceClosed })
    await f.conn.agentSessionStopped('C1', 'C1', 'U1')
    expect(onPlaceClosed).not.toHaveBeenCalled()
    await f.conn.agentSessionStopped('C1', 'C1', 'U1', true)
    expect(onPlaceClosed).toHaveBeenCalledWith({ channel: 'C1', thread: 'C1' })
    await f.conn.stop()
  })

  it('native Stop in a code channel still targets only the displayed agent', async () => {
    const onStatusAction = vi.fn()
    const f = await fixture(true, {
      onThreadSessions: async () => ['slack:C1:C1:a1', 'slack:C1:C1:a2'],
      onStatusAction
    })
    await f.conn.setStatus('C1', 'C1', 'working', { sessionKey: 'slack:C1:C1:a2' })
    await f.handlers.get('agent_session_stopped')!({ event: { channel: 'C1', user: 'U1' } })
    expect(onStatusAction.mock.calls).toEqual([
      [{ kind: 'cancel', sessionKey: 'slack:C1:C1:a2', actor: { userId: 'U1' } }]
    ])
    await f.conn.stop()
  })
})
