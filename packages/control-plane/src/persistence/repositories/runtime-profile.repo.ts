/**
 * PgRuntimeProfileRepo — observed runtime capabilities (design §3.4, §3.14).
 *
 * Sink for `facts/runtime-profile`. Upserts on `(daemonId, runtime)` so the
 * latest observed model/context-window/ACP coverage replaces the prior snapshot,
 * letting placement reason without probing the harness.
 */
import type { FactsRuntimeProfile } from '@agentconnect.md/protocol'
import { Prisma, type RuntimeProfile } from '../../generated/prisma/client.js'
import type { PrismaClient, PrismaLike } from '../prisma.js'
import type { RuntimeProfileRepo, RuntimeProfileRecord, AcpSupport } from '../ports.js'
import { DaemonId } from '../../domain/ids.js'

function toRecord(p: RuntimeProfile): RuntimeProfileRecord {
  return {
    id: p.id,
    daemonId: DaemonId(p.daemonId),
    runtime: p.runtime,
    version: p.version,
    models: p.models,
    contextWindow: p.contextWindow,
    acpSupport: p.acpSupport as AcpSupport,
    acpProtocolVersion: p.acpProtocolVersion,
    toolCalling: p.toolCalling,
    mcpCapabilities: (p.mcpCapabilities as RuntimeProfileRecord['mcpCapabilities']) ?? null,
    modelCatalog: (p.modelCatalog as RuntimeProfileRecord['modelCatalog']) ?? null,
    modelsSource: (p.modelsSource as RuntimeProfileRecord['modelsSource']) ?? null,
    authRequired: p.authRequired,
    observedAt: p.observedAt
  }
}

export class PgRuntimeProfileRepo implements RuntimeProfileRepo {
  constructor(private readonly db: PrismaLike) {}

  async record(daemonId: DaemonId, f: FactsRuntimeProfile, at: Date): Promise<RuntimeProfileRecord> {
    return this.upsertOne(this.db, daemonId, f, at)
  }

  private async upsertOne(
    db: PrismaLike,
    daemonId: DaemonId,
    f: FactsRuntimeProfile,
    at: Date
  ): Promise<RuntimeProfileRecord> {
    const p = await db.runtimeProfile.upsert({
      where: { daemonId_runtime: { daemonId, runtime: f.runtime } },
      create: {
        daemonId,
        runtime: f.runtime,
        version: f.version,
        models: f.models,
        contextWindow: f.contextWindow,
        acpSupport: f.acpSupport,
        acpProtocolVersion: f.acpProtocolVersion,
        toolCalling: f.toolCalling,
        mcpCapabilities: f.mcpCapabilities ?? Prisma.DbNull,
        modelCatalog: f.modelCatalog ?? Prisma.DbNull,
        modelsSource: f.modelsSource ?? null,
        authRequired: f.authRequired ?? false,
        observedAt: at
      },
      update: {
        version: f.version,
        models: f.models,
        contextWindow: f.contextWindow,
        acpSupport: f.acpSupport,
        acpProtocolVersion: f.acpProtocolVersion ?? null,
        toolCalling: f.toolCalling,
        // Absent ⇒ not probed — reset to null rather than keep a stale capability.
        mcpCapabilities: f.mcpCapabilities ?? Prisma.DbNull,
        modelCatalog: f.modelCatalog ?? Prisma.DbNull,
        modelsSource: f.modelsSource ?? null,
        // Absent ⇒ no login warning — clear rather than keep a stale flag.
        authRequired: f.authRequired ?? false,
        observedAt: at
      }
    })
    return toRecord(p)
  }

  async replaceAll(daemonId: DaemonId, runtimes: FactsRuntimeProfile[], at: Date, seq?: number): Promise<boolean> {
    // Prune first (an empty snapshot deletes every row — `notIn: []` matches all),
    // then upsert the survivors. Atomic: the WS connection dispatches inbound
    // frames without awaiting (`void onText(...)`), so two snapshots can race —
    // interleaved prune/upsert steps could otherwise persist a state matching
    // neither snapshot. One transaction per snapshot keeps last-commit-wins whole.
    const apply = async (db: PrismaLike): Promise<boolean> => {
      if (seq !== undefined) {
        // Snapshot-ordering CAS (runtime-model-catalog.md §5): advance the daemon's
        // stored seq only when this frame is newer (or the fence was reset to null
        // on register). The row lock serializes racing snapshot transactions, so
        // the loser observes the winner's committed seq and drops its whole replace.
        const cas = await db.daemon.updateMany({
          where: { id: daemonId, OR: [{ runtimesSnapshotSeq: null }, { runtimesSnapshotSeq: { lt: seq } }] },
          data: { runtimesSnapshotSeq: seq }
        })
        if (cas.count === 0) return false // stale snapshot — write nothing
      }
      await db.runtimeProfile.deleteMany({
        where: { daemonId, runtime: { notIn: runtimes.map((r) => r.runtime) } }
      })
      for (const f of runtimes) await this.upsertOne(db, daemonId, f, at)
      return true
    }
    // Compose under an ambient transaction when given one (TransactionClient has
    // no $transaction); open our own interactive transaction otherwise.
    if ('$transaction' in this.db) return (this.db as PrismaClient).$transaction((tx) => apply(tx))
    return apply(this.db)
  }

  async forDaemon(daemonId: DaemonId): Promise<RuntimeProfileRecord[]> {
    const rows = await this.db.runtimeProfile.findMany({
      where: { daemonId },
      orderBy: { runtime: 'asc' }
    })
    return rows.map(toRecord)
  }

  async forDaemons(daemonIds: DaemonId[]): Promise<RuntimeProfileRecord[]> {
    if (daemonIds.length === 0) return []
    const rows = await this.db.runtimeProfile.findMany({
      where: { daemonId: { in: daemonIds } },
      orderBy: { runtime: 'asc' }
    })
    return rows.map(toRecord)
  }
}
