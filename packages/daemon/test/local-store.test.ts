import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { NoteProjectionRow } from '../src/gitlab/note-projection.js'
import { LocalStore, sessionKey, type StoreDatabase } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { memoryStoreDatabase, openTestStore, usingPostgresStore } from './store-support.js'

/** True in the `store-postgres` project, where every store below is the real pool store. */
const pg = usingPostgresStore()

async function store(): Promise<LocalStore> {
  return await openTestStore({ path: join(mkdtempSync(join(tmpdir(), 'ac-db-')), 'local.sqlite') })
}

/** A second handle on the same durable store — a daemon restart, not a new store. */
async function reopen(path: string): Promise<LocalStore> {
  return await openTestStore(path)
}

/** Every agent a shared-store test names belongs to one org unless the test says otherwise. */
const oneOrg = () => 'org-1'

/** Two pool members over ONE database — what the shared Postgres schema is during a rollout. */
async function sharedMembers(first: string, second: string): Promise<[LocalStore, LocalStore]> {
  const database = pg ? undefined : memoryStoreDatabase()
  return [
    await openTestStore({ database, shared: true, ownerId: first, orgForAgent: oneOrg }),
    await openTestStore({ database, shared: true, ownerId: second, orgForAgent: oneOrg })
  ]
}

/** Undo the v11 transcript fence, so a fixture looks like a store an older daemon wrote. */
const dropTranscriptOrg = (db: DatabaseSync): void => {
  db.exec(`
    DROP INDEX transcript_thread_seq;
    DROP INDEX transcript_text_ts;
    DROP INDEX transcript_agent_tool_call;
    DROP INDEX transcript_thread_event_time;
    DROP INDEX transcript_thread_revision;
    ALTER TABLE transcript DROP COLUMN orgId;
    DROP TABLE transcript_recipient;
    CREATE TABLE transcript_recipient (
      channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT NOT NULL, agentId TEXT NOT NULL,
      PRIMARY KEY (channel, thread, ts, agentId)
    );
    CREATE INDEX transcript_thread_seq ON transcript (channel, thread, seq);
    CREATE UNIQUE INDEX transcript_text_ts ON transcript (channel, thread, ts) WHERE kind = 'text';
    CREATE UNIQUE INDEX transcript_agent_tool_call
      ON transcript (channel, thread, sender, tool_call_id) WHERE tool_call_id IS NOT NULL;
    CREATE INDEX transcript_thread_event_time ON transcript (channel, thread, eventTimeUs DESC, seq DESC);
    CREATE INDEX transcript_thread_revision ON transcript (channel, thread, revision);
  `)
}

describe.skipIf(pg)('LocalStore schema versioning', () => {
  const userVersion = (path: string): number => {
    const db = new DatabaseSync(path)
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
    db.close()
    return v
  }

  it('stamps a freshly created store with the current schema version', async () => {
    // A new database gets the whole schema from the CREATE block, so it must skip
    // the upgrade list outright rather than replay it.
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-fresh-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    expect(userVersion(path)).toBeGreaterThanOrEqual(1)
  })

  it('reopens an existing store without rewriting its version', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-reopen-')), 'local.sqlite')
    const first = await LocalStore.open(path)
    await first.appendTranscript({ channel: 'C1', thread: 'T', ts: '1', sender: 'U1', kind: 'text', text: 'hello' })
    await first.close()
    const stamped = userVersion(path)

    const second = await LocalStore.open(path)
    expect((await second.threadTranscript('C1', 'T')).map((r) => r.text)).toEqual(['hello'])
    await second.close()
    expect(userVersion(path)).toBe(stamped)
  })

  it('adds permission ownership, recovery ownership and per-owner routing when upgrading a v1 store', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-v1-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE permission_requests DROP COLUMN ownerId')
    old.exec('DROP INDEX session_metadata_outbox_attempt')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN failedAttempts')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN nextAttemptAt')
    old.exec('ALTER TABLE dreams DROP COLUMN ownerId')
    old.exec('ALTER TABLE webchat_mcp_grant_ledger DROP COLUMN ownerId')
    old.exec('ALTER TABLE inbox DROP COLUMN reportOwnerId')
    old.exec('ALTER TABLE inbox DROP COLUMN reportClaimedAt')
    old.exec('ALTER TABLE cron_runs DROP COLUMN definition')
    old.exec('ALTER TABLE session_purges DROP COLUMN ownerId')
    old.exec('ALTER TABLE session_purges DROP COLUMN claimedAt')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN ownerId')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN claimedAt')
    dropTranscriptOrg(old)
    old.exec('ALTER TABLE sessions DROP COLUMN sessionId')
    old.exec('ALTER TABLE sessions DROP COLUMN directDestination')
    old.exec('PRAGMA user_version = 1')
    old.close()

    await (await LocalStore.open(path)).close()

    const upgraded = new DatabaseSync(path)
    const columnsOf = (table: string): string[] =>
      (upgraded.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name)
    const columns = columnsOf('permission_requests')
    const outboxColumns = columnsOf('session_metadata_outbox')
    const dreamColumns = columnsOf('dreams')
    const grantColumns = columnsOf('webchat_mcp_grant_ledger')
    const inboxColumns = columnsOf('inbox')
    const cronColumns = columnsOf('cron_runs')
    const purgeColumns = columnsOf('session_purges')
    upgraded.close()
    expect(columns).toContain('ownerId')
    // Session-metadata snapshots are leased per pool member too (#1023).
    expect(outboxColumns).toEqual(expect.arrayContaining(['failedAttempts', 'nextAttemptAt', 'ownerId', 'claimedAt']))
    // Recovery ownership: a pool member must be able to tell its own rows from a peer's.
    expect(dreamColumns).toContain('ownerId')
    expect(grantColumns).toContain('ownerId')
    expect(inboxColumns).toEqual(expect.arrayContaining(['reportOwnerId', 'reportClaimedAt']))
    // A stamp is only comparable to a fire of the same schedule definition (#1031).
    expect(cronColumns).toContain('definition')
    // Purge receipts are leased per pool member (#1032).
    expect(purgeColumns).toEqual(expect.arrayContaining(['ownerId', 'claimedAt']))
    expect(userVersion(path)).toBe(14)
  })

  it.skipIf(pg)('never persists the CP routing map on a shared store, and still does on an owned one', async () => {
    // One row and many members: each member's save used to erase every other member's, and each
    // boot hydrated whichever map was written last — a foreign `routingEpoch` with it. A shared
    // member now writes nothing and reads nothing, so it starts from an empty map at epoch 0.
    const database = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ac-schema-shared-')), 'local.sqlite'))
    const backing = SqliteAsyncDatabase.adopt(database)
    const first = await LocalStore.open({ database: backing, shared: true, ownerId: 'member-1', orgForAgent: oneOrg })
    const second = await LocalStore.open({ database: backing, shared: true, ownerId: 'member-2', orgForAgent: oneOrg })

    await first.setCpRouting(1, '{"a":[]}', '[]')
    await second.setCpRouting(9, '{"b":[]}', '[{"kind":"global"}]')
    expect(await first.getCpRouting()).toBeUndefined()
    expect(await second.getCpRouting()).toBeUndefined()
    // Not even a row to leak: `ownerId` is a process incarnation, so any partition key a member
    // could write here would be abandoned on its next restart.
    expect(database.prepare('SELECT COUNT(*) AS n FROM cp_routing').get()).toMatchObject({ n: 0 })
    database.close()

    // An exclusively owned store is untouched: it is the one store where the row survives a restart.
    const solo = await store()
    await solo.setCpRouting(4, '{"solo":[]}', '[{"kind":"global"}]')
    expect(await solo.getCpRouting()).toMatchObject({ routingEpoch: 4, assignments: '{"solo":[]}' })
    await solo.close()
  })

  it('re-keys the capture gate by agent when upgrading a v5 store', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-v5-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('DROP TABLE session_gates')
    old.exec(`CREATE TABLE session_gates (
      acpSessionId TEXT PRIMARY KEY, localExcluded INTEGER NOT NULL DEFAULT 1,
      cpPrivate INTEGER, cpRev INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER
    )`)
    old.exec(`INSERT INTO sessions (key, agentId, acpSessionId) VALUES
      ('a', 'bot-a', 'acp-1'), ('b', 'bot-b', 'acp-2'), ('c', 'bot-c', 'acp-2')`)
    old.exec(`INSERT INTO session_gates (acpSessionId, localExcluded, cpPrivate, cpRev) VALUES
      ('acp-1', 1, 0, 4), ('acp-2', 0, 0, 7), ('acp-orphan', 0, 0, 1)`)
    old.exec('ALTER TABLE cron_runs DROP COLUMN definition')
    old.exec('ALTER TABLE session_purges DROP COLUMN ownerId')
    old.exec('ALTER TABLE session_purges DROP COLUMN claimedAt')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN ownerId')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN claimedAt')
    dropTranscriptOrg(old)
    old.exec('ALTER TABLE sessions DROP COLUMN sessionId')
    old.exec('ALTER TABLE sessions DROP COLUMN directDestination')
    old.exec('PRAGMA user_version = 5')
    old.close()

    const upgraded = await LocalStore.open(path)
    // Attributable: the CP verdict follows the one agent that held the id.
    expect(await upgraded.isCaptureExcluded('bot-a', 'acp-1')).toBe(false)
    // Held by two agents: the stored verdict was never attributable to either, so
    // both start from the fail-closed state and wait for their own CP push.
    expect(await upgraded.isCaptureExcluded('bot-b', 'acp-2')).toBe(true)
    expect(await upgraded.isCaptureExcluded('bot-c', 'acp-2')).toBe(true)
    expect(await upgraded.applyCpCaptureGate('bot-b', 'acp-2', false, 1)).toBe('applied')
    expect(await upgraded.isCaptureExcluded('bot-b', 'acp-2')).toBe(false)
    expect(await upgraded.isCaptureExcluded('bot-c', 'acp-2')).toBe(true)
    await upgraded.close()

    expect(userVersion(path)).toBe(14)
  })

  it('re-keys the runtime catalog cache on its owning member when upgrading a v7 store', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-v7-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec(`
      DROP TABLE runtime_catalog_meta;
      DROP TABLE runtime_model_catalog;
      CREATE TABLE runtime_catalog_meta (
        runtimeId TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source TEXT NOT NULL, defaultModel TEXT,
        permissionModes TEXT, defaultPermissionMode TEXT, complete INTEGER NOT NULL DEFAULT 0,
        modelsHash TEXT, observedAt INTEGER NOT NULL
      );
      CREATE TABLE runtime_model_catalog (
        runtimeId TEXT NOT NULL, modelId TEXT NOT NULL, fingerprint TEXT NOT NULL,
        capsJson TEXT NOT NULL, observedAt INTEGER NOT NULL, PRIMARY KEY (runtimeId, modelId)
      );
      INSERT INTO runtime_catalog_meta (runtimeId, fingerprint, source, complete, observedAt)
        VALUES ('claude', 'fp-1', 'acp', 1, 100);
      INSERT INTO runtime_model_catalog (runtimeId, modelId, fingerprint, capsJson, observedAt)
        VALUES ('claude', 'opus', 'fp-1', '{}', 100);
    `)
    old.exec('ALTER TABLE session_purges DROP COLUMN ownerId')
    old.exec('ALTER TABLE session_purges DROP COLUMN claimedAt')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN ownerId')
    old.exec('ALTER TABLE session_metadata_outbox DROP COLUMN claimedAt')
    dropTranscriptOrg(old)
    old.exec('ALTER TABLE sessions DROP COLUMN sessionId')
    old.exec('ALTER TABLE sessions DROP COLUMN directDestination')
    old.exec('PRAGMA user_version = 7')
    old.close()

    const upgraded = await LocalStore.open(path)
    // Pre-upgrade rows name no member, so no member can honestly claim them; the next
    // probe refills the cache this one owns.
    expect(await upgraded.getRuntimeCatalogMeta('claude')).toBeUndefined()
    expect(await upgraded.listRuntimeModelCaps()).toEqual([])
    await upgraded.close()

    const after = new DatabaseSync(path)
    const metaColumns = after.prepare('PRAGMA table_info(runtime_catalog_meta)').all() as { name: string; pk: number }[]
    const capColumns = after.prepare('PRAGMA table_info(runtime_model_catalog)').all() as { name: string; pk: number }[]
    after.close()
    const primaryKey = (columns: { name: string; pk: number }[]): string[] =>
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name)
    expect(primaryKey(metaColumns)).toEqual(['ownerId', 'runtimeId'])
    expect(primaryKey(capColumns)).toEqual(['ownerId', 'runtimeId', 'modelId'])
    expect(userVersion(path)).toBe(14)
  })

  it('backfills a v11 store with the outward id its sessions were already reported under', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-v11-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE sessions DROP COLUMN sessionId')
    old.exec(`INSERT INTO sessions (key, agentId, platform, channel, thread, acpSessionId, state, updatedAt)
      VALUES ('k1', 'bot-a', 'slack', 'C1', 'T1', 'acp-1', 'idle', 100)`)
    // A session that never launched has no id to inherit — it gets one when it next needs one.
    old.exec(`INSERT INTO sessions (key, agentId, platform, channel, thread, acpSessionId, state, updatedAt)
      VALUES ('k2', 'bot-a', 'slack', 'C1', 'T2', NULL, 'idle', 100)`)
    old.exec('ALTER TABLE sessions DROP COLUMN directDestination')
    old.exec('PRAGMA user_version = 11')
    old.close()

    const upgraded = await LocalStore.open(path)
    // The control plane already knows this session by its ACP id: renaming it would orphan the row.
    expect((await upgraded.getSession('k1'))?.sessionId).toBe('acp-1')
    expect((await upgraded.getSessionByOutwardId('acp-1'))?.key).toBe('k1')
    expect((await upgraded.getSession('k2'))?.sessionId).toBeNull()
    expect(await upgraded.ensureOutwardSessionId('k2', 'bot-a')).toMatch(/^[0-9a-f-]{36}$/)
    await upgraded.close()
    expect(userVersion(path)).toBe(14)
  })

  // The regression that made `directDestination` reachable on fresh databases only: the step was
  // appended to SCHEMA_MIGRATIONS without bumping SCHEMA_VERSION, so `upgradeSchema` stopped short
  // of it and every established store failed at query time instead of at boot.
  it('adds directDestination to a v12 store', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-v12-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    old.exec('ALTER TABLE sessions DROP COLUMN directDestination')
    old.exec(`INSERT INTO sessions (key, agentId, platform, channel, thread, acpSessionId, state, updatedAt)
      VALUES ('k1', 'bot-a', 'slack', 'C1', 'T1', 'acp-1', 'idle', 100)`)
    old.exec('PRAGMA user_version = 12')
    old.close()

    const upgraded = await LocalStore.open(path)
    // The read path that broke: every dispatch resolves a session's classification.
    expect(await upgraded.getSessionClassification('bot-a', 'acp-1')).toEqual({})
    await upgraded.setSessionClassification('k1', { sourceBindingKind: 'external', directDestination: true })
    expect(await upgraded.getSessionClassification('bot-a', 'acp-1')).toMatchObject({ directDestination: true })
    await upgraded.close()
    expect(userVersion(path)).toBe(14)
  })

  it('refuses a store written by a newer daemon WITHOUT touching it first', async () => {
    // Rolling a daemon back must fail loudly: this build cannot know what the newer
    // schema did, so "upgrading" it would corrupt more than it fixed. The refusal
    // has to land before any DDL — the CREATE block is IF NOT EXISTS, but on a
    // newer store "not exists" is the wrong question, and re-adding this version's
    // objects is exactly the damage the refusal exists to prevent.
    const path = join(mkdtempSync(join(tmpdir(), 'ac-schema-future-')), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const setup = new DatabaseSync(path)
    // Stand in for an object this build would happily recreate.
    setup.exec('DROP TABLE transcript')
    setup.exec('PRAGMA user_version = 9999')
    setup.close()

    await expect(LocalStore.open(path)).rejects.toThrow(/newer than this daemon understands/)

    const after = new DatabaseSync(path)
    const rebuilt = after
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'transcript'")
      .get() as { n: number }
    const version = after.prepare('PRAGMA user_version').get() as { user_version: number }
    after.close()
    expect(rebuilt.n).toBe(0) // the CREATE block never ran
    expect(version.user_version).toBe(9999) // and the version was not rewritten
  })
})

describe('LocalStore', () => {
  it('keeps every agent reply in a thread, and lets a finalization refresh its own text', async () => {
    // The production failure this pins: a response finalization used to reach the
    // transcript with the literal ts `'final'` (a `:final` msgId suffix that
    // `transcriptCoords` read as the ts). The UNIQUE index is (channel, thread, ts) and
    // does NOT include the recipient, so only the FIRST agent reply in a thread survived
    // — every later one was silently dropped by INSERT OR IGNORE. In a multi-agent Slack
    // thread that means an agent sees exactly one peer message, ever.
    const s = await store()
    const row = (ts: string, text: string, extra: Record<string, unknown> = {}) => ({
      channel: 'slack:C1',
      thread: '100.1',
      ts,
      sender: 'bot-a',
      recipient: 'bot-b',
      kind: 'text' as const,
      text,
      ...extra
    })
    await s.appendTranscript(row('100.2', '1'))
    await s.appendTranscript(row('100.3', '3'))
    await s.appendTranscript(row('100.4', '7'))

    const texts = async () => (await s.threadTranscript('slack:C1', '100.1')).map((r) => r.text)
    expect(await texts()).toEqual(['1', '3', '7'])

    // A finalization lands on its OWN post's coordinates and upgrades the text in place —
    // the post can hold a streamed prefix, and a text row has no other update path.
    await s.appendTranscript(row('100.4', '7 (complete)', { authoritative: true }))
    expect(await texts()).toEqual(['1', '3', '7 (complete)'])

    // Without that marker a re-observation must never rewrite an existing row.
    await s.appendTranscript(row('100.4', 'stale replay'))
    expect(await texts()).toEqual(['1', '3', '7 (complete)'])
  })

  it('upserts and reads back a session record', async () => {
    const s = await store()
    const key = sessionKey('slack', 'C1', '100.1', 'bot-a')
    await s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: null,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const got = await s.getSession(key)
    expect(got?.agentId).toBe('bot-a')
    expect(got?.state).toBe('idle')
    await s.close()
  })

  it('persists only explicitly pending session snapshots and fences stale ACKs', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-session-outbox-')), 'local.sqlite')
    const first = await reopen(path)
    await first.upsertSession({
      key: sessionKey('slack', 'C1', '100.1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: '100.1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })

    // Enrichment alone never turns an existing historical row into replay work.
    expect(await first.saveSessionMetadataSnapshot('bot-a', 'acp-1', '{"phase":"plan"}', false, 1)).toBeUndefined()
    expect(await first.hasPendingSessionMetadata()).toBe(false)

    expect(await first.saveSessionMetadataSnapshot('bot-a', 'acp-1', '{"phase":"start"}', true, 2)).toBe(1)
    await first.close()

    const restored = await reopen(path)
    expect(await restored.nextSessionMetadataSnapshot()).toMatchObject({
      agentId: 'bot-a',
      sessionId: 'acp-1',
      revision: 1,
      snapshot: '{"phase":"start"}',
      failedAttempts: 0,
      nextAttemptAt: null
    })

    expect(await restored.recordSessionMetadataSnapshotFailure('bot-a', 'acp-1', 1, 100)).toEqual({
      failedAttempts: 1,
      nextAttemptAt: 100
    })
    expect(await restored.nextSessionMetadataSnapshot(99)).toBeUndefined()
    expect(await restored.nextSessionMetadataAttemptAt()).toBe(100)
    await restored.close()

    const deferred = await reopen(path)
    expect(await deferred.pendingSessionMetadataSnapshot('bot-a', 'acp-1')).toMatchObject({
      failedAttempts: 1,
      nextAttemptAt: 100
    })

    // A newer projection replaces the payload and revision. Its predecessor's
    // delayed ACK cannot delete it.
    expect(await deferred.saveSessionMetadataSnapshot('bot-a', 'acp-1', '{"phase":"end"}', false, 3)).toBe(2)
    expect(await deferred.acknowledgeSessionMetadataSnapshot('bot-a', 'acp-1', 1)).toBe(false)
    expect(await deferred.nextSessionMetadataSnapshot()).toMatchObject({
      revision: 2,
      snapshot: '{"phase":"end"}',
      failedAttempts: 0,
      nextAttemptAt: null
    })
    expect(await deferred.acknowledgeSessionMetadataSnapshot('bot-a', 'acp-1', 2)).toBe(true)
    expect(await deferred.hasPendingSessionMetadata()).toBe(false)
    await deferred.close()
  })

  it('does not recursively mine dream execution sessions as dream sources', async () => {
    const s = await store()
    await s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'source-session',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await s.upsertSession({
      key: sessionKey('dream', 'memory', 'drm-1', 'bot-a'),
      agentId: 'bot-a',
      platform: 'dream',
      channel: 'memory',
      thread: 'drm-1',
      acpSessionId: 'dream-session',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 2
    })

    // A source is named the way the dream will report it — outwardly (§1.1), since the citation
    // becomes durable provenance the console reads back.
    const outward = (await s.getSession(sessionKey('slack', 'C1', 'T1', 'bot-a')))!.sessionId
    expect(outward).not.toBe('source-session')
    expect(await s.dreamSessionSources('bot-a', 20)).toEqual([
      { sessionId: outward, channel: 'C1', thread: 'T1', updatedAt: 1 }
    ])
    await s.close()
  })

  it('returns transcript entries strictly after a marker, ordered by ts', async () => {
    const s = await store()
    await s.appendTranscript({ channel: 'C1', thread: '100.1', ts: '100.2', sender: 'U1', kind: 'text', text: 'first' })
    await s.appendTranscript({
      channel: 'C1',
      thread: '100.1',
      ts: '100.3',
      sender: 'U2',
      kind: 'text',
      text: 'second'
    })
    await s.appendTranscript({ channel: 'C1', thread: '100.1', ts: '100.4', sender: 'U1', kind: 'text', text: 'third' })
    const gap = await s.transcriptSince('C1', '100.1', '100.2', 'bot-a')
    expect(gap.map((e) => e.text)).toEqual(['second', 'third'])
    const all = await s.transcriptSince('C1', '100.1', null, 'bot-a')
    expect(all).toHaveLength(3)
    await s.close()
  })

  it('replay returns only text rows; the full activity log returns all kinds in order', async () => {
    const s = await store()
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '1', sender: 'U1', kind: 'text', text: 'ask' })
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '2', sender: 'bot', kind: 'reasoning', text: 'hmm' })
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '3', sender: 'bot', kind: 'tool', text: 'Read x' })
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '4', sender: 'bot', kind: 'text', text: 'answer' })

    // §8.5 replay: conversational text only
    expect((await s.transcriptSince('C1', 'T', null, 'bot-a')).map((e) => e.text)).toEqual(['ask', 'answer'])
    // Web UI: every kind, insertion order
    expect((await s.threadTranscript('C1', 'T')).map((r) => [r.kind, r.text])).toEqual([
      ['text', 'ask'],
      ['reasoning', 'hmm'],
      ['tool', 'Read x'],
      ['text', 'answer']
    ])
    await s.close()
  })

  it('round-trips per-cron last-run stamps with their definition (latest-wins)', async () => {
    const s = await store()
    expect(await s.cronRun('bot-a:daily')).toBeUndefined()
    await s.setCronLastRun('bot-a:daily', 1000, 'def-1')
    await s.setCronLastRun('bot-a:daily', 2000, 'def-2')
    await s.setCronLastRun('bot-b:weekly', 1500, 'def-1')
    expect(await s.cronRun('bot-a:daily')).toEqual({ lastRunAt: 2000, definition: 'def-2' })
    expect(await s.cronRun('bot-b:weekly')).toEqual({ lastRunAt: 1500, definition: 'def-1' })
    await s.close()
  })

  it('claims a catch-up only for the definition the stamp was written under', async () => {
    const s = await store()
    await s.setCronLastRun('bot-a:daily', 1000, 'def-1')
    await s.setDreamLastRun('bot-a', 1000, 'def-1')
    // A definition that has moved on cannot claim the moment the old one left behind.
    expect(await s.claimCronCatchUp('bot-a:daily', 2000, 3000, 'def-2')).toBe(false)
    expect(await s.claimDreamCatchUp('bot-a', 2000, 3000, 'def-2')).toBe(false)
    expect(await s.cronRun('bot-a:daily')).toEqual({ lastRunAt: 1000, definition: 'def-1' })
    // The same definition claims once; the loser of the race sees a stamp past the occurrence.
    expect(await s.claimCronCatchUp('bot-a:daily', 2000, 3000, 'def-1')).toBe(true)
    expect(await s.claimCronCatchUp('bot-a:daily', 2000, 3000, 'def-1')).toBe(false)
    expect(await s.claimDreamCatchUp('bot-a', 2000, 3000, 'def-1')).toBe(true)
    expect(await s.claimDreamCatchUp('bot-a', 2000, 3000, 'def-1')).toBe(false)
    // Never claimed for a schedule that has never stamped a run.
    expect(await s.claimCronCatchUp('bot-b:weekly', 2000, 3000, 'def-1')).toBe(false)
    await s.close()
  })

  it("enumerates and drops one agent's stamp keys without matching a neighbour", async () => {
    const s = await store()
    await s.setCronLastRun('bot-a:daily', 1000, 'def-1')
    await s.setCronLastRun('bot-a:weekly', 1000, 'def-1')
    // A prefix match must be exact: an agent id is not a LIKE pattern, and a longer id that merely
    // starts with this one is a different agent.
    await s.setCronLastRun('bot-ab:daily', 1000, 'def-1')
    await s.setCronLastRun('bot%:daily', 1000, 'def-1')
    expect((await s.cronRunKeys('bot-a')).sort()).toEqual(['bot-a:daily', 'bot-a:weekly'])
    expect(await s.cronRunKeys('bot%')).toEqual(['bot%:daily'])
    await s.deleteCronRun('bot-a:weekly')
    expect(await s.cronRunKeys('bot-a')).toEqual(['bot-a:daily'])
    await s.close()
  })

  it('stores a bounded editor approval history and expires live requests after restart', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-permission-')), 'local.sqlite')
    const s = await reopen(path)
    await s.createPermissionRequest({
      id: 'request-1',
      agentId: 'bot-a',
      sessionId: 'session-1',
      createdAt: 100,
      requesterId: 'user-1',
      requesterName: 'Ada',
      command: 'Bash: pnpm test',
      status: 'pending',
      resolvedAt: null
    })
    await s.createPermissionRequest({
      id: 'request-2',
      agentId: 'bot-a',
      sessionId: 'session-1',
      createdAt: 200,
      requesterId: 'user-2',
      requesterName: 'Lin',
      command: 'Edit: app.ts',
      status: 'pending',
      resolvedAt: null
    })

    expect(await s.resolvePermissionRequest('bot-a', 'request-2', 'allowed', 250)).toBe(true)
    expect(await s.resolvePermissionRequest('bot-a', 'request-2', 'denied', 300)).toBe(false)
    expect(await s.listPermissionRequests('bot-a')).toMatchObject([
      { id: 'request-1', status: 'pending', resolvedAt: null },
      { id: 'request-2', status: 'allowed', resolvedAt: 250 }
    ])
    await s.close()

    const reopened = await reopen(path)
    expect(await reopened.listPermissionRequests('bot-a')).toMatchObject([
      { id: 'request-2', status: 'allowed', resolvedAt: 250 },
      { id: 'request-1', status: 'expired' }
    ])
    await reopened.close()
  })

  it('tracks channel-intro state per (agent, platform, channel) and integration seeding', async () => {
    const s = await store()
    expect(await s.channelIntroSet('bot-a', 'slack')).toEqual(new Set())
    expect(await s.isChannelIntroSeeded('int-1')).toBe(false)

    await s.markChannelIntro('bot-a', 'slack', 'C1', null) // adopted as silent baseline
    await s.markChannelIntro('bot-a', 'slack', 'C2', 123) // introduced-in
    await s.markChannelIntroSeeded('int-1', 100)

    expect(await s.channelIntroSet('bot-a', 'slack')).toEqual(new Set(['C1', 'C2']))
    expect(await s.isChannelIntroSeeded('int-1')).toBe(true)
    // Scoped: another agent / platform / integration is unaffected.
    expect(await s.channelIntroSet('bot-b', 'slack')).toEqual(new Set())
    expect(await s.channelIntroSet('bot-a', 'telegram')).toEqual(new Set())
    expect(await s.isChannelIntroSeeded('int-2')).toBe(false)

    // Idempotent: re-marking never duplicates or overwrites the original row.
    await s.markChannelIntro('bot-a', 'slack', 'C1', 999)
    await s.markChannelIntroSeeded('int-1', 999)
    expect(await s.channelIntroSet('bot-a', 'slack')).toEqual(new Set(['C1', 'C2']))
    await s.close()
  })

  it('supports both latest-wins and per-turn token accounting', async () => {
    const s = await store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    await s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await s.addTokenUsage(key, { totalTokens: 12, inputTokens: 10, outputTokens: 2 })
    await s.addTokenUsage(key, { totalTokens: 9, inputTokens: 7, outputTokens: 2, cachedReadTokens: 3 })
    expect(await s.getUsage(key)).toMatchObject({
      totalTokens: 21,
      inputTokens: 17,
      outputTokens: 4,
      cachedReadTokens: 3
    })
    await s.setTokenUsage(key, { totalTokens: 30, inputTokens: 24, outputTokens: 6 })
    expect(await s.getUsage(key)).toMatchObject({ totalTokens: 30, inputTokens: 24, outputTokens: 6 })
    await s.close()
  })

  it('accumulates fallback cost and lets a runtime snapshot replace it', async () => {
    const s = await store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    await s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    expect(await s.addCost(key, 0.1, 'USD')).toBe(true)
    expect(await s.addCost(key, 0.2, 'USD')).toBe(true)
    expect((await s.getUsage(key)).costAmount).toBeCloseTo(0.3)
    expect((await s.getUsage(key)).costCurrency).toBe('USD')
    expect(await s.addCost(key, 0.4, 'EUR')).toBe(false)

    await s.setUsageSnapshot(key, { costAmount: 0.25, costCurrency: 'USD' })
    expect(await s.getUsage(key)).toMatchObject({ costAmount: 0.25, costCurrency: 'USD' })
    await s.close()
  })

  it.skipIf(pg)('keeps an increment a concurrent writer would otherwise have erased', async () => {
    // The pool shape: two members touch one session across a handover. `usage` is one JSON blob, so
    // a plain read-merge-write silently drops whichever writer commits first. The compare-and-set
    // notices and re-merges instead.
    const database = new DatabaseSync(join(mkdtempSync(join(tmpdir(), 'ac-usage-race-')), 'local.sqlite'))
    const backing = SqliteAsyncDatabase.adopt(database)
    const peer = await LocalStore.open({ database: backing, shared: true, ownerId: 'member-2', orgForAgent: oneOrg })
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')

    // Slip the peer's whole write in between our read and our compare-and-set, exactly once.
    let raced = false
    const racing: StoreDatabase = {
      exec: (sql) => backing.exec(sql),
      close: () => backing.close(),
      batch: (statements) => backing.batch(statements),
      transaction: (fn) => backing.transaction(fn),
      query: async (sql, params) => {
        const result = await backing.query(sql, params)
        if (sql.startsWith('SELECT usage FROM sessions') && !raced) {
          raced = true
          await peer.addTokenUsage(key, { totalTokens: 5 })
        }
        return result
      }
    }
    const member = await LocalStore.open({ database: racing, shared: true, ownerId: 'member-1', orgForAgent: oneOrg })
    await member.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })

    await member.addTokenUsage(key, { totalTokens: 10 })

    expect(raced).toBe(true)
    // 15, not 10: the peer's 5 survived our write instead of being overwritten by it.
    expect(await peer.getUsage(key)).toMatchObject({ totalTokens: 15 })
    database.close()
  })
})

describe('LocalStore session/transcript read-back (session/list, session/history)', () => {
  const seed = async (s: LocalStore, key: string, agentId: string, acpSessionId: string | null, updatedAt: number) =>
    await s.upsertSession({
      key,
      agentId,
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId,
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt
    })

  it('listSessions excludes null-acpSessionId rows, filters by agent, orders updatedAt DESC', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    await seed(s, 'k2', 'bot-a', 'acp-2', 300)
    await seed(s, 'k3', 'bot-a', null, 999) // never launched → no acp id → excluded
    await seed(s, 'k4', 'bot-b', 'acp-4', 200)
    // all agents: newest first, null acp dropped
    expect((await s.listSessions()).map((r) => r.acpSessionId)).toEqual(['acp-2', 'acp-4', 'acp-1'])
    // scoped to bot-a
    expect((await s.listSessions('bot-a')).map((r) => r.acpSessionId)).toEqual(['acp-2', 'acp-1'])
    await s.close()
  })

  it('getSessionByAcpId returns the row on hit and undefined on miss', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect((await s.getSessionByAcpId('acp-1'))?.key).toBe('k1')
    expect(await s.getSessionByAcpId('nope')).toBeUndefined()
    await s.close()
  })

  it('getSessionByAcpIdForAgent disambiguates runtime-local session ids', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'shared-acp-id', 100)
    await seed(s, 'k2', 'bot-b', 'shared-acp-id', 200)
    expect((await s.getSessionByAcpIdForAgent('bot-a', 'shared-acp-id'))?.key).toBe('k1')
    expect((await s.getSessionByAcpIdForAgent('bot-b', 'shared-acp-id'))?.key).toBe('k2')
    expect(await s.getSessionByAcpIdForAgent('bot-c', 'shared-acp-id')).toBeUndefined()
    await s.close()
  })

  it('mints one outward id per slot, before the session row and across every later upsert', async () => {
    const s = await store()
    // A credential is issued before the turn writes the session, so the id must exist first.
    const minted = await s.ensureOutwardSessionId('k1', 'bot-a')
    expect(minted).toMatch(/^[0-9a-f-]{36}$/)
    expect(await s.ensureOutwardSessionId('k1', 'bot-a')).toBe(minted)
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    // The session proper landing on the skeleton row keeps the id the credential already carries.
    expect((await s.getSession('k1'))?.sessionId).toBe(minted)
    await seed(s, 'k1', 'bot-a', 'acp-rebuilt', 200)
    // A rebuilt ACP hop is a new runtime instance of the SAME session: outward id unchanged.
    expect((await s.getSession('k1'))?.sessionId).toBe(minted)
    // A slot the daemon never issued a credential for gets its id from the upsert itself.
    await seed(s, 'k2', 'bot-a', 'acp-2', 100)
    const other = (await s.getSession('k2'))!.sessionId
    expect(other).toMatch(/^[0-9a-f-]{36}$/)
    expect(other).not.toBe(minted)
    await s.close()
  })

  it('a pre-session mint stages itself, leaving no half-built session behind', async () => {
    const s = await store()
    // The pool also issues credentials for keys that never become sessions at all.
    const internal = await s.ensureOutwardSessionId('internal:memory:bot-a', 'bot-a')
    expect(await s.getSession('internal:memory:bot-a')).toBeUndefined()
    expect(await s.listSessions()).toEqual([])
    expect(await s.ensureOutwardSessionId('internal:memory:bot-a', 'bot-a')).toBe(internal)

    // A real slot mints the same way, and the turn's own insert adopts it — coordinates and all.
    const minted = await s.ensureOutwardSessionId('k1', 'bot-a')
    expect(await s.getSession('k1')).toBeUndefined()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect(await s.getSession('k1')).toMatchObject({
      sessionId: minted,
      platform: 'slack',
      channel: 'C1',
      thread: 'k1'
    })
    await s.close()
  })

  it('settles on the session row when a full insert lands mid-mint', async () => {
    const s = await store()
    // The interleaving the staging table makes possible: the mint reads no session, the turn's
    // own insert commits with an id of its own (the stage it would have adopted did not exist
    // yet), and only then does the mint stage its. Answering with the stage would split one
    // session's identity — credential under one name, metadata and usage under another.
    const reads: string[] = []
    const realGet = (s as any).db.prepare.bind((s as any).db)
    ;(s as any).db.prepare = (sql: string) => {
      const stmt = realGet(sql)
      if (!sql.startsWith('SELECT sessionId FROM sessions')) return stmt
      return {
        ...stmt,
        get: async (...args: unknown[]) => {
          const row = await stmt.get(...args)
          reads.push(sql)
          // Exactly once, between the mint's first read and its stage, the turn writes the row.
          if (reads.length === 1) await seed(s, 'k1', 'bot-a', 'acp-1', 100)
          return row
        }
      }
    }
    const minted = await s.ensureOutwardSessionId('k1', 'bot-a')
    ;(s as any).db.prepare = realGet
    const row = (await s.getSession('k1'))!.sessionId
    expect(minted).toBe(row)
    // ...and the stage is settled onto it, so the next ask cannot revive the losing name.
    expect(await s.ensureOutwardSessionId('k1', 'bot-a')).toBe(row)
    await s.close()
  })

  it('a purged slot does not hand its identity to the next session on the same key', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    const first = (await s.getSession('k1'))!.sessionId
    expect(await s.deleteSession('k1', { reason: 'retention', at: 1_000 })).toBe(true)
    // The receipt just reported `first` as purged; reusing it would resurrect a dead row upstream.
    await seed(s, 'k1', 'bot-a', 'acp-2', 200)
    expect((await s.getSession('k1'))!.sessionId).not.toBe(first)
    await s.close()
  })

  it('a record that outlives its session keeps the name it was written with', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    const outward = (await s.getSession('k1'))!.sessionId!
    // What a durable record (a dream, an advertisement) stores at write time.
    const written = (await s.dreamSessionSources('bot-a', 10))[0]!.sessionId
    expect(written).toBe(outward)

    // Retention takes the session AND the staging row with it, so nothing can map acp → outward
    // any more. A record that had resolved at READ time would answer with a different id from
    // here on; one written with the outward name does not change.
    expect(await s.deleteSession('k1', { reason: 'retention', at: 1_000 })).toBe(true)
    expect(await s.getSessionByOutwardId(outward)).toBeUndefined()
    expect(written).toBe(outward)
    await s.close()
  })

  it('getSessionByOutwardId resolves the outward id, and falls back to the ACP one', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    const outward = (await s.getSession('k1'))!.sessionId!
    expect((await s.getSessionByOutwardId(outward))?.key).toBe('k1')
    expect((await s.getSessionByOutwardId(outward, 'bot-a'))?.key).toBe('k1')
    // Scoped to the agent that owns it, so a peer cannot read another org's session.
    expect(await s.getSessionByOutwardId(outward, 'bot-b')).toBeUndefined()
    // A caller still holding the runtime's name — or a CP row written before v12 — still lands.
    expect((await s.getSessionByOutwardId('acp-1'))?.key).toBe('k1')
    expect(await s.getSessionByOutwardId('nope')).toBeUndefined()
    await s.close()
  })

  it('triggeredBy is first-wins across upserts and survives state-only rewrites', async () => {
    const s = await store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    await s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      triggeredBy: 'U-FIRST'
    })
    // A later turn's upsert (different sender, or a read-back row without the
    // field) must not steal / clear the original credit.
    await s.upsertSession({ ...(await s.getSession(key))!, state: 'prompting', updatedAt: 2, triggeredBy: 'U-SECOND' })
    expect((await s.getSession(key))?.triggeredBy).toBe('U-FIRST')
    expect((await s.listSessions('bot-a'))[0]?.triggeredBy).toBe('U-FIRST')
    await s.close()
  })

  it('setSessionTitle: latest wins, null clears, survives upserts; unknown key is a no-op', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect((await s.getSession('k1'))?.title).toBeNull() // fresh rows have no title
    await s.setSessionTitle('k1', 'Fix the deploy script')
    expect((await s.listSessions('bot-a'))[0]?.title).toBe('Fix the deploy script')
    await s.setSessionTitle('k1', 'Fix the deploy script (renamed)')
    expect((await s.getSession('k1'))?.title).toBe('Fix the deploy script (renamed)')
    // a session-state upsert (e.g. a new turn) must not clear the title
    await s.upsertSession({ ...(await s.getSession('k1'))!, state: 'prompting', updatedAt: 200 })
    expect((await s.getSession('k1'))?.title).toBe('Fix the deploy script (renamed)')
    // ACP semantics: an explicit null clears
    await s.setSessionTitle('k1', null)
    expect((await s.getSession('k1'))?.title).toBeNull()
    // unknown key: no row created
    await s.setSessionTitle('slack:C1:none:x', 'ghost')
    expect(await s.getSession('slack:C1:none:x')).toBeUndefined()
    await s.close()
  })

  it('modelOverride: undefined until set, then persists across state upserts; unknown key no-op', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect(await s.getModelOverride('k1')).toBeUndefined()
    await s.setModelOverride('k1', 'opus-4.8')
    expect(await s.getModelOverride('k1')).toBe('opus-4.8')
    // a later turn's state-only upsert must not drop the override
    await s.upsertSession({ ...(await s.getSession('k1'))!, state: 'prompting', updatedAt: 200 })
    expect(await s.getModelOverride('k1')).toBe('opus-4.8')
    await s.setModelOverride('slack:C1:none:x', 'ghost')
    expect(await s.getModelOverride('slack:C1:none:x')).toBeUndefined()
    await s.close()
  })

  it('permissionModeOverride: undefined until set, then persists across state upserts; unknown key no-op', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    expect(await s.getPermissionModeOverride('k1')).toBeUndefined()
    await s.setPermissionModeOverride('k1', 'plan')
    expect(await s.getPermissionModeOverride('k1')).toBe('plan')
    // a later turn's state-only upsert must not drop the override
    await s.upsertSession({ ...(await s.getSession('k1'))!, state: 'prompting', updatedAt: 200 })
    expect(await s.getPermissionModeOverride('k1')).toBe('plan')
    await s.setPermissionModeOverride('slack:C1:none:x', 'ghost')
    expect(await s.getPermissionModeOverride('slack:C1:none:x')).toBeUndefined()
    await s.close()
  })

  it('clears every chat-authored runtime override without clearing output mode', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'acp-1', 100)
    await s.setModelOverride('k1', 'opus-4.8')
    await s.setEffortOverride('k1', 'high')
    await s.setPermissionModeOverride('k1', 'plan')
    await s.setFastModeOverride('k1', true)
    await s.setOutputModeOverride('k1', 'high')

    await s.clearRuntimeConfigOverrides('bot-a')

    expect(await s.getModelOverride('k1')).toBeUndefined()
    expect(await s.getEffortOverride('k1')).toBeUndefined()
    expect(await s.getPermissionModeOverride('k1')).toBeUndefined()
    expect(await s.getFastModeOverride('k1')).toBeUndefined()
    expect(await s.getOutputModeOverride('k1')).toBe('high')
    await s.close()
  })

  it('display names: latest-wins upsert, batch lookup returns only known ids', async () => {
    const s = await store()
    await s.setDisplayName('C1', 'general', 1)
    await s.setDisplayName('U1', 'Dana Reyes', 1)
    await s.setDisplayName('C1', 'general-renamed', 2)
    const names = await s.getDisplayNames(['C1', 'U1', 'U-unknown'])
    expect(names.get('C1')).toBe('general-renamed')
    expect(names.get('U1')).toBe('Dana Reyes')
    expect(names.has('U-unknown')).toBe(false)
    expect((await s.getDisplayNames([])).size).toBe(0)
    await s.close()
  })

  it('profile avatars: latest-wins upsert, batch lookup returns only known ids', async () => {
    const s = await store()
    await s.setProfileAvatar('slack:one', 'bad', 'not-a-url', 1)
    await s.setProfileAvatar('slack:one', 'U1', 'https://avatars.example.test/old.png', 1)
    await s.setProfileAvatar('slack:one', 'U1', 'https://avatars.example.test/new.png', 2)
    await s.setProfileAvatar('slack:two', 'U1', 'https://avatars.example.test/other.png', 2)
    const avatars = await s.getProfileAvatars('slack:one', ['U1', 'U-unknown'])
    expect(avatars.get('U1')).toBe('https://avatars.example.test/new.png')
    expect(avatars.has('U-unknown')).toBe(false)
    expect((await s.getProfileAvatars('slack:two', ['U1'])).get('U1')).toBe('https://avatars.example.test/other.png')
    expect((await s.getProfileAvatars('slack:one', ['bad'])).size).toBe(0)
    expect((await s.getProfileAvatars('slack:one', [])).size).toBe(0)
    await s.close()
  })

  it('channel scopes: latest-wins, batch lookup returns only known ids', async () => {
    const s = await store()
    await s.setChannelScope('T1', { parentId: 'C1' }, 1)
    await s.setChannelScope('T2', { parentId: 'C1' }, 2)
    // A moved thread re-parents (latest-wins).
    await s.setChannelScope('T1', { parentId: 'C2' }, 3)
    const scopes = await s.getChannelScopes(['T1', 'T2', 'unknown'])
    expect(scopes.get('T1')).toEqual({ parentId: 'C2' })
    expect(scopes.get('T2')).toEqual({ parentId: 'C1' })
    expect(scopes.has('unknown')).toBe(false)
    // An empty note writes no row at all.
    await s.setChannelScope('T9', {}, 4)
    expect((await s.getChannelScopes(['T9'])).size).toBe(0)
    expect((await s.getChannelScopes([])).size).toBe(0)
    await s.close()
  })

  it('observedChannels/observedUsers: distinct per physical bot, newest-first, name-joined', async () => {
    const s = await store()
    const sess = async (
      key: string,
      platform: string,
      channel: string,
      triggeredBy: string,
      updatedAt: number,
      transportScope: string | null = 'bot-scope-a'
    ) =>
      await s.upsertSession({
        key,
        agentId: 'bot-a',
        platform,
        channel,
        thread: 't',
        transportScope,
        acpSessionId: null,
        state: 'idle',
        lastDeliveredTs: null,
        triggeredBy,
        updatedAt
      })
    await sess('k1', 'telegram', '-100', 'U1', 1)
    await sess('k2', 'telegram', '55', 'U1', 3) // same user, newer; distinct channel
    await sess('k3', 'telegram', '-100', 'U2', 2) // same channel as k1, newer than k1
    await sess('k4', 'slack', 'C9', 'U9', 5) // different platform — excluded
    await sess('k5', 'telegram', '-999', 'U9', 9, 'bot-scope-b') // different physical bot — excluded
    await sess('k6', 'telegram', '-legacy', 'U8', 8, null) // legacy unknown bot — excluded
    await s.setDisplayName('-100', 'team chat', 1)
    await s.setDisplayName('55', '@bob', 1)

    const chans = await s.observedChannels('bot-a', 'telegram', 'bot-scope-a')
    // Distinct channels, newest-first by their latest session (55@3 before -100@2), names joined.
    expect(chans).toEqual([
      { id: '55', name: '@bob' },
      { id: '-100', name: 'team chat' }
    ])
    // Slack session's channel is not in the Telegram set.
    expect((await chans).find((c) => c.id === 'C9')).toBeUndefined()

    const users = await s.observedUsers('bot-a', 'telegram', 'bot-scope-a')
    expect(users).toEqual([
      { id: 'U1', name: null }, // U1's latest session @3 (no display name → null)
      { id: 'U2', name: null }
    ])
    expect(await s.observedUsers('bot-a', 'discord', 'bot-scope-a')).toEqual([])
    await s.close()
  })

  it('transcriptPage returns newest-first, paginates via beforeSeq, and reports hasMore', async () => {
    const s = await store()
    // seq is AUTOINCREMENT → insertion order 1..4
    for (const ts of ['1', '2', '3', '4']) {
      await s.appendTranscript({ channel: 'C1', thread: 'T', ts, sender: 'U', kind: 'text', text: `m${ts}` })
    }
    // A title-tool row persisted by an older daemon is internal housekeeping. It must
    // not consume page slots or surface after that daemon upgrades.
    await s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '5',
      sender: 'bot-a',
      toolCallId: 'title-tool',
      title: 'mcp.agentconnect.setSessionTitle',
      body: JSON.stringify({
        toolCallId: 'title-tool',
        rawInput: { server: 'agentconnect', tool: 'setSessionTitle', arguments: { title: 'Hidden' } }
      })
    })
    // newest page of 2: seq 4,3 (DESC), more older rows remain
    const page1 = await s.transcriptPage('C1', 'T', null, 2)
    expect(page1.rows.map((r) => r.text)).toEqual(['m4', 'm3'])
    expect(page1.hasMore).toBe(true)
    // next page strictly older than seq 3: seq 2,1 — last page, no more
    const lowest = page1.rows[page1.rows.length - 1]!.seq
    const page2 = await s.transcriptPage('C1', 'T', lowest, 2)
    expect(page2.rows.map((r) => r.text)).toEqual(['m2', 'm1'])
    expect(page2.hasMore).toBe(false)
    // beforeSeq is exclusive (seq >= beforeSeq excluded)
    expect((await s.transcriptPage('C1', 'T', 2, 10)).rows.map((r) => r.text)).toEqual(['m1'])
    await s.close()
  })

  it('keeps a session-local tool id isolated between agents sharing a thread', async () => {
    // ACP tool ids are session-local, so two agents in one thread may legitimately
    // reuse one — the transcript_agent_tool_call index is unique per SENDER, not
    // thread-wide, or one agent's tool body would overwrite the other's.
    const s = await store()
    const toolCallId = 'session-local-tc'
    const aBody = JSON.stringify({ toolCallId, rawOutput: 'agent-a output' })
    const bInitial = JSON.stringify({ toolCallId, rawOutput: 'agent-b partial' })
    const bFinal = JSON.stringify({ toolCallId, rawOutput: 'agent-b final' })
    await s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'bot-a',
      toolCallId,
      title: 'agent-a tool',
      body: aBody
    })
    await s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '2',
      sender: 'bot-b',
      toolCallId,
      title: 'agent-b tool',
      body: bInitial
    })
    await s.updateToolCall('C1', 'T', 'bot-b', toolCallId, { title: 'agent-b done', body: bFinal })

    expect(await s.getToolBodyForAgent('C1', 'T', 'bot-a', toolCallId)).toBe(aBody)
    expect(await s.getToolBodyForAgent('C1', 'T', 'bot-b', toolCallId)).toBe(bFinal)
    await s.close()
  })

  it('transcriptPageForAgent scopes to what THAT agent received or produced (no peer cross-talk)', async () => {
    const s = await store()
    // Delivered to bot-a + bot-a's own reply.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'U1',
      recipient: 'bot-a',
      kind: 'text',
      text: 'to-a'
    })
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '2', sender: 'bot-a', kind: 'text', text: 'a-reply' })
    // Delivered to bot-b + bot-b's own reply.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '3',
      sender: 'U1',
      recipient: 'bot-b',
      kind: 'text',
      text: 'to-b'
    })
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '4', sender: 'bot-b', kind: 'text', text: 'b-reply' })
    // bot-b's PRIVATE reasoning (sender=bot-b, no recipient) — must NOT leak into bot-a's view.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '5',
      sender: 'bot-b',
      kind: 'reasoning',
      text: 'b-thinks'
    })
    // bot-a owns this legacy row, so the agent scope alone would include it. The
    // internal-housekeeping filter must still remove it from console history.
    await s.insertToolCall({
      channel: 'C1',
      thread: 'T',
      ts: '6',
      sender: 'bot-a',
      toolCallId: 'title-tool',
      title: 'mcp.agentconnect.setSessionTitle',
      body: JSON.stringify({ toolCallId: 'title-tool' })
    })

    expect((await s.transcriptPageForAgent('C1', 'T', 'bot-a', null, 50)).rows.map((r) => r.text).reverse()).toEqual([
      'to-a',
      'a-reply'
    ])
    expect((await s.transcriptPageForAgent('C1', 'T', 'bot-b', null, 50)).rows.map((r) => r.text).reverse()).toEqual([
      'to-b',
      'b-reply',
      'b-thinks'
    ])
    await s.close()
  })

  it('transcriptPageForAgent shows a shared message to EVERY agent it was delivered to (dedup survival)', async () => {
    const s = await store()
    // A shared thread message that both agents catch up on. The second appendTranscript is
    // deduped by the (channel, thread, ts) unique index, so the row keeps recipient='bot-a'
    // — but the delivery to 'bot-b' must still be recorded so bot-b's view shows it.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'U1',
      recipient: 'bot-a',
      kind: 'text',
      text: 'shared'
    })
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '1',
      sender: 'U1',
      recipient: 'bot-b',
      kind: 'text',
      text: 'shared'
    })

    expect((await s.transcriptPageForAgent('C1', 'T', 'bot-a', null, 50)).rows.map((r) => r.text)).toEqual(['shared'])
    expect((await s.transcriptPageForAgent('C1', 'T', 'bot-b', null, 50)).rows.map((r) => r.text)).toEqual(['shared'])
    // A third agent it was never delivered to does not see it.
    expect((await s.transcriptPageForAgent('C1', 'T', 'bot-c', null, 50)).rows.map((r) => r.text)).toEqual([])
    await s.close()
  })

  it('does not pull in a peer non-text row that shares a ts with a delivered text message', async () => {
    const s = await store()
    // A text message delivered to bot-a at ts='7'.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '7',
      sender: 'U1',
      recipient: 'bot-a',
      kind: 'text',
      text: 'to-a'
    })
    // A peer's PRIVATE reasoning that happens to share ts='7' (internal rows aren't ts-deduped,
    // so a collision is possible). The delivery match is keyed by ts, so it must be gated to
    // text rows or this peer row would leak into bot-a's view.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '7',
      sender: 'bot-b',
      kind: 'reasoning',
      text: 'b-secret'
    })

    const aRows = (await s.transcriptPageForAgent('C1', 'T', 'bot-a', null, 50)).rows
    expect(aRows.map((r) => r.text)).toEqual(['to-a'])
    expect(aRows.some((r) => r.text === 'b-secret')).toBe(false)
    await s.close()
  })
})

describe('LocalStore session lifecycle (§7.3/#111/#118)', () => {
  const seed = async (s: LocalStore, key: string, agentId: string, state: 'idle' | 'prompting', updatedAt: number) =>
    await s.upsertSession({
      key,
      agentId,
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId: 'acp-' + key,
      state,
      lastDeliveredTs: null,
      updatedAt
    })

  it('setSessionState transitions an existing row and stamps updatedAt', async () => {
    const s = await store()
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    await seed(s, key, 'bot-a', 'prompting', 100)
    await s.setSessionState(key, 'idle', 500)
    const got = await s.getSession(key)
    expect(got?.state).toBe('idle')
    expect(got?.updatedAt).toBe(500)
    // unknown key is a no-op (row created later by the SessionManager)
    await s.setSessionState('slack:C1:none:x', 'idle', 1)
    expect(await s.getSession('slack:C1:none:x')).toBeUndefined()
    await s.close()
  })

  it('agentLastActivityTs is the max updatedAt across an agent non-closed sessions', async () => {
    const s = await store()
    await seed(s, 'k1', 'bot-a', 'idle', 100)
    await seed(s, 'k2', 'bot-a', 'prompting', 300)
    await seed(s, 'k3', 'bot-b', 'idle', 999)
    expect(await s.agentLastActivityTs('bot-a')).toBe(300)
    expect(await s.agentLastActivityTs('nobody')).toBeNull()
    // a closed session no longer counts toward activity
    await s.setSessionState('k2', 'closed', 300)
    expect(await s.agentLastActivityTs('bot-a')).toBe(100)
    await s.close()
  })

  it('setSessionMuted persists a cold !stop tombstone across reopen and later session creation', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-mute-')), 'local.sqlite')
    let s = await reopen(path)
    const key = sessionKey('slack', 'C1', 'T1', 'bot-a')
    expect(await s.getSession(key)).toBeUndefined()
    expect(await s.isSessionMuted(key)).toBe(false)
    await s.setSessionMuted(key, true)
    expect(await s.isSessionMuted(key)).toBe(true)
    expect(await s.getSession(key)).toBeUndefined()
    await s.close()

    // A daemon restart before SessionManager creates the row must retain the mute.
    s = await reopen(path)
    expect(await s.isSessionMuted(key)).toBe(true)
    // Creating/upserting the actual session mirrors but never overwrites the tombstone.
    await seed(s, key, 'bot-a', 'idle', 100)
    expect((await s.getSession(key))?.muted).toBe(1)
    await seed(s, key, 'bot-a', 'prompting', 200)
    expect(await s.isSessionMuted(key)).toBe(true)
    await s.setSessionMuted(key, false)
    expect(await s.isSessionMuted(key)).toBe(false)
    await s.close()

    const reopened = await reopen(path)
    expect(await reopened.isSessionMuted(key)).toBe(false)
    expect((await reopened.getSession(key))?.muted).toBe(0)
    await reopened.close()
  })

  it('closeIdleSessions closes only idle rows past the TTL, leaving prompting alone', async () => {
    const s = await store()
    await seed(s, 'old-idle', 'bot-a', 'idle', 100)
    await seed(s, 'fresh-idle', 'bot-a', 'idle', 900)
    await seed(s, 'old-prompting', 'bot-a', 'prompting', 100) // a live turn keeps the thread open
    const closed = await s.closeIdleSessions(1000, 500) // cutoff = 500
    expect((await closed).map((r) => r.key)).toEqual(['old-idle'])
    expect(closed[0]).toMatchObject({
      key: 'old-idle',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'old-idle',
      acpSessionId: 'acp-old-idle'
    })
    expect((await s.getSession('old-idle'))?.state).toBe('closed')
    expect((await s.getSession('fresh-idle'))?.state).toBe('idle')
    expect((await s.getSession('old-prompting'))?.state).toBe('prompting')
    await s.close()
  })

  it('closeIdleSessions spares a session the isExempt predicate keeps (background work in flight)', async () => {
    const s = await store()
    await seed(s, 'busy', 'bot-a', 'idle', 100) // idle + past TTL, but has live background work
    await seed(s, 'done', 'bot-a', 'idle', 100) // idle + past TTL, quiescent
    // Exempt the one whose acpSessionId is still working.
    const closed = await s.closeIdleSessions(1000, 500, (_agentId, acpSessionId) => acpSessionId === 'acp-busy')
    expect(closed.map((r) => r.key)).toEqual(['done'])
    expect((await s.getSession('busy'))?.state).toBe('idle') // spared
    expect((await s.getSession('done'))?.state).toBe('closed') // closed as usual
    await s.close()
  })

  it('openSessionAgents excludes closed rows; closedSessionAgents returns exactly them', async () => {
    const s = await store()
    // Seed with real (channel, thread) coords — the shared `seed` above stores
    // thread=key, which would defeat a per-thread query.
    const put = async (agentId: string, thread: string, state: 'idle' | 'closed') =>
      await s.upsertSession({
        key: sessionKey('slack', 'C1', thread, agentId),
        agentId,
        platform: 'slack',
        channel: 'C1',
        thread,
        acpSessionId: `acp-${agentId}-${thread}`,
        state,
        lastDeliveredTs: null,
        updatedAt: 100
      })
    // Two agents once active in thread T1; plus a live session in T2 (scoping check).
    await put('bot-a', 'T1', 'idle')
    await put('bot-b', 'T1', 'idle')
    await put('bot-a', 'T2', 'idle')
    expect((await s.openSessionAgents('C1', 'T1')).sort()).toEqual(['bot-a', 'bot-b'])
    expect(await s.closedSessionAgents('C1', 'T1')).toEqual([])

    await s.setSessionState(sessionKey('slack', 'C1', 'T1', 'bot-a'), 'closed', 200)
    expect(await s.openSessionAgents('C1', 'T1')).toEqual(['bot-b'])
    expect(await s.closedSessionAgents('C1', 'T1')).toEqual(['bot-a'])

    await s.setSessionState(sessionKey('slack', 'C1', 'T1', 'bot-b'), 'closed', 200)
    expect(await s.openSessionAgents('C1', 'T1')).toEqual([])
    expect((await s.closedSessionAgents('C1', 'T1')).sort()).toEqual(['bot-a', 'bot-b'])
    // T2 stays live and unaffected.
    expect(await s.openSessionAgents('C1', 'T2')).toEqual(['bot-a'])
    expect(await s.closedSessionAgents('C1', 'T2')).toEqual([])
    await s.close()
  })
})

describe('LocalStore session retention GC (#485)', () => {
  const seed = async (
    s: LocalStore,
    key: string,
    state: 'idle' | 'prompting' | 'cancelling' | 'resuming' | 'closed',
    updatedAt: number,
    acpSessionId: string | null = 'acp-' + key
  ) =>
    await s.upsertSession({
      key,
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId,
      state,
      lastDeliveredTs: null,
      updatedAt
    })

  it('listExpiredSessions returns idle/closed rows past the cutoff oldest-first, including unbound ones', async () => {
    const s = await store()
    await seed(s, 'old-closed', 'closed', 200)
    await seed(s, 'older-idle', 'idle', 100)
    await seed(s, 'never-bound', 'closed', 150, null) // no ACP id, still a candidate (may own a worktree)
    await seed(s, 'fresh-closed', 'closed', 900)
    await seed(s, 'old-prompting', 'prompting', 100) // live turn — never a candidate
    await seed(s, 'old-resuming', 'resuming', 100) // re-attaching — never a candidate
    expect((await s.listExpiredSessions(500)).map((r) => r.key)).toEqual(['older-idle', 'never-bound', 'old-closed'])
    await s.close()
  })

  it('sessionHasPendingInboxRows counts admitted work, not terminal hook receipts', async () => {
    const s = await store()
    // A completed hook receipt (dedup row) must not pin the session forever —
    // hook-triggered review sessions are exactly what #485 collects.
    await s.appendInbox({
      id: 'receipt',
      sessionKey: 'k',
      agentId: 'bot-a',
      msg: '{}',
      completedAt: 50,
      enqueuedAt: '0000000001'
    })
    expect(await s.sessionHasPendingInboxRows('k')).toBe(false)
    await s.appendInbox({ id: 'queued', sessionKey: 'k', agentId: 'bot-a', msg: '{}', enqueuedAt: '0000000002' })
    expect(await s.sessionHasPendingInboxRows('k')).toBe(true)
    await s.close()
  })

  it('deleteSession removes the row and its mute/inbox/gate/permission cascades, keeping transcripts', async () => {
    const s = await store()
    await seed(s, 'gone', 'closed', 100)
    await s.setSessionMuted('gone', true)
    await s.setLocalCaptureGate('bot-a', 'acp-gone', true)
    await s.appendInbox({ id: 'm1', sessionKey: 'gone', agentId: 'bot-a', msg: '{}', enqueuedAt: '0000000001' })
    // An unacknowledged terminal hook report is an outbox toward the CP and must
    // survive the session delete (same rule as removeInboxByAgentId).
    await s.appendInbox({
      id: 'm1-report',
      sessionKey: 'gone',
      agentId: 'bot-a',
      msg: '{}',
      completedAt: 90,
      terminalReport: '{"outcome":"done"}',
      enqueuedAt: '0000000002'
    })
    await s.createPermissionRequest({
      id: 'p1',
      agentId: 'bot-a',
      sessionId: 'acp-gone',
      createdAt: 100,
      requesterId: null,
      requesterName: null,
      command: 'rm -rf /tmp/x',
      status: 'pending',
      resolvedAt: null
    })
    // ACP session ids are runtime-local: another agent's identically named
    // session must keep its permission history.
    await s.createPermissionRequest({
      id: 'p2',
      agentId: 'bot-b',
      sessionId: 'acp-gone',
      createdAt: 100,
      requesterId: null,
      requesterName: null,
      command: 'ls',
      status: 'pending',
      resolvedAt: null
    })
    // Thread history is (channel, thread)-scoped and shared — it must survive.
    await s.appendTranscript({ channel: 'C1', thread: 'gone', ts: '1.1', sender: 'u1', kind: 'text', text: 'hello' })
    expect(await s.sessionHasPendingInboxRows('gone')).toBe(true)

    expect(await s.deleteSession('gone')).toBe(true)

    expect(await s.getSession('gone')).toBeUndefined()
    expect(await s.isSessionMuted('gone')).toBe(false)
    expect(await s.sessionHasPendingInboxRows('gone')).toBe(false)
    expect((await s.listInboxBySessionKeyFifo()).map((r) => r.id)).toEqual(['m1-report'])
    expect(await s.listPermissionRequests('bot-a')).toEqual([])
    expect((await s.listPermissionRequests('bot-b')).map((r) => r.id)).toEqual(['p2'])
    // The gate row is gone: an unknown session falls back to excluded-by-default.
    expect((await s.transcriptSince('C1', 'gone', null, 'bot-a')).map((r) => r.text)).toEqual(['hello'])
    // Idempotent: a second delete (or an unknown key) reports false, not an error.
    expect(await s.deleteSession('gone')).toBe(false)
    await s.close()
  })

  it('deleteSession drops only the deleted agent gate for a shared ACP id', async () => {
    const s = await store()
    // ACP session ids are runtime-local: bot-a and bot-b can both hold `acp-shared`.
    const put = async (key: string, agentId: string) =>
      await s.upsertSession({
        key,
        agentId,
        platform: 'slack',
        channel: 'C1',
        thread: key,
        acpSessionId: 'acp-shared',
        state: 'closed',
        lastDeliveredTs: null,
        updatedAt: 100
      })
    await put('a', 'bot-a')
    await put('b', 'bot-b')
    await s.setLocalCaptureGate('bot-a', 'acp-shared', false) // capture open (not excluded)
    await s.setLocalCaptureGate('bot-b', 'acp-shared', false)

    // bot-a's session expires: its own gate goes, bot-b's is untouched.
    expect(await s.deleteSession('a')).toBe(true)
    expect(await s.isCaptureExcluded('bot-a', 'acp-shared')).toBe(true) // no row ⇒ excluded-by-default
    expect(await s.isCaptureExcluded('bot-b', 'acp-shared')).toBe(false)

    expect(await s.deleteSession('b')).toBe(true)
    expect(await s.isCaptureExcluded('bot-b', 'acp-shared')).toBe(true)
    await s.close()
  })

  it('deleteSession leaves unrelated sessions and their dependents alone', async () => {
    const s = await store()
    await seed(s, 'gone', 'closed', 100)
    await seed(s, 'kept', 'closed', 100)
    await s.setSessionMuted('kept', true)
    await s.appendInbox({ id: 'm2', sessionKey: 'kept', agentId: 'bot-a', msg: '{}', enqueuedAt: '0000000002' })
    await s.deleteSession('gone')
    expect(await s.getSession('kept')).toBeDefined()
    expect(await s.isSessionMuted('kept')).toBe(true)
    expect(await s.sessionHasPendingInboxRows('kept')).toBe(true)
    await s.close()
  })

  it('deleteSession records the CP-owed purge receipt in the same transaction', async () => {
    const s = await store()
    await seed(s, 'gone', 'closed', 100)
    // A session that never bound an ACP id was never reported to the CP, so there
    // is no metadata row to mark and no receipt to keep.
    await seed(s, 'unbound', 'closed', 100, null)

    // The receipt addresses the session by its outward id, not the ACP hop's.
    const outward = (await s.getSession('gone'))!.sessionId!
    await s.deleteSession('gone', { reason: 'retention', at: 1_700 })
    await s.deleteSession('unbound', { reason: 'retention', at: 1_800 })

    expect(await s.listSessionPurges(10, 0)).toEqual([
      { agentId: 'bot-a', sessionId: outward, reason: 'retention', purgedAt: 1_700 }
    ])
    await s.close()
  })

  it('a purge receipt survives until acknowledged, and only for the reported agent', async () => {
    const s = await store()
    // Both rows carry the SAME outward id — the shape a v11 store leaves behind, where the
    // backfill took each session's runtime-local ACP id. The ACK fence is the agent, not the id.
    await s.upsertSession({
      key: 'a',
      agentId: 'bot-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'a',
      acpSessionId: 'acp-a',
      sessionId: 'acp-a',
      state: 'closed',
      lastDeliveredTs: null,
      updatedAt: 100
    })
    await s.upsertSession({
      key: 'b',
      agentId: 'bot-b',
      platform: 'slack',
      channel: 'C1',
      thread: 'b',
      acpSessionId: 'acp-a',
      sessionId: 'acp-a',
      state: 'closed',
      lastDeliveredTs: null,
      updatedAt: 100
    })
    await s.deleteSession('a', { reason: 'retention', at: 100 })
    await s.deleteSession('b', { reason: 'retention', at: 200 })
    expect(await s.listSessionPurges(10, 0)).toHaveLength(2)

    await s.acknowledgeSessionPurges('bot-a', ['acp-a'])
    expect(await s.listSessionPurges(10, 0)).toEqual([
      { agentId: 'bot-b', sessionId: 'acp-a', reason: 'retention', purgedAt: 200 }
    ])
    await s.close()
  })
})

describe('LocalStore pool-wide runtime probe claim', () => {
  // One member per runtime image runs the probe sandbox; the rest read what it published. The
  // store is what decides which member that is, so the race and the stale holder both settle here.
  it('gives the claim to exactly one member, and the loser reads the winner’s answer', async () => {
    const s = await store()
    const claim = (memberId: string) =>
      s.claimRuntimeImageProbe({ imageRef: 'runtime:v1', memberId, now: 1_000, staleBefore: 0 })
    expect(await claim('member-a')).toBe(true)
    expect(await claim('member-b')).toBe(false)
    // Re-entrant for the holder: a retry after a transient failure is not a second member.
    expect(await claim('member-a')).toBe(true)

    expect(await s.readRuntimeImageProbe('runtime:v1')).toBeUndefined()
    await s.publishRuntimeImageProbe({ imageRef: 'runtime:v1', payload: '{"table":{},"results":[]}', now: 2_000 })
    expect(await s.readRuntimeImageProbe('runtime:v1')).toEqual({
      payload: '{"table":{},"results":[]}',
      probedAt: 2_000
    })
  })

  it('lets another member retake a claim whose holder went away', async () => {
    // Otherwise one member dying mid-probe leaves the whole pool advertising nothing, forever.
    const s = await store()
    expect(await s.claimRuntimeImageProbe({ imageRef: 'runtime:v1', memberId: 'gone', now: 1_000, staleBefore: 0 }))
    expect(
      await s.claimRuntimeImageProbe({ imageRef: 'runtime:v1', memberId: 'next', now: 9_000, staleBefore: 5_000 })
    ).toBe(true)
  })

  it('keys the answer on the image, so a template bump is a different question', async () => {
    const s = await store()
    await s.publishRuntimeImageProbe({ imageRef: 'runtime:v1', payload: '{"v":1}', now: 1 })
    expect(await s.readRuntimeImageProbe('runtime:v2')).toBeUndefined()
    expect(
      await s.claimRuntimeImageProbe({ imageRef: 'runtime:v2', memberId: 'member-a', now: 1, staleBefore: 0 })
    ).toBe(true)
    // And publishing the new image leaves the old row alone.
    await s.publishRuntimeImageProbe({ imageRef: 'runtime:v2', payload: '{"v":2}', now: 2 })
    expect((await s.readRuntimeImageProbe('runtime:v1'))?.payload).toBe('{"v":1}')
  })

  it('drops answers for images the pool stopped running long ago', async () => {
    // One row per image tag ever deployed would otherwise accumulate for the life of the store.
    const s = await store()
    const year = 365 * 24 * 60 * 60_000
    await s.publishRuntimeImageProbe({ imageRef: 'runtime:ancient', payload: '{"v":0}', now: 1 })
    await s.publishRuntimeImageProbe({ imageRef: 'runtime:current', payload: '{"v":1}', now: year })
    expect(await s.readRuntimeImageProbe('runtime:ancient')).toBeUndefined()
    expect((await s.readRuntimeImageProbe('runtime:current'))?.payload).toBe('{"v":1}')
  })
})

describe('LocalStore runtime model-catalog cache (runtime-model-catalog.md §4)', () => {
  const meta = (runtimeId: string, fingerprint: string, observedAt = 100) => ({
    runtimeId,
    fingerprint,
    source: 'acp' as const,
    defaultModel: 'opus',
    permissionModes: [{ value: 'default', name: 'Default' }],
    observedAt
  })
  const cap = (runtimeId: string, modelId: string, observedAt = 100) => ({
    runtimeId,
    modelId,
    fingerprint: 'fp-1',
    caps: { name: modelId, efforts: [{ value: 'high', name: 'High' }], defaultEffort: 'high', fastMode: true },
    observedAt
  })

  it('round-trips defaultPermissionMode (absent stays absent)', async () => {
    const s = await store()
    await s.recordRuntimeCatalogMeta({ ...meta('copilot', 'fp-1'), defaultPermissionMode: 'agent' })
    expect((await s.getRuntimeCatalogMeta('copilot'))?.defaultPermissionMode).toBe('agent')
    await s.recordRuntimeCatalogMeta(meta('claude', 'fp-1'))
    expect(await s.getRuntimeCatalogMeta('claude')).not.toHaveProperty('defaultPermissionMode')
  })

  it('round-trips catalog meta and per-model capability rows', async () => {
    const s = await store()
    expect(await s.getRuntimeCatalogMeta('claude')).toBeUndefined()
    expect(await s.listRuntimeCatalogMetas()).toEqual([])
    expect(await s.listRuntimeModelCaps()).toEqual([])

    await s.recordRuntimeCatalogMeta(meta('claude', 'fp-1'))
    await s.upsertRuntimeModelCap(cap('claude', 'opus'))
    await s.upsertRuntimeModelCap(cap('claude', 'sonnet'))
    await s.upsertRuntimeModelCap({ ...cap('codex', 'gpt'), caps: {} })

    // A phase-1 meta write is never complete and carries no modelsHash — both keys
    // are absent (not null) on read-back.
    expect(await s.getRuntimeCatalogMeta('claude')).toEqual({
      runtimeId: 'claude',
      fingerprint: 'fp-1',
      source: 'acp',
      defaultModel: 'opus',
      permissionModes: [{ value: 'default', name: 'Default' }],
      complete: false,
      observedAt: 100
    })
    expect((await s.listRuntimeCatalogMetas()).map((m) => m.runtimeId)).toEqual(['claude'])
    expect((await s.listRuntimeModelCaps('claude')).map((c) => c.modelId)).toEqual(['opus', 'sonnet'])
    expect((await s.listRuntimeModelCaps('claude'))[0]?.caps).toEqual({
      name: 'opus',
      efforts: [{ value: 'high', name: 'High' }],
      defaultEffort: 'high',
      fastMode: true
    })
    // Unscoped list spans runtimes; empty caps round-trip as {}.
    expect((await s.listRuntimeModelCaps()).map((c) => `${c.runtimeId}:${c.modelId}`)).toEqual([
      'claude:opus',
      'claude:sonnet',
      'codex:gpt'
    ])
    expect((await s.listRuntimeModelCaps('codex'))[0]?.caps).toEqual({})

    // Latest-wins upsert on (runtimeId, modelId).
    await s.upsertRuntimeModelCap({ ...cap('claude', 'opus', 999), fingerprint: 'fp-2', caps: { fastMode: false } })
    const opus = (await s.listRuntimeModelCaps('claude')).find((c) => c.modelId === 'opus')
    expect(opus).toMatchObject({ fingerprint: 'fp-2', observedAt: 999 })
    expect(opus?.caps).toEqual({ fastMode: false })
    await s.close()
  })

  it('recordRuntimeCatalogMeta preserves complete/modelsHash on the same fingerprint, resets on change', async () => {
    const s = await store()
    await s.recordRuntimeCatalogMeta(meta('claude', 'fp-1'))
    await s.markRuntimeCatalogComplete('claude', 'fp-1', 'hash-1', 200)
    expect(await s.getRuntimeCatalogMeta('claude')).toMatchObject({
      complete: true,
      modelsHash: 'hash-1',
      observedAt: 200
    })

    // A phase-1 re-write on the SAME generation must neither satisfy nor re-open the
    // discovery gate: complete/modelsHash survive while the mutable fields update.
    await s.recordRuntimeCatalogMeta({ ...meta('claude', 'fp-1', 300), defaultModel: 'sonnet' })
    expect(await s.getRuntimeCatalogMeta('claude')).toMatchObject({
      complete: true,
      modelsHash: 'hash-1',
      defaultModel: 'sonnet',
      observedAt: 300
    })

    // An adapter upgrade (new fingerprint) re-opens the gate.
    await s.recordRuntimeCatalogMeta(meta('claude', 'fp-2', 400))
    const reset = await s.getRuntimeCatalogMeta('claude')
    expect(reset).toMatchObject({ fingerprint: 'fp-2', complete: false, observedAt: 400 })
    expect(reset?.modelsHash).toBeUndefined()
    await s.close()
  })

  it('markRuntimeCatalogComplete is fenced by fingerprint (stale discovery cannot close a new generation)', async () => {
    const s = await store()
    await s.recordRuntimeCatalogMeta(meta('claude', 'fp-2'))
    await s.markRuntimeCatalogComplete('claude', 'fp-1', 'stale-hash', 999) // old-generation straggler
    expect(await s.getRuntimeCatalogMeta('claude')).toMatchObject({ complete: false, observedAt: 100 })
    expect((await s.getRuntimeCatalogMeta('claude'))?.modelsHash).toBeUndefined()
    await s.markRuntimeCatalogComplete('claude', 'fp-2', 'hash-2', 500)
    expect(await s.getRuntimeCatalogMeta('claude')).toMatchObject({
      complete: true,
      modelsHash: 'hash-2',
      observedAt: 500
    })
    // Unknown runtime: no row created.
    await s.markRuntimeCatalogComplete('ghost', 'fp', 'h', 1)
    expect(await s.getRuntimeCatalogMeta('ghost')).toBeUndefined()
    await s.close()
  })

  it('pruneRuntimeModelCaps keeps only the listed ids, scoped to one runtime', async () => {
    const s = await store()
    for (const id of ['opus', 'sonnet', 'haiku']) await s.upsertRuntimeModelCap(cap('claude', id))
    await s.upsertRuntimeModelCap(cap('codex', 'gpt'))
    await s.pruneRuntimeModelCaps('claude', ['opus', 'haiku'])
    expect((await s.listRuntimeModelCaps('claude')).map((c) => c.modelId)).toEqual(['haiku', 'opus'])
    expect((await s.listRuntimeModelCaps('codex')).map((c) => c.modelId)).toEqual(['gpt'])
    // An empty keep-set clears the runtime's rows entirely.
    await s.pruneRuntimeModelCaps('claude', [])
    expect(await s.listRuntimeModelCaps('claude')).toEqual([])
    expect(await s.listRuntimeModelCaps('codex')).toHaveLength(1)
    await s.close()
  })

  it('keeps two members of one shared store on independent catalogs', async () => {
    // The rollout case: two image generations, one Postgres schema. Each member reads and
    // writes only its own rows, so neither sees the other's fingerprint as a change.
    const [a, b] = await sharedMembers('member-a', 'member-b')
    await a.recordRuntimeCatalogMeta(meta('claude', 'fp-a'))
    await a.upsertRuntimeModelCap(cap('claude', 'opus'))
    await a.markRuntimeCatalogComplete('claude', 'fp-a', 'hash-a', 200)

    await b.recordRuntimeCatalogMeta(meta('claude', 'fp-b'))
    await b.upsertRuntimeModelCap(cap('claude', 'haiku'))
    await b.upsertRuntimeModelCap(cap('claude', 'sonnet'))
    await b.pruneRuntimeModelCaps('claude', ['haiku'])

    // a's gate stays closed on its own generation; the prune-on-success stayed inside b.
    expect(await a.getRuntimeCatalogMeta('claude')).toMatchObject({
      fingerprint: 'fp-a',
      complete: true,
      modelsHash: 'hash-a',
      observedAt: 200
    })
    expect(await b.getRuntimeCatalogMeta('claude')).toMatchObject({ fingerprint: 'fp-b', complete: false })
    expect((await a.listRuntimeModelCaps('claude')).map((c) => c.modelId)).toEqual(['opus'])
    expect((await b.listRuntimeModelCaps('claude')).map((c) => c.modelId)).toEqual(['haiku'])
    // Hydration too: a member boots on its own catalog, never a peer image's.
    expect((await a.listRuntimeCatalogMetas()).map((m) => m.fingerprint)).toEqual(['fp-a'])
    expect((await b.listRuntimeModelCaps()).map((c) => c.modelId)).toEqual(['haiku'])
    // And a completion from the other member cannot close a's gate on a's fingerprint.
    await b.markRuntimeCatalogComplete('claude', 'fp-a', 'hash-a', 300)
    expect((await b.getRuntimeCatalogMeta('claude'))?.complete).toBe(false)
    await a.close()
  })

  it('finds a pending skill proposal behind many skill-bearing dreams', async () => {
    // The proposed filter must be IN the query: rows whose candidates are all
    // accepted/dismissed (or empty) must not consume the scan window, or one
    // genuinely pending older proposal ages out permanently.
    const s = await store()
    const base = {
      agentId: 'a1',
      status: 'adopted' as const,
      trigger: 'manual' as const,
      sessionIds: [],
      snapshotDigest: 'sha256:x'
    }
    // The pending one is the OLDEST.
    await s.insertDream({
      ...base,
      dreamId: 'drm-pending',
      createdAt: '2020-01-01T00:00:00.000Z',
      skills: [{ name: 'deploy-staging', description: 'd', state: 'proposed' }]
    })
    // …buried behind 600 newer dreams that all carry skills, none pending.
    for (let i = 0; i < 600; i++) {
      await s.insertDream({
        ...base,
        dreamId: `drm-${i}`,
        createdAt: `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
        skills: [{ name: `done-${i}`, description: 'd', state: i % 2 ? 'accepted' : 'dismissed' }]
      })
    }

    const pending = await s.pendingSkillDreams('a1', 50)
    expect(pending.map((d) => d.dreamId)).toEqual(['drm-pending'])
    await s.close()
  })
})

describe('LocalStore webchat MCP grant ledger', () => {
  const tuple = {
    conversationId: 'conv-1',
    agentId: 'agent-1',
    authorityId: 'auth-1',
    authorityGeneration: 3
  }

  it('tracks active grants and queues durable revocations', async () => {
    const s = await store()
    await s.recordWebchatMcpGrant({ ...tuple, now: 10 })
    expect(await s.listDueWebchatMcpRevocations(100)).toEqual([])

    await s.markWebchatMcpGrantRevoking({ ...tuple, reason: 'agent_detached', now: 20 })
    const due = await s.listDueWebchatMcpRevocations(20)
    expect(due).toHaveLength(1)
    expect(due[0]).toMatchObject({ ...tuple, state: 'revoking', reason: 'agent_detached', attempts: 0 })

    await s.retryWebchatMcpRevocation('conv-1', 'auth-1', 3, 500, 30)
    expect(await s.listDueWebchatMcpRevocations(100)).toEqual([])
    expect((await s.listDueWebchatMcpRevocations(500))[0]).toMatchObject({ attempts: 1 })

    await s.clearWebchatMcpGrant('conv-1', 'auth-1', 3)
    expect(await s.listDueWebchatMcpRevocations(10_000)).toEqual([])
    await s.close()
  })

  it('re-provisioning cancels a queued revocation, and exact-tuple fences protect newer authorities', async () => {
    const s = await store()
    await s.markWebchatMcpGrantRevoking({ ...tuple, reason: 'session_expired', now: 10 })
    // Conversation resumes: the CP re-validated the authority; the stale revoke must not fire.
    await s.recordWebchatMcpGrant({ ...tuple, authorityGeneration: 4, now: 20 })
    expect(await s.listDueWebchatMcpRevocations(10_000)).toEqual([])

    // A late clear/downgrade for the OLD tuple must not touch the newer active row.
    await s.clearWebchatMcpGrant('conv-1', 'auth-1', 3)
    await s.markWebchatMcpGrantRevoking({ ...tuple, authorityGeneration: 4, reason: 'session_closed', now: 30 })
    expect((await s.listDueWebchatMcpRevocations(30))[0]).toMatchObject({ authorityGeneration: 4 })
    await s.close()
  })

  it('marks the leftover active grants of an exclusively owned store revoking on the startup sweep', async () => {
    const s = await store()
    await s.recordWebchatMcpGrant({ ...tuple, now: 10 })
    await s.recordWebchatMcpGrant({ ...tuple, conversationId: 'conv-2', now: 10 })
    expect(await s.markOwnedWebchatMcpGrantsRevoking('session_closed', 50)).toBe(2)
    const due = await s.listDueWebchatMcpRevocations(50)
    expect(due.map((r) => r.conversationId).sort()).toEqual(['conv-1', 'conv-2'])
    expect(due.every((r) => r.reason === 'session_closed')).toBe(true)
    await s.close()
  })
  it('an authoritative event time upgrades a row the derived-axis observer wrote first', async () => {
    // Regression (merged-conversation-view.md §6 / PR review): with
    // turnFinalContextRefresh on, recordObservedInbound races SessionManager
    // and wins the INSERT — a Telegram row ts="4821" landed at the derived
    // 4_821_000_000µs axis, and the later authoritative append was
    // INSERT-OR-IGNOREd without repair. Explicit eventTimeUs must upgrade the
    // deduped row (and bump its revision); derived recomputes never flap it.
    const s = await store()
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '4821', sender: 'U1', kind: 'text', text: 'hi' })
    const before = (await s.transcriptSince('C1', 'T', null, 'bot-a'))[0] as { eventTimeUs?: number }
    expect(before.eventTimeUs).toBe(4_821_000_000)
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '4821',
      sender: 'U1',
      kind: 'text',
      text: 'hi',
      eventTimeUs: 1_754_123_458_000_000
    })
    const after = (await s.transcriptSince('C1', 'T', null, 'bot-a'))[0] as { eventTimeUs?: number }
    expect(after.eventTimeUs).toBe(1_754_123_458_000_000)
  })

  it('a later append with the fetched image upgrades the observer-written row', async () => {
    // The observer records a platform message before the bytes are downloaded, so the
    // authoritative append is INSERT-OR-IGNOREd — without an in-place upgrade the row's
    // attachmentsJson stays NULL and the console shows only the `[attached: …]` label.
    const s = await store()
    const text = 'look\n[attached: shot.png (image/png)]'
    await s.appendTranscript({ channel: 'C1', thread: 'T', ts: '99', sender: 'U1', kind: 'text', text })
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T',
      ts: '99',
      sender: 'U1',
      kind: 'text',
      text,
      attachments: [{ name: 'shot.png', mimeType: 'image/png', data: 'aW1n' }]
    })
    const row = (await s.transcriptSince('C1', 'T', null, 'bot-a'))[0] as { attachmentsJson?: string | null }
    expect(JSON.parse(row.attachmentsJson ?? 'null')).toEqual([
      { name: 'shot.png', mimeType: 'image/png', data: 'aW1n' }
    ])
    await s.close()
  })

  it('finds a stored image by name, newest first, and only inside its own thread', async () => {
    // Backs forwarding a received file: the copy kept for console replay is what gets sent on,
    // so it has to be addressable by the name the agent read in its `[attached: …]` marker.
    const s = await store()
    const append = (thread: string, ts: string, data: string) =>
      s.appendTranscript({
        channel: 'C1',
        thread,
        ts,
        sender: 'U1',
        kind: 'text',
        text: '[attached: shot.png (image/png)]',
        attachments: [{ name: 'shot.png', mimeType: 'image/png', data }]
      })
    await append('T', '1', 'b2xk')
    await append('T', '2', 'bmV3')
    await append('T_OTHER', '3', 'ZWxzZQ==')

    // The same name can recur in a long conversation; the latest one is what "that image" means.
    expect((await s.transcriptAttachmentByName('C1', 'T', undefined, 'shot.png'))?.data).toBe('bmV3')
    // A neighbouring thread's image is not addressable from here — an agent forwards only
    // what its own conversation received.
    expect(await s.transcriptAttachmentByName('C1', 'T_MISSING', undefined, 'shot.png')).toBeUndefined()
    expect(await s.transcriptAttachmentByName('C1', 'T', undefined, 'other.png')).toBeUndefined()
    await s.close()
  })
})

describe('LocalStore recovery scope on a shared store (daemon pool)', () => {
  // One store, many members. A member's own id is its PROCESS incarnation, so a starting
  // member owns nothing yet — which is exactly why boot must recover nothing here.
  const tuple = {
    conversationId: 'conv-1',
    agentId: 'agent-1',
    authorityId: 'auth-1',
    authorityGeneration: 3
  }
  const openDream = (dreamId: string, agentId = 'agent-1') => ({
    dreamId,
    agentId,
    status: 'running' as const,
    trigger: 'manual' as const,
    sessionIds: [],
    snapshotDigest: 'sha256:x',
    createdAt: '2026-01-01T00:00:00.000Z'
  })

  const sharedPath = (): string => join(mkdtempSync(join(tmpdir(), 'ac-pool-')), 'shared.sqlite')
  const member = async (path: string, ownerId: string): Promise<LocalStore> =>
    await openTestStore({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId,
      orgForAgent: oneOrg
    })

  it("a starting member leaves a peer's live grant and running dream untouched", async () => {
    const path = sharedPath()
    const a = await member(path, 'member-a')
    await a.recordWebchatMcpGrant({ ...tuple, now: 10 })
    await a.insertDream(openDream('drm-a'))

    // A rolling update starts a new Pod: a new owner, while A keeps serving.
    const b = await member(path, 'member-b')
    expect(await b.markOwnedWebchatMcpGrantsRevoking('session_closed', 50)).toBe(0)
    expect(await b.openDreams()).toEqual([])
    expect(await b.listDueWebchatMcpRevocations(10_000)).toEqual([])
    expect(await a.listDueWebchatMcpRevocations(10_000)).toEqual([])
    expect((await a.getDream('agent-1', 'drm-a'))?.status).toBe('running')
    await a.close()
    await b.close()
  })

  it("reclaims a former owner's rows only for the agents this member was handed", async () => {
    const path = sharedPath()
    const a = await member(path, 'member-a')
    await a.recordWebchatMcpGrant({ ...tuple, now: 10 })
    await a.insertDream(openDream('drm-a'))
    const b = await member(path, 'member-b')

    expect(await b.reclaimWebchatMcpGrants(['other-agent'], 'session_closed', 60)).toBe(0)
    expect(await b.strandedDreams(['other-agent'])).toEqual([])

    expect(await b.reclaimWebchatMcpGrants(['agent-1'], 'session_closed', 60)).toBe(1)
    expect((await b.listDueWebchatMcpRevocations(60))[0]).toMatchObject({
      conversationId: 'conv-1',
      state: 'revoking',
      ownerId: 'member-b'
    })
    // The queue moved with the duty: its former owner no longer drains it.
    expect(await a.listDueWebchatMcpRevocations(10_000)).toEqual([])

    const stranded = await b.strandedDreams(['agent-1'])
    expect((await stranded).map((dream) => dream.dreamId)).toEqual(['drm-a'])
    const failed = { ...stranded[0]!, status: 'failed' as const, endedAt: '2026-01-01T00:01:00.000Z' }
    expect(await b.failOpenDream(failed)).toBe(true)
    // Idempotent: the row is terminal now, so a replayed recovery writes nothing.
    expect(await b.failOpenDream(failed)).toBe(false)
    expect(await b.strandedDreams(['agent-1'])).toEqual([])
    await a.close()
    await b.close()
  })

  it("the recovery CAS keeps the outcome the dream's own runner recorded", async () => {
    const path = sharedPath()
    const a = await member(path, 'member-a')
    await a.insertDream(openDream('drm-a'))
    const b = await member(path, 'member-b')
    const stranded = (await b.strandedDreams(['agent-1']))[0]!

    // A finishes between B's read and B's write — the completion must survive.
    await a.updateDream({ ...openDream('drm-a'), status: 'completed', endedAt: '2026-01-01T00:00:30.000Z' })
    expect(await b.failOpenDream({ ...stranded, status: 'failed', endedAt: '2026-01-01T00:01:00.000Z' })).toBe(false)
    expect((await a.getDream('agent-1', 'drm-a'))?.status).toBe('completed')
    await a.close()
    await b.close()
  })

  it('an exclusively owned store still recovers everything it left behind at boot', async () => {
    const s = await store()
    await s.recordWebchatMcpGrant({ ...tuple, now: 10 })
    await s.insertDream(openDream('drm-a'))
    expect(await s.markOwnedWebchatMcpGrantsRevoking('session_closed', 50)).toBe(1)
    expect((await s.openDreams()).map((dream) => dream.dreamId)).toEqual(['drm-a'])
    // There is no duty axis on a single-daemon store — boot already covered it.
    expect(await s.strandedDreams(['agent-1'])).toEqual([])
    expect(await s.reclaimWebchatMcpGrants(['agent-1'], 'session_closed', 60)).toBe(0)
    await s.close()
  })

  // Purge receipts (#1032): one session_purges table for the whole pool, leased per
  // member exactly like the hook-completion outbox — a peer's live row is never
  // offered, claimed, or released by anyone but its owner.
  const LEASE_MS = 2 * 60 * 1_000
  const purged = async (s: LocalStore, key: string, agentId: string, ownerId: string, at: number): Promise<string> => {
    await s.upsertSession({
      key,
      agentId,
      platform: 'slack',
      channel: 'C1',
      thread: key,
      acpSessionId: `acp-${key}`,
      state: 'closed',
      lastDeliveredTs: null,
      updatedAt: 0
    })
    const outward = (await s.getSession(key))!.sessionId!
    expect(await s.deleteSession(key, { reason: 'retention', at, ownerId })).toBe(true)
    return outward
  }
  const ids = (rows: { sessionId: string }[]) => rows.map((row) => row.sessionId)

  it("offers a pool member its own purge receipts, never a live peer's", async () => {
    const path = sharedPath()
    const a = await member(path, 'store-a')
    const b = await member(path, 'store-b')
    const fromA = await purged(a, 'from-a', 'agent-a', 'daemon-a', 1_000)
    const fromB = await purged(b, 'from-b', 'agent-b', 'daemon-b', 1_000)

    expect(ids(await a.listSessionPurges(10, 1500, 'daemon-a', ['agent-a']))).toEqual([fromA])
    // B serves both agents and still may not touch A's row: A's claim is live.
    expect(ids(await b.listSessionPurges(10, 1500, 'daemon-b', ['agent-a', 'agent-b']))).toEqual([fromB])
    expect(await b.claimSessionPurges('agent-a', [fromA], 'daemon-b', 1_500)).toEqual([])
    // Nor release it: the ACK fence is the claim holder.
    await b.acknowledgeSessionPurges('agent-a', [fromA], 'daemon-b')
    expect(ids(await a.listSessionPurges(10, 1500, 'daemon-a', []))).toEqual([fromA])
    // The owner renews and settles its own row.
    expect(await a.claimSessionPurges('agent-a', [fromA], 'daemon-a', 1_500)).toEqual([fromA])
    await a.acknowledgeSessionPurges('agent-a', [fromA], 'daemon-a')
    expect(await a.listSessionPurges(10, 1_500, 'daemon-a', [])).toEqual([])
    await a.close()
    await b.close()
  })

  it('lets the member that serves the agent take over a purge receipt after the owner claim lapses', async () => {
    const path = sharedPath()
    const a = await member(path, 'store-a')
    const b = await member(path, 'store-b')
    const fromA = await purged(a, 'from-a', 'agent-a', 'daemon-a', 1_000)
    const lapsed = 1_000 + LEASE_MS + 1

    // Still not B's to take while B does not serve the agent.
    expect(await b.listSessionPurges(10, lapsed, 'daemon-b', ['agent-b'])).toEqual([])
    expect(ids(await b.listSessionPurges(10, lapsed, 'daemon-b', ['agent-a']))).toEqual([fromA])
    expect(await b.claimSessionPurges('agent-a', [fromA], 'daemon-b', lapsed)).toEqual([fromA])
    // The takeover is exclusive: the dead owner's id no longer holds the row.
    expect(await a.listSessionPurges(10, lapsed, 'daemon-a', [])).toEqual([])
    expect(await a.claimSessionPurges('agent-a', [fromA], 'daemon-a', lapsed)).toEqual([])
    await a.close()
    await b.close()
  })

  it('a single-daemon store drains and settles every receipt unfenced', async () => {
    const s = await store()
    await s.upsertSession({
      key: 'k',
      agentId: 'agent-1',
      platform: 'slack',
      channel: 'C1',
      thread: 'k',
      acpSessionId: 'acp-k',
      state: 'closed',
      lastDeliveredTs: null,
      updatedAt: 0
    })
    const outward = (await s.getSession('k'))!.sessionId!
    await s.deleteSession('k', { reason: 'retention', at: 1_000 })
    expect(ids(await s.listSessionPurges(10, 1500, 'daemon-a', []))).toEqual([outward])
    expect(await s.claimSessionPurges('agent-1', [outward], undefined, 1_500)).toEqual([outward])
    await s.acknowledgeSessionPurges('agent-1', [outward])
    expect(await s.listSessionPurges(10, 1_500)).toEqual([])
    await s.close()
  })
})

describe('LocalStore activation rendezvous (send-message-routing-rework.md §3.2/§8.6)', () => {
  const KEY = ['slack', 'scope-1', '1720000000.000100', 'agent-target'].join('\u001f')
  const ENVELOPE = JSON.stringify({ callFrom: 'agent-author', hopCount: 3 })

  it('admits an internal-wake-first pairing exactly once and replays the same child', async () => {
    const s = await store()
    const first = await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect(first.dispatch).toBe(true)
    expect(await s.admitActivation(KEY, 'child-1')).toBe(true)

    // A retry of the same delivery — a redelivered wake, or replay after restart — must
    // read back the SAME child rather than opening a second session.
    const retry = await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect(retry.dispatch).toBe(false)
    expect(retry.record.state).toBe('admitted')
    expect(retry.record.childSessionId).toBe('child-1')
    await s.close()
  })

  it('holds a platform-first observation pending until the envelope arrives', async () => {
    const s = await store()
    const claimed = await s.claimActivationObservation(
      KEY,
      { agentCallDeliveryId: 'd-1', platformMessageId: '1720000000.000100', transcriptCoordinates: 'C1 T1' },
      1000
    )
    expect(claimed.state).toBe('pending')
    expect(claimed.callEnvelope).toBeFalsy()
    // The precondition the design states outright: a platform-first record cannot become
    // `admitted` until `callEnvelope` is present — the visible post carries none of the
    // lineage, so admitting on it would fabricate the call it is supposed to accompany.
    expect(await s.admitActivation(KEY, 'child-1')).toBe(false)

    const attached = await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect(attached.dispatch).toBe(true)
    expect(await s.admitActivation(KEY, 'child-1')).toBe(true)
    expect((await s.getActivation(KEY))?.state).toBe('admitted')
    // The visible observation survives the transition, so the later half reconciles onto
    // the same transcript row instead of duplicating the hand-off.
    expect((await s.getActivation(KEY))?.platformMessageId).toBe('1720000000.000100')
    await s.close()
  })

  it('is idempotent for a redelivered platform event', async () => {
    const s = await store()
    const obs = { agentCallDeliveryId: 'd-1', platformMessageId: 'ts-1', transcriptCoordinates: 'C1 T1' }
    await s.claimActivationObservation(KEY, obs, 1000)
    await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    await s.admitActivation(KEY, 'child-1')
    // Slack redelivers; the observation must not reset an admitted record.
    await s.claimActivationObservation(KEY, obs, 1000)
    expect((await s.getActivation(KEY))?.state).toBe('admitted')
    expect((await s.getActivation(KEY))?.childSessionId).toBe('child-1')
    await s.close()
  })

  it('expires an envelope-less pairing to transcript-only, and never revives it', async () => {
    const s = await store()
    await s.claimActivationObservation(
      KEY,
      { agentCallDeliveryId: 'd-1', platformMessageId: 'ts-1', transcriptCoordinates: 'C1 T1' },
      1000
    )
    expect((await s.expireActivations(999)).transcriptOnly).toEqual([])
    const expired = await s.expireActivations(1000)
    expect(expired.transcriptOnly.map((r) => r.agentCallDeliveryId)).toEqual(['d-1'])
    expect((await s.getActivation(KEY))?.state).toBe('transcript-only')

    // A very late wake must not resurrect a delivery already reported failed — otherwise
    // the operator sees a failure AND the target runs a turn for it anyway.
    const late = await s.attachActivationEnvelope(KEY, ENVELOPE, 5000)
    expect(late.dispatch).toBe(false)
    expect((await s.getActivation(KEY))?.state).toBe('transcript-only')
    await s.close()
  })

  it('never expires a record that already has its envelope', async () => {
    const s = await store()
    await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)
    expect((await s.expireActivations(999)).transcriptOnly).toEqual([])
    expect((await s.getActivation(KEY))?.state).toBe('pending')
    await s.close()
  })

  it('releases — not reports — a claim left pending WITH an envelope past its TTL', async () => {
    // The crash case. In-process, a dispatch that never admits is repaired by the
    // admission callback; a hard crash in that window leaves the row with nobody to run
    // it. Left alone the key is claimed forever and every retry after restart is
    // deduplicated against a child that does not exist — exactly-once becoming never.
    const s = await store()
    expect((await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)).dispatch).toBe(true)
    const sweep = await s.expireActivations(1000)
    // Not a delivery FAILURE report: unlike the envelope-less case, nothing here says the
    // delivery was observed and lost — only that this attempt did not finish.
    expect(sweep.transcriptOnly).toEqual([])
    expect(sweep.released).toBe(1)
    expect(await s.getActivation(KEY)).toBeUndefined()
    // …and the key is claimable again, which is the whole point.
    expect((await s.attachActivationEnvelope(KEY, ENVELOPE, 5000)).dispatch).toBe(true)
    await s.close()
  })

  it('grants the dispatch claim once, even before admission settles', async () => {
    // Admission settles asynchronously, so "not yet admitted" is NOT "nobody is handling
    // it". A second arrival inside that window must not also be told to dispatch, or one
    // logical delivery wakes the target twice.
    const s = await store()
    expect((await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)).dispatch).toBe(true)
    expect((await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)).dispatch).toBe(false)
    expect((await s.getActivation(KEY))?.state).toBe('pending')
    await s.close()
  })

  it('releases a claim whose dispatch never admitted, so a retry is a first attempt', async () => {
    // The other half of exactly-once: a rejected turn, a persistence failure, or a crash
    // between claim and admission would otherwise leave a claimed key with no child, and
    // every retry would be deduplicated against it — exactly-once becoming never.
    const s = await store()
    expect((await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)).dispatch).toBe(true)
    expect(await s.releaseActivation(KEY)).toBe(true)
    expect(await s.getActivation(KEY)).toBeUndefined()
    expect((await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)).dispatch).toBe(true)

    // …but releasing never reopens a settled decision: an admitted record has a real
    // child, and a transcript-only one was already reported as a delivery failure.
    await s.admitActivation(KEY, 'child-1')
    expect(await s.releaseActivation(KEY)).toBe(false)
    expect(await s.getActivation(KEY)).toMatchObject({ state: 'admitted', childSessionId: 'child-1' })
    await s.close()
  })

  it('reconciles a crashed claim against the durable inbox instead of guessing', async () => {
    // A crash between claim and admission leaves two rows that look identical and need
    // OPPOSITE answers. Releasing both would let a replayed turn be dispatched a second
    // time; admitting both would strand a delivery that never persisted. The inbox row is
    // the only evidence that distinguishes them.
    const s = await store()
    const durable = ['slack', 'scope-1', 'ts-durable', 'agent-target'].join('\u001f')
    const lost = ['slack', 'scope-1', 'ts-lost', 'agent-target'].join('\u001f')
    expect((await s.attachActivationEnvelope(durable, ENVELOPE, 1000, 'delivery-durable')).dispatch).toBe(true)
    expect((await s.attachActivationEnvelope(lost, ENVELOPE, 1000, 'delivery-lost')).dispatch).toBe(true)
    // Only the first one's turn actually reached the durable queue before the crash.
    await s.appendInbox({
      id: 'delivery-durable',
      sessionKey: 'k',
      agentId: 'bot-b',
      msg: '{}',
      enqueuedAt: '0000000001'
    })

    const sweep = await s.expireActivations(1000)
    expect(sweep.transcriptOnly).toEqual([])
    // Durably queued ⇒ startup replay will run it, so the claim COMPLETES. A later retry
    // must be deduplicated against it, not allowed to deliver again.
    expect((await s.getActivation(durable))?.state).toBe('admitted')
    expect((await s.attachActivationEnvelope(durable, ENVELOPE, 5000)).dispatch).toBe(false)
    // Never persisted ⇒ nothing will replay, so the key must become claimable again.
    expect(sweep.released).toBe(1)
    expect(await s.getActivation(lost)).toBeUndefined()
    expect((await s.attachActivationEnvelope(lost, ENVELOPE, 5000, 'delivery-lost-retry')).dispatch).toBe(true)
    await s.close()
  })

  it('releases a legacy claim that carries no dispatch id', async () => {
    // Rows written before `dispatchId` existed cannot be reconciled. Releasing is the same
    // answer as "never persisted" — the safe direction, since the alternative strands the
    // key forever.
    const s = await store()
    expect((await s.attachActivationEnvelope(KEY, ENVELOPE, 1000)).dispatch).toBe(true)
    expect((await s.expireActivations(1000)).released).toBe(1)
    expect(await s.getActivation(KEY)).toBeUndefined()
    await s.close()
  })

  it('keys separate targets of one visible post independently', async () => {
    // §3.2: one channel-root post can address several agents; each must be admitted once,
    // and one target's admission must not consume another's.
    const s = await store()
    const a = ['slack', 'scope-1', 'ts-1', 'agent-a'].join('\u001f')
    const b = ['slack', 'scope-1', 'ts-1', 'agent-b'].join('\u001f')
    expect((await s.attachActivationEnvelope(a, ENVELOPE, 1000)).dispatch).toBe(true)
    expect((await s.attachActivationEnvelope(b, ENVELOPE, 1000)).dispatch).toBe(true)
    await s.admitActivation(a, 'child-a')
    expect((await s.getActivation(b))?.state).toBe('pending')
    await s.close()
  })
})

describe('sandbox generations', () => {
  it('never hands the same number out twice for an agent, and starts each agent at 1', async () => {
    const s = await store()
    expect(await s.nextSandboxGeneration('agent-a')).toBe(1)
    expect(await s.nextSandboxGeneration('agent-a')).toBe(2)
    expect(await s.nextSandboxGeneration('agent-b')).toBe(1)
    expect(await s.nextSandboxGeneration('agent-a')).toBe(3)
    await s.close()
  })

  it('survives a reopen, because the sandbox pod the number fences does', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-generations-')), 'local.sqlite')
    const first = await reopen(path)
    expect(await first.nextSandboxGeneration('agent-a')).toBe(1)
    await first.close()
    const reopened = await reopen(path)
    expect(await reopened.nextSandboxGeneration('agent-a')).toBe(2)
    await reopened.close()
  })
})

describe('transcript org fence on a shared store', () => {
  const orgs: Record<string, string> = { 'agent-a': 'org-a', 'agent-b': 'org-b' }
  const twoOrgMembers = async (): Promise<[LocalStore, LocalStore]> => {
    const database = memoryStoreDatabase()
    const orgForAgent = (agentId: string): string | undefined => orgs[agentId]
    return [
      await LocalStore.open({ database, shared: true, ownerId: 'member-1', orgForAgent }),
      await LocalStore.open({ database, shared: true, ownerId: 'member-2', orgForAgent })
    ]
  }

  it('keeps two orgs holding the SAME channel/thread key independent', async () => {
    // Platform ids are unique only inside one org, so a pool store keyed on (channel, thread)
    // alone let one org's dedup swallow another org's message, and served one org's rows to
    // the other org's console.
    const [a, b] = await twoOrgMembers()
    const row = { channel: 'C1', thread: 'T1', ts: '1', sender: 'U', kind: 'text' as const }
    await a.appendTranscript({ ...row, recipient: 'agent-a', text: 'org A' })
    await b.appendTranscript({ ...row, recipient: 'agent-b', text: 'org B' })

    expect((await a.threadTranscript('C1', 'T1', 'agent-a')).map((r) => r.text)).toEqual(['org A'])
    expect((await b.threadTranscript('C1', 'T1', 'agent-b')).map((r) => r.text)).toEqual(['org B'])
    expect((await a.transcriptPageForAgent('C1', 'T1', 'agent-a', null, 10)).rows.map((r) => r.text)).toEqual(['org A'])
    expect((await b.transcriptPageForAgent('C1', 'T1', 'agent-b', null, 10)).rows.map((r) => r.text)).toEqual(['org B'])
    expect((await a.transcriptSince('C1', 'T1', null, 'agent-a')).map((e) => e.text)).toEqual(['org A'])
    expect(await a.firstMessageText('C1', 'T1', 'agent-a')).toBe('org A')
    expect(await b.firstMessageText('C1', 'T1', 'agent-b')).toBe('org B')
    await a.close()
  })

  it('keeps a tool call, its body and the thread revision inside one org', async () => {
    const [a, b] = await twoOrgMembers()
    const call = { channel: 'C1', thread: 'T1', ts: '2', toolCallId: 'call-1', title: 'Bash' }
    await a.insertToolCall({ ...call, sender: 'agent-a', body: '{"rawInput":"A"}' })
    await b.insertToolCall({ ...call, sender: 'agent-b', body: '{"rawInput":"B"}' })
    expect(await a.getToolBodyForAgent('C1', 'T1', 'agent-a', 'call-1')).toBe('{"rawInput":"A"}')
    expect(await b.getToolBodyForAgent('C1', 'T1', 'agent-b', 'call-1')).toBe('{"rawInput":"B"}')

    // A peer org's update can never reach this row: the fence is in the WHERE clause.
    await b.updateToolCall('C1', 'T1', 'agent-b', 'call-1', { title: 'Bash', body: '{"rawInput":"B2"}' })
    expect(await a.getToolBodyForAgent('C1', 'T1', 'agent-a', 'call-1')).toBe('{"rawInput":"A"}')

    // One org's write never moves the other org's context fence for the same thread key.
    const peerRevision = await b.threadTranscriptRevision('C1', 'T1', 'agent-b')
    await a.appendTranscript({ channel: 'C1', thread: 'T1', ts: '3', sender: 'agent-a', kind: 'text', text: 'A reply' })
    expect(await b.threadTranscriptRevision('C1', 'T1', 'agent-b')).toBe(peerRevision)
    expect(await a.currentTranscriptRevision('agent-a')).toBe(await a.threadTranscriptRevision('C1', 'T1', 'agent-a'))
    await a.close()
  })

  it('refuses a row it cannot attribute rather than filing it where anyone may read it', async () => {
    const [a] = await twoOrgMembers()
    await expect(
      a.appendTranscript({
        channel: 'C1',
        thread: 'T9',
        ts: '1',
        sender: 'U',
        kind: 'text',
        text: 'nobody owns this'
      })
    ).rejects.toThrow(/transcript organization/)
    // A session in the thread is enough: an observed inbound is recorded before routing
    // names a recipient, and the thread's owner is what attributes it.
    await a.upsertSession({
      key: sessionKey('slack', 'C1', 'T9', 'agent-a'),
      agentId: 'agent-a',
      platform: 'slack',
      channel: 'C1',
      thread: 'T9',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await a.appendTranscript({ channel: 'C1', thread: 'T9', ts: '1', sender: 'U', kind: 'text', text: 'observed' })
    expect((await a.threadTranscript('C1', 'T9', 'agent-a')).map((r) => r.text)).toEqual(['observed'])
    await a.close()
  })
})

describe('code-host note projection ledger (gitlab-com-integration.md §16)', () => {
  const DAEMON = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd1'
  const ledgerRow = (overrides: Partial<NoteProjectionRow> = {}): NoteProjectionRow => ({
    projectionKey: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    projectionId: 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1',
    hookId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
    agentId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
    orgId: 'org-1',
    provider: 'gitlab',
    projectId: '4455667',
    mergeRequestIid: 42,
    headSha: 'a'.repeat(40),
    generation: '1',
    writeMarker: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1',
    state: 'queued',
    body: 'AgentConnect run — Queued',
    noteId: '9001',
    credentialEpoch: '2',
    daemonId: DAEMON,
    phase: 'in_flight',
    ...overrides
  })

  // The projector's key fence compares its stored row against the incoming desired frame with ===,
  // so a field that does not survive the read refuses every update after the create.
  it('reads every field back with the value and type it was written with', async () => {
    const s = await store()
    const row = ledgerRow()
    await s.beginNoteProjectionWrite(row, 1000)
    const stored = await s.getNoteProjection(DAEMON, row.projectionKey)
    expect(stored).toEqual(row)
    expect(typeof stored!.mergeRequestIid).toBe('number')
    for (const field of ['hookId', 'projectId', 'mergeRequestIid', 'headSha'] as const) {
      expect(stored![field]).toBe(row[field])
    }
    await s.close()
  })

  it('replays an unsettled write with the same fields the sweep compares', async () => {
    const s = await store()
    const row = ledgerRow()
    await s.recordNoteProjectionOutcome(row, 'written', undefined, 1000)
    expect(await s.listUnsettledNoteProjections(DAEMON)).toEqual([
      { ...row, phase: 'settled_unreported', outcome: 'written' }
    ])
    await s.close()
  })
})

describe.skipIf(pg)('transcript org migration from a v10 store', () => {
  const v10Store = async (prefix: string): Promise<string> => {
    const path = join(mkdtempSync(join(tmpdir(), prefix)), 'local.sqlite')
    await (await LocalStore.open(path)).close()
    const old = new DatabaseSync(path)
    dropTranscriptOrg(old)
    old.exec(`INSERT INTO transcript (channel, thread, ts, sender, kind, text, recipient, eventTimeUs, revision)
      VALUES ('C1', 'T1', '1', 'U', 'text', 'kept', 'agent-a', 1000000, 1)`)
    old.exec("INSERT INTO transcript_recipient (channel, thread, ts, agentId) VALUES ('C1', 'T1', '1', 'agent-b')")
    old.exec('ALTER TABLE sessions DROP COLUMN sessionId')
    old.exec('ALTER TABLE sessions DROP COLUMN directDestination')
    old.exec('PRAGMA user_version = 10')
    old.close()
    return path
  }

  it('backfills a store no pool shares with its single partition, keeping every row', async () => {
    const path = await v10Store('ac-transcript-v10-')
    const upgraded = await LocalStore.open(path)
    expect((await upgraded.threadTranscript('C1', 'T1')).map((r) => r.text)).toEqual(['kept'])
    // The delivery table came across too, so the co-hosted recipient still sees the row.
    expect((await upgraded.transcriptPageForAgent('C1', 'T1', 'agent-b', null, 10)).rows.map((r) => r.text)).toEqual([
      'kept'
    ])
    await upgraded.close()

    const after = new DatabaseSync(path)
    const recipientKey = (
      after.prepare('PRAGMA table_info(transcript_recipient)').all() as { name: string; pk: number }[]
    )
      .filter((column) => column.pk > 0)
      .sort((first, second) => first.pk - second.pk)
      .map((column) => column.name)
    expect(recipientKey).toEqual(['orgId', 'channel', 'thread', 'ts', 'agentId'])
    after.close()
  })

  it('drops what a shared store cannot attribute, because no org survives in its rows', async () => {
    // Nothing here records an agent's org — the daemon learns it from the CP at runtime — so
    // sessions → agent → org resolves to nothing and a kept row would be readable by whichever
    // org reused the channel/thread ids.
    const path = await v10Store('ac-transcript-v10-shared-')
    const shared = await LocalStore.open({
      database: SqliteAsyncDatabase.adopt(new DatabaseSync(path)),
      shared: true,
      ownerId: 'member-1',
      orgForAgent: () => 'org-a'
    })
    expect(await shared.threadTranscript('C1', 'T1', 'agent-a')).toEqual([])
    expect((await shared.transcriptPageForAgent('C1', 'T1', 'agent-b', null, 10)).rows).toEqual([])
    await shared.close()
  })
})
