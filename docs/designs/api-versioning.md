# AgentConnect Control Plane — REST API Versioning (`/api/v1`)

> **Status:** Implemented. The CP serves `/api/v1` through
> `packages/control-plane/src/http/version.ts`.
>
> **Scope.** How the Control Plane (CP) REST surface is versioned before it is
> exposed externally. Extends [`control-plane-implementation.md`](control-plane-implementation.md)
> §2.1 (the C2 BFF HTTP server) — read that first for the route tree and the
> `humanAuth` / org-scope plumbing this design wraps. This document changes **only
> the URL surface**; no DB schema, no daemon↔CP protocol frame, and no auth
> behaviour changes.

## 1. Motivation

An unversioned root-mounted API leaves no stable path for a breaking revision:

```
GET  /orgs
GET  /me
GET  /orgs/:orgId/agents
```

A version segment lets old and new external clients coexist while a breaking
revision is introduced.

## 2. Decision

1. **Prefix the entire public REST surface with `/api/v1`.** A future breaking
   revision ships as `/api/v2/*` **alongside** `/api/v1/*`, never by rewriting v1.
2. **Webchat's CP surface is versioned with the REST org tree.**
   `POST /api/v1/orgs/:orgId/agents/:agentId/webchat/token` mints the
   short-lived credential; the browser WebSocket itself terminates at the relay
   and content never traverses CP.
3. **No general dual-mount or backward-compat aliases.** Routes whose URLs are
   handed out externally—OAuth callbacks, agent/org icon PNGs, and MCP—also
   mount at public `/v1` aliases so a direct CP host can serve the
   declared public shape. OAuth bootstrap metadata and `/oauth/*` remain at the
   root.

Prefix literal: **`/api/v1`** (not a bare `/v1`) — unambiguous even when the CP is
served on the same host as the Web UI, and independent of whether a dedicated API
subdomain is ever introduced (see §6).

## 3. Two layers — path prefix vs. API subdomain

A recurring question is "prefix `/api/v1`, or a subdomain like
`api.example.com/v1`?"
These are **not alternatives** — they live in different layers:

| Concern                        | Layer                            | Where it lives                           |
| ------------------------------ | -------------------------------- | ---------------------------------------- |
| `/api/v1` path prefix          | **Application** (Fastify routes) | **this repo** (`packages/control-plane`) |
| `api.example.com/v1` subdomain | **Ingress / DNS** (host routing) | runtime edge configuration               |

The subdomain only answers _"which host serves the API"_; the `/v1` **path segment**
answers _"which version"_. Even with an `api.` subdomain, the ingress simply routes
`api.example.com/v1/*` to the CP's `/api/v1/*` (an optional rewrite). So the versioning
decision that belongs in **this** repo is the **path prefix**; the subdomain is a
later, orthogonal ops decision layered on top and is out of scope here.

**The web console does not pin the public shape.** The CP _always_ serves
`/api/v1/*` internally, but the console targets whatever public base the host
exposes via `CP_URL` — it carries the version path itself (`…/api/v1` direct-to-CP,
or `https://api.example.com/v1` behind the rewrite) rather than hard-coding `/api/v1`
in the client (§5.4). So a host can present the API as `api.example.com/v1/…` and the
console follows, with no rebuild.

> Note: `NEXT_PUBLIC_LOGTO_API_RESOURCE=https://api.example.com` in `.env.example`
> is an **OIDC audience identifier URI**, not a routable host — unrelated to this
> design.

## 4. Surface inventory — what is versioned, what is not

| Surface                                                                                                  | Under `/api/v1`? | Rationale                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------------------- | :--------------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET/POST /orgs`, `GET/PATCH /me`                                                                        |     **yes**      | Identity-scoped public resources → `/api/v1/orgs`, `/api/v1/me`.                                                                                                                                        |
| `/orgs/:orgId/*` (agents, daemons, keys, integrations, bots, members, crons, sessions, usage, stream, …) |     **yes**      | The whole tenant resource tree → `/api/v1/orgs/:orgId/*`.                                                                                                                                               |
| `GET /health`                                                                                            |      **no**      | Infra liveness/readiness probe hit at a **stable** path by the host; versioning a probe is an anti-pattern. `curl …/health` in the README is unaffected.                                                |
| webchat token `/orgs/:orgId/agents/:agentId/webchat/token`                                               |     **yes**      | The CP mint endpoint is `/api/v1/orgs/:orgId/agents/:agentId/webchat/token`; the browser WebSocket terminates at the relay.                                                                             |
| daemon control WS `/daemon/ws`                                                                           |      **no**      | Internal CP↔daemon channel, versioned **in-band** by the protocol frames (subprotocol `agentconnect.v1`), not by URL. The daemon makes **zero** REST calls to the CP, so this is unaffected either way. |

**Verified daemon coupling.** A repo-wide search of `packages/daemon/src` for CP
REST calls found none — the daemon dials only `/daemon/ws` (see
`packages/daemon/src/cp/client.ts`) and its `login` probe is a WS handshake,
not REST. So the daemon-side blast radius of this change is **zero**.

## 5. Design

### 5.1 Single source of truth

The version lives in exactly one place, and the two sides meet only at deploy time:

- **CP (canonical):** `packages/control-plane/src/http/version.ts` →
  `export const API_V1_PREFIX = '/api/v1'`. The CP always serves here.
- **Web:** **no** version constant — the client treats `CP_URL` as the full API base
  and appends resource paths (§5.4). The deployment wires `CP_URL` to whatever public
  URL routes to the CP's `/api/v1/*`.

### 5.2 CP server — one wrapper (`http/server.ts`)

`buildHttpServer` mounts `healthRoutes` at the bare root (unversioned probe), then
wraps **all** other route registrations in a single Fastify plugin carrying
`{ prefix: API_V1_PREFIX }`. Fastify concatenates nested prefixes, so the existing
`{ prefix: '/orgs/:orgId' }` scope becomes `/api/v1/orgs/:orgId` automatically:

```
void app.register(healthRoutes)                       // stays /health
void app.register(async (api) => {
  await api.register(orgRoutes(deps))                 // /api/v1/orgs
  await api.register(meRoutes(deps))                  // /api/v1/me
  await api.register(async (scope) => {
    scope.addHook('preValidation', scope.humanAuth)
    scope.addHook('preValidation', makeOrgScope(deps.repos.org))
    await scope.register(orgScopedRoutes(deps))        // /api/v1/orgs/:orgId/…
    …                                                  // daemons, keys, agents, …
  }, { prefix: '/orgs/:orgId' })
}, { prefix: API_V1_PREFIX })
```

Unchanged and unaffected (all root-level, inherited by children): the zod type
provider, CORS, the `humanAuth` decorator (registered via `fastify-plugin`, so
`app.humanAuth` / `scope.humanAuth` still resolve inside the wrapper), and the
error mapper.

### 5.3 Webchat

Webchat ingress lives in the relay plane. The browser mints its short-lived
token through the versioned CP REST surface, then dials the relay directly.

### 5.4 Web client (`lib/api.ts`)

The client does **not** hard-code the version. `CP_URL` is redefined as the **full
API base** (origin + version path), and the one chokepoint `cpBase()` feeds the
REST helpers by appending resource paths. `webchatWsUrl()` separately mints a
token and uses the relay URL returned by the CP. This keeps the public API shape
a pure hosting choice: point `CP_URL` at `http://cp.example.com:8080/api/v1`
(direct-to-CP) or `https://api.example.com/v1` (behind an ingress rewriting
`/v1/*` → CP `/api/v1/*`) and the browser follows — no rebuild, no client-side
prefix constant.

Trade-off (accepted): `CP_URL` MUST include the version path — a bare origin 404s.
The dev default is `http://localhost:8080/api/v1`.

### 5.5 Clean cut (no dual-mount)

Routes whose URLs are handed **out** of the system—OAuth callbacks, agent/org
icon PNGs, and the AgentConnect MCP endpoint—are additionally mounted at the
public `/v1` prefix so the declared public form also routes on a direct CP
host. The embedded OAuth authorization-server bootstrap surface
(`.well-known` and `/oauth/*`) is mounted unversioned at the root. The
organization resource tree remains single-mounted at `/api/v1`.

The old root paths are not registered. `/api/v1` is the application contract,
and public clients must use a configured base containing the version path.
Dual-mounting would expand the supported surface and weaken the clean version
boundary.

## 6. Ingress / subdomain (out of scope here)

Host routing and path rewrites come from runtime edge configuration.
The application contract is the `/api/v1` route tree, while `CP_URL` may contain
any fully qualified, versioned public base such as
`https://api.example.com/v1`. A configured subpath such as
`https://cp.example.com/cp` composes with the internal route tree without
changing its version semantics.

## 7. Implementation Surface

Code:

- `packages/control-plane/src/http/version.ts` defines `API_V1_PREFIX`.
- `packages/control-plane/src/http/server.ts` wraps non-health registrations (§5.2).
- `packages/web/src/lib/api.ts` treats `CP_URL` as the full API base and exports
  `webchatWsUrl()` to mint a token and dial the relay; no client-side version
  constant (§5.4).
- `.env.example` documents a `NEXT_PUBLIC_CP_URL` default that carries the
  version path.

Tests:

- `packages/control-plane/test/integration/*.route.test.ts` — route-path tests
  use `/api/v1/orgs/${DEFAULT_ORG_ID}` as the organization-scoped base. Root
  literals such as `/orgs` and `/me` become `/api/v1/...`, while `/health`
  stays unversioned. Tests hard-code the expected `/api/v1` literal rather than
  importing `API_V1_PREFIX`, so a wrong prefix is actually caught.
  `src/**/*.test.ts` unit tests do not hit the REST surface.

Docs:

- `packages/control-plane/README.md` — note the `/api/v1` convention (and that
  `/health` + `/daemon/ws` stay unversioned). The `curl …/health` example is unchanged.
- No daemon changes; no DB/migration changes; no protocol-package changes.

## 8. Future — v2 coexistence

When a breaking change is needed, mount a second versioned tree (`/api/v2/*`)
next to `/api/v1/*` and migrate clients per-endpoint; retire `/api/v1` only once
no client uses it. The `API_V1_PREFIX` constant generalises to a small set of
mounted version prefixes at that point.
