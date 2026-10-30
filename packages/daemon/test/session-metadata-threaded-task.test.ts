// auto-session-mode.md §6.2, §11: a threaded task's metadata names the coordinator that opened it, as lineage only.
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventSession } from '@agentconnect.md/protocol'
import { SessionMetadataOutbox, type SessionMetadataHost } from '../src/store/session-metadata-outbox.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaab'
const NOW = 1_000_000

let opened: { outbox: SessionMetadataOutbox; store: LocalStore } | undefined
afterEach(async () => {
  opened?.outbox.dispose()
  await opened?.store.close()
  opened = undefined
})

async function world() {
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  const sync = vi.fn<(event: EventSession) => Promise<'acknowledged' | 'unsupported'>>(async () => 'acknowledged')
  const host: SessionMetadataHost = {
    store: () => store,
    warn: vi.fn(),
    debug: vi.fn(),
    clock: () => ({ now: () => NOW, setTimeout, clearTimeout }) as never,
    daemonId: () => 'd1',
    controlPlaneConfigured: () => true,
    draining: () => false,
    cpClient: () => ({ state: 'READY', supportsServerFeature: () => true, syncEventSession: sync }) as never,
    agents: () => new Map([[AGENT, { id: AGENT } as never]]),
    servesAgent: () => true,
    sessionLink: (id) => `https://console.example.test/sessions/${id}`,
    sessionThreadUrl: () => undefined
  }
  const outbox = new SessionMetadataOutbox(host)
  opened = { outbox, store }
  const session = async (channel: string, thread: string, kind: 'channel' | 'dm' = 'channel') => {
    const key = sessionKey('slack', channel, thread, AGENT, 'T0EXAMPLE')
    await store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel,
      thread,
      transportScope: 'T0EXAMPLE',
      acpSessionId: `acp-${channel}-${thread}`,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: NOW,
      triggeredBy: 'U0ALICE'
    })
    await store.setSessionClassification(key, { conversationKind: kind })
    return { key, channel, thread, outward: await store.ensureOutwardSessionId(key, AGENT, NOW) }
  }
  /** Index `task` under `coordinator`, with its own thread attached unless it works in the background. */
  const taskOf = async (
    coordinator: Awaited<ReturnType<typeof session>>,
    task: Awaited<ReturnType<typeof session>>,
    threaded = true
  ) => {
    await store.assistantSubsessions.open({
      agentId: AGENT,
      childSessionKey: task.key,
      parentSessionId: coordinator.outward,
      parentSessionKey: coordinator.key,
      title: 'Webhook retries',
      now: NOW
    })
    if (threaded)
      await store.assistantSubsessions.attachThread({
        agentId: AGENT,
        childSessionKey: task.key,
        platform: 'slack',
        channel: task.channel,
        transportScope: 'T0EXAMPLE',
        thread: task.thread,
        sinceRound: 1,
        now: NOW
      })
  }
  const emitted = async (s: Awaited<ReturnType<typeof session>>): Promise<EventSession | undefined> => {
    await outbox.emitSessionMetadataSnapshot({
      sessionId: `acp-${s.channel}-${s.thread}`,
      sessionKey: s.key,
      agentId: AGENT,
      phase: 'start',
      platform: 'slack',
      channel: s.channel
    })
    await outbox.drainSessionMetadataSnapshots()
    return sync.mock.calls
      .map(([event]) => event)
      .filter((event) => event.sessionId === s.outward)
      .at(-1)
  }
  return { session, taskOf, emitted }
}

describe('a threaded task’s session metadata', () => {
  it('names its coordinator as lineage, classified by its own conversation', async () => {
    const w = await world()
    const coordinator = await w.session('C0SUPPORT', 'append:coordinator-1')
    const task = await w.session('C0SUPPORT', '1700000000.000100')
    await w.taskOf(coordinator, task)
    expect(await w.emitted(task)).toMatchObject({ parentSessionId: coordinator.outward, directDestination: true })
    expect(await w.emitted(coordinator)).not.toHaveProperty('parentSessionId')
  })

  it('names no parent for a thread session no task holds, nor for a task with no thread', async () => {
    const w = await world()
    const coordinator = await w.session('C0SUPPORT', 'append:coordinator-1')
    const plain = await w.session('C0SUPPORT', '1700000000.000200')
    const unthreaded = await w.session('C0SUPPORT', '1700000000.000300')
    await w.taskOf(coordinator, unthreaded, false)
    for (const s of [plain, unthreaded]) {
      const event = await w.emitted(s)
      expect(event).not.toHaveProperty('parentSessionId')
      expect(event).not.toHaveProperty('directDestination')
    }
  })

  // A DM's coordinator is private to its member; lineage there would hand the task the parent's tightening.
  it('names no parent in a DM', async () => {
    const w = await world()
    const coordinator = await w.session('D0ALICE', 'append:coordinator-1', 'dm')
    const task = await w.session('D0ALICE', '1700000000.000100', 'dm')
    await w.taskOf(coordinator, task)
    expect(await w.emitted(task)).not.toHaveProperty('parentSessionId')
  })
})
