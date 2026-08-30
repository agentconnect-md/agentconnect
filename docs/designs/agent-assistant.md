# AgentConnect MCP — System-Operations MCP for AI Tools

**Status**: MCP and OAuth are available; the delegated credential path (P4)
remains planned. **The DEDICATED built-in assistant agent (P3) is CANCELLED**
(2026-07-29, see [preset-agents.md](preset-agents.md)): assistant/admin
capabilities are planned to fold into the `agentconnect` general preset instead —
first step: its webapp (Playground/webchat) sessions get this MCP's admin toolset,
with the per-session delegated key (P4's webchat half) still the security
prerequisite. The dedicated agent's own design (identity machinery, restricted
profile, built-in prompt) is deleted from this document — git history holds it;
what transfers is specified live in §4 (the session credential, incl. §4.3
injection) and §6 (the tool surface). · **Version**: v2
**Scope**: protocol + daemon + control-plane + web

> **Orientation.** Shipped: the MCP server and its tools (§6), the embedded OAuth
> AS (§7). Planned: the per-session delegated credential (§4, "P4") — the
> prerequisite for reaching this toolset from inside an AgentConnect conversation.
> Cancelled: the dedicated built-in assistant agent that was this document's
> original vehicle for that conversation (§3, §8).

> **v2 architecture**: expose "operate the AgentConnect system" as **one CP-hosted MCP server (AgentConnect MCP)**. Users connect it from **their own AI tools** (claude.ai, Claude Code, Cursor, and others) and operate the system through it. It supports **automatic OAuth browser sign-in** (paste URL → browser opens → sign in and consent → complete, like Linear/Sentry). One tool set, authorization model (identity = user behind the credential), and audit system serves three kinds of consumers:
>
> 1. **External AI tools**—OAuth browser sign-in (§7) or manually supplied personal API key (existing `/me/keys`). **This is the shipped consumer.**
> 2. **A platform-injected session credential**—a short-lived delegated key the platform mints for a trusted webchat session and injects without the user pasting anything ("pre-authenticated," §4/§5). Planned, not built. This consumer originally motivated a dedicated built-in `agent-assistant` agent (§3/§8); that agent is cancelled, and the successor is the `agentconnect` general preset's own webapp sessions (preset-agents.md §4).
> 3. **Future IM-bound identities**—after identity binding, mint a delegated key for the bound user (§12).
>
> The authorization kernel is invariant: **what a caller can see and do is exactly what the user behind its credential can see and do**, enforced through existing RBAC + resource visibility.

---

## 1. Background and Goals

Users currently operate AgentConnect through the Web console or REST API. This design adds:

- **AgentConnect MCP** (shipped): a CP-hosted MCP endpoint. Users add it to their own AI tools and manage agents, crons, and integrations or inspect sessions/usage through natural language ("stop alerts-bot" or "whose agent used the most tokens this week?"). This turns the CP management plane into a product surface **for AI to use**, without locking it to one harness.
- **A conversational entry inside AgentConnect itself** (planned): a webchat/Playground session that reaches the same toolset through a platform-injected per-session credential (§4), for users who do not want to configure MCP in an external tool. The vehicle is the `agentconnect` general preset's webapp sessions (preset-agents.md §4); the dedicated built-in agent this document originally proposed is cancelled (§3).

Design requirements:

1. **Authorization = user behind the credential**. The MCP has no authority of its own, and neither does any agent that reaches it. Resources hidden from that user remain hidden from tools; resources that user cannot delete remain undeletable.
2. **External connection must support zero-configuration browser sign-in** through the MCP Authorization OAuth flow (§7), without forcing users to copy API keys.
3. **No built-in agent ships.** The assistant slugs stay reserved as an impersonation guard only (preset-agents.md §3.3).
4. **The in-product conversational entry is Web-only**: only webchat has a trusted console principal. IM ingress waits for cross-system identity binding (§12). External AI tools are unaffected because their OAuth/personal key already establishes a trusted identity.

### Architecture in One Diagram

```
External AI tool (claude.ai / Claude Code / Cursor…)          ── SHIPPED ──┐
        │  OAuth browser sign-in (§7) or Bearer personal key               │
        ▼                                                                  ▼
User ─ webchat ─▶ agent session on a daemon (ACP) ─(delegated key auto-injected ──▶ AgentConnect MCP (CP-hosted, §6)
                 [planned, §4; target = the `agentconnect`  = "pre-authenticated", §4)   │ calls service layer in process
                  general preset's webapp sessions —                                     ▼
                                                                     existing RBAC + visibility unchanged + per-operation audit
```

The CP remains outside the message hot path—the agent conversation stays local to the daemon. MCP tool calls are **control-plane operations**, which properly belong on the CP.

---

## 2. Decision Table (Forks)

| Decision                 | Choice                                                                                                                                                            | Rejected alternative                                                                                                                                                                                                                |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool host                | **CP-hosted MCP server; tool definitions, confirmation, rate limits, and audit live in one place only** (§6)                                                      | Daemon built-in tool set + daemon→CP REST (v1: duplicate tool evolution in daemon and unusable by external AI tools); per-operation WebSocket frames (duplicate authz)                                                              |
| Authorization model      | **Credential is identity: all three credential types (§5) resolve to a user, and tools execute as that user**                                                     | Assistant/MCP holds organization-level admin credentials (prompt injection compromises the whole organization; viewer can escalate)                                                                                                 |
| External authentication  | **Thin OAuth AS embedded in CP (automatic browser sign-in, §7) + Bearer personal-key fallback**                                                                   | Keys only (claude.ai connectors have no formal manual-header UI and UX is poor); OAuth only (dead end for headless/CI—Sentry and Atlassian both had to add key paths)                                                               |
| OAuth AS host            | **Thin AS embedded in CP, issuing opaque tokens; `/authorize` reuses console login** (mainstream pattern from Sentry/Notion/Linear/Atlassian/Cloudflare guidance) | Use Logto directly as AS—**Logto still has no DCR** (roadmap Backlog, CIMD Paused, absent in v1.41.0); wildcard redirect URIs exclude ports (breaks random localhost ports from Claude Code); token model couples to Logto JWT/JWKS |
| High-risk operations     | **Credential/member/organization/access-control operations excluded from tool catalog; delegated keys hard-denied for those route families in the CP** (§6.3)     | Expose everything and rely on RBAC (injection-triggered key minting/member changes have excessive blast radius)                                                                                                                     |
| Destructive confirmation | **Tool schema requires exact `confirm: '<resource-name>'` echo** (§6.4)                                                                                           | Prompt-only convention (fails when model behavior drifts)                                                                                                                                                                           |

---

## 3. The built-in assistant agent — cancelled

The original design gave each organization one built-in agent (`AgentKind`
discriminator + partial unique index, fixed properties locked at creation, a
dedicated `/orgs/:orgId/assistant` provisioning surface, roster/wire plumbing).
**That agent is cancelled** (2026-07-29, preset-agents.md §4): no such kind
ships, and the assistant slugs stay reserved only as an impersonation guard.

None of that identity machinery transfers. It existed to make a second built-in
agent behave _unlike_ an ordinary one, whereas the successor — the AgentConnect
MCP admin toolset reached from the `agentconnect` general preset's webapp
sessions — runs inside an ordinary, user-editable agent. The boundary that DOES
carry forward is the credential (§4) and the closed, confirm-gated, auditable
tool surface (§6), both specified there. Git history holds the full cancelled
model if its rationale is ever needed.

Still live from this area, and unaffected by the cancellation: the reserved
agent slugs (authoritative set in preset-agents.md §3.3) and the OAuth tables
of §7.

## 4. Session Ingress and Identity Binding (P4, planned — Webchat Only)

> **Still planned, and still the prerequisite.** The per-session delegated
> credential below is what makes any admin tool safe to reach from inside an
> AgentConnect conversation, and it is unbuilt. **One correction:** step 1 originally
> minted "only when the target agent has `kind='assistant'`". No such kind ships, so
> the gate is **session-shaped** instead — a webapp session on the agent entitled to
> the toolset (preset-agents.md §4). The rest of this section — the verification leg,
> the ownership-bound `conversationId`, session-scoped binding, and fail-closed
> injection — is unaffected.

Current chain: browser obtains a short-lived token from
`POST /agents/:agentId/webchat/token` → connects to the **relay pool**
(`packages/relay/src/relay-browser-server.ts`) → relay delegates token
validation to CP via `rc/verify(webchat-token)` → bridges to the target daemon
with `rd/*` frames. Content does not traverse the CP. P4 can mint delegation
during the `rc/verify` leg, but delivery must follow relay→daemon `rd/*`.

Today `rc/verify(webchat-token)` resolves `{ userId, user, orgId, agentId,
daemonId, conversationId }`. CP persists an ownership-only binding for the
conversation before minting, and a resume must match the same user, agent, and
organization. The relay treats the verified `conversationId` as
`chatId`/`sessionKey` on `rd/*`; a caller-supplied query cannot select another
session. It still does **not** resolve a membership role. P4 therefore needs an
explicit delegation extension rather than treating the existing verification
response as a complete mint point:

1. After token verification, ask CP to resolve the user's current membership
   role and mint `apiKeyService.mintDelegated(...)` only for a session that is
   entitled to the admin toolset (§5) — originally "only when the
   target agent has `kind='assistant'`"; the successor condition is the
   `agentconnect` general preset's webapp sessions (preset-agents.md §4).
2. Include the token-bound `conversationId` in that request, then carry
   `{ delegationId, secret, userId, displayName, expiresAt }` through a dedicated
   session-establishment frame or the first `rd/*` message. **The daemon holds
   the credential; the agent/model never sees it.**
3. Daemon binds delegation persistently by authenticated user plus
   `sessionKey` (local-store session row, restart recoverable). Reconnecting as
   the same user mints and **replaces** it, immediately revoking the old key.
4. MCP injection carries only the credential bound to that authenticated
   session (§4.3), preventing a caller-supplied conversation ID from crossing
   user boundaries.

The original design could argue that no non-webchat path even reached the
assistant: that agent had no integrations, so cron, peer-call, and routeRules
could never match it. **The successor cannot borrow that argument** — the general
preset is a fully integrated agent that Slack, GitHub, and crons all reach. So
the boundary must hold at the **credential**: a session with no minted delegation
gets no admin toolset at all (§4.3, fail-closed). That is why P4 is a hard
prerequisite rather than an accompaniment.

### 4.3 Injecting the toolset without exposing the credential

Moved here from the cancelled §8 — these mechanics are agent-shape-independent;
only the branch changes, from "this agent has `kind='assistant'`" to "this
session holds a delegation".

- Inject **exactly one** MCP server for a delegated session: the CP's
  AgentConnect MCP endpoint, with the key bound to that session. The admin
  surface stays closed and auditable — do not widen it with memory,
  collaboration, or platform tools, and do not resolve external `mcpServers`
  into it.
- Transport: where the runtime supports HTTP MCP (`runtime-prober.ts`
  `mcpCapabilities`), pass URL + header directly; otherwise reuse the existing
  stdio bridge (`mcp/bridge.ts`), where the daemon spawns the bridge with
  `AC_MCP_URL` / `AC_MCP_KEY` in the child's environment. **The credential lives
  only in an environment the daemon created for that child and never becomes
  visible to the model** — the same discipline as the existing `AC_MCP_TOKEN`.
- Derive the CP endpoint from `controlPlane.url` by ws(s)→http(s): the CP serves
  one port, so reachability matches the live WebSocket.
- A missing or expired delegation **fails closed**: `tools/call` returns an
  explicit "session credential expired; reconnect" error rather than degrading to
  an unauthenticated call. Reconnecting remints and restores operation.

---

## 5. Credentials: Three Types, One Table and Pipeline

All use the `ApiKey` table and the same verification pipeline from daemon-api-key-auth.md (hash-only, pepper, revocable; dot-free Bearer branch in `http/plugins/auth.ts`):

| Dimension              | Personal key (manual)                                                                                                                                                                                            | **OAuth token (§7, new)**                                | **Delegated key (webchat session, planned)**                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| principalType          | `user` (existing)                                                                                                                                                                                                | `oauth`                                                  | `delegated` (`relay` is an existing non-human principal precedent, `ports.ts:94`)        |
| Minted by              | User self-service `POST /me/keys` (`me-keys.ts`)                                                                                                                                                                 | **Only `/oauth/token`** (code/refresh exchange)          | **Only webchat-token verification** (§4; delivery follows the relay→daemon session path) |
| TTL                    | 90d default (user-selectable)                                                                                                                                                                                    | **1h** (silent refresh, §7.4)                            | **12h**, replaced on reconnect                                                           |
| Scopes                 | None (= full REST authority of user)                                                                                                                                                                             | `mcp:read` / `mcp:write` (user selects at consent, §7.3) | `['assistant']` + CP hard deny for high-risk route families (§6.3)                       |
| Authorization boundary | User RBAC                                                                                                                                                                                                        | User RBAC ∩ scopes                                       | User RBAC ∩ deny-list                                                                    |
| Role                   | Identical for all three: **never baked into credential**. `makeOrgScope` (`org-scope.ts`) calls `roleOf` on every request, so demotion or organization removal applies immediately (removed → 404, self-healing) |                                                          |                                                                                          |

`authenticateUser` accepts both `user` and `oauth` principals, resolves the
bound human and organization, and carries granted scopes into
`req.apiKeyScopes`. The planned delegated credential path must add a distinct
principal and `req.delegation = { keyId, agentId }` without widening the
existing human-key boundary. **Credentials never enter transcripts or model
context.**

**Material trust-model improvement**: a daemon never holds organization-wide CP credentials (its daemon key can only access the WebSocket control channel). A compromised daemon can at most obtain credentials for currently active webchat users, lasting 12h, with high-risk surfaces removed and every call audited (§9.3)—far less than giving a daemon a management key.

---

## 6. AgentConnect MCP Server (CP-Hosted, Core Deliverable)

### 6.1 Endpoint and Authentication

- **Mount**: add MCP Streamable HTTP endpoint `POST /api/v1/mcp` to the same single-port Fastify process as REST/WebSocket. Use the **MCP SDK v2** web-standard handler from `@modelcontextprotocol/server` (`createMcpHandler().fetch(request)`), driven by an approximately 15-line Node↔Fetch adapter from Fastify. No Express or global middleware; `app.inject` continues to work. Create one stateless `Server` per POST using low-level `setRequestHandler('tools/list'|'tools/call')` so each call can be audited.
- **Public address**: a hosted installation may give MCP a **dedicated origin** through `PUBLIC_MCP_URL`; the domain comes from runtime configuration. This document uses the placeholder `https://mcp.example.com`. The user pastes the domain itself. PRM declares `resource` as the **bare origin without trailing slash** (`https://mcp.example.com`). This follows MCP Authorization canonical URI rules (2025-06-18 §Canonical Server URI: implementations SHOULD consistently use the no-trailing-slash form unless the slash is semantically significant; the example is `&resource=https%3A%2F%2Fmcp.example.com`). It also matches the connector URL stored by claude.ai and the audience bound to its token.
  - **The client canonical URI has no trailing slash.** A slash mismatch lets OAuth and token issuance finish but causes audience binding to fail before the endpoint receives the token. Keep the configured resource, discovery documents, and token audience byte-for-byte identical.
  - AS issuer/endpoints use the same bare origin. **The entire OAuth surface (resource + embedded AS) is on this origin.** The embedded AS exists only for MCP (§7); the API host exposes no OAuth. Edge maps that host's root path to internal CP `/api/v1/mcp`, forwarding `/.well-known/*` unchanged (PRM at root is the path-inserted location for a root resource; AS metadata too) and `/oauth/*`.
  - Without `PUBLIC_MCP_URL` (local development / no subdomain), fall back to `<public-base>/v1/mcp` (`MCP_PUBLIC_PATH`), matching the public callback convention: `/api` is internal, while public paths use `/v1`. Edge rewrites `/v1/*` to `/api/v1/*`; direct CP hosting uses a root-level `/v1` alias in `server.ts`. Every **externally declared** URL—PRM `resource`, PRM location, 401 challenge—uses public form. This is required for §7.2's exact byte-for-byte match between PRM `resource` and the URL supplied by the user.
- **Authentication**: every HTTP request carries `Authorization: Bearer <key>` using any credential type in §5, through the unified pipeline. Missing/invalid credential → **401 + `WWW-Authenticate: Bearer resource_metadata="…"`**. This is both the error response and the entry into §7 OAuth discovery; the specification recognizes the header only on 401.
- **Organization boundary**: every credential type binds to **one organization** (existing `req.apiKeyOrgId` semantics), so an MCP session is naturally organization-scoped. Switching organizations requires another credential/authorization.
- **Prefer statelessness**: resolve principal and current role on every request; do not cache authorization in an MCP session.

### 6.2 Tool Catalog (v1)

Tools **call the CP service layer directly or reuse route-handler logic**, preserving zod validation, `denyViewerWrite`, `canView/canEdit`, and `visibilityWhere`. The tool layer never duplicates authz; it only translates 403/404 into model-friendly errors:

| Tool                                                           | Equivalent REST                                            | Write?  |
| -------------------------------------------------------------- | ---------------------------------------------------------- | ------- |
| `whoami`                                                       | GET /me + GET /orgs/:orgId (credential identity/role)      | –       |
| `listAgents` / `getAgent`                                      | GET /agents(:id)                                           | –       |
| `listWorkspaceFiles` / `readWorkspaceFile`                     | GET /agents/:id/workspace/files(file) (proxied, unstored)  | –       |
| `createAgent` / `updateAgent`                                  | POST /agents · PATCH /agents/:id                           | ✎       |
| `deleteAgent`                                                  | DELETE /agents/:id                                         | ✎🔥     |
| `listDaemons` / `renameDaemon`                                 | GET /daemons · PATCH /daemons/:id                          | –/✎     |
| `listCrons` / `getCron` / `listCronRuns`                       | GET /crons…                                                | –       |
| `upsertCron` / `runCron` / `deleteCron`                        | PUT /crons/:id · POST /crons/:id/run · DELETE              | ✎(🔥)   |
| `listSessions` / `getSession`                                  | GET /sessions(:id) (body policy is Open Question 1 in §15) | –       |
| `getUsage`                                                     | GET /usage                                                 | –       |
| `listIntegrations` / `setChannelTrigger` / `removeIntegration` | GET · PATCH channels/:channelId · DELETE                   | –/✎(🔥) |
| `listBots` / `listMembers` / `listAgentHooks` / `listHookRuns` | GET (metadata only, no secret)                             | –       |

Write tools require `mcp:write` for OAuth tokens or an unrestricted personal key. Role gates (deny all writes for viewers; reserve some operations for owner) are **not reimplemented in tools**; REST guards remain authoritative.

### 6.3 Credential-Specific Boundaries and Deny-List

- **Personal key / OAuth token (external tools)**: the user explicitly authorized the credential, so the tool catalog is **curation, not a security boundary**. Credential/member/organization/access-control operations are intentionally absent so the user's AI lacks convenient high-risk buttons, but hard boundaries are user RBAC + OAuth scopes. Existing guards block the worst cases (a key cannot mint another key, `me-keys.ts:84`; OAuth follows the same rule).
- **Delegated key (a platform-injected session credential, §4)**: add a **server-side hard denial beyond the catalog**. New guard `denyDelegated` returns 403 whenever `req.delegation` exists for these route families, preventing direct handcrafted requests that bypass tools:
  - all credential routes: `/me/keys`, `/daemons/token`, `/daemons/:id/keys`, `/agents/:id/webchat/token` (prevents a delegated session recursively opening another agent);
  - members and organization: writes under `/members`, `PATCH|DELETE /orgs/:orgId`;
  - access control: writes to all three `/sharing` families and `/agents/:id/call-policy`;
  - credential-bearing integrations: writes to `/bots`, Slack install / GitHub installation funnels, and `/slack/config`;
  - hook writes (persistent entry points; read-only in v1);
  - **its own host agent** — the "cannot unlock itself" property. The cancelled design got this from guards on `kind='assistant'`; with the toolset inside an ordinary agent, the successor must re-establish it against whatever configures that agent's admin sessions.

### 6.4 Destructive Operations Require Schema-Level Confirmation

Schemas for 🔥 tools `deleteAgent`, `deleteCron`, and `removeIntegration` require `confirm: string` that must **exactly equal the target resource name**. The CP compares it in the tool execution layer. This is a mechanism, not a prompt convention, and applies to every caller. A prompt may additionally ask for verbal confirmation, but that is a habit, never the boundary.

### 6.5 Rate Limits and Audit

- Per-key limits: 30 write operations/min and 120 total operations/min using an in-memory CP sliding window. 429 returns "Too many operations."
- Every tool invocation writes an `audit_event` of kind `mcp_tool_call` (§9.3), with `principalType` distinguishing external/OAuth/delegated.

---

## 7. Thin OAuth AS: Automatic Browser Sign-In

> Target experience: claude.ai → Add custom connector → paste MCP domain (§6.1; example `https://mcp.example.com`, local development `http://localhost:8080/v1/mcp`) → Connect → browser opens → console sign-in (Logto social login / devAuth passthrough) → select organization + consent → complete.
> Claude Code: `claude mcp add --transport http agentconnect <url>` → `/mcp` → browser → complete, with automatic token refresh.

### 7.1 Why a Thin AS Embedded in CP Instead of Logto as AS

- MCP Authorization (current 2025-11-25; previous Final 2025-06-18) allows a pure Resource Server to refer to any external AS, but Claude's zero-configuration connection depends on **DCR (RFC 7591)**. **Logto still does not support DCR** (❌ in mcp-auth provider matrix; roadmap Backlog; CIMD item Paused; absent through v1.41.0 in 2026-06). Its wildcard redirect URI also **explicitly excludes ports**, while Claude Code uses `http://localhost:<random-port-each-time>/callback` (RFC 8252), which fails directly.
- Mainstream products—**Sentry, Notion, Linear, Atlassian, and Cloudflare's official guidance/workers-oauth-provider**—embed a thin AS beside the MCP server and **issue their own tokens**; the product's existing login is used only for `/authorize`, and upstream credentials never leave. GitHub is the exception, requiring a pre-registered App per host; its ecosystem leverage does not apply here.
- Additional benefit: exchanged access tokens are exactly §5 `oauth` ApiKey rows. OAuth is merely a third mint point; verification, audit, organization binding, and immediate revocation are all reused without changes.

### 7.2 Endpoints (CP, `http/oauth/`)

> The OAuth AS is implemented as Fastify-native routes over `OAuthService`.
> MCP SDK v2 treats the MCP server as a Resource Server and does not provide an
> embedded AS. AgentConnect therefore owns the small AS route set and discovery
> document, while using the SDK on the resource-server side. This keeps
> `app.inject` coverage intact and avoids a global Express middleware layer.

```
GET  /.well-known/oauth-protected-resource               RFC 9728 PRM (root document: for a dedicated MCP domain
                                                         with a root resource, the path-inserted location is here;
                                                         edge on the MCP host forwards it unchanged; also generic fallback)
GET  /.well-known/oauth-protected-resource/v1/mcp        RFC 9728 PRM (path-inserted for public /v1/mcp, §6.1;
                                                         used by the 401 challenge without a dedicated domain)
GET  /.well-known/oauth-authorization-server             RFC 8414 AS metadata (issuer = AS origin; with dedicated MCP
                                                         domain, it is that domain; API host exposes no OAuth)
POST /oauth/register                                     RFC 7591 DCR (client_id = generated mcp-<uuid>, public)
GET  /oauth/authorize                                    → 302 to console consent page (§7.3)
POST /oauth/token                                        code/refresh exchange (PKCE S256 in OAuthService.exchangeCode)
```

Hard requirements verified against specifications and Claude documentation:

- **401 shape is load-bearing**: `WWW-Authenticate` is recognized only on 401 and ignored on 200. PRM `resource` must **exactly match byte for byte, including path**, the MCP URL supplied by the user. Only the **first** `authorization_servers` entry is used.
- AS metadata **must** declare `code_challenge_methods_supported: ["S256"]`; since 2025-11-25, clients continue only after verifying PKCE support. `grant_types` contains `authorization_code` + `refresh_token`; `token_endpoint_auth_methods_supported` contains `none` because Claude registers through DCR as a **public client**.
- **DCR**: allow anonymous registration. Claude creates a new client **for every new connection**, a known source of growth. Give registrations a **90d TTL** (same default as workers-oauth-provider). Later add **CIMD** (client_id is the HTTPS URL of a metadata document, preferred in 2025-11-25). When AS metadata declares `client_id_metadata_document_supported: true`, Claude automatically prefers it and registration-table growth disappears.
- **Redirect URI validation**: hosted surfaces (claude.ai/Desktop/mobile) use `https://claude.ai/api/mcp/auth_callback` (also allow the `https://claude.com/...` variant). Claude Code uses `http://localhost/callback` and `http://127.0.0.1/callback`, comparing while **ignoring ports** as required by RFC 8252 §7.3.
- **RFC 8707 `resource` parameter**: client sends it in both authorize and token requests (MCP URL including path). Store it in grant as audience. Tokens are usable only at this endpoint, naturally satisfying audience validation.
- **Scopes**: 401 challenge includes `scope="mcp:read mcp:write"` (client treats it as authoritative), and AS metadata `scopes_supported` lists the same scopes. Claude automatically adds `offline_access` for refresh tokens when the AS declares it, so include that too.
- **Latency limits**: discovery/registration/token ≤10s; refresh ≤30s. Timeouts cause intermittent connection failure. `/token` and `/register` use different content-type parsers (form vs. JSON); do not share one.
- **3xx trap**: cross-host redirects drop `Authorization`; never redirect MCP endpoint or well-known documents across domains.

### 7.3 `/authorize` → Console Consent Page (Reuse Login)

The CP has no browser session; it is only an OIDC resource server. Login lives in the Web console through Logto browser SDK; when `OIDC_ISSUER` is unset, devAuth passes through. Use the standard two-stage flow:

```
GET /oauth/authorize?client_id&redirect_uri&code_challenge&resource&scope&state
  → CP validates params + client + redirect_uri → stores pending request (id, 10min TTL)
  → 302 https://console…/oauth/consent?request=<id>

console /oauth/consent page (new):
  not signed in → existing Logto sign-in → return
  signed in → show client name (DCR/CIMD registration), organization picker (user orgs + roles),
              scope picker (mcp:read / mcp:read+write), Approve / Deny
  approve → POST /api/v1/oauth/consent { requestId, orgId, scopes }
            (console OIDC identity, or devAuth locally; API/OAuth keys are rejected)
  → CP creates authorization code bound to userId+orgId+scopes+PKCE challenge+resource
  → browser 302 redirect_uri?code&state

POST /oauth/token(code + code_verifier [+ client_id])
  → validate PKCE/redirect_uri/resource → mint oauth ApiKey (1h) + refresh token → return
```

- **Organization selection happens on the consent page** because keys bind to one organization. This matches Atlassian per-site authorization and Sentry path-constrained sessions. Switching organizations means reauthorizing; a client may add a second connector.
- Consent context, approval, and grant list/revocation require the interactive console identity. Existing personal keys and OAuth access tokens cannot mint or manage further credentials.
- In local devAuth, consent passes through as DEFAULT_OWNER, allowing end-to-end testing.

### 7.4 Token Model (Two New Tables + ApiKey Reuse)

- `oauth_client { clientId, name, redirectUris[], tokenEndpointAuthMethod, createdAt, expiresAt(90d) }`—DCR product. CIMD clients are fetched/validated by URL and not persisted.
- `oauth_grant { id, userId, orgId, clientId, scopes[], resource, rtHash, prevRtHash, rtExpiresAt, createdAt, revokedAt }`—one row per authorization. **Rotate refresh tokens while accepting the newest two generations**. workers-oauth-provider experience shows strict one-time validity can lock a user out if the client fails to persist the new token. Refresh expires after 30d inactivity. Dead refresh returns RFC 6749 `invalid_grant`, which prompts Claude to reauthenticate.
- Access token = **`ApiKey` row with principalType `oauth`, TTL 1h**, whose `meta` points to grantId. Existing key cleanup removes expired rows. **Revoking a grant revokes every token under it** through the Profile "Connected AI tools" card (§11).
- Claude refreshes passively on 401 and proactively ≤5min before expiry; 1h TTL is invisible to users.

### 7.5 Cloud Connector Reachability

**claude.ai / Desktop / mobile initiates MCP connections from the provider's
cloud network.** Follow the provider's current published networking
requirements; private or split DNS and restrictive ingress can prevent both
MCP access and identity-provider callbacks. Therefore, **CP and console must be
publicly reachable over HTTPS** for cloud connectors. Private self-hosted
installations can still use Claude Code, where the flow runs on the user's
machine, or a manually supplied personal key.

### 7.6 Implementation Locations (Hand-Rolled Fastify, No Express)

The AS is entirely Fastify-native routes (`http/oauth/routes.ts` + `metadata.ts`) over an SDK-independent `OAuthService` (302 lines):

- **`/oauth/token` is form-urlencoded**: add an `application/x-www-form-urlencoded` parser inside this **encapsulated plugin**, leaving the main API untouched.
- **PKCE S256 lives in `OAuthService.exchangeCode`**. One-time code consumption (`consumeCode` atomically), two-generation refresh rotation, and loopback redirect-port ignoring all live in `OAuthService` so both injection and real sockets exercise them.
- **`client_id` is generated as `mcp-<uuid>`**, always public (`token_endpoint_auth_method:'none'`, no secret).
- OAuth routes use `schema:{ hide:true }` and do not enter OpenAPI.
- Derive issuer/base per request from `PUBLIC_CP_URL` in production or request host in dev/test, and include it in discovery documents.

> **Do not mount the OAuth AS through global Express middleware.**
> `@fastify/express` installs a global `onRequest` dispatcher that interferes
> with `light-my-request` body capture. Keep the AS Fastify-native and
> inject-testable.

---

## 8. Daemon-side injection — cancelled as written, mechanics moved

Every rule here branched on `kind='assistant'`, and no such kind ships. The
transferable part — how the MCP server and its credential reach a session
without the credential ever becoming visible to the model — now lives in §4.3,
where the branch is session-shaped rather than agent-kind-shaped.

Two rules do **not** transfer and are deliberately not carried forward:

- The **restricted runtime profile** (empty scratch workspace, Bash/Edit/Write
  disabled, a `claude`-only runtime allowlist). It defended against vertical
  escalation — a viewer driving a built-in agent into shell access on the daemon
  host. The successor's host is the general preset: an ordinary, shell-capable
  development agent, so that defense cannot simply be inherited. **This reopens
  the question**: what stops a low-privilege member from reaching admin tools, or
  the daemon host, through a session on an agent they can already talk to? The
  credential model answers the first half (tools execute as the caller, §4/§6);
  the second half needs its own answer before the toolset ships.
- The **immutable built-in system prompt**: a user-editable agent has no
  CP-owned prompt to lock.

## 9. Control-Plane Implementation

### 9.1 Change List

| File                          | Change                                                                                                                                                                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http/mcp/` (new)             | AgentConnect MCP endpoint, tool registry (§6.2), confirmation, rate limits                                                                                                                                           |
| `http/oauth/`                 | `metadata.ts` (root + path-inserted PRM and AS metadata), `routes.ts` (register/authorize/token), `consent.ts` (consent context/decision + grant CRUD), `base.ts` (base URL + metadata + 401 challenge construction) |
| `http/plugins/auth.ts`        | `withApiKeyAuth` recognizes oauth/delegated → principal + scopes + `req.delegation`                                                                                                                                  |
| `http/rbac.ts` (or new guard) | Mount `denyDelegated` on §6.3 route families                                                                                                                                                                         |
| Relay browser session path    | Add an explicit CP mint request carrying the authenticated relay `chatId`, then deliver the delegation through the relay→daemon session path (§4)                                                                    |
| `registry/apiKeyService.ts`   | `mintDelegated`/`mintOauth` + verification branches + expiry cleanup                                                                                                                                                 |
| Audit                         | Tool execution writes `audit_event` kind `mcp_tool_call` (§9.3)                                                                                                                                                      |

### 9.2 Visibility Interaction

When tools operate on resources, service-layer `visibilityWhere`/`canView` filters as the credential user. Restricted resources remain invisible to unauthorized tool callers with 404 semantics, adding no existence oracle. The host agent's own visibility is simply whatever the org set for it.

### 9.3 Audit

Use the existing append-only `audit_event` stream with kind `mcp_tool_call`
(defined in migration `00000000000000_init`). Its `details` contain
`{ tool, args, status, apiKeyId }`; `actorUserId` and `orgId` use the standard
columns. MCP tool calls are management-plane operations like `cron_change` and
`hook_change`, so no separate operation-log table is required.

Resource `lastModifiedByUserId` naturally records the **actual user** because they are the principal. An edit through an MCP tool is equivalent to a console click in resource audit; the operation event supplies the "through which interface" dimension.

### 9.4 [Superseded] Session Privacy (Assistant Exception)

> **Superseded** with the assistant agent (§3). Retained because the successor
> shape inherits the underlying question: an admin-tool conversation is a per-user
> operational conversation, whoever hosts it.

Session list/detail reads the **CP database** (`SessionMeta`, synchronized from daemon `event/session` snapshots in `sessions.ts:116-183`; transcript body remains daemon-fetched). Visibility normally derives from agent. Assistant would be organization-visible, but **its sessions are private per-user operational conversations**:

- Add optional `initiatorUserId` to `event/session` snapshot (`protocol/frames/telemetry.ts`) and `SessionMeta` (assistant session = delegated userId; ordinary agent omits it, unchanged behavior).
- CP routes filter `kind='assistant'` rows to
  `initiatorUserId === viewer.userId`; organization role is not a visibility
  bypass. Apply the same gate to `/sessions/:id/messages` and `tool-body`.
- Webchat Playground list is already scoped by conversation ownership; no change.

---

## 10. Security Analysis

1. **Confused deputy (eliminated)**: tool authority always equals credential user. CP service layer enforces RBAC/visibility from `req.principal`; role is resolved live, so demotion applies immediately. The MCP — and any agent session reaching it — has no independent authority to borrow.
2. **Prompt injection**:
   - Tool RESULTS are data, not instructions: agent descriptions, session titles, and cron names may carry text planted by another member. The defenses are CP tool-layer properties and apply to every caller — delegated deny-list (§6.3), schema-level confirmation (§6.4), rate limits (§6.5), complete audit (§9.3).
   - _External AI tool_: same risk exists, but the user **authorized their own tool**. Consent can grant only `mcp:read`; curation, confirmation, and audit still apply. Hard boundary is user RBAC ∩ scopes.
3. **Vertical escalation (member → daemon host shell) — OPEN.** External tools never run on our hosts, so this only bites the in-product path. The cancelled design answered it with a mandatory restricted runtime profile; the successor's host is an ordinary shell-capable agent, so it needs a new answer before the toolset ships (§8, preset-agents.md §9).
4. **Credential surface**: the delegated key would be minted only by the gateway, 12h, replaced on reconnect (planned, §4); OAuth access token 1h with rotating refresh and Profile revocation; personal key retains existing lifecycle. All store hash-only and every call is audited. **Open DCR grants no authority**: client registration gives no access; every access requires human browser consent.
5. **Lateral isolation**: independent per-user delegation bound to an independent `sessionKey` (§4). The cancelled design added memory-tool removal and a per-initiator session filter, which were properties of that agent, not of the tool layer.
6. **MCP/OAuth exposure**: same TLS origin as REST. Unauthenticated callers see only 401 + public metadata, intentionally public. Pending authorize requests have short TTL; codes are one-time + PKCE.

---

## 11. Web Console

- **"Connect your AI" page/card** in Settings or Profile: show MCP URL and connection guides for claude.ai connectors, `claude mcp add`, and Cursor. Before OAuth ships, provide manual personal-key path by reusing ApiKeysCard.
- **OAuth consent page** (§7.3, new route `/oauth/consent`): reuse login + organization/scope selection. Add Profile **"Connected AI tools"** card listing oauth_grant client name, organization, scopes, recent use, and one-click revoke.

---

## 12. Future: IM Ingress Requires Cross-System Identity Binding

Not in v1; reserve the design. The mechanism below is agent-shape-independent — it
is a mint point, and the cancellation of the assistant agent does not touch it:

- New table `platform_identity { orgId, platform, platformUserId, userId, verifiedAt }`; binding flow = start in console → return verification code from IM (or Slack OpenID).
- After binding, IM admission to an admin-tool session looks up `platformUserId` → asks CP to mint delegation for userId through a new WebSocket REQ → then uses the same path as webchat. Unbound users receive "Bind your identity first."
- A cron-driven session similarly binds delegation to the cron creator; CP verifies the current role at fire time and delivers it with `cron/run`.
- Both change **only the mint point**. §5/§6 credential/tool/audit are reused unchanged—the long-term benefit of tools in CP and credential-as-identity.

---

## 13. Phases

MCP first: **P0–P2 do not touch daemon/protocol/agent model** — they are shipped. P3
is cancelled; P4 remains the prerequisite for any in-product conversational entry:

| Phase   | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P0**  | **Available:** `POST /api/v1/mcp` (stateless Streamable HTTP, JSON mode) + personal-key Bearer auth + **15 read-only tools** (reuse REST RBAC/visibility through `app.inject`) + per-call `audit_event`. It is usable from Claude Code with a manually supplied key via `--header`. Code: `src/http/mcp/{tools,routes}.ts` + unit/integration tests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **P1**  | **Available:** **9 write tools** (§6.2 ✎: createAgent/updateAgent/deleteAgent, renameDaemon, upsertCron/runCron/deleteCron, setChannelTrigger/removeIntegration; §6.3 curation excludes credential/member/organization/access-control/bot/hook writes) + **§6.4 confirmation gate** (🔥 deletions require exact `confirm` matching resource name; execution comparison returns 412 without echoing expected value) + **§6.5 rate limit** (`McpRateLimiter` in-memory window, 120 total/30 writes per credential per minute, one shared instance across both mounts; rejected calls consume no budget and create no audit) + **per-tool scope gate** (tools/list hides writes from `mcp:read`; tools/call returns 403; org-scope REST guard remains fallback) + MCP ToolAnnotations (readOnlyHint/destructiveHint) + Web **"Connect your AI" modal** (rail-footer Help entry, MCP endpoint URL + claude.ai/Claude Code instructions + "More" external connector docs, runtime-injected `MCP_URL`). Code: `src/http/mcp/{tools,routes,rate-limit}.ts`, `packages/web/…/ConnectAiModal.tsx` + unit/integration tests |
| **P2**  | **Available:** thin OAuth AS (§7)—well-known PRM (root + path-inserted) + AS metadata, `/oauth/register` (DCR public client), `/oauth/authorize` (validate then 302 to console consent), `/oauth/token` (code + refresh, PKCE S256, form-urlencoded), consent backend (`/api/v1/oauth/consent{,/context}` + `/oauth/grants` CRUD), and Web consent page. `GET/DELETE /oauth/grants` supports revocation through the API; a Profile "Connected AI tools" card is not present. Access token = `oauth` ApiKey (1h) + rotating refresh (two-generation window). Code: `src/http/oauth/*`, `src/registry/oauthService.ts`, `oauth.repo.ts` + unit/integration tests                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **P3**  | **CANCELLED (2026-07-29).** Was: assistant foundation — `AgentKind` + reserved slug + fixed-property guards + `/assistant` endpoints + `AgentSpec.kind` + restricted runtime profile + Web enablement/badge. Only the **reserved slugs** were kept, and they shipped with preset-agents.md M0 instead. Successor: the AgentConnect MCP admin toolset inside the `agentconnect` general preset's webapp sessions (preset-agents.md §4, M3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **P5+** | IM identity binding, cron delegation, per-user memory namespace, CIMD, enterprise SSO direct connection (§12 / §7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 14. Test Plan

Scope: the MCP, OAuth, credential-matrix, `denyDelegated`, and reserved-slug cases
below are requirements. Cases for the cancelled built-in agent (§3) are gone with it.

**Unit (CP)**: MCP registry schema (confirmation required families); credential verification matrix for all three key types (expired/revoked/wrong principalType/cross-org/scopes → reject); `denyDelegated` route-family matrix; reserved slug. **Pure OAuth logic**: PKCE S256, redirect URI match (exact hosted / loopback ignore port), one-time code, refresh rotation accepting newest two and rejecting third, `invalid_grant`, exact PRM `resource`, AS metadata includes `code_challenge_methods_supported`.

**Integration (CP, real Postgres)**:

- personal/OAuth key through MCP `listAgents` sees only user-visible resources; unauthorized restricted resource remains invisible;
- viewer write tool returns 403;
- `mcp:read` write tool returns 403;
- confirmation mismatch rejects;
- rate limit returns 429;
- every tool call writes operation audit;
- delegated key calling `/me/keys`, `/daemons/token`, or sharing write returns 403;
- after user removal from organization, credential request returns 404;
- **OAuth end to end** under devAuth: register → authorize → consent → code → token → MCP call → refresh rotation → grant revoke immediately invalidates token;
- 401 contains correct `WWW-Authenticate`; PRM available at root + path-inserted locations.

**Daemon** (P4): concurrent sessions for two users carry their own keys without mixup; expired delegation fails closed with explicit error; restart restores delegation with session; bridge child environment carries credential while transcript does not leak it.

---

## 15. Decision Record

1. Tool surface = CP-hosted AgentConnect MCP, reached by external AI tools through
   OAuth or a personal key. Its second consumer was to be `agent-assistant`, a
   built-in agent with that MCP auto-injected; ❌ cancelled 2026-07-29 — the
   successor is the `agentconnect` general preset's webapp sessions
   (preset-agents.md §4), reaching the same MCP through the same §4 credential.
2. ✅ **External sign-in = thin OAuth AS embedded in CP** (automatic browser login; open DCR + 90d TTL; token = `oauth` ApiKey row, 1h + rotating refresh). Rejected Logto-as-AS because it lacks DCR (roadmap Backlog) and wildcard redirects exclude ports. Logto remains console human login. Personal keys remain for headless/CI, as all compared products except Notion do.
3. ❌ Name `agent-assistant`, kind enum `assistant`, replacing v0 owner-only "system agent." Cancelled with P3; the names stay reserved and unprovisioned (preset-agents.md §3.3).
4. ✅ Credential is identity: personal / OAuth / delegated share one table and pipeline; tools execute as credential user. The cancelled agent added owner-only editability and closed ingress; what survives is the ingress rule itself — a platform-injected credential is minted only for a **webchat** session (§4).
5. ✅ High-risk credential/member/organization/access-control/bot/hook writes excluded from catalog; delegated credential hard-denied server-side.
6. ❌ Restricted runtime profile is mandatory; v1 runtime allowlist = claude. Reopened for the successor, whose host is an ordinary shell-capable agent (preset-agents.md §9).
7. ❌ Assistant receives no memory tools; sessions isolated by initiator — properties of the cancelled agent, not of the tool layer.
8. ✅ **OAuth scopes are security boundaries, not decoration**: `authenticateUser` carries `row.scopes` into `req.apiKeyScopes`; **org-scope guard returns 403 for write methods other than GET/HEAD when a scoped token lacks `mcp:write`**. Otherwise `mcp:read` browser consent silently authorizes writes to all REST endpoints. Personal keys have `scopes=[]` and remain unrestricted. MCP endpoint is outside the org subtree, so its read tools use POST without being blocked. P1 adds a mirrored per-tool gate: without `mcp:write`, tools/list hides write tools and tools/call returns 403. Org-scope remains fallback because injected REST requests from write tools pass through it.
9. ✅ **Disconnect↔refresh race fixed**: refresh rereads grant after minting. If revoked, reclaim the freshly minted token and return `invalid_grant`, preventing disconnect from releasing one extra 1h token tied to a revoked grant.

### Open Questions

1. Should read tools include session **body** (`getSessionMessages`)? `canView` permits it semantically, but body entering model context expands prompt-injection surface. Preferred v1: metadata + console deep link only. External tools and in-product sessions could differ (external = user accepts risk).
2. Rate-limit thresholds and whether to add an organization-wide ceiling.
3. Delegation delivery-frame path. Relay migration is complete, so P4 must
   extend the current CP verification/relay session flow with an authenticated
   `chatId`-aware mint request and deliver the result via relay→daemon `rd/*`.
   Exact frame shape remains a P4 design decision; see §4.
4. Synchronization between MCP catalog and OpenAPI: manually curated (current) vs. generated from OpenAPI + allowlist; revisit when tools grow.
5. Should consent support "remember choice / skip repeat consent" for same client + organization + scopes?
6. claude.ai requires public CP/console reachability (§7.5). How should documentation and product messaging describe private self-hosted deployments?
7. **OAuth-row garbage collection**: no cleanup yet exists for consumed or
   expired `oauth_code`, expired `oauth` API keys, or expired `oauth_client`
   rows; `*_expiresAt_idx` indexes bound query cost. Add an OAuth reaper modeled
   after `CronRunReaper`/`SlackInstallReaper` to delete consumed or expired
   codes, expired and revoked OAuth API keys, and expired clients.
