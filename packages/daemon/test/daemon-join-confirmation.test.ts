// The daemon's join confirmation (#2979): one card in the live turn's conversation, and a parked call's outcome back in its session.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Daemon } from '../src/daemon.js'
import { WorkBoundary } from '../src/messages/message-boundary.js'
import type { JoinRequest } from '../src/mcp/ops/join-ask.js'
import type { SessionContext } from '../src/mcp/ops.js'
import { JOIN_ANSWER_REFUSED } from '../src/permissions/join-confirmation.js'
import { TerminalOutputFolder } from '../src/session/terminal-output-folder.js'
import { TelegramConnection } from '../src/telegram/connection.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const AGENT = 'agent-1'
const INT = 'int-1'
const CHAT = '-100'
const THREAD = 'tg:50'

/** A daemon holding one live Telegram turn, asked by member 42, whose cards are recorded. */
async function world() {
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null })
  daemon.cfg = { ...(daemon.cfg ?? {}), webAppUrl: 'https://console.example.test' }
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  const int = {
    id: INT,
    platform: 'telegram',
    core: {
      mode: 'direct',
      bindRules: [],
      mutedChannels: [],
      gated: false,
      sessionModes: [],
      externalChannels: [],
      decisions: { bindings: [], definitions: [] }
    }
  }
  // People in chat may only talk to the agent: a join confirmation does not depend on that level.
  daemon.agents.set(AGENT, { id: AGENT, name: 'Butler', chatActions: 'talk', integrations: [int] })
  let n = 100
  const conn = Object.create(TelegramConnection.prototype)
  conn.postCard = vi.fn(async () => String(++n))
  conn.postChrome = vi.fn(async () => String(++n))
  conn.editCard = vi.fn(async () => {})
  conn.updateMessage = vi.fn(async () => {})
  conn.answerCallback = vi.fn(async () => {})
  daemon.tgConnByIntegration.set(INT, conn)
  const key = sessionKey('telegram', CHAT, THREAD, AGENT)
  daemon.pending.set(JSON.stringify([AGENT, 's1']), {
    plan: {
      platform: 'telegram',
      agentId: AGENT,
      agentName: 'Butler',
      integrationId: INT,
      sessionKey: key,
      requesterId: '42',
      channel: CHAT,
      thread: THREAD,
      transcriptChannel: CHAT,
      statusThread: THREAD,
      sessionThread: THREAD,
      isDm: false,
      approvalSurfaceSuppressed: false
    },
    entry: { msg: { source: 'user', text: 'post the notes in #general', sender: { id: '42', isBot: false } } },
    conn,
    hostKey: AGENT,
    acpSessionId: 's1',
    outwardSessionId: 'sid-1',
    turnState: { replyTo: 50 },
    chrome: {},
    reply: { text: '', attemptText: '', attemptAnswerUpdates: [] },
    signals: { applyChain: Promise.resolve() },
    approval: { waitMs: 0, depth: 0 },
    builtinSystemToolCallIds: new Set<string>(),
    conv: { onUpdate: () => [], hasBuffered: () => false },
    rec: { onUpdate: () => [] },
    termOut: new TerminalOutputFolder(),
    workBoundary: new WorkBoundary()
  })
  const ctx = { agentId: AGENT, platform: 'telegram', channel: CHAT, thread: THREAD } as SessionContext
  const ask: JoinRequest = {
    integrationId: 'int-slack',
    channel: 'C-GEN',
    name: 'general',
    purpose: 'post',
    askers: [{ kind: 'member', platform: 'telegram', integrationId: INT, userId: '42' }]
  }
  const tap = async (requestId: string, userId: string): Promise<string | undefined> => {
    conn.answerCallback.mockClear()
    await daemon.handleTelegramCallback(
      { id: 'cb-1', data: `ac_pm:${requestId}:0`, channel: CHAT, messageId: 101, userId, name: 'Ada Example' },
      conn
    )
    const [, text, how] = conn.answerCallback.mock.calls[0] as [string, string | undefined, { alert?: boolean }]
    return how?.alert ? text : undefined
  }
  return { daemon, store, conn, ctx, ask, tap }
}

describe('the daemon’s join confirmation', () => {
  it('cards the live turn’s conversation once for parallel calls, and only its asker answers', async () => {
    const w = await world()
    const offeredFirst = vi.fn()
    const offeredSecond = vi.fn()
    const first = w.daemon.confirmJoin(w.ctx, w.ask, offeredFirst)
    const second = w.daemon.confirmJoin(w.ctx, w.ask, offeredSecond)
    await vi.waitFor(() => expect(w.conn.postCard).toHaveBeenCalledTimes(1), WAIT)
    // Both parked calls hear the one offer, so both can return before the answer.
    await vi.waitFor(() => expect(offeredSecond).toHaveBeenCalledTimes(1), WAIT)
    expect(offeredFirst).toHaveBeenCalledTimes(1)
    const [channel, text, buttons, anchor] = w.conn.postCard.mock.calls[0] as [string, string, unknown[][], object]
    expect(channel).toBe(CHAT)
    expect(anchor).toMatchObject({ replyTo: 50 })
    expect(text).toContain('Let Butler join #general to post there?')
    expect(buttons.flat()).toEqual([
      expect.objectContaining({ text: 'Join' }),
      expect.objectContaining({ text: 'Don’t join' })
    ])
    const requestId = (await w.store.listPermissionRequests(AGENT))[0]!.id

    expect(await w.tap(requestId, '7')).toBe(JOIN_ANSWER_REFUSED)
    expect(w.conn.editCard).not.toHaveBeenCalled()
    expect(await w.tap(requestId, '42')).toBeUndefined()
    await expect(first).resolves.toBe('join')
    await expect(second).resolves.toBe('join')
    await vi.waitFor(() => expect(w.conn.editCard).toHaveBeenCalledTimes(1), WAIT)
    expect(String(w.conn.editCard.mock.calls[0]![2])).toContain('Joined #general — Ada Example')
    await w.store.close()
  })

  it('asks nothing without a live turn', async () => {
    const w = await world()
    w.daemon.pending.clear()
    await expect(w.daemon.confirmJoin(w.ctx, w.ask, vi.fn())).resolves.toBe('unavailable')
    expect(w.conn.postCard).not.toHaveBeenCalled()
    await w.store.close()
  })

  it('hands a parked call’s late outcome to its session as a new message', async () => {
    const w = await world()
    const key = sessionKey('telegram', CHAT, THREAD, AGENT)
    await w.store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'telegram',
      channel: CHAT,
      thread: THREAD,
      acpSessionId: 's1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: Date.now()
    })
    const dispatch = vi.fn(async () => {})
    w.daemon.dispatch = dispatch
    const call = { tool: 'getChannelHistory', name: 'general', purpose: 'read' as const, to: 'Ada Example' }
    await w.daemon.deliverJoinOutcome(w.ctx, { ...call, result: { messages: [{ text: 'hello' }] } })
    await w.daemon.deliverJoinOutcome(w.ctx, { ...call, error: 'getChannelHistory: the bot did not join #general.' })
    expect(dispatch).toHaveBeenCalledTimes(2)
    const [agentId, joined] = dispatch.mock.calls[0] as unknown as [
      string,
      { channel: string; text: string; source: string }
    ]
    expect(agentId).toBe(AGENT)
    expect(joined).toMatchObject({ channel: CHAT, source: 'agent' })
    expect(joined.text).toContain('ran once the bot joined')
    expect(joined.text).toContain('"text": "hello"')
    const [, refused] = dispatch.mock.calls[1] as unknown as [string, { text: string }]
    expect(refused.text).toContain('did nothing. getChannelHistory: the bot did not join #general.')
    await w.store.close()
  })
})
