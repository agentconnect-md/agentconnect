// The artifact producer backfill (artifacts.md §4, §7.2): revision 1's agent, else the earliest ready revision's.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { prisma } from '../setup.db.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20270212000000_artifact_producer/migration.sql', import.meta.url)
)

type Rev = [number, string, 'pending' | 'ready' | 'closed']

async function artifact(revisions: Rev[]): Promise<string> {
  const id = randomUUID()
  await prisma.artifact.create({ data: { id, orgId: DEFAULT_ORG_ID, title: 'Report', visibility: 'org' } })
  for (const [number, agentId, state] of revisions) {
    await prisma.artifactRevision.create({
      data: {
        id: randomUUID(),
        artifactId: id,
        number,
        manifest: {
          entry: 'index.html',
          files: [{ path: 'index.html', sha256: 'a'.repeat(64), bytes: 1, mediaType: 'text/html' }]
        },
        storageMode: 'signed',
        storagePrefix: `src/${DEFAULT_ORG_ID}/artifact/${id}/${number}`,
        producedByAgentId: agentId,
        producedByAgentName: 'Reporter',
        producedInSessionId: 'session-1',
        totalBytes: 1,
        fileCount: 1,
        state,
        idempotencyKey: `key-${randomUUID()}`
      }
    })
  }
  return id
}

describe('artifact producer backfill', () => {
  it('takes revision 1’s agent, else the earliest remaining ready revision’s, and leaves a row with neither null', async () => {
    const [a, b] = [randomUUID(), randomUUID()]
    const kept = await artifact([
      [1, a, 'ready'],
      [2, b, 'ready']
    ])
    const pending = await artifact([[1, a, 'pending']])
    const pruned = await artifact([
      [3, b, 'pending'],
      [4, a, 'ready'],
      [5, b, 'ready']
    ])
    const empty = await artifact([])

    const sql = await readFile(MIGRATION, 'utf8')
    // The column already exists in the migrated test database, so only the backfill runs again.
    await prisma.$executeRawUnsafe(sql.slice(sql.indexOf('UPDATE "artifact"')))

    const producer = async (id: string) =>
      (await prisma.artifact.findUniqueOrThrow({ where: { id } })).producedByAgentId
    expect(await producer(kept)).toBe(a)
    expect(await producer(pending)).toBe(a)
    expect(await producer(pruned)).toBe(a)
    expect(await producer(empty)).toBeNull()
  })
})
