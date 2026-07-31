/**
 * Ambient shared-transaction seam (webchat-preset-agentconnect-mcp.md §8).
 *
 * When a delegated MCP tool's ENTIRE side effect is a mutation inside the CP
 * database, the accepted design requires that mutation and the operation's
 * terminal transition to commit in ONE transaction — which removes the
 * ambiguous window for that tool. The mutation, however, is executed through
 * the tool's ordinary nested REST route (`app.inject`), whose repositories are
 * bound at construction time; they cannot receive a `TransactionClient`
 * parameter per call without re-implementing the route.
 *
 * This seam solves that without touching authorization or route code: the
 * composition root wraps the ROOT PrismaClient in {@link withSharedTxRouting},
 * and {@link runWithSharedTx} makes every repository call issued inside its
 * callback — across `app.inject`, plugins, and nested awaits — execute on one
 * `TransactionClient` via AsyncLocalStorage. Outside the callback the wrapper
 * is the root client verbatim, so nothing else in the process changes.
 *
 * `$transaction` composes under an active shared transaction (the OUTER
 * boundary wins), mirroring `withAmbientTx`'s rule: an interactive callback
 * runs against the ambient transaction, and a batch array — whose operations
 * were already created against the ambient transaction by this same wrapper —
 * is awaited in place.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma, PrismaClient } from '../generated/prisma/client.js'

const storage = new AsyncLocalStorage<Prisma.TransactionClient>()

/** Run `fn` with every wrapped-client call routed onto `tx`. */
export function runWithSharedTx<T>(tx: Prisma.TransactionClient, fn: () => Promise<T>): Promise<T> {
  return storage.run(tx, fn)
}

/** True while a shared transaction is ambient on the current async context. */
export function inSharedTx(): boolean {
  return storage.getStore() !== undefined
}

export function withSharedTxRouting(root: PrismaClient): PrismaClient {
  return new Proxy(root, {
    get(target, prop, receiver) {
      const store = storage.getStore()
      if (!store) return Reflect.get(target, prop, receiver)
      if (prop === '$transaction') {
        return (arg: ((tx: Prisma.TransactionClient) => Promise<unknown>) | Promise<unknown>[]): Promise<unknown> =>
          typeof arg === 'function' ? arg(store) : Promise.all(arg)
      }
      if (!(prop in store)) return Reflect.get(target, prop, receiver)
      const value = Reflect.get(store, prop, store)
      return typeof value === 'function' ? value.bind(store) : value
    }
  }) as PrismaClient
}
