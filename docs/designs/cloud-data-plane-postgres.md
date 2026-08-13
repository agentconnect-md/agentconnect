# Cloud daemon data-plane PostgreSQL

Cloud daemons started with `--k8s` require a data-plane PostgreSQL connection. Local and self-hosted daemons keep SQLite and never read this configuration.

The daemon accepts no database CLI flag or environment variable. The deployment must mount a Kubernetes Secret at `/var/run/ac-data-plane/config.json`:

```json
{
  "version": 1,
  "databaseUrl": "postgresql://daemon:password@data-plane-postgres:5432/agentconnect",
  "schema": "org_01abc234",
  "orgId": "org_01abc234",
  "maxConnections": 4
}
```

`databaseUrl` is an install-level execution-data credential. `schema` is the org locator supplied by deployment orchestration. `orgId` is that org's control-plane id, which the daemon states on its control socket: a cloud daemon's Kubernetes identity serves every org and so names none, and the mount is where the same orchestration already says which org this daemon runs for (see "Daemon identity" in [agentconnect-org-operator.md](agentconnect-org-operator.md)). Present ⇒ this is a cloud daemon, and it will not fall back to an API key. Every daemon may connect to the same database, but each org uses a separate schema; store queries set `search_path` to exactly that validated schema. The connection file should therefore be mounted from a Secret, not a ConfigMap.

The daemon refuses `--k8s` startup when the file is absent, invalid, unreachable, or cannot be migrated. Non-Kubernetes startup does not inspect the file, even if it exists.

## Schema upgrades

Data-plane migrations are independent from the Control Plane Prisma migrations. Each org schema contains `_agentconnect_schema_migrations`. First touch runs pending migrations inside one transaction while holding a transaction-scoped PostgreSQL advisory lock derived from the schema name. This makes concurrent first touch by several daemon members safe. A migration failure rolls back startup; a schema newer than the daemon is refused.

Migration rules:

1. Append a migration; never edit one already released.
2. Keep each version transactional and safe under a rolling deployment.
3. Add nullable columns or a compatible default before readers require them; destructive cleanup belongs in a later release.
4. Exercise the shared-schema integration test with `DATA_PLANE_TEST_DATABASE_URL` before release.

The PostgreSQL transcript tables preserve the SQLite transcript's insertion sequence, mutation revision, per-agent recipients, tool bodies, attachment/quote sidecars, and chronological event-time index. Transcript mutation transactions hold a per-org advisory lock while assigning revisions, making revision order commit-safe across daemon members. History pages and their terminal revision watermark come from one repeatable-read snapshot, so a concurrent commit cannot be skipped by the next live cursor.
