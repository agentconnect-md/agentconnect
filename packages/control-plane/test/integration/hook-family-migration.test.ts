/**
 * The `hook_family_split` backfill (webhook-triggers-and-github-events.md).
 *
 * Legacy rows held every subject family of one (agent, repo) in ONE row. The
 * migration splits them into one row per family, keeping the review-capable
 * family on the existing id — projections, review leases and run history all
 * key on it. This test inserts legacy-shaped rows into the already-migrated
 * test database and re-executes the migration file verbatim, which is why that
 * file must be idempotent.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const DAEMON = 'd7d7d7d7-dddd-4ddd-8ddd-dddddddddddd'
const MIGRATION = fileURLToPath(
  new URL('../../prisma/migrations/20260917000000_hook_family_split/migration.sql', import.meta.url)
)

let migrationSql: string
beforeAll(async () => {
  migrationSql = await readFile(MIGRATION, 'utf8')
})

/** Split the file into executable statements, keeping `$$ … $$` blocks whole. */
function statements(sql: string): string[] {
  const parts: string[] = []
  let buf = ''
  let inDollarBlock = false
  for (let i = 0; i < sql.length; i += 1) {
    if (sql.startsWith('$$', i)) {
      inDollarBlock = !inDollarBlock
      buf += '$$'
      i += 1
      continue
    }
    if (sql[i] === ';' && !inDollarBlock) {
      parts.push(buf)
      buf = ''
      continue
    }
    buf += sql[i]
  }
  parts.push(buf)
  // A trailing segment is comments/whitespace only — Postgres would reject it.
  return parts.map((part) => part.trim()).filter((part) => /[^\s-]/.test(part.replace(/--[^\n]*/g, '')))
}

async function runMigration(): Promise<void> {
  for (const statement of statements(migrationSql)) await prisma.$executeRawUnsafe(statement)
}

/** A legacy row: one family-less definition holding every subscription. */
async function legacyHook(
  agentId: string,
  over: {
    kind: 'github' | 'gitlab' | 'webhook'
    repoId?: bigint
    events?: string[]
    commentFamilies?: string[]
    reviewPolicy?: 'off' | 'full'
    reportingMode?: 'off' | 'check'
    configRevision?: bigint
  }
): Promise<string> {
  const id = randomUUID()
  await prisma.hookDef.create({
    data: {
      id,
      orgId: DEFAULT_ORG_ID,
      agentId,
      kind: over.kind,
      name: 'legacy',
      sessionMode: over.kind === 'webhook' ? 'perDelivery' : 'perThread',
      family: null,
      mentionOnly: true,
      labelFilter: ['bug'],
      targetPlatform: 'slack',
      targetChannel: 'C-legacy',
      ...(over.kind === 'webhook' ? { urlToken: `whk_${randomUUID().replaceAll('-', '')}` } : {}),
      ...(over.repoId !== undefined
        ? { repoId: over.repoId, repoFullName: 'acme/legacy', githubSessionKey: 'acme/legacy' }
        : {}),
      events: over.events ?? [],
      commentFamilies: over.commentFamilies ?? [],
      reviewPolicy: over.reviewPolicy ?? 'off',
      reportingMode: over.reportingMode ?? 'off',
      configRevision: over.configRevision ?? 1n
    }
  })
  return id
}

const familyRows = (agentId: string, repoId: bigint) =>
  prisma.hookDef.findMany({ where: { agentId, repoId }, orderBy: { family: 'asc' } })

describe('hook_family_split — legacy rows become one row per subject family', () => {
  it('splits a multi-family github row, keeping the id and review trio on the pull-request family', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const repoId = 5001n
    const legacyId = await legacyHook(agentId, {
      kind: 'github',
      repoId,
      events: ['pull_request:*', 'issues:opened', 'issue_comment:created', 'push:*'],
      commentFamilies: ['issues', 'pull_request'],
      reviewPolicy: 'full',
      reportingMode: 'check',
      configRevision: 5n
    })

    await runMigration()

    const rows = await familyRows(agentId, repoId)
    expect(rows.map((row) => row.family)).toEqual(['issues', 'pull_request', 'push'])
    const [issues, pullRequest, push] = rows

    // The review-capable family keeps the row id (and therefore its history).
    expect(pullRequest!.id).toBe(legacyId)
    expect(pullRequest!.events).toEqual(['pull_request:*', 'issue_comment:created'])
    expect(pullRequest!.commentFamilies).toEqual(['pull_request'])
    expect(pullRequest!.reviewPolicy).toBe('full')
    expect(pullRequest!.reportingMode).toBe('check')
    // The compiled definition shrank, so the relay must be pushed again.
    expect(pullRequest!.configRevision).toBe(6n)

    // A sibling is a fresh row at the default fences, never a review row.
    expect(issues!.events).toEqual(['issues:opened', 'issue_comment:created'])
    expect(issues!.commentFamilies).toEqual(['issues'])
    expect(issues!.reviewPolicy).toBe('off')
    expect(issues!.reportingMode).toBe('off')
    expect(issues!.configRevision).toBe(1n)
    expect(push!.events).toEqual(['push:*'])
    expect(push!.commentFamilies).toEqual([])

    // Everything the family does not decide travels with the split.
    for (const row of rows) {
      expect(row.mentionOnly).toBe(true)
      expect(row.labelFilter).toEqual(['bug'])
      expect(row.targetChannel).toBe('C-legacy')
      // Sibling rows answer the same threads: one grandfathered session namespace.
      expect(row.githubSessionKey).toBe('acme/legacy')
    }

    // Re-running the file is a no-op: the rows already have a family.
    await runMigration()
    expect(await prisma.hookDef.count({ where: { agentId, repoId } })).toBe(3)
  })

  it('splits a comment-only github rule into both thread families and bumps its revision', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const repoId = 5002n
    const legacyId = await legacyHook(agentId, {
      kind: 'github',
      repoId,
      events: ['issue_comment:created'],
      commentFamilies: []
    })

    await runMigration()

    const rows = await familyRows(agentId, repoId)
    expect(rows.map((row) => row.family)).toEqual(['issues', 'pull_request'])
    for (const row of rows) expect(row.events).toEqual(['issue_comment:created'])
    expect(rows[0]!.commentFamilies).toEqual(['issues'])
    expect(rows[1]!.commentFamilies).toEqual(['pull_request'])
    // The events did not change but the repo-wide comment scope did — narrowing
    // it IS a new compiled definition.
    expect(rows.find((row) => row.id === legacyId)!.configRevision).toBe(2n)
  })

  it('gives a gitlab note-only family its own row, even with no matching event pattern', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const repoId = 5003n
    await legacyHook(agentId, {
      kind: 'gitlab',
      repoId,
      events: ['merge_request:*'],
      commentFamilies: ['issues', 'merge_request']
    })

    await runMigration()

    const rows = await familyRows(agentId, repoId)
    expect(rows.map((row) => row.family)).toEqual(['issues', 'merge_request'])
    // The issues family arrived through the note subscription alone, so it
    // watches notes and nothing else — an empty event list is valid at the DB.
    expect(rows[0]!.events).toEqual([])
    expect(rows[0]!.commentFamilies).toEqual(['issues'])
    expect(rows[1]!.events).toEqual(['merge_request:*'])
    expect(rows[1]!.commentFamilies).toEqual(['merge_request'])
  })

  it('labels a single-family row in place, without a sibling or a revision bump', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const repoId = 5004n
    const legacyId = await legacyHook(agentId, {
      kind: 'github',
      repoId,
      events: ['pull_request:*'],
      commentFamilies: [],
      configRevision: 3n
    })

    await runMigration()

    const rows = await familyRows(agentId, repoId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      id: legacyId,
      family: 'pull_request',
      configRevision: 3n,
      events: ['pull_request:*'],
      commentFamilies: []
    })
  })

  it('leaves a generic webhook row alone — it has no subject family', async () => {
    await seedDaemon(prisma, DAEMON)
    const agentId = randomUUID()
    await seedAgent(prisma, agentId, { daemonId: DAEMON })
    const legacyId = await legacyHook(agentId, { kind: 'webhook', configRevision: 4n })

    await runMigration()

    expect(await prisma.hookDef.findUniqueOrThrow({ where: { id: legacyId } })).toMatchObject({
      family: null,
      configRevision: 4n
    })
    expect(await prisma.hookDef.count({ where: { agentId } })).toBe(1)
  })
})
