# Cloud daemon data-plane PostgreSQL

Install-wide cloud daemons run their complete durable store in PostgreSQL. A cloud
daemon must not open `state/local.sqlite`, use SQLite as a write-through cache, or
replicate a subset of SQLite rows into PostgreSQL. PostgreSQL is the only durable
write target and the source of every restart/read-back decision.

This rule applies to every process started with `--k8s`. Since the per-org execution
envelope was deleted, that means the daemon pool's members; there is no
single-organization envelope daemon any more, and the one-shot `reconcile` job opens no
store at all — it needs the sandbox API and a control-plane connection, nothing durable.
Local and
self-hosted daemons started without `--k8s` keep their daemon-local SQLite store and
never read the cloud data-plane configuration.

The daemon accepts no database CLI flag or environment variable. The deployment must mount a Kubernetes Secret at `/var/run/ac-data-plane/config.json`:

```json
{
  "version": 1,
  "databaseUrl": "postgresql://daemon:password@data-plane-postgres:5432/agentconnect",
  "maxConnections": 4
}
```

`databaseUrl` is the install-level execution-data credential. Every cloud daemon
connects to this one database and shares one table set for every organization
managed by the Control Plane. There is no per-org database setting. The connection
file should therefore be mounted from a Secret, not a ConfigMap.

## Store boundary

The PostgreSQL implementation replaces the complete durable `LocalStore` surface,
including:

- sessions, visibility gates, metadata and purge outboxes;
- transcript rows, recipients, tool bodies, attachments, and mutation cursors;
- durable inbox, hook-report receipts, activation rendezvous, and loop guards;
- memory-capture and remote-MCP revocation outboxes;
- cron watermarks, orchestration rows, dreams, and channel-introduction state;
- routing, runtime-catalog, identity/display, and platform-observation caches.

In-process turn streams, live ACP hosts, timers, sockets, and other generation-local
objects remain memory-only. They are not a second store.

The daemon's existing store callers keep their synchronous commit-before-return
contract. Cloud mode satisfies it through a dedicated PostgreSQL worker: the caller
does not return until that worker reports the database commit. This preserves the
durable-admission boundary without opening SQLite or treating memory as committed
state. A local memory cache may accelerate an immutable or reconstructible read, but
it must never be acknowledged as durable, participate in correctness after a restart,
or receive a mirrored durable write.

Organization-owned keys retain their trusted agent, integration, transport, or
protocol-envelope scope. A platform channel/user identifier alone is never a tenant
identity. Cloud replicas share the tables, so durable state transitions use the
same conditional updates and explicit transactions exposed by the store contract.

Replica startup never applies process-lifecycle recovery globally. Permission rows
carry a process owner, and a daemon expires another owner's pending rows only after
the authoritative CP roster assigns their agent to that daemon. Each memory pump
selects, recovers, expires, and measures only the connection ids in its live CP
registry; a `sending` claim becomes recoverable after a two-minute lease, which
exceeds the plugin transport's maximum call timeout. Activation dispatch claims use
a database compare-and-set, and retry if a concurrent release removes the claimed
row before it can be read back.

## Ownership rules for a shared table

Every table here was written for a store with exactly one writer, so sharing it makes
the absence of an owner predicate a defect rather than a simplification. Four rules
apply to any table added from here on; the member-replacement audit retrofitted them
across the store.

1. **A claimable row names its owner and its claim.** `ownerId` plus `claimedAt`, with
   `SHARED_OUTBOX_LEASE_MS` as the lease: a member is offered its own rows, unowned
   rows, and a lapsed peer's rows **for agents it currently serves**; it takes a CAS
   claim before every emit; and the ACK, the failure count and the release are all
   fenced to the claim holder, so a peer can never null a payload it merely read. The
   hook-completion outbox, the session purge receipts and the session-metadata outbox
   all follow this shape. A row whose organization the reader cannot resolve is
   **parked** for the member that can — released and backed off, never failure-counted,
   because circling the pool is not progress.
2. **`ownerId` is a process incarnation, not a member identity.** It is minted per store
   open, which is exactly right for claims and caches and exactly wrong for anything a
   restart should inherit: a per-owner key on install-wide singleton state abandons a row
   on every restart. Such state is either not persisted on a shared store (the CP routing
   map) or keyed by something durable.
3. **Boot recovers only what this incarnation owned.** A member starts while its peers
   serve live traffic, so "unfinished" means "a peer is working on it", not "wreckage".
   Webchat MCP grants and dreams are recovered by owner; a genuinely stranded row is
   reclaimed when the control plane hands this member the agent, and the recovery write
   is itself a CAS so it cannot overwrite a terminal state the real runner recorded.
4. **Concurrent writers use a relative write or a compare-and-set, never a
   read-modify-write.** The PostgreSQL facade rewrites `BEGIN IMMEDIATE` to a plain
   `BEGIN`, so a caller that assumed SQLite's writer lock gets none — the second writer
   merely blocks on the row lock and then overwrites with a stale-derived value. Counter
   increments, usage accumulation, revision tests and single-winner latches are therefore
   single statements with `RETURNING`.

Keys inherit the same widening. An identifier that was unique only within one process —
an ACP session id, for instance — becomes an install-wide collision domain here, so it is
keyed by its owning agent as well; a per-member cache is keyed by its owning member, with
a departed owner's rows reclaimed on a shorter window than the caller's own.

The daemon refuses `--k8s` startup when the file is absent, invalid, unreachable, or cannot be migrated. Non-Kubernetes startup does not inspect the file, even if it exists.

## Schema upgrades

Data-plane migrations are independent from the Control Plane Prisma migrations. The
complete store lives in the install-wide `agentconnect_cloud_store` schema and keeps
its version in `_local_store_schema_version`. Startup holds an install-wide
PostgreSQL advisory lock while checking and applying the schema, so concurrent daemon
members cannot race first creation or an upgrade. A schema newer than the daemon is
refused.

Migration rules:

1. Append a migration; never edit one already released.
2. Keep each version transactional and safe under a rolling deployment.
3. Add nullable columns or a compatible default before readers require them; destructive cleanup belongs in a later release.
4. Keep old and new daemon versions compatible throughout rolling deployment.
5. Keep every statement portable across both drivers, and prove it. The store suites
   re-run against a real `postgres:16` in their own Vitest project and CI job, and a text
   check over `local-store.ts` fails on SQLite-only constructs the worker does not
   rewrite — two-argument `MAX`/`MIN`, `IFNULL`, `IIF`, the date functions, `INSERT OR
REPLACE`, `GROUP_CONCAT`, `printf`, `TYPEOF`, `||` concatenation, comma `LIMIT` — with
   an explicit exempt marker for a statement that has a reason. That list grows by making
   SQL portable, never by teaching the worker another function name.

The PostgreSQL transcript tables preserve the SQLite transcript's insertion sequence,
mutation revision, per-agent recipients, tool bodies, attachment/quote sidecars, and
chronological event-time index. Transcript mutations assign revisions under a
PostgreSQL advisory transaction lock, making revision order commit-safe across daemon
members.

**Transcripts are org-fenced in the store, and only there.** A platform channel/thread id
is unique inside one organization, so on a shared store two organizations can collide on
one `(channel, thread, ts)` key: an `INSERT OR IGNORE` swallowing another org's message,
a thread read serving another org's rows. `transcript` and `transcript_recipient`
therefore carry a `NOT NULL orgId` that joins the recipient primary key and prefixes every
transcript index; writes resolve it from the agent (recipient, else sender, else the agent
that made the thread live) and a shared store **refuses** a row it cannot attribute rather
than filing it where anyone may read it. Reads that keyed on `(channel, thread)` key on
`(org, channel, thread)`. One read stays deliberately unfenced and says so in place:
resolving a Telegram thread from a message runs before routing names an agent, and its key
is a physical-bot-scoped channel — one integration owns that bot, one org owns that
integration — and it returns a thread id, never content. The separate org-fenced transcript
pair that once lived in the `agentconnect_data_plane` schema was constructed and never read
or written; it is deleted, and its schema migration drops the tables, so exactly one store
carries the fence.

There is no SQLite-to-PostgreSQL backfill or dual-write cutover inside a running cloud
daemon. Deployments migrate the PostgreSQL schema first, stop any pre-single-store
cloud workload, and then start binaries that use PostgreSQL exclusively. Local
SQLite files are not imported because they belong to a different deployment shape
and authority boundary.
