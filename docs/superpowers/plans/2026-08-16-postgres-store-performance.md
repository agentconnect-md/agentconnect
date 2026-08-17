# Cluster Daemon PostgreSQL Capacity Benchmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans task by task.

**Goal:** Add an opt-in real-PostgreSQL benchmark that measures current cluster-daemon concurrency and characterizes the synchronous bridge with same-trace async-single and async-pool comparisons.

**Architecture:** Pure benchmark support owns settings, sampling, statistics, saturation, and report validation. One integration entry uses the production daemon/data-plane path for capacity and three benchmark executors for the controlled storage trace. A dedicated Vitest configuration owns one PostgreSQL Testcontainer and keeps the benchmark outside the default suite.

**Tech Stack:** TypeScript, Vitest 4, `pg`, Testcontainers PostgreSQL 16, production daemon store classes.

---

### Task 1: Statistics, settings, and capacity derivation

**Files:**

- Create: `packages/daemon/test/performance/postgres-capacity-support.test.ts`
- Create: `packages/daemon/test/performance/postgres-capacity-support.ts`

- [ ] Write failing tests for strict concurrency-list parsing, numeric settings (100-turn minimum), nearest-rank percentiles, 10 ms drift sampling, timer-race plus elapsed-time timeout classification, and the four saturation rules.
- [ ] Run the focused unit test and confirm RED because the support module is absent.
- [ ] Implement the smallest pure support module, including injected clock/timer seams where required.
- [ ] Run the focused unit test and confirm GREEN.

### Task 2: Same-trace sync/async PostgreSQL executors

**Files:**

- Create: `packages/daemon/test/performance/postgres-trace.ts`
- Create: `packages/daemon/test/performance/postgres-trace.test.ts`
- Create: `packages/daemon/test/performance/postgres-trace-contract.bench.ts`

- [ ] Write failing tests against fake executors proving the trace has exactly 17 hand-offs, yields after every hand-off in every mode, preserves batch boundaries, and generates unique turn identifiers.
- [ ] Define a small executor contract with `exec`, `query`, `batch`, and `close`; implement the deterministic trace independently of either executor.
- [ ] Define canonical `?`-placeholder statements with an explicitly qualified private schema. Implement executor-specific binding, normalized results, and sequential-autocommit batches on one checked-out client.
- [ ] Implement `SyncWorkerTraceExecutor` over `PostgresSyncDatabase`, plus the same `AsyncTraceExecutor` over `pg.Pool` sizes 1 and N. Keep one-line comments only.
- [ ] Run the trace unit tests and confirm GREEN.
- [ ] Add an opt-in real-PostgreSQL contract entry in `postgres-trace-contract.bench.ts` that runs both executor kinds from clean state and proves identical normalized results and final rows; never put Docker work in default-discovered `.test.ts` files.

### Task 3: Real daemon harness

**Files:**

- Create: `packages/daemon/test/performance/postgres-daemon-harness.ts`
- Create: `packages/daemon/test/performance/postgres-daemon-harness.test.ts`

- [ ] Write a failing lifecycle test with fake injected boundaries: generate N active agents, start one Kubernetes-mode daemon, run concurrent independent evaluation turns, and stop cleanly.
- [ ] Implement a per-agent scripted ACP host with the exact emission order, 38 pauses including one after the final emission, unique session/tool IDs, and no shared update callback.
- [ ] Implement daemon scaffolding with limits at least as large as the maximum rung and evaluation memory explicitly off. Build a `satisfies K8sRuntimePlane` fake implementing every interface member, including `withSandbox`, `ensureChannel`, `probeRuntimes`, `workspaceRootFor`, `runsInSandbox`, `gitRunnerFor`, `workspaceFilesFor`, `memoryFsFor`, `clearPath`, launch/adopt/release/suspend/discard methods, and shutdown.
- [ ] In the integration entry inject `openDataPlane` to call `PostgresDataPlane.open` with the fixed authoritative benchmark org resolver, and inject a resolving CP startup barrier. Do not replace `PostgresDataPlane` or `LocalStore`.
- [ ] Assert the harness uses distinct agents/conversations, returns terminal output, and never overlaps turns within one agent.
- [ ] Add a real-PostgreSQL assertion proving generated-agent transcript writes resolve to the benchmark organization.
- [ ] Run the focused lifecycle test and confirm GREEN.

### Task 4: Real benchmark entry and isolated runner

**Files:**

- Create: `packages/daemon/test/performance/postgres-capacity.bench.ts`
- Create: `packages/daemon/test/performance/postgres-capacity-global-setup.ts`
- Create: `packages/daemon/vitest.postgres-capacity.config.ts`
- Create: `packages/daemon/test/performance/tsconfig.json`
- Modify: `packages/daemon/package.json`

- [ ] Create the one-worker Vitest config and benchmark-specific Testcontainer setup first. Provide URL, image, and queried server version; set a timeout large enough for every default rung and mode.
- [ ] Write a failing real-PostgreSQL benchmark slice that checks one daemon rung and executor equivalence before implementing the full ladder.
- [ ] Implement per-rung lifecycle in this exact order: reset, initialize, warm, measure at least 100 completed turns and four waves while healthy, verify before close, close, reset. Stop admitting work after error/timeout, record the partial rung, and fully drain the owner before continuing.
- [ ] Run fresh daemon rungs, then fresh sync-worker, async-single, and async-pool trace rungs. Measure with the shared latency/event-loop sampler, classify late timer callbacks by elapsed time too, and retain every rung summary.
- [ ] Enforce only structural invariants, derive capacities, compute matched-rung ratios, and emit exactly one parseable JSON report.
- [ ] Add `perf:postgres-capacity` to the daemon package and a no-emit TypeScript config for all benchmark sources.
- [ ] Run `pnpm --filter @agentconnect.md/daemon perf:postgres-capacity`; confirm the daemon and all three trace modes complete and exactly one report is emitted.

### Task 5: Verification

- [ ] Run `pnpm --filter @agentconnect.md/daemon exec vitest run test/performance/postgres-capacity-support.test.ts test/performance/postgres-trace.test.ts test/performance/postgres-daemon-harness.test.ts`.
- [ ] Run the opt-in benchmark from a clean database.
- [ ] Run `pnpm --filter @agentconnect.md/daemon exec tsc -p test/performance/tsconfig.json`.
- [ ] Run `pnpm --filter @agentconnect.md/daemon exec vitest list | rg 'postgres-capacity\.bench'` and require no match.
- [ ] Run `pnpm exec prettier --check packages/daemon/test/performance packages/daemon/vitest.postgres-capacity.config.ts packages/daemon/package.json docs/superpowers/specs/2026-08-16-postgres-store-performance-design.md docs/superpowers/plans/2026-08-16-postgres-store-performance.md`.
- [ ] Inspect the final diff for accidental production changes. Verify `completed + errors + timeouts === attempted` for every rung and require the sample target only for healthy rungs.
- [ ] Report the measured capacity range, the first saturation reason, sync/async ratios, host context, and the workload caveat.
