# Async LocalStore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task by task.

**Goal:** Replace the blocking `PostgresSyncDatabase`/worker bridge with an async `StoreDatabase` contract: `LocalStore` becomes Promise-returning, PostgreSQL runs on an awaited main-thread `pg.Pool`, SQLite stays `DatabaseSync` under an async facade. Design: `docs/superpowers/specs/2026-08-17-async-local-store-design.md`.

**Architecture:** Tasks 1–3 are independently shippable and behavior-preserving (new async database layer beside the old one; enabling refactors that dissolve the hard sync contexts). Task 4 flips `LocalStore` and every call site in one compiler-driven wave on a feature branch. Task 5 deletes the sync bridge and turns on pool parallelism. Task 6 verifies, including a capacity-benchmark rerun against the pre-refactor report.

**Tech Stack:** TypeScript, `pg` Pool, `node:sqlite`, Vitest 4, Testcontainers PostgreSQL 16.

---

### Task 1: Async `StoreDatabase` contract + SQLite adapter

**Files:**

- Create: `packages/daemon/src/store/store-database.ts` (interface + `StoreBatchStatement`/`StoreBatchResult`, moved out of `local-store.ts`)
- Create: `packages/daemon/src/store/sqlite-async-database.ts`
- Create: `packages/daemon/test/store-database.test.ts`

- [ ] Write failing tests for the async contract over SQLite: `exec`/`query`/`batch` resolve after durability, `transaction(fn)` commits/rolls back, and — the load-bearing one — a statement issued concurrently while a transaction is open waits for COMMIT (database-wide mutex) instead of joining it.
- [ ] Define the async `StoreDatabase` with `exec`, `query`, `batch`, `transaction<T>(fn)`, `close`. Drop the prepared-statement facade (`prepare`/`StoreStatement`) in favor of `query` — statement caching is an adapter concern.
- [ ] Implement the SQLite adapter: synchronous `DatabaseSync` work behind resolved promises, one async mutex serializing all operations, `transaction` holding it across BEGIN…COMMIT.
- [ ] Confirm GREEN. Do not touch `local-store.ts` yet.

### Task 2: Main-thread `PostgresAsyncDatabase` (dialect layer ported from the worker)

**Files:**

- Create: `packages/daemon/src/store/postgres-dialect.ts` (rewrite/bind/canonical columns/PRAGMA + `sqlite_master` emulation, moved from `postgres-store-worker.js`)
- Create: `packages/daemon/src/store/postgres-async-database.ts`
- Create: `packages/daemon/test/postgres-async-database.int.test.ts` (postgres Vitest project)
- Test: `packages/daemon/test/local-store-sql-portability.test.ts` (extend, don't fork)

- [ ] Write failing unit tests for the ported dialect module: every rewrite rule, `?` and `@name` binding, revision-slot detection, `INSERT OR IGNORE`, PRAGMA/user_version/sqlite_master emulation — asserting byte-identical output to the worker's current behavior.
- [ ] Extract the dialect functions from `postgres-store-worker.js` into `postgres-dialect.ts`; make the worker import it so old and new paths share one implementation during the transition.
- [ ] Implement `PostgresAsyncDatabase`: `pg.Pool` (size from `DataPlaneConfig.maxConnections`), schema bootstrap (advisory schema lock, `search_path`, version table, revision sequence), `finishSchemaInitialization()`, `transaction` pinning one pooled client, transcript-revision advisory-lock transaction for revision-bearing writes.
- [ ] Add an integration equivalence test: run a representative statement set through `PostgresSyncDatabase` and `PostgresAsyncDatabase` from clean schemas and assert identical normalized rows/changes.
- [ ] Confirm GREEN on both the unit and postgres projects.

### Task 3: Enabling refactors (behavior-preserving, land before the flip)

**Files:**

- Modify: `packages/daemon/src/daemon.ts`, `packages/daemon/src/session/session-manager.ts`
- Modify: `packages/daemon/src/store/local-store.ts` (listener dispatch only)
- Modify: `packages/daemon/src/agents/dream-runner.ts`
- Modify: `packages/daemon/src/slack/name-resolver.ts`, `packages/daemon/src/messages/channel-name-resolver.ts`, `packages/daemon/src/memory-plugin/outbox.ts` callers

- [ ] `routeRules` prefetch: compute `threadOwner`/`threadParticipants` for the candidate thread key before each `routeRules` call and pass closures over the prefetched values; `packages/activation-policy` stays untouched. Verify with existing activation tests.
- [ ] Post-commit listener dispatch: `notifyTranscriptMutation` queues the transcript-mutation listener via `queueMicrotask` instead of invoking it mid-write; assert existing transcript/session-activity tests still pass and add one test that the listener never observes a half-applied batch.
- [ ] `DreamRunner`: move the constructor's `supersededDreams()` sweep into an async `start()` called from `Daemon.start()`.
- [ ] Widen the name-resolver `save`/`saveAvatar`/`saveScope`, `CpRoutingLayer.load`, and memory-provider `outbox.enqueue` seams to `void | Promise<void>` (or async) so the flip has somewhere to put its awaits.
- [ ] Run the full daemon test suite; zero behavior diffs expected.

### Task 4: Flip `LocalStore` async and migrate every call site

**Files:**

- Modify: `packages/daemon/src/store/local-store.ts` (all ~195 methods; `static async open`)
- Modify: `packages/daemon/src/store/postgres-data-plane.ts`, `packages/daemon/src/store/retention.ts`
- Modify: `packages/daemon/src/daemon.ts` (~321 sites), `session/session-manager.ts`, `session/thread-context.ts`, `agents/dream-runner.ts`, `memory-plugin/outbox.ts`, `cp/session-reader.ts`, `runtimes/model-catalog.ts`
- Create: `packages/daemon/test/store-support.ts` (`openTestStore()`)
- Modify: 25 test files (98 `new LocalStore(` sites)

- [ ] Convert the constructor to `static async open(source)`: fresh-probe → migrations → CREATE block → revision seed → permission-request expiry as sequential awaits, keeping the ordering comments. `PostgresDataPlane.open` and `Daemon.start()` await it.
- [ ] Convert methods per the design's three treatments: `transaction()` at the 12 explicit BEGIN/COMMIT sites plus `claimMemoryCapture`; CAS-shaped sequences unchanged (record the audit as one-line comments where non-obvious); the transcript mutex around `appendTranscript`/`writeTranscriptRows`/`flushToolCallWrites` and the `transcriptRevision` field updates.
- [ ] Make `drainPendingWritesFirst` await the in-flight flush; keep the buffer's re-arm-on-failure behavior; make `close()` async (flush, wait for in-flight ops, close backend).
- [ ] Chase `await` through all consumers until `pnpm --filter @agentconnect.md/daemon typecheck` is clean. Fire-and-forget is allowed only at the cache-write sinks named in the design; every other call awaits. Keep startup ordering (`sweepAgeOnly` → catalog hydrate → CP client) as sequential awaits.
- [ ] Add `openTestStore()` and migrate the 98 test construction sites; keep the SQLite/PG dual-backend switch from `test/store-postgres/backend.ts`.
- [ ] Run the default daemon suite and the postgres project; fix fallout file by file.

### Task 5: Delete the sync bridge, enable pool parallelism

**Files:**

- Delete: `packages/daemon/src/store/postgres-sync-database.ts`, `packages/daemon/src/store/postgres-store-worker.js`
- Modify: `packages/daemon/src/store/postgres-data-plane.ts`, `packages/daemon/src/store/postgres-config.ts`
- Modify: `packages/daemon/test/store-postgres/setup.ts` (+ backend helpers)

- [ ] Wire `PostgresDataPlane` to `PostgresAsyncDatabase`; reuse or share the existing data-plane `pg.Pool` sizing; remove the worker hand-off and both `Atomics.wait` sites.
- [ ] Point the postgres test project's per-pool database setup at the async database.
- [ ] Add concurrency tests: parallel turns exercising usage CAS, transcript-revision monotonicity under interleaving, and a transaction site, on both backends.
- [ ] `rg -n "Atomics.wait|postgres-store-worker|PostgresSyncDatabase" packages/daemon/src` returns nothing.

### Task 6: Verification and measurement

- [ ] `pnpm --filter @agentconnect.md/daemon test` and the postgres project both GREEN; `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
- [ ] Update `test/performance/` trace executors if they imported the deleted sync bridge; keep the `sync-worker` mode only if the benchmark retains a frozen copy for comparison, otherwise drop that mode and note it in the report schema.
- [ ] Rerun `pnpm --filter @agentconnect.md/daemon perf:postgres-capacity` and diff against the pre-refactor report: capacity rung, p95 infrastructure latency, event-loop delay p99. Record both reports next to this plan.
- [ ] Graceful-shutdown check: a daemon stopped mid-turn drains the tool buffer and ends the pool without unhandled rejections.
- [ ] Inspect the final diff for accidental schema or dialect changes; confirm `SCHEMA_VERSION` untouched.

The post-refactor run is `2026-08-17-async-local-store-post-report.json` next to this plan. No
pre-refactor report was ever committed, so the before/after comparison is the report's own
`traces.syncWorker` ladder — the frozen bridge the benchmark still measures — against
`traces.asyncPool`.
