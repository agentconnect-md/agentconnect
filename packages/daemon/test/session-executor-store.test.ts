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

  it('records the strategy the session was born with beside either half, and keeps the first one recorded', async () => {
    const store = await openTestStore()
    const rec = session(`t-${crypto.randomUUID()}`)
    await store.upsertSession(rec)
    await store.setSessionExecutor(rec.key, { stayedHomeReason: 'holder_least_loaded', birthStrategy: 'srt' })
    expect(await store.getSessionExecutor(rec.key)).toEqual({
      stayedHomeReason: 'holder_least_loaded',
      birthStrategy: 'srt'
    })
    await store.upsertSession({ ...rec, state: 'prompting', updatedAt: 2 })
    expect(await store.getSession(rec.key)).toMatchObject({ birthStrategy: 'srt' })

    // A move to another machine, or a verdict written without one, never changes the boundary it was born in (§5).
    await store.setSessionExecutor(rec.key, { executorDaemonId: EXECUTOR, birthStrategy: 'host' })
    expect(await store.getSessionExecutor(rec.key)).toEqual({ executorDaemonId: EXECUTOR, birthStrategy: 'srt' })
    await store.setSessionExecutor(rec.key, { executorDaemonId: OTHER })
    expect(await store.getSessionExecutor(rec.key)).toEqual({ executorDaemonId: OTHER, birthStrategy: 'srt' })
    await store.close()
  })

  it('fills the birth strategy of one agent’s earlier verdicts, and nothing it already has or that has no verdict', async () => {
    const store = await openTestStore()
    const agent = `bot-${crypto.randomUUID()}`
    const other = `bot-${crypto.randomUUID()}`
    const row = async (agentId: string): Promise<string> => {
      const rec = { ...session(`t-${crypto.randomUUID()}`), agentId }
      await store.upsertSession(rec)
      return rec.key
    }
    const placed = await row(agent)
    await store.setSessionExecutor(placed, { executorDaemonId: EXECUTOR })
    const home = await row(agent)
    await store.setSessionExecutor(home, { stayedHomeReason: 'shared_session' })
    const recorded = await row(agent)
    await store.setSessionExecutor(recorded, { stayedHomeReason: 'not_on_group', birthStrategy: 'srt' })
    const undecided = await row(agent)
    const elsewhere = await row(other)
    await store.setSessionExecutor(elsewhere, { stayedHomeReason: 'shared_session' })

    await store.backfillBirthStrategy(agent, 'microsandbox')
    expect(await store.getSessionExecutor(placed)).toEqual({
      executorDaemonId: EXECUTOR,
      birthStrategy: 'microsandbox'
    })
    expect(await store.getSessionExecutor(home)).toEqual({
      stayedHomeReason: 'shared_session',
      birthStrategy: 'microsandbox'
    })
    expect(await store.getSessionExecutor(recorded)).toEqual({ stayedHomeReason: 'not_on_group', birthStrategy: 'srt' })
    // Nothing placed it yet, so its birth is still ahead of it.
    expect(await store.getSession(undecided)).toMatchObject({ birthStrategy: null })
    expect(await store.getSessionExecutor(elsewhere)).toEqual({ stayedHomeReason: 'shared_session' })
    await store.close()
  })

  it('lists the open isolated sessions of the given agents, and none that execute elsewhere', async () => {
    const store = await openTestStore()
    const held = `bot-${crypto.randomUUID()}`
    const other = `bot-${crypto.randomUUID()}`
    const row = async (over: Partial<SessionRecord> = {}): Promise<SessionRecord> => {
      const rec: SessionRecord = {
        ...session(`t-${crypto.randomUUID()}`),
        agentId: held,
        acpSessionId: `acp-${crypto.randomUUID()}`,
        workspaceIsolation: 'session',
        ...over
      }
      await store.upsertSession(rec)
      return rec
    }
    const worktree = await row()
    const prompting = await row({ state: 'prompting' })
    const stayedHome = await row()
    await store.setSessionExecutor(stayedHome.key, { stayedHomeReason: 'holder_least_loaded' })
    await row({ workspaceIsolation: 'shared' })
    await row({ state: 'closed' })
    // Its executor counts it; the holder's host for it is a pipe.
    const placed = await row()
    await store.setSessionExecutor(placed.key, { executorDaemonId: EXECUTOR })
    const elsewhere = await row({ agentId: other })

    const keys = async (agentIds: string[], exceptKey?: string) =>
      (await store.listOwnIsolatedSessions(agentIds, exceptKey)).map((r) => r.key).sort()
    expect(await keys([held])).toEqual([worktree.key, prompting.key, stayedHome.key].sort())
    expect(await keys([held], worktree.key)).toEqual([prompting.key, stayedHome.key].sort())
    expect(await keys([held, other])).toEqual([worktree.key, prompting.key, stayedHome.key, elsewhere.key].sort())
    expect(await keys([])).toEqual([])
    // The ACP id rides along: it is how a shared agent host says which of these it has loaded.
    const listed = await store.listOwnIsolatedSessions([held])
    expect(listed.find((r) => r.key === worktree.key)).toEqual({
      key: worktree.key,
      agentId: held,
      acpSessionId: worktree.acpSessionId
    })
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
      for (const column of ['executorDaemonId', 'stayedHomeReason', 'birthStrategy']) {
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
    old.exec('ALTER TABLE sessions DROP COLUMN decisionModel')
    old.exec('ALTER TABLE sessions DROP COLUMN executorDaemonId')
    old.exec('ALTER TABLE sessions DROP COLUMN stayedHomeReason')
    old.exec('ALTER TABLE sessions DROP COLUMN originCodeHostReplyTarget')
    old.exec('ALTER TABLE inbox DROP COLUMN codeHostReplyTarget')
    old.exec(`INSERT INTO sessions (key, agentId, platform, channel, thread, acpSessionId, state, updatedAt)
      VALUES ('k1', 'bot-a', 'slack', 'C1', 'T1', 'acp-1', 'idle', 100)`)
    // A pre-v24 store still carries the transcript's old shape (message-intake.md §10).
    old.exec(`
      DROP INDEX transcript_channel_seq;
      DROP INDEX transcript_channel_event_time;
      DROP INDEX transcript_channel_revision;
      DROP INDEX transcript_recipient_session;
      DROP TABLE transcript_recipient;
      CREATE TABLE transcript_recipient (
        orgId TEXT NOT NULL DEFAULT '',
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT NOT NULL, agentId TEXT NOT NULL,
        PRIMARY KEY (orgId, channel, thread, ts, agentId)
      );
      CREATE INDEX transcript_thread_seq ON transcript (orgId, channel, thread, seq);
      CREATE INDEX transcript_thread_event_time ON transcript (orgId, channel, thread, eventTimeUs DESC, seq DESC);
      CREATE INDEX transcript_thread_revision ON transcript (orgId, channel, thread, revision);
    `)
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

  it.skipIf(usingPostgresStore())(
    'adds the birth strategy to a v28 store, leaving its verdicts without one',
    async () => {
      const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-v28b-')), 'local.sqlite')
      await (await LocalStore.open(path)).close()
      const old = new DatabaseSync(path)
      old.exec('ALTER TABLE sessions DROP COLUMN birthStrategy')
      old.exec(`INSERT INTO sessions (key, agentId, platform, channel, thread, acpSessionId, state, updatedAt, executorDaemonId)
      VALUES ('k1', 'bot-a', 'slack', 'C1', 'T1', 'acp-1', 'idle', 100, '${EXECUTOR}')`)
      old.exec('PRAGMA user_version = 28')
      old.close()

      const upgraded = await LocalStore.open(path)
      // What the daemon's startup fills from the agent (session-executors.md §5).
      expect(await upgraded.getSessionExecutor('k1')).toEqual({ executorDaemonId: EXECUTOR })
      await upgraded.backfillBirthStrategy('bot-a', 'host')
      expect(await upgraded.getSessionExecutor('k1')).toEqual({ executorDaemonId: EXECUTOR, birthStrategy: 'host' })
      await upgraded.close()
    }
  )
})
