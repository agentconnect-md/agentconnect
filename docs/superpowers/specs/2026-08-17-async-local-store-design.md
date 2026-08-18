# Async LocalStore Design

## Purpose

Remove the synchronous PostgreSQL bridge (`PostgresSyncDatabase` + `postgres-store-worker.js`,
`Atomics.wait` on the daemon main thread) by converting `LocalStore` and its `StoreDatabase`
seam to an async, Promise-returning contract. On PostgreSQL the store then runs on an awaited
`pg.Pool` on the main thread; on SQLite it stays `node:sqlite` `DatabaseSync` under an async
facade. The 2026-08-16 capacity benchmark exists to quantify the before/after: `sync-worker`
vs `async-single` isolates the blocking/bridge cost, `async-single` vs `async-pool` the
connection-parallelism win.

## What must not change

- **Commit-before-return.** Every store method resolves only after its writes are durable.
  Awaiting replaces blocking; the contract is identical from the caller's perspective.
- **The SQL dialect.** `LocalStore` keeps writing SQLite-flavored SQL. The rewrite/bind layer
  currently inside the worker (SQLite→PG rewrites, `?`/`@name` binding,
  `PRAGMA journal_mode`/`user_version` emulation, `sqlite_master` emulation,
  `INSERT OR IGNORE` → `ON CONFLICT DO NOTHING`, canonical column-case restoration)
  moves verbatim to a main-thread module; it is not redesigned in this refactor.
- **Transcript revision semantics.** On PG: `pg_advisory_xact_lock` + `_transcript_revision_seq`
  inside one transaction per revision-bearing write. On SQLite: in-memory
  `transcriptRevision` seeded from `MAX(revision)`. Revisions stay monotonic per store.
- **Shared-store cross-process rules.** A shared-store statement is a CAS or a relative
  write, never a read-then-write; pool members already race each other, and this refactor
  adds no new cross-process interleaving.
- **Schema, migrations, and on-disk/DB layout.** No schema change; `SCHEMA_VERSION`
  untouched.

## The new seam

`StoreDatabase` becomes async:

```ts
interface StoreDatabase {
  exec(sql: string): Promise<void>
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[]; changes: number }>
  batch(statements: StoreBatchStatement[]): Promise<StoreBatchResult[]>
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>
  close(): Promise<void>
}
```

- `transaction(fn)` replaces today's hand-written `exec('BEGIN')`/`COMMIT`/`ROLLBACK` at the
  12 explicit transaction sites. On PG it pins one pooled client for the callback (BEGIN …
  COMMIT/ROLLBACK on that client); other operations keep using the pool concurrently. On
  SQLite the adapter holds a database-wide async mutex for the duration — one connection
  means a concurrent statement would otherwise join an open transaction.
- The SQLite adapter executes synchronously under the hood and returns resolved promises;
  it serializes all operations through the same mutex so a transaction window is never
  interleaved.
- `PostgresAsyncDatabase` owns a `pg.Pool` (size from `DataPlaneConfig.maxConnections`),
  the ported dialect module, schema bootstrap (advisory schema lock, `search_path`,
  `_local_store_schema_version`, `_transcript_revision_seq`), and
  `finishSchemaInitialization()` releasing the advisory lock. The worker thread and both
  `Atomics.wait` sites are deleted.

## Intra-process atomicity: the one new hazard

Today the sync bridge blocks the main thread, so every multi-statement `LocalStore` method
is atomic with respect to all other daemon JavaScript. Async execution lets two turns
interleave between a method's statements. Every multi-statement method gets one of three
recorded treatments:

1. **`transaction()`** — the 12 explicit BEGIN/COMMIT sites (`setSessionMuted`,
   `closeIdleSessions`, `deleteSession`, `claimSessionPurges`, `acknowledgeSessionPurges`,
   `coalesceHookInbox`, `recordLoopGuardTurnForInbox`, `claimActivationObservation`,
   `expireActivations`, `createOrchestration`, `recordRuntimeCatalogMeta`, `upgradeSchema`),
   plus `claimMemoryCapture`'s claim-then-read pair.
2. **Already CAS-shaped, leave as is** — sequences designed for cross-process races on the
   shared store are also safe under intra-process interleaving: `mergeUsage` (guarded UPDATE
   retry loop), the loop-guard trip latch, `appendMemoryCapture`'s insert-then-classify,
   claim/release methods with `WHERE state = …` guards, `nextSandboxGeneration`
   (upsert + RETURNING).
3. **Store-internal transcript mutex** — one async mutex serializes the transcript write
   path: `appendTranscript`, `insertToolCall`/`writeTranscriptRows`, `updateToolCall`'s
   buffer flush, and the in-memory `transcriptRevision` updates that must stay in lockstep
   with the statements around them. Transcript reads and all non-transcript traffic stay
   concurrent; the mutex only recreates, for this one path, the serialization the sync
   bridge used to provide for free.

The tool-write buffer keeps its shape (latest-wins map, 200 ms timer, 64-entry / 4 MiB
early flush). `drainPendingWritesFirst` becomes async: every database entry point awaits
the in-flight flush promise first; a failed flush re-arms and rethrows exactly as today.

## Construction becomes two-phase

`new LocalStore(...)` currently probes `sqlite_master`, runs migrations, executes the DDL
block, seeds `transcriptRevision`, and expires stale permission requests — all in the
constructor. That moves to `static async LocalStore.open(source)` with a private
constructor; the load-bearing ordering (fresh-probe → migrations → CREATE block) becomes an
awaited sequence with the same comments. `PostgresDataPlane.open` already has the async
factory shape and simply awaits the store too; the daemon's SQLite fallback awaits
`LocalStore.open(statePath(root))` inside `Daemon.start()`.

## Sync contexts that must be dissolved first

Behavior-preserving enabling refactors, shippable independently before the API flip:

- **`routeRules` sync `threadOwner` callback** (`packages/activation-policy`): the policy
  package stays pure and sync. The daemon prefetches the owner/participants for the one
  candidate thread key before calling `routeRules` and passes a closure over the prefetched
  values.
- **Transcript mutation listener re-entrancy**: `notifyTranscriptMutation` currently invokes
  the daemon's listener synchronously mid-write, and the listener reads the store. Dispatch
  moves to post-commit (`queueMicrotask`), so a listener never re-enters an open
  transaction; `scheduleSessionActivity` then awaits its own read.
- **`DreamRunner` constructor** store calls move into an async `start()`/factory.
- **Callback sinks widened to `void | Promise<void>`**: Slack/channel name-resolver `save`
  / `saveAvatar` / `saveScope`, `CpRoutingLayer.load`, and the memory provider's
  `outbox.enqueue`. Cache-style saves become awaited-in-background writes with error
  logging; `enqueue` and `load` become genuinely awaited by their owners.
- **Startup ordering** (`sweepAgeOnly` before catalog hydrate before CP client) is already
  inside `async Daemon.start()`; the ordering survives as sequential awaits and keeps its
  comments.

## Call-site migration

The API flip cannot compile halfway, so it lands as one compiler-driven wave on a feature
branch: flip the store, then chase `await` through the ~420 call sites (daemon.ts ~321
across ~108 methods, session-manager, dream-runner, memory outbox, session-reader,
model-catalog, thread-context, retention) until `pnpm typecheck` is clean. Fire-and-forget
is permitted only for the named cache writes; everything else awaits. Tests gain one shared
factory (`test/store-support.ts: openTestStore()`) replacing the 98 direct constructions
across 25 files, keeping the existing SQLite/PG dual-backend switch from
`test/store-postgres/backend.ts`.

## Verification

- Existing suites on both backends: default Vitest project (SQLite) and
  `vitest.postgres.config.ts` (Testcontainers PG), plus `local-store-sql-portability`.
- New targeted concurrency tests: interleaved turns hammering the treatments above
  (usage CAS, transcript mutex, transaction sites) on both backends.
- Rerun the 2026-08-16 capacity benchmark; the daemon-capacity rungs and the
  event-loop-delay p99 are the acceptance evidence. Expected direction: event-loop delay
  collapses and the saturation rung moves up toward the `async-pool` trace ceiling; the
  report, not a promised ratio, is the deliverable.
- Graceful-shutdown check: `close()` drains the tool buffer, waits for in-flight
  operations, then ends the pool.

## Non-goals

- Redesigning the SQL dialect layer, schema, or retention semantics.
- Making `packages/activation-policy` async.
- Streaming/cursor read APIs, per-table repositories, or splitting LocalStore.
- Changing SQLite into a worker or WAL settings.
