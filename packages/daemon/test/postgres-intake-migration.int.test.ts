/**
 * message-intake.md §10 on the PostgreSQL dialect. The SQLite fixture in `local-store.test.ts`
 * covers the copy-rename branch; this is the only thing that proves the other one — the in-place
 * `ALTER COLUMN thread DROP NOT NULL` plus its index drops — and that the U+001F literal the
 * admission backfill splits the transcript channel on survives the rewrite.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import { LocalStore, transcriptChannelKey } from '../src/store/local-store.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL

/** Put the schema back into the shape a v23 daemon left it in. */
const V23_SHAPE = [
  'DROP INDEX IF EXISTS transcript_channel_seq',
  'DROP INDEX IF EXISTS transcript_text_ts',
  'DROP INDEX IF EXISTS transcript_channel_event_time',
  'DROP INDEX IF EXISTS transcript_channel_revision',
  'DROP INDEX IF EXISTS transcript_recipient_session',
  'DROP TABLE IF EXISTS transcript_recipient',
  `CREATE TABLE transcript_recipient (
     orgId TEXT NOT NULL DEFAULT '', channel TEXT NOT NULL, thread TEXT NOT NULL,
     ts TEXT NOT NULL, agentId TEXT NOT NULL,
     PRIMARY KEY (orgId, channel, thread, ts, agentId))`,
  'ALTER TABLE transcript ALTER COLUMN thread SET NOT NULL',
  'CREATE INDEX transcript_thread_seq ON transcript (orgId, channel, thread, seq)',
  "CREATE UNIQUE INDEX transcript_text_ts ON transcript (orgId, channel, thread, ts) WHERE kind = 'text'",
  'CREATE INDEX transcript_thread_event_time ON transcript (orgId, channel, thread, eventTimeUs DESC, seq DESC)',
  'CREATE INDEX transcript_thread_revision ON transcript (orgId, channel, thread, revision)'
]

describe.skipIf(!databaseUrl)('the v23 → v24 channel-record migration on PostgreSQL', () => {
  it('alters the record in place, backfills admissions, merges append duplicates and nulls their threads', async () => {
    const suffix = randomUUID().replace(/-/g, '')
    const schema = `mig_${suffix}`
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const scope = 'slack:bot-1'
    const channel = transcriptChannelKey('C1', scope)
    const org = `org-${suffix}`
    const orgForAgent = (): string => org

    // A fresh v24 store, then rolled back onto the v23 shape with a v23 fixture in it.
    const bootstrap = await PostgresAsyncDatabase.open(config, () => undefined, schema)
    await bootstrap.finishSchemaInitialization()
    const first = await LocalStore.open({ database: bootstrap, shared: true, ownerId: 'm1', orgForAgent })
    await first.close()

    const raw = await PostgresAsyncDatabase.open(config, () => undefined, schema)
    await raw.finishSchemaInitialization()
    try {
      for (const statement of V23_SHAPE) await raw.exec(statement)
      // The session the backfill joins on; its transport scope is what makes the U+001F
      // channel key the only thing that can match the row.
      await raw.exec(
        `INSERT INTO sessions (key, agentId, platform, channel, thread, transportScope, acpSessionId, state, updatedAt)
         VALUES ('slack:C1:append:7:bot-a', 'bot-a', 'slack', 'C1', 'append:7', '${scope}', 'acp-a', 'idle', 1)`
      )
      await raw.exec(
        `INSERT INTO sessions (key, agentId, platform, channel, thread, transportScope, acpSessionId, state, updatedAt)
         VALUES ('slack:C1:append:8:bot-b', 'bot-b', 'slack', 'C1', 'append:8', '${scope}', 'acp-b', 'idle', 1)`
      )
      // A rotated append session of bot-a: it holds the THIRD copy while bot-a also holds the
      // second, so the merge must not repoint both onto one (seq, agentId).
      await raw.exec(
        `INSERT INTO sessions (key, agentId, platform, channel, thread, transportScope, acpSessionId, state, updatedAt)
         VALUES ('slack:C1:append:9:bot-a', 'bot-a', 'slack', 'C1', 'append:9', '${scope}', 'acp-c', 'idle', 1)`
      )
      // Insertion order IS the merge order: the kept copy is bot-b's, neither of bot-a's.
      for (const [thread, recipient] of [
        ['append:8', 'bot-b'],
        ['append:7', 'bot-a'],
        ['append:9', 'bot-a']
      ])
        await raw.exec(
          `INSERT INTO transcript (orgId, channel, thread, ts, sender, kind, text, recipient, revision)
           VALUES ('${org}', '${channel}', '${thread}', '10', 'U1', 'text', 'dup', '${recipient}', 1)`
        )
      await raw.exec('UPDATE _local_store_schema_version SET version = 23 WHERE singleton = true')

      const upgraded = await LocalStore.open({ database: raw, shared: true, ownerId: 'm2', orgForAgent })
      // One row, both admissions, thread reported unknown.
      const rows = (await raw.query('SELECT seq, thread FROM transcript', [])).rows as {
        seq: number
        thread: string | null
      }[]
      expect(rows).toHaveLength(1)
      expect(rows[0]!.thread).toBeNull()
      const keys = (
        (await raw.query('SELECT sessionKey FROM transcript_recipient ORDER BY sessionKey', [])).rows as {
          sessionkey?: string
          sessionKey?: string
        }[]
      ).map((r) => r.sessionKey ?? r.sessionkey)
      expect(keys).toEqual(['slack:C1:append:7:bot-a', 'slack:C1:append:8:bot-b'])
      // Each append session reads the merged row through its own admission.
      for (const [coordinate, agentId, key] of [
        ['append:7', 'bot-a', 'slack:C1:append:7:bot-a'],
        ['append:8', 'bot-b', 'slack:C1:append:8:bot-b']
      ] as const) {
        const page = await upgraded.transcriptPageForAgent(
          { transcriptChannel: channel, coordinate, sessionKey: key, agentId, orgId: org },
          null,
          10
        )
        expect(page.rows.map((r) => r.text)).toEqual(['dup'])
      }
      await upgraded.close()
    } finally {
      await raw.exec(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
      await raw.close()
    }
  })
})
