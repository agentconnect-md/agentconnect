// Where a background task's completion reaches its conversation: the thread of the turn that started the task.
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { FakeClock } from '@agentconnect.md/connection'
import { agentHostKey } from '../src/acp/host-key.js'
import { Daemon } from '../src/daemon.js'
import { BG_TASK_WAKE_GRACE_MS } from '../src/daemon/constants.js'
import { pendingTurnKey } from '../src/daemon/turn-types.js'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import { LocalStore, sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { fakeSlackAppFactory } from './fakes/slack-app.js'
import { WAIT } from './wait-support.js'

const AGENT = 'agent-1'
const OWNER = agentHostKey(AGENT)
const DM = 'D-ADA'
const ACP = 'acp-1'
/** The person's message the turn that started the task replied under. */
const ASKED_UNDER = '1700.0001'
/** A DM that is one long session. */
const APPEND = 'append:1000'
const evt = (subtype: string, extra: Record<string, unknown> = {}) => ({ type: 'system', subtype, ...extra })

/** A daemon with one idle Slack DM session at `thread`, whose turn replying in `replyThread` started a task that settled after it ended. */
async function settledTask(thread: string, replyThread: string | undefined) {
  const clock = new FakeClock(1_000_000)
  const daemon: any = new Daemon({ slackAppFactory: fakeSlackAppFactory(), sandboxMechanism: null, clock })
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  daemon.store = store
  daemon.agents.set(AGENT, {
    id: AGENT,
    name: 'Butler',
    output: { mode: 'medium', showFooter: false },
    integrations: [{ id: 'int-s', platform: 'slack' }]
  })
  const conn = { postMessage: vi.fn(async (..._args: unknown[]) => '1700.0009') }
  daemon.connByIntegration.set('int-s', conn)
  const key = sessionKey('slack', DM, thread, AGENT)
  await store.upsertSession({
    key,
    agentId: AGENT,
    platform: 'slack',
    channel: DM,
    thread,
    acpSessionId: ACP,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1
  })
  await store.setSessionClassification(key, { conversationKind: 'dm' })
  const dispatch = vi.fn(async () => {})
  daemon.dispatch = dispatch

  // The turn starts the task, then ends before it settles.
  daemon.pending.set(pendingTurnKey(OWNER, ACP), {
    plan: { sessionKey: key, channel: DM, ...(replyThread !== undefined ? { thread: replyThread } : {}) }
  })
  await daemon.onSdkLifecycle(OWNER, ACP, evt('task_started', { task_id: 't1', description: 'Run the test suite' }))
  daemon.pending.delete(pendingTurnKey(OWNER, ACP))
  await daemon.onSdkLifecycle(OWNER, ACP, evt('task_notification', { task_id: 't1' }))

  /** The wake the daemon dispatches once the grace period passes with nothing narrated. */
  const wake = async (): Promise<NormalizedMessage> => {
    clock.advance(BG_TASK_WAKE_GRACE_MS)
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1), WAIT)
    const [, msg] = dispatch.mock.calls[0] as unknown as [string, NormalizedMessage]
    expect(msg.text).toContain('[background job finished] Run the test suite')
    await store.close()
    return msg
  }
  /** The runtime's own drain cycle narrates the result; the thread it is posted in, and the one its transcript row carries. */
  const narration = async (): Promise<{ posted: unknown; recorded: unknown }> => {
    await daemon.onSdkLifecycle(OWNER, ACP, evt('session_state_changed', { state: 'running' }))
    await daemon.onAcpUpdate(OWNER, ACP, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'All 12 tests pass.' }
    })
    clock.advance(10)
    await daemon.onSdkLifecycle(OWNER, ACP, evt('session_state_changed', { state: 'idle' }))
    await vi.waitFor(() => expect(conn.postMessage).toHaveBeenCalledTimes(1), WAIT)
    const [channel, text, posted] = conn.postMessage.mock.calls[0]!
    expect([channel, text]).toEqual([DM, 'All 12 tests pass.'])
    const rows = await store.transcriptSince(
      { transcriptChannel: transcriptChannelKey(DM, null), coordinate: thread, sessionKey: key, agentId: AGENT },
      null
    )
    const row = rows.find((r: { text: string }) => r.text === 'All 12 tests pass.')
    expect(row).toBeDefined()
    await store.close()
    return { posted, recorded: row!.thread }
  }
  return { wake, narration }
}

describe('the wake for a background task that settled after its turn', () => {
  it('replies under the message whose turn started the task, in a single-session DM', async () => {
    const msg = await (await settledTask(APPEND, ASKED_UNDER)).wake()
    expect(msg).toMatchObject({ channel: DM, thread: ASKED_UNDER, sessionThread: APPEND, isDm: true })
  })

  it('stays at the top level when the turn that started it had no thread', async () => {
    const msg = await (await settledTask(APPEND, undefined)).wake()
    expect(msg.thread).toBeUndefined()
    expect(msg.sessionThread).toBe(APPEND)
  })

  it('replies in a per-thread session’s own thread, as before', async () => {
    const msg = await (await settledTask(ASKED_UNDER, ASKED_UNDER)).wake()
    expect(msg.thread).toBe(ASKED_UNDER)
    expect(msg.sessionThread).toBeUndefined()
  })
})

describe('the narration of a background task’s drain cycle', () => {
  it('is posted under the message whose turn started the task, in a single-session DM', async () => {
    const { posted, recorded } = await (await settledTask(APPEND, ASKED_UNDER)).narration()
    expect(posted).toBe(ASKED_UNDER)
    expect(recorded).toBe(ASKED_UNDER)
  })

  it('stays at the top level when the turn that started it had no thread', async () => {
    const { posted, recorded } = await (await settledTask(APPEND, undefined)).narration()
    expect(posted).toBeUndefined()
    expect(recorded ?? null).toBeNull()
  })

  it('is posted in a per-thread session’s own thread, as before', async () => {
    const { posted, recorded } = await (await settledTask(ASKED_UNDER, ASKED_UNDER)).narration()
    expect(posted).toBe(ASKED_UNDER)
    expect(recorded).toBe(ASKED_UNDER)
  })
})
