/**
 * PgRelayRepo — `RelayRepo` over Prisma (shared-bot-relay.md §6).
 *
 * The relay is stateless deployment infra, so its ONLY durable identity is the
 * unique `name`: `upsertByName` reclaims the same row (and relayId) on restart.
 * `listAlive` is the roster source; `sweepStale` is the failover sweeper. No org,
 * no secret material.
 */
import { randomUUID } from 'node:crypto'
import type { Relay } from '../../generated/prisma/client.js'
import type { PrismaLike } from '../prisma.js'
import type { RelayRepo, RelayRecord } from '../ports.js'

function toRecord(r: Relay): RelayRecord {
  return {
    id: r.id,
    name: r.name,
    daemonUrl: r.daemonUrl,
    features: r.features,
    lastSeenAt: r.lastSeenAt,
    createdAt: r.createdAt
  }
}

export class PgRelayRepo implements RelayRepo {
  constructor(private readonly db: PrismaLike) {}

  async upsertByName(name: string, daemonUrl: string, at: Date, features: string[] = []): Promise<RelayRecord> {
    const row = await this.db.relay.upsert({
      where: { name },
      create: { id: randomUUID(), name, daemonUrl, features, lastSeenAt: at },
      update: { daemonUrl, features, lastSeenAt: at }
    })
    return toRecord(row)
  }

  async touchLastSeen(id: string, at: Date): Promise<boolean> {
    // updateMany (not update) so a swept-then-late-heartbeat row doesn't throw P2025;
    // count === 0 ⇒ the row was swept (caller forces a re-register).
    const res = await this.db.relay.updateMany({ where: { id }, data: { lastSeenAt: at } })
    return res.count > 0
  }

  async listAlive(since: Date): Promise<RelayRecord[]> {
    const rows = await this.db.relay.findMany({
      where: { lastSeenAt: { gte: since } },
      orderBy: { createdAt: 'asc' }
    })
    return rows.map(toRecord)
  }

  async sweepStale(staleBefore: Date): Promise<number> {
    const res = await this.db.relay.deleteMany({
      where: {
        OR: [
          { lastSeenAt: { lt: staleBefore } },
          // Registered but never heartbeated and now older than the window.
          { lastSeenAt: null, createdAt: { lt: staleBefore } }
        ]
      }
    })
    return res.count
  }
}
