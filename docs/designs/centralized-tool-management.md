# Centralized Tool Management — MCP Proxy (Relay Data Plane)

**Status**: P1 and P2 implemented; P3 is future work
**Scope**: protocol + control-plane + relay + daemon + web

> **Architecture**: The MCP proxy's **data plane lives in the relay**, not the
> CP. **The CP stores upstream MCP authentication secrets and broadcasts them to
> the relay pool**, following the existing `rc/bot-assign` + `RcBotSecrets`
> precedent (§5). The relay injects them while proxying. The agent receives only
> a **grant-key-authenticated proxy URL** pointing to the relay.
>
> Why not proxy through the CP? Doing so would put the CP on the hot path of
> every tool call; **if the CP failed, every proxied MCP would fail**, directly
> violating the guarantee that work continues through a CP
> outage. The relay already serves as the secret-holding edge for pool-wide
> Slack HTTP ingress: `rc/bot-assign` broadcasts the bot token and
> `signingSecret` to every connected relay, and whichever relay receives an
> Events API or interaction request verifies its HMAC locally. Keeping upstream
> MCP keys at that same edge reuses the existing trust boundary.
>
> **Design constraints**: (1) console visibility (`org | restricted`) is not a
> call-side authorization boundary; per-agent isolation requires independent,
> revocable per-agent grants at the relay and remains P3 (§6); (2) an upstream
> URL is an SSRF primitive, so relay egress **must** be validated (§5.3); (3)
> the transparent proxy supports only **Streamable HTTP** upstreams. Legacy
> HTTP+SSE exposes a separate `endpoint` that requires rewriting, contradicting
> the "do not parse MCP" rule, so it remains P3 (§5.1).

Current implementation details:

- The CP stores each grant key after passing it through the configured
  `SecretCipher` in `mcp_grant.key`, because daemon reconciliation must recover
  the plaintext capability. `SECRET_CIPHER=none` is identity storage; an
  encrypting provider stores ciphertext. Relays receive only `sha256(key)` in
  `rc/mcp-assign.grantKeyHashes`.
- Provider visibility uses `ResourceVisibility` (`org | restricted`) plus
  `sharedWith`. It controls console access only, never crosses the wire, and
  does not revoke a provider already enabled by an agent.
- MCP facts are derived synchronously from the effective definitions as
  `{name, transport}`. The daemon does not probe MCP servers or proxy URLs.
- `McpProvider.kind` is `custom | open_connector`. Both kinds reuse the same
  relay proxy path and wire shapes. Custom providers are transparent byte
  proxies; `open_connector` providers are served by the relay's MCP adapter
  over the configured OpenConnector runtime API.

Provider flow:

1. The user defines a custom MCP provider: `server url` + `headers` (API key). → §4 registry
2. The registered server has **visibility**, is **proxied by the relay**, and receives a **key-authenticated URL**. → §5 relay + §6 CP
3. An agent selects available MCPs; **the proxy address is delivered to the agent**. → §6/§7 (reuse the existing push path)
4. Starting the agent **injects the proxy address**. → §7 (zero new daemon injection code; reuse `resolve-servers`)

---

## 1. Background

Before the centralized registry, an external MCP server had to be configured
manually on every daemon. The CP and console could enable or disable a server by
name but could not create or distribute definitions. Moving an agent to a
daemon without the matching definition caused that server to be skipped. The
registry and dual-push path close that gap while preserving the invariant that
upstream secrets **never reach a daemon or agent**.

## 2. Goals / Non-Goals

**Goals**: Make the CP the single source of truth for MCP provider definitions (organization-level plus visibility); keep upstream secrets stored only by the **CP and used only by relays**, never by daemons/agents; proxy through the relay; expose only a grant-key-authenticated proxy URL to agents; make agent moves and multiple daemons work automatically; and let relay+daemon continue serving through a CP outage (graceful degradation).

**Non-goals (§10)**: call-side per-agent isolation (console visibility may still
be restricted; see §6), per-agent/per-user upstream identities (the current
implementation shares one identity per provider), private-network upstreams
unless an operator explicitly allowlists the host (§5.3), per-tool allow/deny
controls, **legacy HTTP+SSE upstreams** (the current proxy supports only
Streamable HTTP; §5.1), stdio upstreams, and adding daemon built-in bridge tools
to the registry.

## 3. Architecture Overview

```
 Control plane (on changes)                         Data plane (on every tool call)
 ┌──────────────┐  URL + headers  ┌──────────────────────────┐
 │ Console/user │ ───────────────▶ │ CP registry              │
 └──────────────┘                  │ stores secrets, mints     │
                                   │ grants                    │
                                   └────────┬─────────┬───────┘
       ① Deliver "proxy def"                │         │ ② Deliver grant binding
         (proxy URL + grant key,            │         │   (grantKeyHash→upstream URL+headers)
         no upstream secret)                │         │   over rc/mcp-assign
         over RegisterOk.mcpServers[] /      │         │   (following rc/bot-assign+RcBotSecrets)
         mcpserver/upsert                    ▼         ▼
                                      ┌────────┐   ┌──────────────────────────────────┐
                                      │ daemon │   │ relay (public HTTPS, proxy,      │
                                      └───┬────┘   │ header substitution)             │
                  session/new injects HTTP MCP │   └──────────────┬───────────────────┘
                       URL=relay/mcp/:id         │                  │ local binding lookup,
                                                ▼                  │ inject real headers
                                      agent MCP client ──Bearer grantKey──▶ relay ──real headers──▶ upstream MCP server
                                                ◀──────────────── result stream ───────────────────
```

Key point: **call data passes only through the relay and daemon, never through the CP**. The CP pushes two artifacts only when something changes and is absent from the call path. If the CP goes down, the previously pushed proxy definition on the daemon and grant binding on the relay remain active; only provider creation or updates wait for the CP to recover.

## 4. Data Model (Control Plane)

Mirror the Bot/BotSecret split: a metadata table plus a side table for secrets.

```prisma
// Organization-level MCP provider registry. The name is unique within an
// organization and is the reference used by an agent's enabled-provider list.
model McpProvider {
  id              String             @id @default(uuid()) @db.Uuid
  orgId           String
  name            String             // Reference key; unique within the organization
  kind            McpProviderKind    @default(custom)
  transport       McpTransport       @default(http) // Streamable HTTP only
  url             String             // Upstream endpoint (not a secret; may appear in DTOs)
  visibility      ResourceVisibility @default(org) // Console visibility only
  sharedWith      String[]           @default([])
  createdByUserId String?
  createdAt       DateTime           @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime           @updatedAt @db.Timestamptz(6)
  org             Org                @relation(fields: [orgId], references: [id], onDelete: Cascade)
  createdBy       User?              @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)
  secret          McpProviderSecret?
  grants          McpGrant[]
  @@unique([orgId, name])
  @@index([orgId])
  @@map("mcp_provider")
}

// Upstream authentication headers pass through the configured SecretCipher via
// McpProviderSecretStore (the store seam matches BotSecret). `none` stores
// plaintext; an encrypting provider stores ciphertext. Never included in a DTO
// and never delivered to a daemon.
model McpProviderSecret {
  mcpProviderId String @id @db.Uuid
  headers       Json   @default("[]")   // {name,value}[] for real upstream API keys, etc.
  provider McpProvider @relation(fields: [mcpProviderId], references: [id], onDelete: Cascade)
  @@map("mcp_provider_secret")
}

// Proxy credential: identifies an agent-side connection to the relay and maps
// it to an upstream provider. The current model has one active grant per
// provider (§10 shared identity). The store passes `key` through the configured
// SecretCipher so the CP can recover it for daemon reconciliation. `none` stores
// plaintext; an encrypting provider stores ciphertext. Relays receive only
// sha256(key).
model McpGrant {
  id            String   @id @default(cuid())
  mcpProviderId String   @db.Uuid
  key           String   @unique
  status        String   @default("active")
  createdAt     DateTime @default(now()) @db.Timestamptz(6)
  provider McpProvider @relation(fields: [mcpProviderId], references: [id], onDelete: Cascade)
  @@index([mcpProviderId])
  @@map("mcp_grant")
}
```

`Agent.runtimeOverrides.mcpServers[]` enables providers by name.
`Daemon.mcpServers` reports configuration-derived `{name, transport}` facts;
neither surface exposes upstream secrets.

## 5. Relay Data Plane — Header-Substituting MCP Proxy (Without Parsing MCP)

### 5.1 Proxy route

[`buildRelayServer`](../../packages/relay/src/server.ts) exposes the proxy
alongside the relay's other public HTTP ingress:

```
GET | POST | DELETE /mcp/:providerId
Authorization: Bearer <grantKey>
```

For a `custom` provider, the relay does not understand MCP. It performs
authentication, substitutes headers, and forwards bytes or response streams:

1. Read the grant key from the header → hash it → **look up locally** the delivered binding (§5.2) to obtain `{ upstreamUrl, headers }`.
2. **Replace** the agent-side `Authorization` value, inject the real upstream headers, and forward `GET`, `POST`, or `DELETE` unchanged to `upstreamUrl`. Stream the response back unchanged; do not parse JSON-RPC.
3. Return 401 if providerId does not match the grant, the grant has been revoked, or no binding exists.

An `open_connector` provider uses the same authenticated route and grant
binding, but the relay terminates MCP and translates supported JSON-RPC
requests to the configured OpenConnector runtime API. Its `GET` returns 405 and
`DELETE` is a no-op 200.

**Support only Streamable HTTP upstreams (one endpoint); legacy HTTP+SSE is
excluded from the current proxy.** Transparent byte forwarding requires
agent↔relay and relay↔upstream to use the same transport. Streamable HTTP
(2025-03-26) uses **one endpoint** for message requests and optional server
streams, so transparent proxying works. **The old HTTP+SSE transport
([2024-11-05](https://modelcontextprotocol.io/specification/2024-11-05/basic/transports))
does not**: its initial SSE stream contains an `endpoint` event pointing to a
**different POST URI**. Forwarding that unchanged causes the client either to
connect directly to the upstream (bypassing the relay and losing injected
authentication) or to call an unhandled relay path. Supporting it requires
**rewriting the `endpoint` event and routing the derived endpoint**, which
means parsing MCP and conflicts with the transparent-proxy rule. Provider
creation therefore accepts only `transport: http` and rejects `sse`. Legacy
SSE termination or translation remains P3.

### 5.2 Deliver grant bindings (following the `rc/bot-assign` + `RcBotSecrets` precedent)

The CP already broadcasts **bot secrets to the relay pool** through
[`rc/bot-assign`](../../packages/protocol/src/frames/relay-cp.ts).
`RcBotSecrets` carries the outbound bot token and Slack `signingSecret`; every
connected relay can verify HTTP Events API and interaction requests. MCP
bindings copy that pool-wide distribution pattern:

- `rc/mcp-assign` (C→R) broadcasts
  `{ providerId, upstreamUrl, headers, grantKeyHashes[] }`. Each relay stores the
  binding in memory. A provider may have multiple valid grants during rotation
  and, in P3, for per-agent isolation.
- `rc/mcp-unassign` (C→R) broadcasts `{ providerId }` to invalidate the full
  provider or `{ providerId, grantKeyHash }` to invalidate one grant.
- When a relay registers or reconnects, the CP replays the full persisted
  binding set to that relay.
- Upstream headers therefore exist **only in the CP database and relay memory**,
  at the same trust level as Slack signing secrets held by every relay.

**Validation occurs on every call** (§5.1), not merely when a connection is established: the relay checks the binding by grant hash for every request, so the **next request** after revocation returns 401.

**Revocation and rotation paths (must be defined):**

- Revoke: CP marks `McpGrant.status=revoked` → sends `rc/mcp-unassign{providerId,grantKeyHash}` so the relay removes the hash → removes that key from proxy definitions on affected daemons (`mcpserver/remove` or upsert a new definition).
- Rotate: mint a new key → add the new hash with `rc/mcp-assign` and push a proxy definition containing the new key with `mcpserver/upsert` → unassign the old hash after a grace period.

> Benefit: no CP round trip when connecting (bindings are pushed on change, not fetched per connection), and **losing the CP connection does not affect delivered bindings**—graceful degradation.

### 5.3 Upstream egress validation (mandatory SSRF protection)

The provider `url` is arbitrary editor-supplied input that the relay calls—**an SSRF primitive** capable of reaching services on the relay host or private network, cloud metadata (`169.254.169.254`), or administrative ports. "Treat headers as secrets" **does not address** this surface. The relay must enforce:

- **Reject private, loopback, link-local, and reserved ranges plus cloud metadata IPs by default** (loopback, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, ULA `fc00::/7`, and so on); allow only public addresses.
- **Validate after DNS resolution and pin the validated IP for the connection** to prevent DNS rebinding / TOCTOU, where validation and connection resolve different IPs.
- **Do not follow cross-host redirects**, or apply the same validation to every redirect target.
- Support an **optional egress allowlist** (`RELAY_MCP_ALLOWED_UPSTREAMS`): when configured, allow only listed hosts.
- **Private-upstream support must be an explicit decision**: v1 does **not** support it. A genuine private MCP requirement must be enabled through a per-relay/deployment allowlist, not self-served by a provider editor.
- The CP performs the same static validation when creating or updating a provider to reject obviously invalid URLs early, but **relay egress-time validation is authoritative** because DNS can change.

## 6. CP Control Plane

- **CRUD**:
  [`routes/mcp-providers.ts`](../../packages/control-plane/src/http/routes/mcp-providers.ts)
  creates, updates, and deletes providers with organization scoping, RBAC, and
  complete OpenAPI metadata. **DTOs never contain header values**; they may
  expose header names. Provider URLs pass the static §5.3 gate before storage.
- **Grant key and relay origin**: creation mints an active provider grant,
  returns the plaintext once, and persists it through the configured
  `SecretCipher` so reconciliation can recover it. `none` stores plaintext; an
  encrypting provider stores ciphertext. A reachable relay origin supplies
  `https://relay.example.com/mcp/<providerId>`. Secrets never appear in the URL; the
  grant key is an `Authorization` header.
- **Push two artifacts**:
  - → **relay pool**: broadcast `rc/mcp-assign`
    `{providerId, upstreamUrl, headers, grantKeyHashes[]}` (§5.2).
  - → **daemon**: proxy definition `{name, transport:'http', url:proxyUrl, headers:[Authorization: Bearer <grantKey>]}` (§7).
- **Visibility**: `ResourceVisibility` (`org | restricted`) and `sharedWith`
  govern console reads and who may newly enable a registry provider. They never
  cross the wire. Tightening visibility does not revoke an already-enabled
  provider.
- **Call-side isolation remains P3**: push filtering is **not an authorization
  boundary** because definitions live at organization scope and a relay request does
  not identify the calling agent. The current provider grant is shared across
  the organization. Per-agent isolation requires an independent, revocable
  grant per provider and agent (or narrower session scope), plus relay
  validation on every call.

## 7. Delivery and Injection into the Daemon (Reuse Existing Mechanisms; Zero Injection Code)

The object delivered to a daemon has exactly the shape of an ordinary HTTP
`McpServerDef`, except that it contains the relay proxy URL and grant key rather
than the upstream URL and API key:

- **Protocol**:
  [`frames/mcpserver.ts`](../../packages/protocol/src/frames/mcpserver.ts)
  defines `McpServerSpec`, `mcpserver/upsert`, and `mcpserver/remove`;
  `RegisterOk.mcpServers[]` carries the reconnect snapshot.
- **Placement/filtering**:
  [`placement.ts`](../../packages/control-plane/src/orchestrator/placement.ts)
  includes a proxy definition when any agent on that daemon enables the provider
  name. Live mutations use `mcpserver/upsert` or `mcpserver/remove`, with the
  register snapshot as the convergence backstop.
- **Daemon application**:
  [`CpMcpDefs`](../../packages/daemon/src/mcp/cp-mcp-defs.ts) keeps CP
  definitions in memory keyed by `(orgId, name)`, layers only the owning
  organization's definitions over local definitions, and full-replaces the CP
  set from each reconnect snapshot. It does not rewrite user-authored configuration.
- **Injection requires no special path**:
  [`resolveAgentMcpServers`](../../packages/daemon/src/mcp/resolve-servers.ts)
  converts the effective HTTP definition to the shape attached to
  `session/new`.
- **Facts describe daemon-local definitions**: organization providers already
  live in CP metadata and are not folded into an install-wide fact set. The
  daemon does not open an MCP connection when reporting facts.

> **The runtime must support HTTP MCP transport**:
> [`resolveAgentMcpServers`](../../packages/daemon/src/mcp/resolve-servers.ts)
> skips HTTP definitions for a runtime without `mcpCapabilities.http`.

## 8. Local Configuration Precedence (Unchanged)

The daemon retains local `config.mcpServers` entries (offline/pure-local use may connect directly to upstreams and assumes responsibility for secrets). For each agent, local definitions and that agent organization's CP-delivered proxy definitions are merged; on a name collision, **the CP wins**. Same-named providers in different organizations remain isolated. Local-only names continue working.

## 9. Security Summary

- **Upstream secrets**: stored only in the **CP database** after passing through
  the configured `SecretCipher` (`none` stores plaintext; an encrypting provider
  stores ciphertext, matching `BotSecret`) and **relay memory** (broadcast via
  `rc/mcp-assign`, at the existing trust level for pool-wide Slack signing
  secrets). They **never enter DTOs, reach daemons/agents, or appear in logs**.
- **Grant key**: the header delivered to a daemon contains a grant key—a revocable capability scoped to one provider and useless outside the relay—not the upstream secret. In the worst case, a leak permits calls to that proxy (bounded by rate limiting and revocation) but does not reveal the upstream API key.
- **Hard boundary**: the call data plane is in the relay, not the CP. The CP pushes bindings/definitions only on changes. Secrets are carried in headers, never URLs.
- **SSRF**: the upstream `url` is user-controlled input, so relay egress must apply §5.3 validation: reject private/metadata addresses, pin IPs against rebinding, constrain redirects, and support an optional allowlist. Treating headers as secrets does not establish this boundary.
- **Authorization boundary**: the call capability is an organization-shared
  provider grant. Restricted console visibility does not narrow that
  capability. Per-agent isolation **cannot** be implemented with push filtering
  because definitions are daemon-shared and a relay request has no agent
  identity; it requires per-agent grants and call-time validation (§6).
- **Graceful degradation**: when the CP disconnects, the relay (binding already delivered) and daemon (proxy definition already delivered) continue proxying. Only provider creation or updates are blocked.
- Frames are ≤256 KiB; proxy definitions and bindings are tiny.

## 10. Current and Future Scope

| Scope           | Capabilities                                                                                                                                                                                                                                                                                                                                        |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Current**     | Protocol (`mcpserver/*`, `RegisterOk.mcpServers[]`, `rc/mcp-assign/unassign`); CP provider, secret, and grant storage; `custom` and `open_connector` providers; `ResourceVisibility`; grant rotation; dual push; pool-wide relay bindings; `/mcp/:providerId` Streamable HTTP proxy with §5.3 SSRF validation; `CpMcpDefs`; web provider management |
| **P3 (future)** | Independent per-agent grants with relay call-time validation and revocation; legacy HTTP+SSE termination/translation; per-agent or per-user upstream identity; per-tool allow/deny; stdio bridging; grant usage/auditing; optional private-upstream allowlists                                                                                      |

**Non-goals**: the current proxy accepts only single-endpoint **Streamable
HTTP** upstreams. Legacy HTTP+SSE (separate `endpoint`) and stdio are outside the
current network proxy. The call path uses one shared upstream identity per
provider; restricted console visibility is not per-agent call isolation.
Private upstreams are rejected by default. `autoApprove` and per-tool
granularity are also out of scope.

## 11. Tests

- Protocol codec: zod round-trips for `mcpserver/*` and `rc/mcp-assign/unassign`.
- CP `test:unit`: placement filtering (enable→deliver, disable→remove, follow moves), stored-key/hash handling, correct dual-push payloads, no header values in DTOs, static `url` SSRF validation rejecting private/metadata addresses, console visibility enforcement, `http`-only transport validation, and correct unassign + definition updates during revocation and rotation.
- Relay proxy unit tests: valid grants substitute headers and forward; invalid/revoked grants make the **next call** return 401; SSE streams transparently; binding convergence; **no CP calls**. **SSRF tests** reject private, loopback, `169.254.169.254`, DNS rebinding (public during validation, private on connect), and cross-host redirects; allow only matching allowlist entries.
- Daemon: `CpMcpDefs` upsert/remove/full-replace behavior and local/CP precedence. The existing resolver tests cover injection of effective definitions.
- Review invariant: **upstream headers never enter DTOs, reach daemons, or appear in logs**.
