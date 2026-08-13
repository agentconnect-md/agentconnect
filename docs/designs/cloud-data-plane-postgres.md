# Cloud daemon data-plane PostgreSQL

Cloud daemons started with `--k8s` require a data-plane PostgreSQL connection. Local and self-hosted daemons keep SQLite and never read this configuration.

The daemon accepts no database CLI flag or environment variable. The deployment must mount a Kubernetes Secret at `/var/run/ac-data-plane/config.json`:

```json
{
  "version": 1,
  "databaseUrl": "postgresql://daemon:password@data-plane-postgres:5432/agentconnect",
  "maxConnections": 4
}
```

`databaseUrl` is the install-level execution-data credential. Every cloud daemon connects to this one database and shares one table set for every organization managed by the Control Plane. Organization identity is resolved from the CP agent registry at each store boundary; `org_id` is mandatory in every transcript key, index, and query. There is no per-org database or schema setting. The connection file should therefore be mounted from a Secret, not a ConfigMap.

The daemon refuses `--k8s` startup when the file is absent, invalid, unreachable, or cannot be migrated. Non-Kubernetes startup does not inspect the file, even if it exists.

## Schema upgrades

Data-plane migrations are independent from the Control Plane Prisma migrations. The install-wide `agentconnect_data_plane` schema contains one `_agentconnect_schema_migrations` history. Startup runs pending migrations inside one transaction while holding an install-wide PostgreSQL advisory lock. This makes concurrent startup by several daemon members safe. A migration failure rolls back startup; a schema newer than the daemon is refused.

Migration rules:

1. Append a migration; never edit one already released.
2. Keep each version transactional and safe under a rolling deployment.
3. Add nullable columns or a compatible default before readers require them; destructive cleanup belongs in a later release.
4. Keep old and new daemon versions compatible throughout rolling deployment.
5. Exercise the shared-database integration test with `DATA_PLANE_TEST_DATABASE_URL` before release.

The PostgreSQL transcript tables preserve the SQLite transcript's insertion sequence, mutation revision, per-agent recipients, tool bodies, attachment/quote sidecars, and chronological event-time index. Every uniqueness constraint is organization-scoped, so identical platform identifiers in different organizations cannot collide. Transcript mutation transactions hold a per-org advisory lock while assigning revisions, making revision order commit-safe across daemon members without serializing unrelated organizations. History pages and their organization-scoped terminal revision watermark come from one repeatable-read snapshot, so a concurrent commit cannot be skipped by the next live cursor.
