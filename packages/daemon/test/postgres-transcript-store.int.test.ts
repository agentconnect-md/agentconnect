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
      expect(await first.transcripts.currentTranscriptRevision()).toBeGreaterThan(0)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })
})
