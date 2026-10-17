// The organization record (assistant-mode.md §5.16): three knowledge entries per organization, research's claim and People's opt-out.
import { createHash } from 'node:crypto'
import {
  parseMembersDirectory,
  type KnowledgeRecordFile,
  type KnowledgeRecordWriterKind
} from '@agentconnect.md/protocol'
import { Prisma } from '../../generated/prisma/client.js'
import type { OrgId } from '../../domain/ids.js'
import type {
  OrganizationKnowledgeRecord,
  OrganizationRecordKind,
  OrganizationRecordRepo,
  OrganizationRecordStatus,
  OrganizationRecordWriteInput,
  OrganizationRecordWriteResult
} from '../ports.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import { currentKnowledgeInclude, toKnowledge } from './organization-knowledge.repo.js'

type Tx = Prisma.TransactionClient

export const RECORD_KINDS = ['organization', 'channels', 'people'] as const satisfies readonly OrganizationRecordKind[]
export const RECORD_TITLES: Record<OrganizationRecordKind, string> = {
  organization: 'About',
  channels: 'Channels',
  people: 'People'
}
export const RECORD_FILES: Record<OrganizationRecordKind, KnowledgeRecordFile> = {
  organization: 'organization.md',
  channels: 'channels.md',
  people: 'members.md'
}

export function recordKindOfFile(file: KnowledgeRecordFile): OrganizationRecordKind {
  return file === 'organization.md' ? 'organization' : file === 'channels.md' ? 'channels' : 'people'
}

/** The prisma enum spells `first-look` as `first_look`. */
export function writerKindColumn(
  kind: KnowledgeRecordWriterKind
): 'research' | 'first_look' | 'conversation' | 'person' {
  return kind === 'first-look' ? 'first_look' : kind
}

const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`
const today = (now: Date) => new Date(`${now.toISOString().slice(0, 10)}T00:00:00Z`)

/** Serializes every write of one organization's record, its readers and its claim. */
export async function lockOrganizationRecord(tx: Tx, orgId: string): Promise<void> {
  await tx.$queryRaw(
    Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`organization-record:${orgId}`}, 0)) IS NULL AS "locked"`
  )
}

/** The organization's agents in assistant mode, as their stored policy says. */
export async function assistantModeAgentIds(tx: Tx | PrismaLike, orgId: string): Promise<string[]> {
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "agent" WHERE "orgId" = ${orgId} AND ("assistantMode"->>'enabled') = 'true' ORDER BY "id"
  `)
  return rows.map((row) => row.id)
}

/** Create the record's row and any missing entry, each with its title line alone; People starts read by the assistant-mode agents. The caller holds the lock. */
export async function ensureOrganizationRecord(
  tx: Tx,
  orgId: string,
  provenance: { source: 'agent' | 'migration'; sourceAgentId?: string }
): Promise<void> {
  await tx.organizationRecord.upsert({ where: { orgId }, create: { orgId }, update: {} })
  const present = new Set(
    (
      await tx.organizationKnowledge.findMany({
        where: { orgId, kind: { in: [...RECORD_KINDS] } },
        select: { kind: true }
      })
    ).map((row) => row.kind)
  )
  for (const kind of RECORD_KINDS) {
    if (present.has(kind)) continue
    const content = `# ${RECORD_TITLES[kind]}`
    await tx.organizationKnowledge.create({
      data: {
        orgId,
        title: RECORD_TITLES[kind],
        kind,
        ...(kind === 'people'
          ? {
              visibility: 'selected' as const,
              readers: await assistantModeAgentIds(tx, orgId),
              readersFollowAssistantMode: true
            }
          : {}),
        revisions: {
          create: {
            revision: 1,
            content,
            digest: sha256(content),
            source: provenance.source,
            sourceAgentId: provenance.sourceAgentId ?? null
          }
        }
      }
    })
  }
}

/** An assistant-mode switch in the agent's own row-locked write: People's readers follow it while the list is not hand-edited, and a first switch-on claims research once per organization. */
export async function applyAssistantModeSwitch(
  tx: Tx,
  orgId: string,
  agentId: string,
  change: { on: boolean; claimResearch: boolean; now: Date }
): Promise<{ research?: boolean; researchedBy?: { agentId: string; name: string; at: string } }> {
  await lockOrganizationRecord(tx, orgId)
  if (change.on) await ensureOrganizationRecord(tx, orgId, { source: 'agent', sourceAgentId: agentId })
  const people = await tx.organizationKnowledge.findFirst({
    where: { orgId, kind: 'people' },
    select: { id: true, readers: true, readersFollowAssistantMode: true }
  })
  if (people?.readersFollowAssistantMode) {
    const has = people.readers.includes(agentId)
    if (change.on !== has)
      await tx.organizationKnowledge.update({
        where: { id: people.id },
        data: { readers: change.on ? [...people.readers, agentId] : people.readers.filter((id) => id !== agentId) }
      })
  }
  if (!change.on || !change.claimResearch) return {}
  // A claim whose agent was deleted is free again, so research has an agent to ask.
  const claimed = await tx.organizationRecord.updateMany({
    where: { orgId, researchAgentId: null },
    data: { researchAgentId: agentId, researchClaimedAt: change.now }
  })
  if (claimed.count === 1) return { research: true }
  // The hello of an agent that does not research names the one that does (§5.16).
  const record = await tx.organizationRecord.findUnique({
    where: { orgId },
    select: { researchClaimedAt: true, researchAgent: { select: { id: true, name: true, displayName: true } } }
  })
  const by = record?.researchAgent
  return {
    research: false,
    ...(by && record.researchClaimedAt
      ? {
          researchedBy: {
            agentId: by.id,
            name: (by.displayName?.trim() || by.name).slice(0, 200),
            at: record.researchClaimedAt.toISOString()
          }
        }
      : {})
  }
}

/** An agent's deletion takes it out of every readers list. */
export async function pruneKnowledgeReaders(tx: Tx, orgId: string, agentId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`
    UPDATE "organization_knowledge" SET "readers" = array_remove("readers", ${agentId}), "updatedAt" = now()
    WHERE "orgId" = ${orgId} AND "readers" @> ARRAY[${agentId}]::text[]
  `)
}

async function optOutKeys(db: Tx | PrismaLike, orgId: string): Promise<string[]> {
  return (
    await db.organizationPeopleOptOut.findMany({ where: { orgId }, select: { key: true }, orderBy: { key: 'asc' } })
  ).map((row) => row.key)
}

async function recordEntry(db: Tx | PrismaLike, orgId: string, kind: OrganizationRecordKind) {
  const row = await db.organizationKnowledge.findFirst({ where: { orgId, kind }, include: currentKnowledgeInclude })
  return row ? toKnowledge(row) : null
}

/** A People write that adds or changes the entry of someone who removed theirs; nothing was written. */
export class OptedOutError extends Error {
  constructor(readonly keys: string[]) {
    super(
      `People keeps out ${keys.map((key) => `\`${key}\``).join(', ')}: they removed their entry, and only they write it again`
    )
    this.name = 'OptedOutError'
  }
}

/** The keys whose entry a People write adds or changes. */
function changedEntryKeys(before: string, after: string): string[] {
  const text = (entry: { heading: string; lines: string[] }) => [entry.heading, ...entry.lines].join('\n').trim()
  const old = new Map(parseMembersDirectory(before).entries.map((entry) => [entry.key, text(entry)]))
  return parseMembersDirectory(after).entries.flatMap((entry) =>
    entry.key && old.get(entry.key) !== text(entry) ? [entry.key] : []
  )
}

export class PgOrganizationRecordRepo implements OrganizationRecordRepo {
  constructor(private readonly db: PrismaLike) {}

  async read(
    orgId: OrgId,
    kind: OrganizationRecordKind,
    create?: { sourceAgentId: string }
  ): Promise<{ entry: OrganizationKnowledgeRecord; optOut: string[] } | null> {
    let entry = await recordEntry(this.db, orgId, kind)
    if (!entry && create)
      entry = await withAmbientTx(this.db, async (tx) => {
        await lockOrganizationRecord(tx, orgId)
        await ensureOrganizationRecord(tx, orgId, { source: 'agent', sourceAgentId: create.sourceAgentId })
        return recordEntry(tx, orgId, kind)
      })
    if (!entry) return null
    return { entry, optOut: await optOutKeys(this.db, orgId) }
  }

  async write(
    orgId: OrgId,
    kind: OrganizationRecordKind,
    input: OrganizationRecordWriteInput
  ): Promise<OrganizationRecordWriteResult> {
    return withAmbientTx(this.db, async (tx) => {
      await lockOrganizationRecord(tx, orgId)
      if (input.provenance.source === 'agent')
        await ensureOrganizationRecord(tx, orgId, { source: 'agent', sourceAgentId: input.provenance.sourceAgentId })
      const entry = await recordEntry(tx, orgId, kind)
      if (!entry) return { outcome: 'missing' }
      if (entry.currentRevision !== input.baseRevision)
        return { outcome: 'conflict', entry, optOut: await optOutKeys(tx, orgId) }
      // Marks land before the write, lifts after it: a write that fails leaves its person out, never in (§5.17).
      if (input.optOut.mark.length)
        await tx.organizationPeopleOptOut.createMany({
          data: input.optOut.mark.map((key) => ({ orgId, key, clearedOn: today(input.now) })),
          skipDuplicates: true
        })
      // A removal can land between a writer's read and its write, so the stored marks are checked here, under the lock.
      if (kind === 'people') {
        const lifted = new Set(input.optOut.lift)
        const marked = new Set(await optOutKeys(tx, orgId))
        const keys = changedEntryKeys(entry.content, input.content).filter((key) => marked.has(key) && !lifted.has(key))
        if (keys.length) throw new OptedOutError(keys)
      }
      const revision = entry.currentRevision + 1
      if (input.content !== entry.content) {
        await tx.organizationKnowledge.update({ where: { id: entry.id }, data: { currentRevision: revision } })
        await tx.organizationKnowledgeRevision.create({
          data: {
            knowledgeId: entry.id,
            revision,
            content: input.content,
            digest: sha256(input.content),
            ...(input.provenance.source === 'agent'
              ? {
                  source: 'agent' as const,
                  sourceAgentId: input.provenance.sourceAgentId,
                  writerKind: writerKindColumn(input.provenance.writerKind)
                }
              : { source: 'manual' as const, createdByUserId: input.provenance.createdByUserId ?? null })
          }
        })
      }
      if (input.optOut.lift.length)
        await tx.organizationPeopleOptOut.deleteMany({ where: { orgId, key: { in: input.optOut.lift } } })
      const written = await recordEntry(tx, orgId, kind)
      return { outcome: 'written', entry: written!, optOut: await optOutKeys(tx, orgId) }
    })
  }

  async status(orgId: OrgId): Promise<OrganizationRecordStatus> {
    const [row, entries] = await Promise.all([
      this.db.organizationRecord.findUnique({ where: { orgId } }),
      this.db.organizationKnowledge.findMany({
        where: { orgId, kind: { in: [...RECORD_KINDS] } },
        include: currentKnowledgeInclude
      })
    ])
    const ids = entries.map((entry) => entry.id)
    const researched = ids.length
      ? await this.db.organizationKnowledgeRevision.findFirst({
          where: { knowledgeId: { in: ids }, writerKind: 'research' },
          orderBy: { createdAt: 'desc' },
          select: { createdAt: true, sourceAgentId: true }
        })
      : null
    const agentId = row?.researchAgentId ?? researched?.sourceAgentId ?? null
    const researchedAt =
      researched && (!row?.researchedAt || researched.createdAt > row.researchedAt)
        ? researched.createdAt
        : (row?.researchedAt ?? null)
    // A research round is running while the claiming agent's research session is mid-turn (§5.15 "As shipped").
    const running = row?.researchAgentId
      ? await this.db.sessionMeta.findFirst({
          where: {
            agentId: row.researchAgentId,
            thread: { startsWith: 'subsession:research-' },
            endedAt: null,
            activityState: { not: 'idle' }
          },
          orderBy: { startedAt: 'desc' },
          select: { startedAt: true }
        })
      : null
    return {
      researchAgentId: agentId,
      researchedAt,
      runningSince: running
        ? researchedAt && researchedAt > running.startedAt
          ? researchedAt
          : running.startedAt
        : null,
      entries: entries.map(toKnowledge)
    }
  }

  async optOut(orgId: OrgId): Promise<string[]> {
    return optOutKeys(this.db, orgId)
  }
}
