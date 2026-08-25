/**
 * PrismaClient singleton + `withTx` helper (design §2.4 / §3.13).
 *
 * This is the ONLY module outside `persistence/repositories/` that touches
 * `@prisma/client` construction. Services and edges never import Prisma — they
 * depend on the repository ports in `persistence/ports.ts`.
 *
 * `withTx` runs a callback inside a single interactive transaction so a fencing
 * counter bump (`sessionEpoch`/`routingEpoch`/per-agent `seq`) and the state
 * change it fences commit atomically (§3.13), closing the stale-double-serve
 * gap at the storage layer.
 */
import { PrismaPg } from '@prisma/adapter-pg'
import { PrismaClient, Prisma } from '../generated/prisma/client.js'

/** A client OR a transaction handle — repos accept either (so they compose under `withTx`). */
export type PrismaLike = PrismaClient | Prisma.TransactionClient

let singleton: PrismaClient | undefined

/**
 * Build (or reuse) the process-wide PrismaClient for a given connection URL.
 *
 * v7 has no Rust query engine — queries run through the `@prisma/adapter-pg`
 * driver adapter, so the connection URL is handed to the adapter (not a
 * `datasources` override). `DATABASE_URL` falls back to the env when no explicit
 * URL is passed (the adapter reads `process.env.DATABASE_URL`).
 */
export function createPrisma(databaseUrl?: string): PrismaClient {
  if (singleton) return singleton
  const adapter = new PrismaPg({ connectionString: databaseUrl ?? process.env.DATABASE_URL })
  singleton = new PrismaClient({ adapter })
  return singleton
}

/** Run `fn` inside one interactive transaction (atomic fence + state change). */
export function withTx<T>(prisma: PrismaClient, fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn)
}

/**
 * Run `fn` atomically whether or not the caller already holds a transaction:
 * open one on a root client, COMPOSE under an ambient `TransactionClient`.
 *
 * Prisma has no nested transactions, so a helper that unconditionally called
 * `$transaction` would break every caller that already runs inside one. The
 * `'$transaction' in db` probe is the same discriminator the repositories use
 * (e.g. `PgAgentRepo.transaction`) — a `TransactionClient` deliberately omits
 * that method.
 *
 * Use this for multi-statement invariants that must be all-or-nothing even when
 * reached from a plain client (org creation writes the org, its membership, and
 * its preset agent + marker; a partial commit there is unrecoverable). Composing
 * means the OUTER transaction's boundary wins:
 * a rollback out there also undoes what `fn` wrote, which is the intent.
 */
export function withAmbientTx<T>(
  db: PrismaLike,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  /** Interactive-transaction budget, for a unit of work whose size is data-dependent and can
   *  outgrow Prisma's 5s default. Ignored when composing — the outer boundary owns the clock. */
  opts?: { timeout?: number; maxWait?: number }
): Promise<T> {
  if ('$transaction' in db) return (db as PrismaClient).$transaction(fn, opts)
  return fn(db as Prisma.TransactionClient)
}

/** Probe DB reachability with a trivial round-trip — backs the readiness probe
 *  (`/readyz`). Rejects when the connection is down. */
export async function pingDb(prisma: PrismaLike): Promise<void> {
  await prisma.$queryRaw`SELECT 1`
}

/** Disconnect the singleton (graceful shutdown / test teardown). */
export async function disconnectPrisma(): Promise<void> {
  await singleton?.$disconnect()
  singleton = undefined
}

export { PrismaClient, Prisma }
