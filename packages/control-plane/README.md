# @agentconnect.md/control-plane

The AgentConnect **Control Plane (CP)** — the server side of the daemon↔CP
WebSocket protocol (`docs/designs/daemon-cp-ws-protocol.md`). One Node process
(one Fastify instance) co-hosts the **C2 BFF REST** surface and the **daemon WS
endpoint**, sharing one port and one Postgres connection. The CP stores **only
control-plane metadata** — never message bodies, ACP `session/update` streams, or
attachment bytes (those stay daemon-local).

See `docs/designs/control-plane-implementation.md` for the architecture
reference (module layout §2, Prisma schema §3, WS wiring §4, and testing §5).

## Composition

Everything is assembled through a single root so production and tests build the
identical graph:

- `src/config/env.ts` — `loadConfig()`: zod-validated `process.env` → `AppConfig`
  (fail-fast on boot).
- `src/container.ts` — `buildContainer(config, prisma, clock, secretsProvider)`:
  manual DI, wires repos → services (C3/C4/C5) → the two edges. The only place
  outside `persistence/` aware of concrete repo classes.
- `src/app.ts` — `buildApp({ prisma, clock?, secretsProvider?, config?, fastify? })`:
  the factory **both** prod and tests call. Returns `{ http, mountWs(), shutdown() }`.
- `src/index.ts` — the thin bootstrap: `loadConfig → buildApp → http.listen →
mountWs → SIGTERM/SIGINT → shutdown`.

Tests never call `index.ts`; they call `buildApp(...)` with the shared
Testcontainers `PrismaClient`, a `FakeClock`, and a memory secrets provider.

## Configuration

`AppConfig` (see `src/config/env.ts`) is parsed from the environment. Required:

| var              | meaning                                            |
| ---------------- | -------------------------------------------------- |
| `DATABASE_URL`   | Postgres connection (Prisma)                       |
| `API_KEY_PEPPER` | HMAC pepper for daemon API-key hashes (≥ 32 chars) |

Common optional knobs (with defaults): `PORT=8080`, `HOST=0.0.0.0`,
`WS_PATH=/daemon/ws`, `HEARTBEAT_SEC=15`, `MISSED_BEATS=3`,
`REASSIGN_GRACE_SEC=60`, `ACK_TIMEOUT_MS=5000`,
`SECRETS_PROVIDER=memory`, `OIDC_ISSUER` (unset ⇒ devAuth stub for the WebUI),
`SECRET_CIPHER=none` (identity storage transform; set `vault-transit` +
`VAULT_ADDR` + one of `VAULT_TOKEN`/`VAULT_JWT_ROLE` to encrypt stored tenant
secrets with HashiCorp Vault Transit — see
docs/designs/secret-store-seams.md and `.env.example` for the full variable
list).

## Develop

### Local dev quickstart

From the **repo root**, copy the env template and fill it in (real values stay in
`.env`, which is gitignored):

```bash
cp .env.example .env # then edit DATABASE_URL + API_KEY_PEPPER
```

**Option A — fully local Postgres (Docker).** Fastest to iterate:

```bash
docker run -d --name acp-pg -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=agentconnect \
  -p 5432:5432 postgres:16-alpine
# .env: DATABASE_URL=postgresql://postgres:pw@localhost:5432/agentconnect?schema=public
#       API_KEY_PEPPER=<any 32+ char string>

pnpm install
pnpm --filter @agentconnect.md/control-plane exec prisma migrate deploy # create schema
pnpm --filter @agentconnect.md/control-plane exec prisma db seed        # default org/user
pnpm --filter @agentconnect.md/control-plane run db:seed:example        # (optional) demo rows
pnpm --filter @agentconnect.md/control-plane dev                        # tsx watch → :8080
```

**Option B — operator-provided remote development Postgres.** Point
`DATABASE_URL` in your local `.env` at the endpoint supplied by its operator.
Never commit the connection string. The schema and seed need to be applied only
by whoever owns migrations; other developers can run `dev`:

```bash
# .env: DATABASE_URL=postgresql://app:<password>@db.example.test:5432/agentconnect?schema=public
pnpm install && pnpm --filter @agentconnect.md/control-plane dev
```

> **Your tests never touch the configured development DB.** The integration test
> project boots its own throwaway `postgres:16` via Testcontainers and overrides
> `DATABASE_URL` for the run (see [Test](#test)).

Verify it's up:

```bash
curl -s http://localhost:8080/health # → {"status":"ok"}
```

The REST surface is **versioned under `/api/v1`** (see
[`docs/designs/api-versioning.md`](../../docs/designs/api-versioning.md)): the
caller's `/api/v1/orgs` and `/api/v1/me`, and every tenant resource org-scoped
under `/api/v1/orgs/:orgId/*` (`agents`, `daemons`, `keys`, `integrations`,
`bots`, `members`, `crons`, `sessions`, `usage`, and SSE `stream`). Two surfaces
stay **unversioned**: `GET /health` (an infra probe, hit at a stable path — the
`curl …/health` above is unchanged) and the daemon socket at `WS_PATH` (default
`/daemon/ws`, subprotocol `agentconnect.v1`), versioned in-band by its protocol
frames. The CP issues a short-lived browser token at
`POST /api/v1/orgs/:orgId/agents/:agentId/webchat/token`; the browser then dials
the relay's `/webchat` WebSocket.

### Other commands

```bash
pnpm --filter @agentconnect.md/control-plane prisma:generate # regenerate the client
pnpm --filter @agentconnect.md/control-plane build \
  && pnpm --filter @agentconnect.md/control-plane start # run the built output
```

## Migrate

Prisma schema: `prisma/schema.prisma`. The `threadKey` generated column, the
partial-unique routing index, and the array GIN indexes are hand-edited into the
migration SQL (§3.13). Seed (`prisma/seed.ts`) creates the default single-tenant
Org + owner User.

The v1 baseline targets an empty PostgreSQL database. Databases created from a
pre-v1 release candidate must be reset rather than upgraded in place. Starting
with v1, committed migrations are append-only and must not rewrite the baseline.

```bash
pnpm --filter @agentconnect.md/control-plane exec prisma migrate dev    # dev: create/apply
pnpm --filter @agentconnect.md/control-plane exec prisma migrate deploy # CI/prod: apply
pnpm --filter @agentconnect.md/control-plane exec prisma db seed        # seed defaults
```

### Example data

`prisma/seed-example.sql` populates realistic demo rows (a daemon + runtime
profiles, two agents + seq cursors, workspaces, a routing assignment, a session
milestone, a cron, an audit row) — all **control-plane metadata, no message
bodies**. It is **idempotent** (re-runnable). Apply it after the migration:

```bash
pnpm --filter @agentconnect.md/control-plane run db:seed:example
# or directly: psql "$DATABASE_URL" -f packages/control-plane/prisma/seed-example.sql
```

### Using a remote development database

If a team supplies a remote Postgres for development, **only its migration owner
(or CI) runs `prisma migrate deploy` + `db:seed:example`** on schema changes.
Everyone else can run `dev`. Never commit its connection string; keep it in the
gitignored `.env` (template in `.env.example`) and prefer per-developer roles
over a shared superuser. The test suite remains isolated in Testcontainers.

## Test

Vitest, two projects. **No `docker compose` precondition** — the integration
project boots a `postgres:16-alpine` via Testcontainers (Docker required),
`migrate deploy`s once, clones one database per Vitest pool, and truncates each
pool-local database before a test. Files run with four workers by default;
`INTEGRATION_TEST_WORKERS` can tune the count for the runner.

```bash
pnpm --filter @agentconnect.md/control-plane test      # unit + integration (needs Docker)
pnpm --filter @agentconnect.md/control-plane test:unit # unit only, NO Docker (inner TDD loop)
pnpm --filter @agentconnect.md/control-plane test:int  # integration only
```

Typecheck / build:

```bash
pnpm --filter @agentconnect.md/control-plane typecheck
pnpm --filter @agentconnect.md/control-plane build
```
