# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Product behavior and user-facing invariants are documented in
[`docs/product-conventions.md`](docs/product-conventions.md). Read it before changing
how AgentConnect presents or delivers messages to users.

## What this is

AgentConnect is a multi-agent platform that bridges IM platforms (Slack /
Telegram / Discord) to AI coding agents (Claude, Codex) over ACP. The
authoritative design lives in [`docs/designs/`](docs/designs/) — start with
[architecture.md](docs/designs/architecture.md), and use the grouped index at
[docs/README.md](docs/README.md) to find the rest. Design documentation and every
visual asset embedded in public documentation are maintained in English. Before
adding or reusing a diagram or screenshot, inspect its visible text and verify
that it still matches the current architecture. Prefer diffable SVG or Mermaid
source over opaque raster diagrams.

The defining architectural choice: **the Control Plane is never on the message hot
path.** Agent execution always happens inside a daemon on the data plane. Where
that daemon runs is a deployment choice, not part of the invariant — self-hosted
on machines the organization operates, or a member of the install's managed
Kubernetes pool (Cloud), which shares one PostgreSQL data plane and launches
runtimes in sandbox pods; see §3.1 of the architecture design. Platform ingress
is either daemon-owned directly or forwarded by the optional relay when a stable
public callback endpoint is required; the CP only orchestrates. Concretely:

- A **daemon** owns direct platform connections, local routing, provider API egress,
  and agent execution over **ACP the Control Plane never sees** (local IPC self-hosted;
  one in-cluster dial to the sandbox pod in the pool).
  It also accepts pre-addressed public ingress from the relay. It is a self-contained
  "message + agent execution unit" and keeps running established sessions even if the
  CP is down (graceful degradation).
- The optional **relay** terminates Slack HTTP callbacks, GitHub and GitLab webhooks,
  generic webhooks, and webchat, then forwards content directly to the owning
  daemon. It does not persist message content.
- The **Control Plane** does orchestration/registry/auth + serves the Web UI BFF. It
  stores **only control-plane metadata** — never message bodies, ACP `session/update`
  streams, or attachment bytes. Authorized BFF reads may proxy bounded
  transcript, tool-body, memory, or workspace content from the owning daemon
  without persisting it.
- daemon ↔ CP is a single **WebSocket** used primarily for control signaling
  (register, heartbeat, orchestration commands, telemetry). It also carries the
  scoped request/reply frames for those on-demand BFF reads; live platform
  messages and ACP update streams never use it.

## Monorepo (pnpm workspace, `packages/*`)

| Package                               | Stack                              | Role                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@agentconnect.md/message`            | TypeScript                         | Pure Slack, Lark, Telegram, and Discord normalization; depends on protocol types and contains no platform SDKs or I/O.                                                                                       |
| `@agentconnect.md/protocol`           | zod                                | Shared wire contract — frames, normalized message schemas, and fencing fields (`sessionEpoch`/`seq`/`launchId`). Single source of truth for every wire consumer.                                             |
| `@agentconnect.md/connection`         | TypeScript                         | Wire-agnostic WS dial-out/accept primitives (transport, correlator, backoff, keepalive) shared by daemon, relay, and control-plane.                                                                          |
| `@agentconnect.md/observability`      | OpenTelemetry                      | The Node services' shared OTel bootstrap plus the span-name hygiene that keeps credentials out of exported names. Control-plane and relay each pass only their own name, version, and extra instrumentation. |
| `@agentconnect.md/cli`                | Node CLI (commander)               | The stable `agentconnect` bin: daemon lifecycle (`up`/`down`/`restart`/`status`), service install, `login`, and version management/upgrades.                                                                 |
| `@agentconnect.md/daemon`             | Node CLI (commander)               | The edge unit. Exposes the `agentconnect-daemon` bin (`run`, `chat`, `agent list`, plus hidden `mcp-bridge`/`git-credential`/`gh-token` helpers).                                                            |
| `@agentconnect.md/control-plane`      | Fastify + Prisma (Postgres)        | One Fastify process co-hosts the C2 BFF REST surface **and** the daemon WS endpoint on one port / one Postgres connection.                                                                                   |
| `@agentconnect.md/relay`              | Fastify                            | Optional public ingress: Slack/Feishu HTTP callbacks, webhooks, webchat. Verifies, demuxes to the owning bot, forwards to the daemon. Persists no message content.                                           |
| `@agentconnect.md/setup`              | Fastify + browser UI               | Loopback-only Setup Server for self-hosting, Logto setup, and deployment-owned provider App administration.                                                                                                  |
| `@agentconnect.md/web`                | Next.js 16 + React 19 + Tailwind 4 | Config / monitoring console.                                                                                                                                                                                 |
| `@agentconnect.md/memory-plugin-mem0` | TypeScript                         | Memory-plugin profile wrappers for Mem0 Cloud and OSS.                                                                                                                                                       |
| `@agentconnect.md/k8s-client`         | TypeScript                         | Thin bare-REST in-cluster Kubernetes client (config, HTTP verbs, resumable watch, Lease election) used by the daemon's K8sDriver; ships a fake API server under `./testing`.                                 |

When you change a frame in `protocol`, both daemon and CP consume it — rebuild
`protocol` (or rely on its `development` export → `./src/index.ts`) and check both sides.

## Platform modules

Chat-platform code (Slack, Telegram, Discord, Lark/Feishu) lives in **per-host
modules behind published contracts**, not in branches spread through each host —
see [`docs/designs/integration-plugin-architecture.md`](docs/designs/integration-plugin-architecture.md).
Each host keeps its own per-platform directory plus a static `registry.ts` —
`src/platforms/<id>/` in daemon, relay and control-plane,
`src/components/console/platforms/<id>/` in web (React code stays under
`components/`). The shared, pre-dispatch capability table is
`packages/protocol/src/platform-manifest.ts` (§5).

| Host          | Contract                                                         | What a module owns                                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| daemon        | three-facet adapter (connect/ingress/read port + turn output)    | connection, normalization hand-off, renderers, strategy functions                                                                                                                                                                    |
| relay         | `platforms/contract.ts` — `RelayPlatformIngressPlugin`           | `buildIngest` per bot, `installRoutes`, demux hints, `verify` → `handle`, optional `egress` facet                                                                                                                                    |
| control plane | `platforms/provider.ts` — `CpPlatformProvider`                   | install routes at two mount scopes, credential schema + live validation, create tail, identity projection, reapers, background loops, env keys, the spec projector (bot-assign projector is optional — relay-ingress platforms only) |
| web           | `components/console/platforms/contract.ts` — `WebPlatformModule` | wizard body, settings fragments, `Mark`, api bindings, channel semantics, text renderer                                                                                                                                              |

**GitHub and GitLab are deliberately NOT platform modules.** They have no chat
ingress, so they stay on the webhook / code-host seam (`relay/src/hooks/`,
`control-plane/src/{codehost,github,gitlab}/`,
`daemon/src/{codehost,github,gitlab}/`) and implement a much narrower
per-provider surface than a chat platform does. Webchat is core-owned for the
same kind of reason: it is the console's own surface and shares almost nothing
with an external transport. Do not "finish the job" by forcing either into
`WebPlatformModule` — §2 of the design records why that is the wrong shape.
GitLab has now arrived and made the seam a two-implementer one
([`gitlab-com-integration.md`](docs/designs/gitlab-com-integration.md) §6.5,
§8.1 `CodeHostRepository`), so its members exist: the Layer-2 turn output that
removed the hardcoded `github` case from the dispatch path, and
`daemon/src/codehost/review-adapter.ts` — `CodeHostReviewAdapter` plus the
router that hands provider-routed `submitCodeReview` to whichever adapter owns
the active review turn, the GitHub review orchestrator's member or the GitLab
adapter (`submitGithubReview` survives as a dispatch alias), over the CP's
provider-neutral publication lease and operation ledger behind
`codehost-review-v1`. Each member was extracted in the change that added its
second implementer; extracting from one implementer would have been guessing at
an interface.

Two rules this refactor exists to enforce: **a platform name is never core
knowledge** — core reads a capability, a manifest field, or a registry entry
instead — and **a manifest field is earned by a pre-dispatch read**, or it is a
capability flag with better branding and belongs in a host contract. Adding a
platform should be implementing the four contracts plus one registry line per
host; if you find yourself editing a `switch` in core, the seam is missing a
member and that is the bug to fix.

Web styling is Tailwind-utility-first over the CSS-variable design tokens —
**read [`packages/web/STYLE.md`](packages/web/STYLE.md) before writing console
styles** (var-shorthand color utilities, the `font:`-shorthand/`leading-normal`
rule, the single `desktop:`/`max-desktop:` breakpoint, `shadow-(--shadow-*)`,
the SWC same-line-space gotcha). Inline `style` is reserved for data-driven
values only.

The console has a **≤768px mobile responsive layer** — the `max-width: 768px`
media block in `globals.css` plus `lib/use-is-mobile.ts` (`useIsMobile()`,
SSR-safe). Mobile chrome (app bar, bottom-tab nav, bottom-sheet modals) is
route+CSS-driven in `components/console/Shell.tsx`. Most views render **one
responsive tree** (base = mobile classes + `desktop:` variants; genuinely
divergent fragments dual-render behind `hidden desktop:*` / `desktop:hidden`).
A few detail/list views keep an `if (isMobile) return (…)` fork where the two
form factors differ in **features or interaction**, not just layout — when you
touch one branch, keep the other in sync.

## Comment style

Prefer one-line comments. Do not write multiline comment blocks — if a comment
does not fit on one line, tighten it until it does. When code you are touching
carries a verbose comment, including a pre-existing one, condense it to a single
line instead of leaving it as is.

## Commands

Requires **Node >= 24.12.0** (`.nvmrc` = 24.12.0) and **pnpm 11**.
`package.json#engines` is authoritative.

```bash
pnpm install
pnpm dev       # run all packages in parallel (-r --parallel dev)
pnpm build     # pnpm -r build
pnpm typecheck # type-check all packages
pnpm lint      # eslint .   (lint:fix to autofix)
pnpm format    # prettier --write .   (format:check to verify)
pnpm test      # pnpm -r test

# single package
pnpm --filter @agentconnect.md/daemon dev        # tsx watch ... run
pnpm --filter @agentconnect.md/control-plane dev # tsx watch src/index.ts
pnpm --filter @agentconnect.md/web dev           # next dev
```

`typecheck` covers tests, not just `src`: each package's `tsconfig.typecheck.json`
includes `src` + `test` and resolves workspace siblings from source (no build needed),
so a test calling a stale signature fails at the gate instead of mid-run.

### Control-plane tests (two Vitest projects)

```bash
pnpm --filter @agentconnect.md/control-plane test:unit # pure logic, NO Docker
pnpm --filter @agentconnect.md/control-plane test:int  # test/**/*.test.ts — real Postgres
pnpm --filter @agentconnect.md/control-plane test      # both
# run one test: append -- -t "<name>" or a path to the filter command
```

`test:unit` is the fast inner loop (codec, fencing predicates, placement policy — zero
I/O). `test:int` boots one `postgres:16-alpine` via Testcontainers
(`test/global-setup.ts`: migrate deploy + seed), clones the migrated database once per
Vitest pool, and truncates each pool-local database before a test (`test/setup.db.ts`).
It requires Docker and runs files with four workers by default; set
`INTEGRATION_TEST_WORKERS` to tune that count for the runner.

### Windows

The daemon and the CLI are supported on Windows, and CI's `Unit Test (Windows)` job runs both
packages' unit suites on `windows-latest` — on PRs whose diff reaches those two packages or their
workspace dependency closure, and never on the release path, which skips it as it skips the sandbox
suite. A test case that cannot work there goes on
`it.skipIf(process.platform === 'win32')`; only when _every_ case in a file is POSIX-only does the
file join `WINDOWS_EXCLUDED` in that package's `vitest.config.ts`, which is applied on Windows
alone so `vitest run` is green for a Windows contributor too.

### Prisma

```bash
pnpm --filter @agentconnect.md/control-plane prisma:generate
# Prisma CLI runs in the package dir and does NOT read the repo-root .env — pass it:
DATABASE_URL=... pnpm --filter @agentconnect.md/control-plane exec prisma migrate deploy
pnpm --filter @agentconnect.md/control-plane db:seed:example
```

The generated client lands in `src/generated/prisma`, which is gitignored — run
`prisma:generate` above after a fresh clone or a schema change (`typecheck`, `build`,
and `prepack` already run it as a pre-step). Session rows live in table `session_meta`,
not `session`.

## CP composition (dependency injection)

The CP is assembled through one root so prod and tests build the identical graph:

- `src/config/env.ts` — `loadConfig()`: zod-validated `process.env` → `AppConfig`,
  fail-fast on boot. Required: `DATABASE_URL`, `API_KEY_PEPPER` (≥ 32 chars).
- `src/container.ts` — `buildContainer(...)`: manual DI; the only place outside
  `persistence/` aware of concrete repo classes (repos → services → the two edges).
- `src/app.ts` — `buildApp({ prisma, clock?, secretsProvider?, ... })`: the factory
  **both** prod and tests call. Returns `{ http, mountWs(), shutdown() }`.
- `src/index.ts` — thin bootstrap (`loadConfig → buildApp → listen → mountWs → SIGTERM`).

Tests never call `index.ts`; they call `buildApp(...)` with the Testcontainers
`PrismaClient`, a `FakeClock`, and a memory secrets provider.

## Local full-stack gotchas

- **CP `dev` auto-loads the repo-root `.env`.** `loadConfig()` still reads `process.env`
  directly (no dotenv at runtime); the CP `dev` script feeds it via Node's native
  `tsx watch --env-file-if-exists=../../.env` (`-if-exists` so no-`.env` envs don't fail).
  So `pnpm dev` / `pnpm --filter @agentconnect.md/control-plane dev` just work once a
  root `.env` exists (`cp .env.example .env`). `prod`/`start` and tests are unaffected —
  they get env from the real environment, not the file.
- **Prefer local Docker Postgres for dev.** If a team supplies a remote
  development database, keep its connection details outside this repository.
- **Next.js reads `.env` from `packages/web/`**, not the repo root. Web API base
  defaults to `http://localhost:8080` (`NEXT_PUBLIC_CP_URL` overrides).
- Git hooks are installed via `scripts/setup-hooks.sh` on `pnpm prepare`;
  `lint-staged` runs on commit.

## Human auth (Web UI) — opt-in OIDC

Console sign-in is optional social login through Logto. Setup Server owns the
browser application, API Resource, enabled sign-in methods, Management API
application, and provider connectors in the typed deployment document; provider
secrets are write-only entries in the deployment secret store.

- **CP** is a provider-agnostic OIDC resource server: `http/plugins/auth.ts` verifies the
  bearer JWT (JWKS via OIDC discovery) and JIT-provisions a local user from the token's
  `sub` (`persistence/repositories/user.repo.ts`). The issuer and service origins are
  startup topology; the required token audience comes from the persisted browser auth
  configuration. The base Compose stack stays in loopback-only no-auth mode until
  Setup Server bootstraps sign-in.
- **Web** uses `@logto/browser` (`src/lib/auth.ts`); the login UI is social-only
  (`src/components/Auth.tsx`), redirect landing at `src/app/auth/callback`.
- **Runtime config:** `src/lib/public-env.tsx` reads the Control Plane's
  `/api/v1/runtime-config` snapshot at request time and emits `window.__AC_ENV`, so a
  prebuilt Web image receives the persisted auth state without build-time tenant
  configuration. `CP_INTERNAL_URL` and public service routes remain process topology.

## OpenAPI docs

The CP's public REST surface is self-documenting — `http/plugins/openapi.ts`
generates an OpenAPI 3.1 doc from the routes' zod schemas (Swagger-UI at `/docs`,
raw JSON at `/api/v1/openapi.json`). **When you add or change a route, give its
`schema` a `tags` (from the exported `Tag` map), `summary`, `description`, and a
unique `operationId`** — the transform passes these through, and without them a
docs UI (ReadMe / Swagger) renders only the bare path with no name or group.
