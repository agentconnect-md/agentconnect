import { randomUUID } from 'node:crypto'
import { Pool } from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { PostgresDataPlane } from '../src/store/postgres-transcript-store.js'
import { DATA_PLANE_SCHEMA } from '../src/store/postgres-migrations.js'

const databaseUrl = process.env.DATA_PLANE_TEST_DATABASE_URL
const orgIds = new Set<string>()

function testOrg(): string {
  const orgId = `org-test-${randomUUID()}`
  orgIds.add(orgId)
  return orgId
}

afterAll(async () => {
  if (!databaseUrl || orgIds.size === 0) return
  const pool = new Pool({ connectionString: databaseUrl })
  try {
    await pool.query(`SET search_path TO ${DATA_PLANE_SCHEMA}, pg_catalog`)
    await pool.query('DELETE FROM transcript_recipient WHERE org_id = ANY($1)', [[...orgIds]])
    await pool.query('DELETE FROM transcript WHERE org_id = ANY($1)', [[...orgIds]])
  } finally {
    await pool.end()
  }
})

describe.skipIf(!databaseUrl)('PostgreSQL transcript store', () => {
  it('shares one table set across daemon pools while isolating organizations', async () => {
    const orgA = testOrg()
    const orgB = testOrg()
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const orgForAgent = (agentId: string) =>
      agentId === 'agent-a1' || agentId === 'agent-a2' ? orgA : agentId === 'agent-b' ? orgB : undefined
    const [first, second] = await Promise.all([
      PostgresDataPlane.open(config, orgForAgent),
      PostgresDataPlane.open(config, orgForAgent)
    ])
    try {
      first.transcripts.appendTranscript({
        channel: 'same-channel',
        thread: 'same-thread',
        ts: '1.000001',
        sender: 'user-a',
        recipient: 'agent-a1',
        kind: 'text',
        text: 'org A row'
      })
      second.transcripts.appendTranscript({
        channel: 'same-channel',
        thread: 'same-thread',
        ts: '1.000001',
        sender: 'user-a',
        recipient: 'agent-a2',
        kind: 'text',
        text: 'org A row'
      })
      second.transcripts.appendTranscript({
        channel: 'same-channel',
        thread: 'same-thread',
        ts: '1.000001',
        sender: 'user-b',
        recipient: 'agent-b',
        kind: 'text',
        text: 'org B row'
      })
      await Promise.all([first.transcripts.flush(), second.transcripts.flush()])
      const [forA1, forA2, forB] = await Promise.all([
        first.transcripts.transcriptPageForAgent('same-channel', 'same-thread', 'agent-a1', null, 10),
        second.transcripts.transcriptPageForAgent('same-channel', 'same-thread', 'agent-a2', null, 10),
        first.transcripts.transcriptPageForAgent('same-channel', 'same-thread', 'agent-b', null, 10)
      ])
      expect(forA1.rows.map((row) => row.text)).toEqual(['org A row'])
      expect(forA2.rows.map((row) => row.text)).toEqual(['org A row'])
      expect(forB.rows.map((row) => row.text)).toEqual(['org B row'])
      expect(await first.transcripts.currentTranscriptRevision('agent-a1')).toBe(forA1.cursor)
      expect(await first.transcripts.currentTranscriptRevision('agent-b')).toBe(forB.cursor)
    } finally {
      await Promise.all([first.close(), second.close()])
    }
  })

  it('serializes revision assignment through commit across daemon pools', async () => {
    const orgId = testOrg()
    const suffix = randomUUID().replaceAll('-', '')
    const config = { version: 1 as const, databaseUrl: databaseUrl!, maxConnections: 2 }
    const orgForAgent = (agentId: string) => (agentId === 'agent-a' ? orgId : undefined)
    const [first, second] = await Promise.all([
      PostgresDataPlane.open(config, orgForAgent),
      PostgresDataPlane.open(config, orgForAgent)
    ])
    const setup = new Pool({ connectionString: databaseUrl })
    try {
      await setup.query(`SET search_path TO ${DATA_PLANE_SCHEMA}, pg_catalog`)
      await setup.query(`
        CREATE FUNCTION delay_slow_transcript_${suffix}() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.org_id = '${orgId}' AND NEW.sender = 'slow-writer' THEN PERFORM pg_sleep(0.4); END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER delay_slow_transcript_${suffix} BEFORE INSERT ON transcript
          FOR EACH ROW EXECUTE FUNCTION delay_slow_transcript_${suffix}();
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
      await setup.query(`DROP TRIGGER IF EXISTS delay_slow_transcript_${suffix} ON transcript`).catch(() => undefined)
      await setup.query(`DROP FUNCTION IF EXISTS delay_slow_transcript_${suffix}()`).catch(() => undefined)
      await setup.end()
      await Promise.all([first.close(), second.close()])
    }
  })
})
