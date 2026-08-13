import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { PostgresDataPlane } from '../src/store/postgres-transcript-store.js'
import { quotePgIdentifier } from '../src/store/postgres-migrations.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL
const schemas: string[] = []

afterAll(async () => {
  if (!databaseUrl || schemas.length === 0) return
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    for (const schema of schemas) await pool.query(`DROP SCHEMA ${quotePgIdentifier(schema)} CASCADE`)
  } finally {
    await pool.end()
  }
})

describe.skipIf(!databaseUrl)('PostgreSQL transcript store', () => {
  it('shares one org schema safely across daemon pools and upgrades it once', async () => {
    const schema = `org_test_${randomUUID().replaceAll('-', '')}`
    schemas.push(schema)
    const config = { version: 1 as const, databaseUrl: databaseUrl!, schema, maxConnections: 2 }
    const [first, second] = await Promise.all([PostgresDataPlane.open(config), PostgresDataPlane.open(config)])
    try {
      first.transcripts.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: '1.000001',
        sender: 'U1',
        recipient: 'agent-a',
        kind: 'text',
        text: 'shared durable row'
      })
      second.transcripts.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: '1.000001',
        sender: 'U1',
        recipient: 'agent-b',
        kind: 'text',
        text: 'shared durable row'
      })
      await Promise.all([first.transcripts.flush(), second.transcripts.flush()])
      const [forA, forB] = await Promise.all([
        first.transcripts.transcriptPageForAgent('C1', 'T1', 'agent-a', null, 10),
        second.transcripts.transcriptPageForAgent('C1', 'T1', 'agent-b', null, 10)
      ])
      expect(forA.rows.map((row) => row.text)).toEqual(['shared durable row'])
      expect(forB.rows.map((row) => row.text)).toEqual(['shared durable row'])
      expect(forA.cursor).toBe(forA.rows[0]!.revision)
      expect(await first.transcripts.currentTranscriptRevision()).toBeGreaterThan(0)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })

  it('serializes revision assignment through commit across daemon pools', async () => {
    const schema = `org_test_${randomUUID().replaceAll('-', '')}`
    schemas.push(schema)
    const config = { version: 1 as const, databaseUrl: databaseUrl!, schema, maxConnections: 2 }
    const [first, second] = await Promise.all([PostgresDataPlane.open(config), PostgresDataPlane.open(config)])
    const setup = new Pool({ connectionString: databaseUrl })
    try {
      await setup.query(`SET search_path TO ${quotePgIdentifier(schema)}, pg_catalog`)
      await setup.query(`
        CREATE FUNCTION delay_slow_transcript() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.sender = 'slow-writer' THEN PERFORM pg_sleep(0.4); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER delay_slow_transcript BEFORE INSERT ON transcript
          FOR EACH ROW EXECUTE FUNCTION delay_slow_transcript();
      `)
      first.transcripts.appendTranscript({
        channel: 'C2',
        thread: 'T2',
        ts: '2.000001',
        sender: 'slow-writer',
        recipient: 'agent-a',
        kind: 'text',
        text: 'commits first'
      })
      await new Promise((resolve) => setTimeout(resolve, 50))
      second.transcripts.appendTranscript({
        channel: 'C2',
        thread: 'T2',
        ts: '2.000002',
        sender: 'fast-writer',
        recipient: 'agent-a',
        kind: 'text',
        text: 'commits second'
      })
      const firstCommit = await Promise.race([
        first.transcripts.flush().then(() => 'slow'),
        second.transcripts.flush().then(() => 'fast')
      ])
      expect(firstCommit).toBe('slow')
      await Promise.all([first.transcripts.flush(), second.transcripts.flush()])
      const tail = await first.transcripts.transcriptTailForAgent('C2', 'T2', 'agent-a', 0, 10)
      expect(tail.rows.map((row) => row.text)).toEqual(['commits first', 'commits second'])
      expect(tail.cursor).toBe(tail.rows.at(-1)!.revision)
    } finally {
      await setup.end()
      await Promise.all([first.close(), second.close()])
    }
  })
})
