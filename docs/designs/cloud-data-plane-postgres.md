# Cloud daemon data-plane PostgreSQL

Install-wide cloud daemons run their complete durable store in PostgreSQL. A cloud
daemon must not open `state/local.sqlite`, use SQLite as a write-through cache, or
replicate a subset of SQLite rows into PostgreSQL. PostgreSQL is the only durable
write target and the source of every restart/read-back decision.

This rule applies to every process started with `--k8s`, including the pooled
`ac-cloud-daemon` identity and single-organization envelope daemons. Local and
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
5. Exercise the shared-database integration test with `DATA_PLANE_TEST_DATABASE_URL` before release.

The PostgreSQL transcript tables preserve the SQLite transcript's insertion sequence,
mutation revision, per-agent recipients, tool bodies, attachment/quote sidecars, and
chronological event-time index. Transcript mutations assign revisions under a
PostgreSQL advisory transaction lock, making revision order commit-safe across daemon
members.

There is no SQLite-to-PostgreSQL backfill or dual-write cutover inside a running cloud
daemon. Deployments migrate the PostgreSQL schema first, stop any pre-single-store
cloud workload, and then start binaries that use PostgreSQL exclusively. Local
SQLite files are not imported because they belong to a different deployment shape
and authority boundary.
