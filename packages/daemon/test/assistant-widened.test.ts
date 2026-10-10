// Widened-session marks (assistant-mode.md §5.5): one contract suite, run on SQLite by default and on PostgreSQL by store-postgres.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

let store: LocalStore | undefined
afterEach(async () => {
  await store?.close()
  store = undefined
})

async function open(): Promise<LocalStore> {
  store = await openTestStore()
  return store
}

/** A fresh agent id per case: the pool store is shared by every suite of a worker. */
const agent = (): string => `agent-${randomUUID()}`
const dmKey = (agentId: string, coordinate = 'append:1'): string =>
  sessionKey('slack', 'D0EXAMPLE', coordinate, agentId, 'T0EXAMPLE')

const sessionRow = (agentId: string, key: string, thread: string) => ({
  key,
  agentId,
  platform: 'slack',
  channel: 'D0EXAMPLE',
  thread,
  transportScope: 'T0EXAMPLE',
  acpSessionId: 'acp-1',
  state: 'idle' as const,
  lastDeliveredTs: null,
  updatedAt: 1_000
})

const dm = { platform: 'slack', channel: 'D0EXAMPLE' }

describe('assistant widened-session marks', () => {
  it('marks a session once, per agent, and finds its place', async () => {
    const s = await open()
    const a = agent()
    const b = agent()
    expect(await s.assistantWidened.has(a, dmKey(a))).toBe(false)
    expect(await s.assistantWidened.placeMarked(a, 'slack', 'D0EXAMPLE')).toBe(false)
    await s.assistantWidened.mark(a, dmKey(a), dm, 1_000)
    await s.assistantWidened.mark(a, dmKey(a), dm, 2_000)
    expect(await s.assistantWidened.has(a, dmKey(a))).toBe(true)
    expect(await s.assistantWidened.placeMarked(a, 'slack', 'D0EXAMPLE')).toBe(true)
    // A fresh coordinate is a new session, another place is its own, and so is another agent.
    expect(await s.assistantWidened.has(a, dmKey(a, 'append:2'))).toBe(false)
    expect(await s.assistantWidened.placeMarked(a, 'slack', 'D0OTHER')).toBe(false)
    expect(await s.assistantWidened.placeMarked(a, 'telegram', 'D0EXAMPLE')).toBe(false)
    expect(await s.assistantWidened.has(b, dmKey(a))).toBe(false)
    expect(await s.assistantWidened.placeMarked(b, 'slack', 'D0EXAMPLE')).toBe(false)
    expect(await s.assistantWidened.deleteForAgent(a)).toBe(1)
    expect(await s.assistantWidened.has(a, dmKey(a))).toBe(false)
    expect(await s.assistantWidened.placeMarked(a, 'slack', 'D0EXAMPLE')).toBe(false)
  })

  it('lifts the mark of a purged session and of a cleared context, and keeps their place marked', async () => {
    const s = await open()
    const a = agent()
    const purged = dmKey(a, 'append:1')
    const cleared = dmKey(a, 'T1')
    const kept = dmKey(a, 'append:2')
    await s.upsertSession(sessionRow(a, purged, 'append:1'))
    await s.upsertSession(sessionRow(a, cleared, 'T1'))
    await s.upsertSession(sessionRow(a, kept, 'append:2'))
    for (const key of [purged, cleared, kept]) await s.assistantWidened.mark(a, key, dm, 1_000)
    expect(await s.deleteSession(purged)).toBe(true)
    // `!new` on a session that keeps its key clears its context, and lifts the mark with it.
    expect(await s.clearSessionContext(cleared, '200.0', 2_000, 'acp-1')).toBe(true)
    expect(await s.assistantWidened.has(a, purged)).toBe(false)
    expect(await s.assistantWidened.has(a, cleared)).toBe(false)
    expect(await s.assistantWidened.has(a, kept)).toBe(true)
  })

  it('keeps a place marked by a lifted session only, and marks a lifted session again on a read back', async () => {
    const s = await open()
    const a = agent()
    const key = dmKey(a, 'T1')
    await s.upsertSession(sessionRow(a, key, 'T1'))
    await s.assistantWidened.mark(a, key, dm, 1_000)
    expect(await s.clearSessionContext(key, '200.0', 2_000, 'acp-1')).toBe(true)
    expect(await s.assistantWidened.has(a, key)).toBe(false)
    expect(await s.assistantWidened.placeMarked(a, 'slack', 'D0EXAMPLE')).toBe(true)
    await s.assistantWidened.mark(a, key, dm, 3_000)
    expect(await s.assistantWidened.has(a, key)).toBe(true)
  })

  it('keeps the mark when a clear does not happen', async () => {
    const s = await open()
    const a = agent()
    const key = dmKey(a, 'T1')
    await s.upsertSession(sessionRow(a, key, 'T1'))
    await s.assistantWidened.mark(a, key, dm, 1_000)
    expect(await s.clearSessionContext(key, '200.0', 2_000, 'acp-other')).toBe(false)
    expect(await s.assistantWidened.has(a, key)).toBe(true)
  })
})

describe.skipIf(usingPostgresStore())('the widened-session marks across a restart and an upgrade on SQLite', () => {
  it('survives reopening the store', async () => {
    const path = tempStorePath('ac-assistant-widened-')
    const a = agent()
    const first = await LocalStore.open(path)
    await first.assistantWidened.mark(a, dmKey(a), dm, 1_000)
    await first.close()
    const reopened = await LocalStore.open(path)
    try {
      expect(await reopened.assistantWidened.has(a, dmKey(a))).toBe(true)
    } finally {
      await reopened.close()
    }
  })

  it('adds the table to a v40 store and stamps the current version', async () => {
    expect(SCHEMA_VERSION).toBe(43)
    const path = tempStorePath('ac-assistant-v40-')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE assistant_widened_session; PRAGMA user_version = 40')
    old.close()

    const upgraded = await LocalStore.open(path)
    const a = agent()
    try {
      await upgraded.assistantWidened.mark(a, dmKey(a), dm, 1_000)
      expect(await upgraded.assistantWidened.has(a, dmKey(a))).toBe(true)
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    db.close()
  })
})
