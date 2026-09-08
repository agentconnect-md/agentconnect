// The CP memory home's two tables (memory-evolution.md §3.2.1); org fencing is the caller's, proved before the call.
// Every op is ONE transaction under a per-agent advisory lock — the atomic conditional write unified-memory-interface.md §5 builds on.
import { Prisma } from '../../generated/prisma/client.js'
import type { AgentId, OrgId } from '../../domain/ids.js'
import { MAX_MEMORY_FILE_BYTES } from '../../agent-memory/limits.js'
import { withAmbientTx, type PrismaLike } from '../prisma.js'
import type {
  AgentMemoryAppendOutcome,
  AgentMemoryCommitOutcome,
  AgentMemoryFileEntry,
  AgentMemoryFileRepo,
  AgentMemoryFileSlice,
  AgentMemoryHistoryInput,
  AgentMemoryHistoryPage,
  AgentMemoryHistoryRecord,
  AgentMemoryHistoryRepo,
  AgentMemoryHistoryRetention,
  AgentMemoryRenameOutcome
} from '../ports.js'

type Tx = Prisma.TransactionClient

/** The prefix every row beneath `path` starts with; the tree root is the empty prefix, which every row matches. */
function childPrefix(path: string): string {
  return path === '' ? '' : `${path}/`
}

async function lockTree(tx: Tx, key: string): Promise<void> {
  await tx.$queryRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0)) IS NULL AS "locked"`)
}

async function fileExists(tx: Tx, agentId: AgentId, path: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ found: boolean }[]>(Prisma.sql`
    SELECT EXISTS(SELECT 1 FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${path}) AS "found"
  `)
  return rows[0]?.found ?? false
}

async function dirExists(tx: Tx, agentId: AgentId, path: string): Promise<boolean> {
  const rows = await tx.$queryRaw<{ found: boolean }[]>(Prisma.sql`
    SELECT EXISTS(
      SELECT 1 FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND starts_with("path", ${childPrefix(path)})
    ) AS "found"
  `)
  return rows[0]?.found ?? false
}

export class PgAgentMemoryFileRepo implements AgentMemoryFileRepo {
  constructor(private readonly db: PrismaLike) {}

  async read(agentId: AgentId, path: string, offset: number, limit: number): Promise<AgentMemoryFileSlice | null> {
    const rows = await this.db.$queryRaw<{ size: number; mtime: Date; slice: Uint8Array }[]>(Prisma.sql`
      SELECT "size", "mtime", substr("content", ${offset + 1}::int, ${limit}::int) AS "slice"
      FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${path}
    `)
    const row = rows[0]
    return row ? { size: row.size, mtime: row.mtime, slice: row.slice } : null
  }

  append(
    agentId: AgentId,
    orgId: OrgId,
    path: string,
    chunk: Uint8Array,
    create: boolean,
    now: Date
  ): Promise<AgentMemoryAppendOutcome> {
    return withAmbientTx(this.db, async (tx) => {
      await lockTree(tx, `agent-memory:${agentId}`)
      const bytes = Buffer.from(chunk)
      if (create) {
        if (bytes.byteLength > MAX_MEMORY_FILE_BYTES) return { ok: false, reason: 'too-large' }
        const inserted = await tx.$queryRaw<{ size: number }[]>(Prisma.sql`
          INSERT INTO "agent_memory_file" ("agentId", "orgId", "path", "content", "size", "mtime", "stagedAt")
          VALUES (${agentId}::uuid, ${orgId}, ${path}, ${bytes}, ${bytes.byteLength}::int, ${now}, ${now})
          ON CONFLICT DO NOTHING RETURNING "size"
        `)
        return inserted[0] ? { ok: true, size: inserted[0].size } : { ok: false, reason: 'exists' }
      }
      const current = await tx.$queryRaw<{ size: number }[]>(Prisma.sql`
        SELECT "size" FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${path} FOR UPDATE
      `)
      if (!current[0]) return { ok: false, reason: 'missing' }
      if (current[0].size + bytes.byteLength > MAX_MEMORY_FILE_BYTES) return { ok: false, reason: 'too-large' }
      const updated = await tx.$queryRaw<{ size: number }[]>(Prisma.sql`
        UPDATE "agent_memory_file"
        SET "content" = "content" || ${bytes}, "size" = "size" + ${bytes.byteLength}::int, "mtime" = ${now}
        WHERE "agentId" = ${agentId}::uuid AND "path" = ${path}
        RETURNING "size"
      `)
      return { ok: true, size: updated[0]!.size }
    })
  }

  commit(
    agentId: AgentId,
    path: string,
    temp: string,
    ifMatchMtime: string | undefined,
    now: Date
  ): Promise<AgentMemoryCommitOutcome> {
    return withAmbientTx(this.db, async (tx) => {
      await lockTree(tx, `agent-memory:${agentId}`)
      const staged = await tx.$queryRaw<{ size: number }[]>(Prisma.sql`
        SELECT "size" FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${temp} FOR UPDATE
      `)
      if (!staged[0]) return { ok: false, reason: 'temp-missing' }
      const dropTemp = () =>
        tx.$executeRaw(
          Prisma.sql`DELETE FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${temp}`
        )
      if (await dirExists(tx, agentId, path)) {
        await dropTemp()
        return { ok: false, reason: 'target-is-directory' }
      }
      const target = await tx.$queryRaw<{ mtime: Date }[]>(Prisma.sql`
        SELECT "mtime" FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${path} FOR UPDATE
      `)
      const previous = target[0]?.mtime ?? null
      // A brand-new target never matches a non-empty precondition; the disk ports drop the temp on a miss too.
      if (ifMatchMtime && (!previous || previous.toISOString() !== ifMatchMtime)) {
        await dropTemp()
        return { ok: false, reason: 'conflict' }
      }
      await tx.$executeRaw(
        Prisma.sql`DELETE FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${path}`
      )
      // The token is strictly monotonic per path: never the previous one, whatever the clock says.
      const published = await tx.$queryRaw<{ size: number; mtime: Date }[]>(Prisma.sql`
        UPDATE "agent_memory_file"
        SET "path" = ${path}, "stagedAt" = NULL,
            "mtime" = GREATEST(${now}::timestamptz, COALESCE(${previous}::timestamptz + interval '1 millisecond', ${now}::timestamptz))
        WHERE "agentId" = ${agentId}::uuid AND "path" = ${temp}
        RETURNING "size", "mtime"
      `)
      return { ok: true, size: published[0]!.size, mtime: published[0]!.mtime }
    })
  }

  async stat(agentId: AgentId, path: string): Promise<'file' | 'dir' | 'missing'> {
    const rows = await this.db.$queryRaw<{ file: boolean; dir: boolean }[]>(Prisma.sql`
      SELECT
        EXISTS(SELECT 1 FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${path}) AS "file",
        EXISTS(SELECT 1 FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND starts_with("path", ${childPrefix(path)})) AS "dir"
    `)
    return rows[0]?.file ? 'file' : rows[0]?.dir ? 'dir' : 'missing'
  }

  listUnder(agentId: AgentId, path: string): Promise<AgentMemoryFileEntry[]> {
    return this.db.$queryRaw<AgentMemoryFileEntry[]>(Prisma.sql`
      SELECT "path", "size", "mtime", ("stagedAt" IS NOT NULL) AS "staged"
      FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND starts_with("path", ${childPrefix(path)})
      ORDER BY "path"
    `)
  }

  rmdir(agentId: AgentId, path: string): Promise<boolean> {
    return withAmbientTx(
      this.db,
      async (tx) => !(await fileExists(tx, agentId, path)) && !(await dirExists(tx, agentId, path))
    )
  }

  async rm(agentId: AgentId, path: string): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      await lockTree(tx, `agent-memory:${agentId}`)
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "agent_memory_file"
        WHERE "agentId" = ${agentId}::uuid AND ("path" = ${path} OR starts_with("path", ${childPrefix(path)}))
      `)
    })
  }

  rename(agentId: AgentId, from: string, to: string): Promise<AgentMemoryRenameOutcome> {
    return withAmbientTx(this.db, async (tx) => {
      await lockTree(tx, `agent-memory:${agentId}`)
      if (await fileExists(tx, agentId, from)) {
        if (from === to) return 'moved'
        if (await dirExists(tx, agentId, to)) return 'occupied'
        await tx.$executeRaw(
          Prisma.sql`DELETE FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid AND "path" = ${to}`
        )
        await tx.$executeRaw(Prisma.sql`
          UPDATE "agent_memory_file" SET "path" = ${to} WHERE "agentId" = ${agentId}::uuid AND "path" = ${from}
        `)
        return 'moved'
      }
      if (!(await dirExists(tx, agentId, from))) return 'absent'
      if (from === to) return 'moved'
      if ((await fileExists(tx, agentId, to)) || (await dirExists(tx, agentId, to))) return 'occupied'
      // A directory rename is a prefix rewrite; `substr` counts characters, so the cut is `char_length`, never `.length`.
      await tx.$executeRaw(Prisma.sql`
        UPDATE "agent_memory_file"
        SET "path" = ${to} || substr("path", char_length(${from}::text) + 1)
        WHERE "agentId" = ${agentId}::uuid AND starts_with("path", ${childPrefix(from)})
      `)
      return 'moved'
    })
  }

  async utimes(agentId: AgentId, path: string, mtime: Date): Promise<void> {
    await this.db.$executeRaw(Prisma.sql`
      UPDATE "agent_memory_file" SET "mtime" = ${mtime} WHERE "agentId" = ${agentId}::uuid AND "path" = ${path}
    `)
  }

  sweepStaged(before: Date, limit: number): Promise<number> {
    return this.db.$executeRaw(Prisma.sql`
      DELETE FROM "agent_memory_file" WHERE ("agentId", "path") IN (
        SELECT "agentId", "path" FROM "agent_memory_file"
        WHERE "stagedAt" IS NOT NULL AND "stagedAt" < ${before} LIMIT ${limit}::int
      )
    `)
  }

  async deleteTree(agentId: AgentId): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      await lockTree(tx, `agent-memory:${agentId}`)
      await tx.$executeRaw(Prisma.sql`DELETE FROM "agent_memory_file" WHERE "agentId" = ${agentId}::uuid`)
    })
  }
}

type HistoryRow = {
  id: string
  path: string
  event: 'add' | 'update' | 'delete'
  before: string | null
  after: string
  at: Date
  source: 'tool' | 'console' | 'distill' | 'dream'
  truncated: boolean | null
  bytes: number
}

function toRecord(row: HistoryRow): AgentMemoryHistoryRecord {
  return {
    id: row.id,
    path: row.path,
    event: row.event,
    ...(row.before !== null ? { before: row.before } : {}),
    after: row.after,
    at: row.at,
    source: row.source,
    ...(row.truncated !== null ? { truncated: row.truncated } : {}),
    bytes: row.bytes
  }
}

export class PgAgentMemoryHistoryRepo implements AgentMemoryHistoryRepo {
  constructor(private readonly db: PrismaLike) {}

  async append(
    agentId: AgentId,
    orgId: OrgId,
    root: string,
    records: AgentMemoryHistoryInput[],
    retention: AgentMemoryHistoryRetention
  ): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      await lockTree(tx, `agent-memory-history:${agentId}`)
      // A re-sent batch carries the same ids; the daemon never reads the log back, so duplicates are simply dropped.
      await tx.agentMemoryHistory.createMany({
        data: records.map((record) => ({
          id: record.id,
          agentId,
          orgId,
          root,
          path: record.path,
          event: record.event,
          before: record.before ?? null,
          after: record.after,
          at: record.at,
          source: record.source,
          truncated: record.truncated ?? null,
          bytes: record.bytes
        })),
        skipDuplicates: true
      })
      // Retention is a delete: the newest N versions of each file first, then the store's byte cap, oldest first.
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "agent_memory_history" WHERE "id" IN (
          SELECT "id" FROM (
            SELECT "id", row_number() OVER (PARTITION BY "path" ORDER BY "at" DESC, "seq" DESC) AS "rn"
            FROM "agent_memory_history" WHERE "agentId" = ${agentId}::uuid AND "root" = ${root}
          ) ranked WHERE "rn" > ${retention.maxVersionsPerFile}::int
        )
      `)
      await tx.$executeRaw(Prisma.sql`
        DELETE FROM "agent_memory_history" WHERE "id" IN (
          SELECT "id" FROM (
            SELECT "id", sum("bytes") OVER (ORDER BY "at" DESC, "seq" DESC ROWS UNBOUNDED PRECEDING) AS "running"
            FROM "agent_memory_history" WHERE "agentId" = ${agentId}::uuid AND "root" = ${root}
          ) summed WHERE "running" > ${retention.maxBytesPerRoot}::bigint
        )
      `)
    })
  }

  async page(
    agentId: AgentId,
    root: string,
    path: string,
    cursor: string | undefined,
    limit: number
  ): Promise<AgentMemoryHistoryPage> {
    // The cursor is the record the page starts at (the daemon's sidecar semantics); one extra row tells whether more follow.
    const anchor = cursor
      ? await this.db.$queryRaw<{ at: Date; seq: bigint }[]>(Prisma.sql`
          SELECT "at", "seq" FROM "agent_memory_history"
          WHERE "id" = ${cursor}::uuid AND "agentId" = ${agentId}::uuid AND "root" = ${root} AND "path" = ${path}
        `)
      : undefined
    if (anchor && !anchor[0]) return { records: [] }
    const bound = anchor?.[0]
      ? Prisma.sql`AND ("at", "seq") <= (${anchor[0].at}::timestamptz, ${anchor[0].seq}::bigint)`
      : Prisma.empty
    const rows = await this.db.$queryRaw<HistoryRow[]>(Prisma.sql`
      SELECT "id", "path", "event", "before", "after", "at", "source", "truncated", "bytes"
      FROM "agent_memory_history"
      WHERE "agentId" = ${agentId}::uuid AND "root" = ${root} AND "path" = ${path} ${bound}
      ORDER BY "at" DESC, "seq" DESC LIMIT ${limit + 1}::int
    `)
    const next = rows[limit]
    return { records: rows.slice(0, limit).map(toRecord), ...(next ? { nextCursor: next.id } : {}) }
  }

  async deleteTree(agentId: AgentId): Promise<void> {
    await withAmbientTx(this.db, async (tx) => {
      await lockTree(tx, `agent-memory-history:${agentId}`)
      await tx.$executeRaw(Prisma.sql`DELETE FROM "agent_memory_history" WHERE "agentId" = ${agentId}::uuid`)
    })
  }
}
