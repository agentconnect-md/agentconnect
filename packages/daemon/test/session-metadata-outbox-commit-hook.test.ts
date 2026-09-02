import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { SessionMetadataOutbox, type SessionMetadataHost } from '../src/store/session-metadata-outbox.js'
import { LocalStore } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'

const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION = 'outward-1'
const DAEMON = 'd1'

async function world() {
  const store = await LocalStore.open({ database: SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:')) })
  let now = 1_000_000
  const sync = vi.fn<(event: unknown) => Promise<'acknowledged' | 'unsupported'>>(async () => 'acknowledged')
  const committed = vi.fn()
  const cp = { state: 'READY', supportsServerFeature: () => true, syncEventSession: sync }
  const host: SessionMetadataHost = {
    store: () => store,
    warn: vi.fn(),
    debug: vi.fn(),
    // Retry timers are real but cleared by `dispose()`; only `now` is steered.
    clock: () => ({ now: () => now, setTimeout, clearTimeout }) as never,
    daemonId: () => DAEMON,
    controlPlaneConfigured: () => true,
    draining: () => false,
    cpClient: () => cp as never,
    agents: () => new Map([[AGENT, { id: AGENT } as never]]),
    servesAgent: () => true,
    sessionLink: (id) => `https://console.example/sessions/${id}`,
    sessionThreadUrl: () => undefined,
    onSessionMetadataCommitted: committed
  }
  const outbox = new SessionMetadataOutbox(host)
  const save = () =>
    store.saveSessionMetadataSnapshot(
      AGENT,
      SESSION,
      JSON.stringify({ sessionId: SESSION, agentId: AGENT, phase: 'start', ts: new Date(now).toISOString() }),
      true,
      now,
      DAEMON
    )
  return { store, outbox, sync, committed, save, advance: (ms: number) => (now += ms) }
}

describe('session-metadata outbox → approval wait re-assert (slack-approval-dm.md §7)', () => {
  it('fires only once the CP has acknowledged the snapshot, not on a failed attempt', async () => {
    const w = await world()
    await w.save()
    w.sync.mockRejectedValueOnce(Object.assign(new Error('cp unreachable'), { retryable: true }))
    await w.outbox.drainSessionMetadataSnapshots()
    // The drain resolved, but nothing committed: a replay now would be dropped by the CP.
    expect(w.sync).toHaveBeenCalledTimes(1)
    expect(w.committed).not.toHaveBeenCalled()

    w.advance(60_000)
    await w.outbox.drainSessionMetadataSnapshots()
    expect(w.sync).toHaveBeenCalledTimes(2)
    expect(w.committed).toHaveBeenCalledTimes(1)
    expect(w.committed).toHaveBeenCalledWith(AGENT, SESSION)

    // Nothing pending: an idle drain re-asserts nothing.
    await w.outbox.drainSessionMetadataSnapshots()
    expect(w.committed).toHaveBeenCalledTimes(1)
    w.outbox.dispose()
    await w.store.close()
  })
})
