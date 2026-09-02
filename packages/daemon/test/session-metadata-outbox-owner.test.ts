import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import type { EventSession } from '@agentconnect.md/protocol'
import { SessionMetadataOutbox, type SessionMetadataHost } from '../src/store/session-metadata-outbox.js'
import { LocalStore, sessionKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const DAEMON = 'd1'

/** git-workspace-model §11: one host per session, so two sessions of one agent can share a runtime-local ACP id. */
async function world() {
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  const now = 1_000_000
  const sync = vi.fn<(event: EventSession) => Promise<'acknowledged' | 'unsupported'>>(async () => 'acknowledged')
  const cp = { state: 'READY', supportsServerFeature: () => true, syncEventSession: sync }
  const host: SessionMetadataHost = {
    store: () => store,
    warn: vi.fn(),
    debug: vi.fn(),
    clock: () => ({ now: () => now, setTimeout, clearTimeout }) as never,
    daemonId: () => DAEMON,
    controlPlaneConfigured: () => true,
    draining: () => false,
    cpClient: () => cp as never,
    agents: () => new Map([[AGENT, { id: AGENT } as never]]),
    servesAgent: () => true,
    sessionLink: (id) => `https://console.example.test/sessions/${id}`,
    sessionThreadUrl: () => undefined
  }
  const outbox = new SessionMetadataOutbox(host)
  const row = async (channel: string, thread: string) => {
    const key = sessionKey('slack', channel, thread, AGENT)
    await store.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel,
      thread,
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: now,
      triggeredBy: 'U1'
    })
    return { key, channel, outward: await store.ensureOutwardSessionId(key, AGENT, now) }
  }
  // A private DM and a public channel session, both minted `acp-1` by their own hosts.
  const dm = await row('D1', 'T1')
  const channel = await row('C1', 'T2')
  const classify = async () => {
    await store.setSessionClassification(dm.key, { conversationKind: 'dm', directDestination: true })
    await store.setSessionClassification(channel.key, { conversationKind: 'channel' })
  }
  const start = async () => {
    for (const s of [dm, channel]) {
      await outbox.emitSessionMetadataSnapshot({
        sessionId: 'acp-1',
        sessionKey: s.key,
        agentId: AGENT,
        phase: 'start',
        platform: 'slack',
        channel: s.channel
      })
    }
  }
  const events = async (): Promise<Map<string, EventSession>> => {
    await outbox.drainSessionMetadataSnapshots()
    return new Map(sync.mock.calls.map(([event]) => [event.sessionId, event]))
  }
  return { store, outbox, sync, cp, dm, channel, classify, start, events }
}

describe('session metadata names its classification by the logical session', () => {
  it("a snapshot carrying the session key publishes that session's own facts, not a sibling's sharing the ACP id", async () => {
    const w = await world()
    await w.classify()
    await w.start()
    const seen = await w.events()
    expect([...seen.keys()].sort()).toEqual([w.dm.outward, w.channel.outward].sort())
    expect(seen.get(w.dm.outward)).toMatchObject({ conversationKind: 'dm', directDestination: true })
    expect(seen.get(w.channel.outward)?.conversationKind).toBe('channel')
    expect(seen.get(w.channel.outward)?.directDestination).toBeUndefined()
    w.outbox.dispose()
    await w.store.close()
  })

  it("the display-name re-emit carries each row's key, so both siblings are re-emitted as themselves", async () => {
    const w = await world()
    // A `plan` re-emit updates a pending obligation, so the CP is held away until the re-emit has landed;
    // the facts are classified only after the start milestones, so what each event carries came through it.
    w.cp.state = 'CONNECTING'
    await w.start()
    await w.classify()
    await w.outbox.emitSessionMetadataSnapshotsForDisplayName('U1')
    w.cp.state = 'READY'
    const seen = await w.events()
    expect(seen.size).toBe(2)
    expect([...seen.keys()].sort()).toEqual([w.dm.outward, w.channel.outward].sort())
    expect(seen.get(w.dm.outward)).toMatchObject({ conversationKind: 'dm', directDestination: true })
    expect(seen.get(w.channel.outward)?.conversationKind).toBe('channel')
    w.outbox.dispose()
    await w.store.close()
  })
})
