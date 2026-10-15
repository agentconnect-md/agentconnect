// The session-message record (send-message-guide.md §9.3, §9.6): received and sent messages, obligations, purge, and the origin migration.
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import pg from 'pg'
import { describe, expect, it } from 'vitest'
import { LocalStore, SCHEMA_VERSION, sessionKey } from '../src/store/local-store.js'
import { PostgresAsyncDatabase } from '../src/store/postgres-async-database.js'
import type { ReceivedSessionMessage } from '../src/store/session-messages.js'
import { openTestStore, tempStorePath, usingPostgresStore } from './store-support.js'

const key = (agent: string, thread = '1.1') => sessionKey('webchat', `wc-${agent}`, thread, agent)

const message = (over: Partial<ReceivedSessionMessage> & { now?: number } = {}) => ({
  messageId: `msg-${Math.random()}`,
  recipientKey: key('agent-b'),
  recipientAgentId: 'agent-b',
  sourceSessionId: 'sid-a',
  sourceAgentId: 'agent-a',
  kind: 'call' as const,
  replyState: 'open' as const,
  hopCount: 1,
  now: 1000,
  ...over
})

async function session(store: LocalStore, agent: string, sessionId: string, thread = '1.1'): Promise<void> {
  await store.upsertSession({
    key: key(agent, thread),
    agentId: agent,
    platform: 'webchat',
    channel: `wc-${agent}`,
    thread,
    sessionId,
    acpSessionId: `acp-${sessionId}`,
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: Date.now()
  })
}

describe('the session-message record', () => {
  it('records a message once, names a conflict for another recipient, and settles its obligation once', async () => {
    const store = await openTestStore()
    try {
      const messages = store.sessionMessages
      const m = message({ messageId: 'msg-1' })
      expect(await messages.recordReceived(m)).toBe('recorded')
      expect(await messages.recordReceived(m)).toBe('duplicate')
      expect(await messages.recordReceived({ ...m, recipientKey: key('agent-c'), recipientAgentId: 'agent-c' })).toBe(
        'conflict'
      )
      expect(await messages.conflicts('msg-1', key('agent-c'), 'agent-c')).toBe(true)
      expect(await messages.conflicts('msg-1', key('agent-b'), 'agent-b')).toBe(false)
      expect(await messages.settle('msg-1', 'replied', 2000)).toBe(true)
      expect(await messages.settle('msg-1', 'replied', 3000)).toBe(false)
      expect(await messages.received('msg-1')).toMatchObject({ replyState: 'replied', recipientKey: key('agent-b') })
    } finally {
      await store.close()
    }
  })

  it('lists open obligations first, oldest first, then the rest newest first', async () => {
    const store = await openTestStore()
    try {
      const messages = store.sessionMessages
      await messages.recordReceived(message({ messageId: 'msg-old-done', replyState: 'none', now: 1 }))
      await messages.recordReceived(message({ messageId: 'msg-open-1', now: 2 }))
      await messages.recordReceived(message({ messageId: 'msg-new-done', replyState: 'none', now: 3 }))
      await messages.recordReceived(message({ messageId: 'msg-open-2', now: 4 }))
      const ids = (await messages.listFor(key('agent-b'), 10)).map((m) => m.messageId)
      expect(ids).toEqual(['msg-open-1', 'msg-open-2', 'msg-new-done', 'msg-old-done'])
      expect(await messages.countFor(key('agent-b'))).toBe(4)
      expect(await messages.settleOpenFor(key('agent-b'), 5)).toBe(2)
      expect((await messages.listFor(key('agent-b'), 10)).every((m) => m.replyState !== 'open')).toBe(true)
    } finally {
      await store.close()
    }
  })

  it('drops a session’s received, sent and sourced messages when it is purged, and an agent’s when it is removed', async () => {
    const store = await openTestStore()
    try {
      await session(store, 'agent-a', 'sid-a')
      await session(store, 'agent-b', 'sid-b')
      const messages = store.sessionMessages
      await messages.recordReceived(message({ messageId: 'msg-to-b' }))
      await messages.recordReceived(
        message({
          messageId: 'msg-to-a',
          recipientKey: key('agent-a'),
          recipientAgentId: 'agent-a',
          sourceSessionId: 'sid-b',
          sourceAgentId: 'agent-b'
        })
      )
      await messages.recordSent({
        messageId: 'msg-to-b',
        senderKey: key('agent-a'),
        senderAgentId: 'agent-a',
        senderSessionId: 'sid-a',
        recipientAgentId: 'agent-b',
        kind: 'call',
        now: 1
      })
      // Purging A drops what A received, what A sent, and what anyone received from A.
      expect(await store.deleteSession(key('agent-a'))).toBe(true)
      expect(await messages.received('msg-to-a')).toBeUndefined()
      expect(await messages.received('msg-to-b')).toBeUndefined()
      expect(await messages.sent('msg-to-b')).toBeUndefined()
      await messages.recordReceived(
        message({ messageId: 'msg-from-c', sourceAgentId: 'agent-c', sourceSessionId: 'sid-c' })
      )
      await messages.deleteForAgent('agent-c')
      expect(await messages.received('msg-from-c')).toBeUndefined()
    } finally {
      await store.close()
    }
  })
})

describe.skipIf(usingPostgresStore())('the v51 → v52 origin migration on SQLite (send-message-guide.md §9.6)', () => {
  it('gives every session with an origin one synthesized call, carrying an outstanding request, and drops the old tables', async () => {
    const path = tempStorePath('ac-session-messages-v51-')
    const fresh = await LocalStore.open(path)
    await session(fresh, 'agent-a', 'sid-a')
    await session(fresh, 'agent-b', 'sid-b1')
    await session(fresh, 'agent-b', 'sid-b2', '2.2')
    await session(fresh, 'agent-b', 'sid-b3', '3.3')
    await fresh.close()
    const old = new DatabaseSync(path)
    old.exec(`DROP TABLE session_message; DROP TABLE session_message_sent; PRAGMA user_version = 51`)
    // An earlier build's reply-source table, which alone knew a remote origin's agent and coordinates.
    old.exec(`CREATE TABLE session_reply_source (
      sessionKey TEXT NOT NULL, agentId TEXT NOT NULL, sourceSessionId TEXT NOT NULL, sourceAgentId TEXT NOT NULL,
      sourcePlatform TEXT, sourceChannel TEXT, sourceThread TEXT, codeHostReplyTarget TEXT,
      createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, PRIMARY KEY (sessionKey, sourceSessionId))`)
    old.exec('CREATE TABLE session_reply_obligation (sessionKey TEXT NOT NULL, deliveryId TEXT NOT NULL)')
    old
      .prepare(
        `INSERT INTO session_reply_source VALUES (?, 'agent-b', 'sid-remote', 'agent-remote', 'webchat', 'wc-remote', '9.9', NULL, 1, 1)`
      )
      .run(key('agent-b', '2.2'))
    // B1 was called by A's session and still owes it a reply; B2 by a remote session; B3 was started by a person.
    old.prepare(`UPDATE sessions SET originSessionId = 'sid-a', needsParentReply = 1 WHERE key = ?`).run(key('agent-b'))
    old.prepare(`UPDATE sessions SET originSessionId = 'sid-remote' WHERE key = ?`).run(key('agent-b', '2.2'))
    old.close()

    const upgraded = await LocalStore.open(path)
    try {
      const [b1] = await upgraded.sessionMessages.listFor(key('agent-b'), 10)
      expect(b1).toMatchObject({
        recipientKey: key('agent-b'),
        recipientAgentId: 'agent-b',
        sourceSessionId: 'sid-a',
        sourceAgentId: 'agent-a',
        kind: 'call',
        replyState: 'open',
        legacy: true
      })
      expect(b1!.messageId).toMatch(/^msg-/)
      expect((await upgraded.sessionMessages.listFor(key('agent-b', '2.2'), 10))[0]).toMatchObject({
        sourceSessionId: 'sid-remote',
        sourceAgentId: 'agent-remote',
        sourcePlatform: 'webchat',
        sourceChannel: 'wc-remote',
        sourceThread: '9.9',
        replyState: 'none',
        legacy: true
      })
      expect(await upgraded.sessionMessages.listFor(key('agent-b', '3.3'), 10)).toEqual([])
    } finally {
      await upgraded.close()
    }
    const db = new DatabaseSync(path)
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION)
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (t) => t.name
    )
    expect(tables).not.toContain('session_reply_source')
    expect(tables).not.toContain('session_reply_obligation')
    db.close()
  })
})

describe.skipIf(!usingPostgresStore())(
  'the v51 → v52 origin migration on PostgreSQL (send-message-guide.md §9.6)',
  () => {
    it('migrates a session whose origin is not local when no earlier reply-source table exists', async () => {
      const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL!
      const schema = `mig_${randomUUID().replace(/-/g, '')}`
      const config = { version: 1 as const, databaseUrl, maxConnections: 2 }
      const orgForAgent = (): string => 'org-a'
      const admin = new pg.Client({ connectionString: databaseUrl })
      await admin.connect()
      try {
        const fresh = await PostgresAsyncDatabase.open(config, () => undefined, schema)
        await fresh.finishSchemaInitialization()
        const first = await LocalStore.open({ database: fresh, shared: true, ownerId: 'm1', orgForAgent })
        await session(first, 'agent-b', 'sid-b1')
        await first.close()

        await admin.query(`SET search_path TO ${schema}`)
        await admin.query('DROP TABLE session_message; DROP TABLE session_message_sent')
        await admin.query(`UPDATE sessions SET originSessionId = 'gone-origin' WHERE key = $1`, [key('agent-b')])
        await admin.query('UPDATE _local_store_schema_version SET version = 51 WHERE singleton = true')

        const database = await PostgresAsyncDatabase.open(config, () => undefined, schema)
        await database.finishSchemaInitialization()
        const upgraded = await LocalStore.open({ database, shared: true, ownerId: 'm2', orgForAgent })
        try {
          expect((await upgraded.sessionMessages.listFor(key('agent-b'), 10))[0]).toMatchObject({
            sourceSessionId: 'gone-origin',
            sourceAgentId: '',
            kind: 'call',
            legacy: true
          })
        } finally {
          await upgraded.close()
        }
        const version = await admin.query('SELECT version FROM _local_store_schema_version')
        expect(Number(version.rows[0].version)).toBe(SCHEMA_VERSION)
      } finally {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => undefined)
        await admin.end()
      }
    })
  }
)
