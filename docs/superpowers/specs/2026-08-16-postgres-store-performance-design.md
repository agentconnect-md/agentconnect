# Cluster Daemon PostgreSQL Capacity Benchmark Design

## Purpose

Add an opt-in benchmark that answers two separate questions:

1. How many independent agent turns can one current cluster daemon serve concurrently for a declared synthetic workload?
2. How large is the blocking/serialization penalty of the synchronous PostgreSQL bridge on a controlled storage trace?

The benchmark produces measurements, not a universal agent-capacity constant. Capacity always depends on the turn shape, PostgreSQL latency, CPU, and runtime response timing, so every report includes the workload and host description.

## Experiments

### Current-daemon capacity

Run one real `Daemon` in Kubernetes mode over the production `PostgresDataPlane`, `PostgresSyncDatabase`, and `LocalStore`. Inject only external boundaries: a scripted ACP host, the Kubernetes runtime-plane seam, an authoritative benchmark agent-to-organization resolver, and the control-plane startup barrier. The turn enters through `runEvaluationTurn`, so it still crosses the daemon's agent dispatch, serial gate, session manager, transcript, tool, usage, and post-turn paths. Browser-owned evaluation turns intentionally bypass the durable inbox, so inbox admission and cleanup cost is excluded and identified as such in the report.

Generate one active agent and one persistent conversation per concurrency slot. At each rung `1, 2, 4, 8, 16, 32, 64`, launch independent turns concurrently. A healthy rung runs at least four complete waves and collects at least 100 measured turns. The scripted host emits a fixed sequence per turn:

- one reasoning update;
- six tool calls;
- five updates per tool call;
- one final message;
- one usage result;
- a 5 ms asynchronous pause after each emission, including the final message.

The 38 pauses per turn represent an intentionally fast streaming provider. They are not intended to imitate model thinking time; they give the event loop observable work while persistence traffic from multiple sessions overlaps.

Every rung gets a freshly reset database and a newly started daemon. Seed all participating agents identically, then run one unreported warm-up turn per agent before measurement. Sessions remain persistent only within that rung. Turn, message, and tool identifiers remain unique so deduplication cannot remove work. This prevents higher rungs from inheriting the lower rungs' database growth, caches, or process state.

### Synchronous-bridge attribution

Run a second saturated PostgreSQL experiment at the same concurrency ladder. All modes execute the exact same benchmark-owned statement templates, parameters, ordering, batch boundaries, and database schema:

- `sync-worker`: one production `PostgresSyncDatabase`, including its worker hand-off, single `pg.Client`, and `Atomics.wait` behavior;
- `async-single`: a benchmark-only awaited executor with one `pg` connection;
- `async-pool`: the same awaited executor with pool size equal to the configured async connection limit.

The trace has 17 benchmark-owned database hand-offs. It mixes inserts, updates, reads, and multi-statement batches. Every trace yields at the same benchmark-controlled boundary after each hand-off, including in sync mode, so concurrent traces get the same interleaving opportunities. Each logical async batch checks out one connection and executes all its statements sequentially in autocommit order, matching the production sync batch. Its private benchmark tables avoid claiming that a small async executor implements the full `LocalStore` contract.

`sync-worker` versus `async-single` estimates main-thread blocking and worker-bridge cost while holding PostgreSQL connection parallelism at one. `async-single` versus `async-pool` measures the additional concurrency unlocked by multiple connections. The trace is not production `LocalStore` SQL, so these ratios explain the mechanism but cannot be applied arithmetically to the daemon-capacity result. This is not a production async store and does not prove that a full async `LocalStore` conversion will realize the entire difference.

## Capacity Rule

For each experiment and concurrency rung, report throughput, turn latency p50/p95/p99, event-loop delay p99/max, attempted turns, completed turns, errors, and timeouts. Every healthy rung collects at least 100 completed samples and at least four measured waves. A rung with an error or timeout stops accepting work early, records its partial counts, and is saturated without having to reach the healthy sample target. A rung is saturated when any of these first occurs:

- p95 infrastructure latency exceeds twice the concurrency-1 baseline;
- throughput improves by less than 20% over the previous rung;
- event-loop delay p99 exceeds 1 second;
- any turn errors or exceeds 30 seconds.

The reported capacity is the highest rung before the first saturated rung. If the first rung saturates, capacity is reported as below the measured range. If no rung saturates, capacity is reported as at least the largest measured rung. The report also retains all raw rung summaries so the user can reject or reinterpret the heuristic.

For the daemon experiment, infrastructure latency is measured turn wall time minus the scripted 5 ms pauses. For the storage A/B, it is total trace wall time because there is no simulated provider delay.

## Event-loop Measurement

Use a 10 ms recurring drift sampler started before each measured rung. Each sample records `actual callback time - expected callback time`; the sampler is allowed one final callback after work completes before it is stopped. This directly observes the symptom relevant to the design: the daemon main thread could not run scheduled JavaScript while `Atomics.wait` blocked it. A timeout is classified both by a timer race and by elapsed wall time after completion because a blocked main thread can delay the timer itself.

The async executors run on the same main thread and use the same sampler. On a daemon timeout, the rung admits no more turns, waits for the production 30-second store bound to return, then drains/stops that rung's daemon before any reset or later rung starts.

## Isolation and Configuration

The benchmark is excluded from default `pnpm test` discovery and runs in one Vitest worker against one `postgres:16-alpine` Testcontainer. A benchmark-specific global setup provides the database URL, configured image, and queried PostgreSQL version. It has a dedicated package script and config.

Environment variables:

- `AC_PG_CAPACITY_CONCURRENCY`, default `1,2,4,8,16,32,64`;
- `AC_PG_CAPACITY_MIN_TURNS`, default `100`, minimum `100`;
- `AC_PG_CAPACITY_MIN_WAVES`, default `4`, minimum `4`;
- `AC_PG_CAPACITY_STREAM_DELAY_MS`, default `5`, minimum `0`;
- `AC_PG_CAPACITY_ASYNC_POOL_SIZE`, default `16`, minimum `1`;
- `AC_PG_CAPACITY_TURN_TIMEOUT_MS`, default `30000`, minimum `1000`.

The exact lifecycle for every rung is reset, initialize owner, warm up, measure, verify, close owner, then reset. The daemon closes its `PostgresDataPlane` before reset. The sync executor releases its schema lock and closes its worker before reset. Async clients are closed before reset. Warm-up samples and setup are excluded from reported metrics.

## Output

Emit exactly one stable JSON document after all checks pass. It contains:

- schema version and an explicit synthetic-benchmark warning;
- Node, OS, architecture, CPU, and PostgreSQL container metadata;
- all workload settings and statement/update counts;
- daemon-capacity rungs and derived capacity;
- sync-worker, async-single, and async-pool rungs and their derived capacities;
- per-rung throughput, latency percentiles, event-loop delay, completed turns, errors, and timeouts;
- sync/async-single and async-single/async-pool throughput and p95 ratios at matching rungs.

No latency or throughput number is a test assertion. Assertions cover structural correctness: `completed + errors + timeouts === attempted`, healthy-rung sample targets, persisted terminal state, transcript/tool counts, exact trace shape and equivalent final rows across executors, finite ordered metrics, valid saturation derivation, and one parseable report emission. Inbox residue is not asserted because this evaluation surface excludes the durable inbox.

## Non-goals

- Implementing an async `LocalStore` or changing production behavior.
- Measuring provider/model capacity, platform network ingress, or Control Plane traffic.
- Calling one synthetic result the average capacity of every real agent workload.
- Adding a CI performance threshold; Docker-host timings are diagnostic and comparable only on similar hosts.

## Commands

```bash
pnpm --filter @agentconnect.md/daemon exec vitest run test/performance/postgres-capacity-support.test.ts
pnpm --filter @agentconnect.md/daemon perf:postgres-capacity
pnpm --filter @agentconnect.md/daemon exec tsc -p test/performance/tsconfig.json
```
