// The one-time move of the organization files from assistant-mode agents' memory into the record (assistant-mode.md §5.16 "Migration"); idempotent, run at boot.
import { createHash } from 'node:crypto'
import { MEMBERS_OPT_OUT_PATH, parseMembersOptOut } from '@agentconnect.md/protocol'
import { Prisma, type PrismaClient } from '../generated/prisma/client.js'
import type { OrganizationRecordKind } from '../persistence/ports.js'
import {
  ensureOrganizationRecord,
  lockOrganizationRecord,
  RECORD_KINDS
} from '../persistence/repositories/organization-record.repo.js'
import { mergeAbout, mergeChannels, mergePeople, type RecordCopy } from './record-merge.js'

type Log = { info: (obj: object, msg: string) => void; warn: (obj: object, msg: string) => void }

const FILE_KIND: Record<string, OrganizationRecordKind> = {
  'memory/organization.md': 'organization',
  'memory/channels.md': 'channels',
  'memory/members.md': 'people'
}
const INDEX_PATH = 'memory/MEMORY.md'
// An index line that links one of the three names, as the shared index renders it.
const INDEX_LINE = /^- \[[^\]\n]*\]\((?:organization|channels|members)\.md\)/i
const sha256 = (value: string) => `sha256:${createHash('sha256').update(value).digest('hex')}`

interface CopyRow {
  agentId: string
  orgId: string
  path: string
  content: Uint8Array
  mtime: Date
}

/** Moves every assistant-mode agent's copies of the three files into its organization's record, then deletes them and their index lines. */
export class OrganizationRecordMove {
  constructor(private readonly deps: { prisma: PrismaClient; log: Log }) {}

  async run(): Promise<{ organizations: number }> {
    const { prisma, log } = this.deps
    const rows = await prisma.$queryRaw<CopyRow[]>(Prisma.sql`
      SELECT f."agentId", a."orgId", f."path", f."content", f."mtime"
      FROM "agent_memory_file" f JOIN "agent" a ON a."id" = f."agentId"
      WHERE f."stagedAt" IS NULL AND (a."assistantMode"->>'enabled') = 'true'
        AND (lower(f."path") IN ('memory/organization.md', 'memory/channels.md', 'memory/members.md')
             OR f."path" = ${MEMBERS_OPT_OUT_PATH})
    `)
    const byOrg = new Map<string, CopyRow[]>()
    for (const row of rows) byOrg.set(row.orgId, [...(byOrg.get(row.orgId) ?? []), row])
    let organizations = 0
    for (const [orgId, copies] of byOrg) {
      if (!copies.some((copy) => FILE_KIND[copy.path.toLowerCase()])) continue
      try {
        await this.moveOrganization(orgId, copies)
        organizations++
      } catch (err) {
        // The next boot tries again; nothing was deleted before the record held the copies.
        log.warn({ err, orgId }, 'organization-record-move: organization skipped')
      }
    }
    if (organizations) log.info({ organizations }, 'organization-record-move: moved')
    return { organizations }
  }

  private async moveOrganization(orgId: string, copies: CopyRow[]): Promise<void> {
    const { prisma } = this.deps
    const text = (row: CopyRow) => Buffer.from(row.content).toString('utf8')
    const optedOut = new Map<string, string>()
    for (const marker of copies.filter((copy) => copy.path === MEMBERS_OPT_OUT_PATH)) {
      let keys: Map<string, string>
      try {
        keys = parseMembersOptOut(text(marker))
      } catch {
        continue
      }
      for (const [key, day] of keys) {
        const known = optedOut.get(key)
        if (!known || day < known) optedOut.set(key, day)
      }
    }
    await prisma.$transaction(
      async (tx) => {
        await lockOrganizationRecord(tx, orgId)
        for (const [key, day] of optedOut) {
          const clearedOn = new Date(`${day.slice(0, 10)}T00:00:00Z`)
          if (Number.isNaN(clearedOn.getTime())) continue
          const existing = await tx.organizationPeopleOptOut.findUnique({ where: { orgId_key: { orgId, key } } })
          if (!existing) await tx.organizationPeopleOptOut.create({ data: { orgId, key, clearedOn } })
          else if (clearedOn < existing.clearedOn)
            await tx.organizationPeopleOptOut.update({ where: { orgId_key: { orgId, key } }, data: { clearedOn } })
        }
        const allOptedOut = new Set(
          (await tx.organizationPeopleOptOut.findMany({ where: { orgId }, select: { key: true } })).map((r) => r.key)
        )
        await ensureOrganizationRecord(tx, orgId, { source: 'migration' })
        for (const kind of RECORD_KINDS) {
          const kindCopies = copies.filter((copy) => FILE_KIND[copy.path.toLowerCase()] === kind)
          if (!kindCopies.length) continue
          const entry = await tx.organizationKnowledge.findFirstOrThrow({
            where: { orgId, kind },
            include: { revisions: { orderBy: { revision: 'desc' }, take: 1 } }
          })
          const current = entry.revisions[0]!
          // The record's own text counts as a copy once it holds more than its title line.
          const merged: RecordCopy[] = kindCopies.map((copy) => ({ text: text(copy), at: copy.mtime }))
          if (current.content.trim() !== `# ${entry.title}`) merged.push({ text: current.content, at: entry.updatedAt })
          const content =
            kind === 'organization'
              ? mergeAbout(merged)
              : kind === 'channels'
                ? mergeChannels(merged)
                : mergePeople(merged, allOptedOut)
          if (content === current.content) continue
          // A record the move itself created keeps revision 1, now holding the moved text.
          if (entry.currentRevision === 1 && current.content.trim() === `# ${entry.title}`)
            await tx.organizationKnowledgeRevision.update({
              where: { knowledgeId_revision: { knowledgeId: entry.id, revision: 1 } },
              data: { content, digest: sha256(content), source: 'migration', sourceAgentId: null }
            })
          else {
            await tx.organizationKnowledge.update({
              where: { id: entry.id },
              data: { currentRevision: entry.currentRevision + 1 }
            })
            await tx.organizationKnowledgeRevision.create({
              data: {
                knowledgeId: entry.id,
                revision: entry.currentRevision + 1,
                content,
                digest: sha256(content),
                source: 'migration'
              }
            })
          }
        }
        await this.claimResearch(tx, orgId, copies)
      },
      { timeout: 30_000 }
    )
    // The record holds every copy now; a copy written since it was read stays for the next run.
    for (const agentId of new Set(copies.map((copy) => copy.agentId)))
      await this.deleteCopies(
        agentId,
        copies.filter((copy) => copy.agentId === agentId)
      )
  }

  /** A moved record's research: the agent that first switched the mode on, as of its last `organization.md` write. */
  private async claimResearch(tx: Prisma.TransactionClient, orgId: string, copies: CopyRow[]): Promise<void> {
    const record = await tx.organizationRecord.findUniqueOrThrow({ where: { orgId } })
    if (record.researchAgentId) return
    const agents = await tx.agent.findMany({
      where: { orgId, assistantOnboarding: { not: Prisma.DbNull } },
      select: { id: true, assistantOnboarding: true }
    })
    const first = agents
      .map((agent) => ({ id: agent.id, at: (agent.assistantOnboarding as { enabledAt?: string } | null)?.enabledAt }))
      .filter((agent): agent is { id: string; at: string } => typeof agent.at === 'string')
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))[0]
    if (!first) return
    const organization = copies.find(
      (copy) => copy.agentId === first.id && copy.path.toLowerCase() === 'memory/organization.md'
    )
    await tx.organizationRecord.update({
      where: { orgId },
      data: {
        researchAgentId: first.id,
        researchClaimedAt: new Date(first.at),
        ...(organization ? { researchedAt: organization.mtime } : {})
      }
    })
  }

  /** Delete an agent's moved copies, each only if unchanged since it was read, and their index lines, under the memory lock its writes take. */
  private async deleteCopies(agentId: string, copies: CopyRow[]): Promise<void> {
    await this.deps.prisma.$transaction(async (tx) => {
      await tx.$queryRaw(
        Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`agent-memory:${agentId}`}, 0)) IS NULL AS "locked"`
      )
      for (const copy of copies)
        await tx.agentMemoryFile.deleteMany({ where: { agentId, path: copy.path, mtime: copy.mtime, stagedAt: null } })
      const index = await tx.agentMemoryFile.findUnique({ where: { agentId_path: { agentId, path: INDEX_PATH } } })
      if (!index || index.stagedAt) return
      const before = Buffer.from(index.content).toString('utf8')
      const after = before
        .split('\n')
        .filter((line) => !INDEX_LINE.test(line))
        .join('\n')
      if (after === before) return
      const bytes = Buffer.from(after)
      await tx.agentMemoryFile.update({
        where: { agentId_path: { agentId, path: INDEX_PATH } },
        data: {
          content: bytes,
          size: bytes.byteLength,
          mtime: new Date(Math.max(Date.now(), index.mtime.getTime() + 1))
        }
      })
    })
  }
}
