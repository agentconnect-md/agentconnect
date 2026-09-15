/**
 * The `issues_labeled_any_update` backfill (webhook-triggers-and-github-events.md).
 *
 * The console retired the issues "labeled" cadence: a row that fired on
 * `issues:labeled` alone becomes the any-update form with its label filter
 * intact, and every other row is left as it was. This test inserts such rows
 * into the already-migrated test database and re-executes the migration file
 * verbatim, which is why that file must be idempotent.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'd8d8d8d8-dddd-4ddd-8ddd-dddddddddddd'
const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20261005000000_issues_labeled_any_update/migration.sql', import.meta.url)
)

let migrationSql: string
beforeAll(async () => {
  migrationSql = await readFile(MIGRATION, 'utf8')
})

/** One github family row at revision 3 with a label filter, as the console stored it. */
async function githubRow(
  agentId: string,
  over: { repoId: bigint; family: string; events: string[]; commentFamilies?: string[] }
): Promise<string> {
  const id = randomUUID()
  await prisma.hookDef.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      agentId,
      kind: 'github',
      name: 'gh',
      sessionMode: 'perThread',
      repoId: over.repoId,
      repoFullName: 'example-org/example-repo',
      githubSessionKey: 'example-org/example-repo',
      family: over.family,
      events: over.events,
      commentFamilies: over.commentFamilies ?? [],
      labelFilter: ['bug'],
      targetPlatform: 'slack',
      targetChannel: 'C-legacy',
      configRevision: 3n
    }
  })
  return id
}

describe('issues_labeled_any_update — the retired labeled cadence becomes any update', () => {
  it('rewrites only bare `issues:labeled` github rows, keeps their label filter, and is idempotent', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const labeled = await githubRow(agentId, { repoId: 6001n, family: 'issues', events: ['issues:labeled'] })
    const opened = await githubRow(agentId, { repoId: 6002n, family: 'issues', events: ['issues:opened'] })
    const pulls = await githubRow(agentId, {
      repoId: 6001n,
      family: 'pull_request',
      events: ['pull_request:*', 'issue_comment:created'],
      commentFamilies: ['pull_request']
    })

    await prisma.$executeRawUnsafe(migrationSql)
    await prisma.$executeRawUnsafe(migrationSql)

    const converted = await prisma.hookDef.findUniqueOrThrow({ where: { id: labeled } })
    expect(converted.events).toEqual(['issues:*', 'issue_comment:created'])
    expect(converted.commentFamilies).toEqual(['issues'])
    expect(converted.labelFilter).toEqual(['bug'])
    // Bumped exactly once across the two runs: the second saw nothing to convert.
    expect(converted.configRevision).toBe(4n)

    const untouchedOpened = await prisma.hookDef.findUniqueOrThrow({ where: { id: opened } })
    expect(untouchedOpened.events).toEqual(['issues:opened'])
    expect(untouchedOpened.configRevision).toBe(3n)
    const untouchedPulls = await prisma.hookDef.findUniqueOrThrow({ where: { id: pulls } })
    expect(untouchedPulls.events).toEqual(['pull_request:*', 'issue_comment:created'])
    expect(untouchedPulls.configRevision).toBe(3n)
  })
})
