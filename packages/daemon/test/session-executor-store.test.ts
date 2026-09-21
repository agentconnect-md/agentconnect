// The session row's birth verdict (session-executors.md §7): where a spread session executes, or why it stayed with its holder.
import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, sessionKey, type SessionRecord, SCHEMA_VERSION } from '../src/store/local-store.js'
import { openTestStore, usingPostgresStore } from './store-support.js'

const EXECUTOR = 'd2222222-2222-4222-8222-222222222222'
const OTHER = 'd3333333-3333-4333-8333-333333333333'

function session(thread: string): SessionRecord {
  return {
    key: sessionKey('slack', 'C1', thread, 'bot-a'),
    agentId: 'bot-a',
    platform: 'slack',
    channel: 'C1',
    thread,
    acpSessionId: null,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1
  }
}

describe('LocalStore session executor', () => {
  it('records the executor or the reason, never both, and survives the session’s ordinary rewrites', async () => {
    const store = await openTestStore()
    const rec = session(`t-${crypto.randomUUID()}`)
    await store.upsertSession(rec)
    // Nothing placed the session yet — which is every row a daemon before this column wrote.
    expect(await store.getSessionExecutor(rec.key)).toBeUndefined()

    await store.setSessionExecutor(rec.key, { executorDaemonId: EXECUTOR })
    // A turn's state upsert names neither column, so it must not clear what a successor holder reads after failover.
    await store.upsertSession({ ...rec, state: 'prompting', updatedAt: 2 })
    expect(await store.getSessionExecutor(rec.key)).toEqual({ executorDaemonId: EXECUTOR })
    expect(await store.getSession(rec.key)).toMatchObject({ executorDaemonId: EXECUTOR, stayedHomeReason: null })

    // Its executor was lost and the session moved: the row names the new machine.
    await store.setSessionExecutor(rec.key, { executorDaemonId: OTHER })
    expect(await store.getSessionExecutor(rec.key)).toEqual({ executorDaemonId: OTHER })

    // Or it came home, and the reason replaces the machine rather than sitting beside it.
    await store.setSessionExecutor(rec.key, { stayedHomeReason: 'holder_least_loaded' })
    expect(await store.getSessionExecutor(rec.key)).toEqual({ stayedHomeReason: 'holder_least_loaded' })
    expect(await store.getSession(rec.key)).toMatchObject({
      executorDaemonId: null,
      stayedHomeReason: 'holder_least_loaded'
    })
    await store.close()
  })

  it('keeps one session’s verdict off its sibling, and ignores a key it has never seen', async () => {
    const store = await openTestStore()
    const spread = session(`t-${crypto.randomUUID()}`)
    const home = session(`t-${crypto.randomUUID()}`)
    await store.upsertSession(spread)
    await store.upsertSession(home)

    await store.setSessionExecutor(spread.key, { executorDaemonId: EXECUTOR })
    await store.setSessionExecutor(home.key, { stayedHomeReason: 'shared_session' })
    await store.setSessionExecutor('no-such-session', { executorDaemonId: EXECUTOR })

    expect(await store.getSessionExecutor(spread.key)).toEqual({ executorDaemonId: EXECUTOR })
    expect(await store.getSessionExecutor(home.key)).toEqual({ stayedHomeReason: 'shared_session' })
    expect(await store.getSessionExecutor('no-such-session')).toBeUndefined()
    await store.close()
  })

  it('counts the open isolated sessions of the agents held here, and none that execute elsewhere', async () => {
    const store = await openTestStore()
    const held = `bot-${crypto.randomUUID()}`
    const other = `bot-${crypto.randomUUID()}`
    const row = async (over: Partial<SessionRecord> = {}): Promise<SessionRecord> => {
      const rec: SessionRecord = {
        ...session(`t-${crypto.randomUUID()}`),
        agentId: held,
        workspaceIsolation: 'session',
        ...over
      }
      await store.upsertSession(rec)
      return rec
    }
    // A worktree session shares its agent's host, so only its row says it is load.
    const worktree = await row()
    await row({ state: 'prompting' })
    const stayedHome = await row()
    await store.setSessionExecutor(stayedHome.key, { stayedHomeReason: 'holder_least_loaded' })
    await row({ workspaceIsolation: 'shared' })
    await row({ state: 'closed' })
    // Its executor counts it; the holder's host for it is a pipe.
    const placed = await row()
    await store.setSessionExecutor(placed.key, { executorDaemonId: EXECUTOR })
    await row({ agentId: other })

    expect(await store.countOwnIsolatedSessions([held])).toBe(3)
    expect(await store.countOwnIsolatedSessions([held], worktree.key)).toBe(2)
    expect(await store.countOwnIsolatedSessions([held, other])).toBe(4)
    expect(await store.countOwnIsolatedSessions([])).toBe(0)
    await store.close()
  })

  // The SQLite in the pinned Node drops a LAST column by cutting back to the nearest comma BYTE, so a comment holding one there corrupts the table; a newer SQLite hides that.
  it.skipIf(usingPostgresStore())(
    'keeps nothing but whitespace between each column and the comma before it',
    async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-ddl-')), 'local.sqlite')
      await (await LocalStore.open(path)).close()
      const db = new DatabaseSync(path)
      const { sql } = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'sessions'").get() as { sql: string }
      db.close()
      for (const column of ['executorDaemonId', 'stayedHomeReason']) {
        const at = sql.indexOf(column)
        expect([column, sql.slice(sql.lastIndexOf(',', at) + 1, at).trim()]).toEqual([column, ''])
      }
    }
  )

  // An established store is upgraded in place: the step that adds the columns must be reachable, not only the CREATE block.
  it.skipIf(usingPostgresStore())('adds both columns to a v19 store, leaving its sessions unplaced', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-v19-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE sessions DROP COLUMN executorDaemonId')
    old.exec('ALTER TABLE sessions DROP COLUMN stayedHomeReason')
    old.exec(`INSERT INTO sessions (key, agentId, platform, channel, thread, acpSessionId, state, updatedAt)
      VALUES ('k1', 'bot-a', 'slack', 'C1', 'T1', 'acp-1', 'idle', 100)`)
    old.exec('PRAGMA user_version = 19')
    old.close()

    const upgraded = await LocalStore.open(path)
    expect(await upgraded.getSessionExecutor('k1')).toBeUndefined()
    await upgraded.setSessionExecutor('k1', { executorDaemonId: EXECUTOR })
    expect(await upgraded.getSessionExecutor('k1')).toEqual({ executorDaemonId: EXECUTOR })
    await upgraded.close()

    const after = new DatabaseSync(path)
    const version = (after.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    after.close()
    expect(version).toBe(SCHEMA_VERSION)
  })
})
