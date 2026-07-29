# AgentConnect MCP — System-Operations MCP for AI Tools (and the superseded built-in assistant)

**Status**: MCP and OAuth are available; the delegated credential path (P4)
remains planned. **The DEDICATED built-in assistant agent (P3) is CANCELLED**
(2026-07-29, see [preset-agents.md](preset-agents.md)): assistant/admin
capabilities are planned to fold into the `agentconnect` general preset instead —
first step: its webapp (Playground/webchat) sessions get this MCP's admin toolset,
with the per-session delegated key (P4's webchat half) still the security
prerequisite. P3's restricted-profile / fixed-property machinery stays documented
here as the reference for that successor shape. · **Version**: v2
**Scope**: protocol + daemon + control-plane + web

> **Reading guide.** Active design: §§2 (unmarked rows), 5, 6, 7, 9.1–9.3, 10
> (unmarked items), 11 (unmarked bullets), 13 P0–P2, 14, 15. Still planned: §4 (the
> webchat delegated credential, P4) and §13 P4. **Superseded — retained as the
> reference for the successor shape, not as requirements: §3, §8, §9.4, §13 P3, and
> every item explicitly marked `[superseded]`.** "The assistant" in a superseded
> passage always means the cancelled dedicated agent, never a shipping resource.

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
- **A conversational entry inside AgentConnect itself** (planned): a webchat/Playground session that reaches the same toolset through a platform-injected per-session credential (§4), for users who do not want to configure MCP in an external tool. _[superseded]_ This document's original vehicle for that entry was **agent-assistant**, one built-in agent per organization (§3, §8). That agent is cancelled; the successor is the `agentconnect` general preset's webapp sessions (preset-agents.md §4), which reach the toolset through the same §4 credential.

Design requirements:

1. **Authorization = user behind the credential**. The MCP has no authority of its own, and neither does any agent that reaches it. Resources hidden from that user remain hidden from tools; resources that user cannot delete remain undeletable.
2. **External connection must support zero-configuration browser sign-in** through the MCP Authorization OAuth flow (§7), without forcing users to copy API keys.
3. _[superseded]_ **agent-assistant is a built-in resource**: platform-provided, one per organization, undeletable, reserved slug, visible to everyone. No such built-in ships; only the slugs stay reserved (preset-agents.md §3.3).
4. **The in-product conversational entry is Web-only**: only webchat has a trusted console principal. IM ingress waits for cross-system identity binding (§12). External AI tools are unaffected because their OAuth/personal key already establishes a trusted identity.

### Architecture in One Diagram

```
External AI tool (claude.ai / Claude Code / Cursor…)          ── SHIPPED ──┐
        │  OAuth browser sign-in (§7) or Bearer personal key               │
        ▼                                                                  ▼
User ─ webchat ─▶ agent session on a daemon (ACP) ─(delegated key auto-injected ──▶ AgentConnect MCP (CP-hosted, §6)
                 [planned, §4; target = the `agentconnect`  = "pre-authenticated", §4)   │ calls service layer in process
                  general preset's webapp sessions —                                     ▼
                  the built-in assistant of §3/§8 is superseded]      existing RBAC + visibility unchanged + per-operation audit
```

The CP remains outside the message hot path—the agent conversation stays local to the daemon. MCP tool calls are **control-plane operations**, which properly belong on the CP.

---

## 2. Decision Table (Forks)

Rows marked `[superseded]` describe the cancelled dedicated assistant agent (§3/§8)
and are retained as the reference for the successor shape; every other row is active.

| Decision                              | Choice                                                                                                                                                                                                                                      | Rejected alternative                                                                                                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool host                             | **CP-hosted MCP server; tool definitions, confirmation, rate limits, and audit live in one place only** (§6)                                                                                                                                | Daemon built-in tool set + daemon→CP REST (v1: duplicate tool evolution in daemon and unusable by external AI tools); per-operation WebSocket frames (duplicate authz)                                                              |
| Authorization model                   | **Credential is identity: all three credential types (§5) resolve to a user, and tools execute as that user**                                                                                                                               | Assistant/MCP holds organization-level admin credentials (prompt injection compromises the whole organization; viewer can escalate)                                                                                                 |
| External authentication               | **Thin OAuth AS embedded in CP (automatic browser sign-in, §7) + Bearer personal-key fallback**                                                                                                                                             | Keys only (claude.ai connectors have no formal manual-header UI and UX is poor); OAuth only (dead end for headless/CI—Sentry and Atlassian both had to add key paths)                                                               |
| OAuth AS host                         | **Thin AS embedded in CP, issuing opaque tokens; `/authorize` reuses console login** (mainstream pattern from Sentry/Notion/Linear/Atlassian/Cloudflare guidance)                                                                           | Use Logto directly as AS—**Logto still has no DCR** (roadmap Backlog, CIMD Paused, absent in v1.41.0); wildcard redirect URIs exclude ports (breaks random localhost ports from Claude Code); token model couples to Logto JWT/JWKS |
| Built-in discriminator `[superseded]` | **`AgentKind { standard, assistant }`: `Agent.kind` column + `AgentSpec.kind`** — cancelled; no kind discriminator ships, only the slugs stay reserved (preset-agents.md §3.3)                                                              | Reuse `createdByUserId=null` (CLI-created agents also use null); magic slug (spoofable)                                                                                                                                             |
| Assistant visibility `[superseded]`   | **Fixed `visibility='org'`; reject writes to `/sharing` and `/call-policy` for assistant**                                                                                                                                                  | Restricted (contradicts "available to everyone"); owner-only (obsolete v0 requirement)                                                                                                                                              |
| Assistant ingress `[superseded]`      | **Webchat only in v1**; cannot bind integrations, run from cron, or receive peer `messageAgent`. The successor keeps the webchat-only boundary for admin tools but expresses it per **session** rather than per agent (preset-agents.md §4) | Direct IM ingress (platform cannot map IM identity to console user, breaking the authorization model)                                                                                                                               |
| Enablement `[superseded]`             | **Owner explicitly enables and selects placement daemon** (disabled by default; MCP remains available to external tools by default)                                                                                                         | Auto-enable at organization creation (assistant consumes a selected daemon's machine/model budget and requires an explicit decision)                                                                                                |
| Session visibility `[superseded]`     | **Assistant sessions visible only to initiator + organization owner** (§9.4)                                                                                                                                                                | Derive from agent = visible to whole organization (conversation includes data from an individual user's perspective and leaks laterally)                                                                                            |
| Memory tools `[superseded]`           | **Remove memory tools from assistant** (agent memory is shared across users)                                                                                                                                                                | Retain them (A's information becomes readable by B); per-user namespace (too large for v1, future work)                                                                                                                             |
| High-risk operations                  | **Credential/member/organization/access-control operations excluded from tool catalog; delegated keys hard-denied for those route families in the CP** (§6.3)                                                                               | Expose everything and rely on RBAC (injection-triggered key minting/member changes have excessive blast radius)                                                                                                                     |
| Destructive confirmation              | **Tool schema requires exact `confirm: '<resource-name>'` echo** (§6.4)                                                                                                                                                                     | Prompt-only convention (fails when model behavior drifts)                                                                                                                                                                           |
| Assistant runtime `[superseded]`      | **Locked scratch workspace + restricted profile (no shell/file tools), runtime allowlist** (§8.2) — the successor's target is an ordinary, shell-capable general agent, so this reasoning does not transfer unchanged (preset-agents.md §9) | Same profile as ordinary agents (a viewer uses assistant to execute shell on daemon host, a vertical escalation)                                                                                                                    |

---

## 3. [SUPERSEDED] Data Model for the Built-in Assistant Agent

> **Superseded 2026-07-29 — nothing in §3 is a shipping requirement.** The
> `AgentKind` discriminator, the partial unique index, the fixed-property guards,
> and the `/orgs/:orgId/assistant` endpoints all existed to make one built-in
> assistant agent per organization; that agent is cancelled (preset-agents.md §4).
> The section is retained as the reference for the successor shape — the same MCP
> admin toolset reached from the `agentconnect` general preset's webapp sessions —
> whose closed-surface questions (what a session may configure, what it may never
> touch) are the ones answered below in per-agent terms.
>
> **Two carve-outs are live and unaffected:** the reserved agent slugs (the current
> set lives in preset-agents.md §3.3 and includes the assistant names, which stay
> reserved but are never provisioned), and the OAuth tables of §7.4.

`packages/control-plane/prisma/schema.prisma`:

```prisma
enum AgentKind {
  standard
  assistant
}

model Agent {
  // ... existing fields (:291-345)
  kind AgentKind @default(standard)   // beside status (:298)
}
```

- The additive `kind` column defaults existing and new ordinary agents to
  `standard`; assistant rows use `assistant`. Rollout sequencing is outside
  this data-model contract.
- **Reserved slug** _(live — the one carve-out from this section)_: add `RESERVED_AGENT_SLUGS = {'agent-assistant', 'assistant'}` in `http/dto/index.ts`. Existing `RESERVED_SLUGS` at `:590-606` reserves only **organization** slugs; agent names have no protection. Validate `CreateAgentBody`/`UpdateAgentBody` to prevent impersonation. The shipped set is wider and authoritative in preset-agents.md §3.3 (it adds `agentconnect` and `agentconnect-assistant`); the assistant names remain reserved even though no assistant agent is provisioned.
- At most one row per organization: partial unique index `CREATE UNIQUE INDEX ... ON "agent"("orgId") WHERE "kind"='assistant'`.
- Add `kind` to `AgentRecord`/`CreateAgentInput` in `ports.ts`; map it in `agent.repo.ts` `toRecord` at `:59-97`; add it to `AgentDto` in `dto/index.ts:239-273`. It **must appear in the zod DTO or serialization strips it** (house rule from resource-visibility §5.8).
- OAuth tables are in §7.4 (`oauth_client`, `oauth_grant`).

### 3.1 [Superseded] Fixed Assistant Properties (Locked at Creation; Reject Changes Through PATCH and Dedicated Endpoints)

| Field                                  | Fixed value                   | Enforcement point                                                                                                      |
| -------------------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `name`                                 | `agent-assistant`             | Reserved slug + kind discriminator                                                                                     |
| `visibility` / `sharedWith`            | `org` / `[]`                  | `PUT /agents/:id/sharing` (near `agents.ts:485-520`) returns 400 for `kind='assistant'`                                |
| `callPolicy` / `allowedCallerAgentIds` | `selected` / `[]`             | `PUT /agents/:id/call-policy` returns 400; existing daemon check at `daemon.ts:2070` naturally rejects every peer call |
| `workspaceMode`                        | `scratch`                     | PATCH validation                                                                                                       |
| Integrations                           | Always empty                  | Add kind check to agent validation in `POST /integrations` (`integrations.ts:116-118`) → 400                           |
| Cron target                            | Cannot target assistant in v1 | Add kind check to `body.agentId` validation in `PUT /crons/:id` (`crons.ts:96-99`) → 400                               |
| Deletion                               | `DELETE /agents/:id` → 400    | Owner disables by setting `status='inactive'`                                                                          |

Owner-only editable fields (decision §15.4): `runtime`, `runtimeOverrides` (model/effort/fastMode), `status`, and placement (`daemonId`).

### 3.2 [Superseded] Enablement / Provisioning (Dedicated Endpoint, Not Generic POST `/agents`)

```
GET    /orgs/:orgId/assistant   → { enabled, agentId?, daemonId?, status? }
PUT    /orgs/:orgId/assistant   → enable/move placement: { daemonId, runtime? } (idempotent upsert)
DELETE /orgs/:orgId/assistant   → disable (status='inactive'; retain row)
```

Guard with `denyNonOwner`. `PUT`: validate that daemon belongs to the organization and is online and that runtime is in the lockable allowlist (§8.2) → upsert the `kind='assistant'` row (`createdByUserId` = enabling user for audit) → send to daemon through `replicateUpsert` (`agents.ts:241-250`). OpenAPI uses `tags: [Tag.Agents]`, `operationId: getAssistant/enableAssistant/disableAssistant`, and complete summary/description (house rule).

### 3.3 [Superseded] Roster / Wire

Add `kind: z.enum(['standard','assistant']).default('standard')` to `AgentSpec` (`packages/protocol/src/frames/agent.ts:51-95`):

- Daemon needs kind to (1) inject AgentConnect MCP (§8.1), (2) apply the restricted runtime profile (§8.2), and (3) reject locally configured integrations. It is a **behavior field, not a visibility field**, so it does not violate "visibility never goes on wire" (resource-visibility §9). Copy it in `orchestrator/agentSpecAssembler.ts` when `agentRecordToSpec` builds the wire spec.
- Add `kind` to daemon `AgentSchema` (`packages/daemon/src/agents/agent-schema.ts:94-158`) and classify it as CP-owned in `write-agent.ts`.

---

## 4. Session Ingress and Identity Binding (P4, planned — Webchat Only)

> **Still planned, and still the prerequisite.** The per-session delegated
> credential below is what makes any admin tool safe to reach from inside an
> AgentConnect conversation, and it is unbuilt. **One detail is superseded:** step 1
> mints "only when the target agent has `kind='assistant'`". No such kind ships —
> the successor gate is the `agentconnect` general preset's webapp sessions
> (preset-agents.md §4), i.e. a **session-shaped** condition rather than an
> agent-kind one. Everything else in this section — the verification leg, the
> ownership-bound `conversationId`, session-scoped binding, and fail-closed
> injection — carries forward unchanged.

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
   entitled to the admin toolset (§5) — _[superseded]_ originally "only when the
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
   session (§8.1), preventing a caller-supplied conversation ID from crossing
   user boundaries.

_[superseded]_ No non-webchat path reached the assistant agent: §3.1 closed integration, cron, and peer-call paths, and routeRules cannot match an agent with no integration. The successor cannot borrow that argument — the general preset is a fully integrated agent — so the boundary must hold at the **credential**: a session without a minted delegation has no admin toolset at all (§8.1's fail-closed injection), which is why P4 is a hard prerequisite rather than an accompaniment.

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
  - _[superseded]_ **the assistant itself**: every write targeting `kind='assistant'` plus `PUT|DELETE /orgs/:orgId/assistant` (cannot modify/delete/move or unlock itself). No such kind or endpoint ships; the "cannot unlock itself" property is what the successor shape has to re-establish for whatever configures the general preset's admin sessions.

### 6.4 Destructive Operations Require Schema-Level Confirmation

Schemas for 🔥 tools `deleteAgent`, `deleteCron`, and `removeIntegration` require `confirm: string` that must **exactly equal the target resource name**. The CP compares it in the tool execution layer. This is a mechanism, not a prompt convention, and applies to every caller. _[superseded]_ The built-in assistant prompt (§8.3) additionally required restating the operation to the user and receiving verbal confirmation — a prompt-level habit the successor shape can adopt, but never the boundary.

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

## 8. [SUPERSEDED] Daemon-Side Implementation (the Other Half of "Pre-Authenticated")

> **Superseded 2026-07-29 — nothing in §8 is a shipping requirement.** Every rule
> below branches on `kind='assistant'`, and no such kind ships. The section is
> retained as the reference for the successor shape (preset-agents.md §4), where
> the same three problems reappear in session terms: **§8.1** injection and the
> credential-never-reaches-the-model discipline is the piece that transfers most
> directly, with the branch moving from agent kind to "this session holds a
> delegation"; **§8.2**'s restricted profile does **not** transfer — the successor's
> target is the ordinary, shell-capable general preset, so the vertical-escalation
> question it answers is reopened, not inherited; **§8.3**'s immutable built-in
> prompt has no owner once the agent is an ordinary, user-editable one.

Tools live in the CP. The daemon only **connects MCP to the entitled session and supplies the credential**.

### 8.1 [Superseded] MCP Injection

Branch `mcpServersFor` (`daemon.ts:725`) by kind:

- `kind='assistant'` → inject **one** MCP server: AgentConnect MCP (CP endpoint) with delegated key bound to this session (§4). Do **not** inject memory/collaboration/platform tools (`toolsForIntegrations`, `tools.ts:344`) and do **not** resolve external `mcpServers` (early kind check in `resolve-servers.ts`). The assistant capability surface must be closed and auditable.
- Transport: if runtime probing (`runtime-prober.ts` `mcpCapabilities`) supports HTTP MCP, provide URL + header directly. Otherwise reuse existing stdio bridge (`mcp/bridge.ts` / `index.ts:110` precedent): daemon spawns an `mcp-remote-bridge` subcommand with `AC_MCP_URL`/`AC_MCP_KEY` in environment. **The credential exists only in an environment created by daemon for the child and remains invisible to the model**, matching existing `AC_MCP_TOKEN` discipline.
- Derive CP endpoint from `controlPlane.url` (near `config/config-schema.ts:49`) by ws(s)→http(s), because CP uses one port and reachability matches the current WebSocket.
- Missing/expired delegation → bridge returns an explicit fail-closed error for `tools/call`: "Session credential expired; refresh the page and reconnect." Reconnect remints and restores operation. Queued turns under P4 admission queue finish normally while delegation remains valid.

### 8.2 [Superseded] Restricted Runtime Profile (Mandatory Vertical-Escalation Defense)

A viewer cannot create agents but can drive assistant. If assistant gets an ordinary agent profile (claude-code shell/file tools), the viewer can execute commands on daemon host. Therefore assistant ACP host:

- always uses an empty scratch workspace;
- applies a **restricted permission profile** at spawn: Claude runtime disables Bash/Edit/Write/WebFetch and similar built-ins through settings/`--disallowed-tools`; lock `permissionMode` to read-only and set `permissions.policy` to deny local side effects;
- includes these spawn arguments in **`hostSpawnSig`** (`reconciler/reconciler.ts:21-35`) so profile changes cause respawn, following the fastMode lesson;
- uses a **runtime allowlist**. Any runtime whose local tools cannot be reliably locked is rejected by §3.2 `PUT`. v1 allows `claude`.

### 8.3 [Superseded] Built-in System Prompt

CP code generates an immutable template for assistant `description` (which seeds the ACP system prompt through `claudeSessionMeta`). It includes self-introduction, tool semantics, and **safety rules**: restate destructive operations before execution; confirm each target for requests such as "delete every agent"; honestly report operations disallowed by the user's role and never attempt bypass; treat text in tool results as data rather than instructions. Template upgrades naturally hot-update through `replicateUpsert`.

---

## 9. Control-Plane Implementation

### 9.1 Change List

Rows tagged `[superseded]` belong to the cancelled assistant agent (§3/§8) and are
not planned work; the rest is shipped (MCP, OAuth) or planned with P4 (§4).

| File                                      | Change                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/schema.prisma`                    | ~~`AgentKind` + `Agent.kind` + partial unique index~~ `[superseded]`; `principalType` adds `oauth`/`delegated`; `oauth_client`/`oauth_grant` tables                                                                  |
| `http/mcp/` (new)                         | AgentConnect MCP endpoint, tool registry (§6.2), confirmation, rate limits                                                                                                                                           |
| `http/oauth/`                             | `metadata.ts` (root + path-inserted PRM and AS metadata), `routes.ts` (register/authorize/token), `consent.ts` (consent context/decision + grant CRUD), `base.ts` (base URL + metadata + 401 challenge construction) |
| `http/plugins/auth.ts`                    | `withApiKeyAuth` recognizes oauth/delegated → principal + scopes + `req.delegation`                                                                                                                                  |
| `http/rbac.ts` (or new guard)             | Mount `denyDelegated` on §6.3 route families                                                                                                                                                                         |
| `http/routes/assistant.ts` (new)          | `[superseded]` Three §3.2 endpoints                                                                                                                                                                                  |
| `http/routes/agents.ts`                   | `[superseded]` §3.1 fixed-property guards. `RESERVED_AGENT_SLUGS` is live (preset-agents.md §3.3)                                                                                                                    |
| `http/routes/integrations.ts`, `crons.ts` | `[superseded]` Kind check on reference writes (§3.1)                                                                                                                                                                 |
| Relay browser session path                | Add an explicit CP mint request carrying the authenticated relay `chatId`, then deliver the delegation through the relay→daemon session path (§4)                                                                    |
| `registry/apiKeyService.ts`               | `mintDelegated`/`mintOauth` + verification branches + expiry cleanup                                                                                                                                                 |
| `orchestrator/agentSpecAssembler.ts`      | `[superseded]` `agentRecordToSpec` copies `kind` (function moved from `placement.ts`)                                                                                                                                |
| Audit                                     | Tool execution writes `audit_event` kind `mcp_tool_call` (§9.3)                                                                                                                                                      |

### 9.2 Visibility Interaction

When tools operate on resources, service-layer `visibilityWhere`/`canView` filters as the credential user. Restricted resources remain invisible to unauthorized tool callers with 404 semantics, adding no existence oracle. _[superseded]_ The assistant row itself would have carried `visibility='org'`, so existing `canView` (`http/visibility.ts:26-33`) permits all members without predicate changes; the successor's host is an ordinary agent whose visibility is whatever the org set.

### 9.3 Audit

Use the existing append-only `audit_event` stream with kind `mcp_tool_call`
(defined in migration `20260712000000_v1_baseline`). Its `details` contain
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
- CP routes filter `kind='assistant'` rows to `initiatorUserId === viewer.userId` or owner (governance exemption). Apply the same gate to `/sessions/:id/messages` and `tool-body`.
- Webchat Playground list is already scoped by conversation ownership; no change.

---

## 10. Security Analysis

1. **Confused deputy (eliminated)**: tool authority always equals credential user. CP service layer enforces RBAC/visibility from `req.principal`; role is resolved live, so demotion applies immediately. The MCP — and any agent session reaching it — has no independent authority to borrow.
2. **Prompt injection**:
   - _[superseded] Assistant_: data such as agent descriptions, session titles, and cron names may contain instructions planted by another member. Defenses: human-only trigger (no automated ingress), delegated deny-list (§6.3), schema-level confirmation (§6.4), rate limits (§6.5), complete audit (§9.3), and prompt declaration separating data from instructions (§8.3). Of these, only the prompt clause and the "human-only trigger" premise were assistant-specific; the deny-list, confirmation, limits, and audit are properties of the CP tool layer and apply to any caller.
   - _External AI tool_: same risk exists, but the user **authorized their own tool**. Consent can grant only `mcp:read`; curation, confirmation, and audit still apply. Hard boundary is user RBAC ∩ scopes.
3. _[superseded]_ **Vertical escalation (viewer → daemon host shell)**: restricted runtime profile (§8.2) was the hard prerequisite, backed by a runtime allowlist. It applied only to the built-in assistant; external tools do not run on our hosts. The successor's host is an ordinary shell-capable agent, so this is an open question there (preset-agents.md §9), not a solved one.
4. **Credential surface**: the delegated key would be minted only by the gateway, 12h, replaced on reconnect (planned, §4); OAuth access token 1h with rotating refresh and Profile revocation; personal key retains existing lifecycle. All store hash-only and every call is audited. **Open DCR grants no authority**: client registration gives no access; every access requires human browser consent.
5. _[superseded]_ **Lateral isolation**: no memory tools, sessions isolated by initiator, independent per-user delegation bound to independent sessionKey. Per-session delegation binding carries forward with §4; the memory-tool removal and per-initiator session filter were properties of the assistant agent.
6. _[superseded]_ **Who can modify the assistant**: owner only for enable/disable/move/model; every self-targeted write through delegation is denied (§6.3), preventing "unlock yourself."
7. **MCP/OAuth exposure**: same TLS origin as REST. Unauthenticated callers see only 401 + public metadata, intentionally public. Pending authorize requests have short TTL; codes are one-time + PKCE.

---

## 11. Web Console

- **"Connect your AI" page/card** in Settings or Profile: show MCP URL and connection guides for claude.ai connectors, `claude mcp add`, and Cursor. Before OAuth ships, provide manual personal-key path by reusing ApiKeysCard.
- **OAuth consent page** (§7.3, new route `/oauth/consent`): reuse login + organization/scope selection. Add Profile **"Connected AI tools"** card listing oauth_grant client name, organization, scopes, recent use, and one-click revoke.
- _[superseded]_ **Playground/webchat**: pin "Agent Assistant" with a `kind` badge to top of agent list. When disabled, owner sees enable CTA (choose daemon + runtime → `PUT /assistant`); non-owner sees "Ask an owner to enable it."
- _[superseded]_ **AgentsView / AgentDetailView**: Built-in badge; hide VisibilityField, AgentVisibilityCard (call-policy), integrations, and workspace cards. Retain model/effort/status with owner gate, reading `dto.kind` and treating server 403 as authoritative. Apply to both desktop and mobile JSX branches per mobile-console house rule. (No `kind` ships; the preset agent renders as the ordinary agent it is — preset-agents.md §3.1/§3.4.)
- _[superseded]_ **SessionsView**: no new controls; filtering is server-side (§9.4).

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
| **P4**  | Still planned, and the prerequisite for the successor: delegated key (mint/verify/TTL) + webchat-frame delivery + daemon binding and MCP injection + complete `denyDelegated` family. `[superseded]` session privacy (§9.4) as written — its per-user question is reopened for the successor's host                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **P5+** | IM identity binding, cron delegation, per-user memory namespace, CIMD, enterprise SSO direct connection (§12 / §7)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 14. Test Plan

The assistant-agent cases below — fixed-property guards, `/assistant` endpoints,
`kind` checks on cron/integration references, self-modification through delegation,
per-initiator session filtering, and the daemon's kind branching — belong to the
superseded shape (§3/§8) and are not requirements. The MCP, OAuth, credential-matrix,
`denyDelegated`, and reserved-slug cases are active.

**Unit (CP)**: MCP registry schema (confirmation required families); credential verification matrix for all three key types (expired/revoked/wrong principalType/cross-org/scopes → reject); `denyDelegated` route-family matrix; _[superseded]_ assistant fixed-property guard matrix (sharing/call-policy/integration/cron/delete all reject) and partial unique index; reserved slug (live). **Pure OAuth logic**: PKCE S256, redirect URI match (exact hosted / loopback ignore port), one-time code, refresh rotation accepting newest two and rejecting third, `invalid_grant`, exact PRM `resource`, AS metadata includes `code_challenge_methods_supported`.

**Integration (CP, real Postgres)**:

- personal/OAuth key through MCP `listAgents` sees only user-visible resources; unauthorized restricted resource remains invisible;
- viewer write tool returns 403;
- `mcp:read` write tool returns 403;
- confirmation mismatch rejects;
- rate limit returns 429;
- every tool call writes operation audit;
- delegated key calling `/me/keys`, `/daemons/token`, or sharing write returns 403;
- _[superseded]_ `PUT /assistant` idempotent, non-owner 403; cron/integration reference to assistant returns 400; assistant cannot modify/delete itself through delegation;
- after user removal from organization, credential request returns 404;
- _[superseded]_ session list filters by initiator while owner sees all;
- **OAuth end to end** under devAuth: register → authorize → consent → code → token → MCP call → refresh rotation → grant revoke immediately invalidates token;
- 401 contains correct `WWW-Authenticate`; PRM available at root + path-inserted locations.

**Daemon** (P4): _[superseded]_ only `kind='assistant'` gets AgentConnect MCP and receives no memory/collaboration/external MCP, and restricted-profile arguments are part of `hostSpawnSig` so profile changes respawn. Carried forward: concurrent sessions for two users carry their own keys without mixup; expired delegation fails closed with explicit error; restart restores delegation with session; bridge child environment carries credential while transcript does not leak it.

---

## 15. Decision Record

1. Tool surface = CP-hosted AgentConnect MCP, reached by external AI tools through
   OAuth or a personal key. _[superseded]_ Its second consumer was to be
   `agent-assistant`, a built-in agent with that MCP auto-injected
   ("pre-authenticated"); that agent is cancelled (2026-07-29) and the successor is
   the `agentconnect` general preset's webapp sessions (preset-agents.md §4), which
   reach the same MCP through the same §4 credential.
2. ✅ **External sign-in = thin OAuth AS embedded in CP** (automatic browser login; open DCR + 90d TTL; token = `oauth` ApiKey row, 1h + rotating refresh). Rejected Logto-as-AS because it lacks DCR (roadmap Backlog) and wildcard redirects exclude ports. Logto remains console human login. Personal keys remain for headless/CI, as all compared products except Notion do.
3. ❌ _[superseded]_ Name `agent-assistant`, kind enum `assistant`, replacing v0 owner-only "system agent." Cancelled with P3; the names stay reserved and unprovisioned (preset-agents.md §3.3).
4. ✅ Credential is identity: personal / OAuth / delegated share one table and pipeline; tools execute as credential user. _[superseded]_ The assistant was to be owner-enabled and owner-editable only; undeletable, unshareable, not peer-callable or integration/cron-triggered. What survives is the ingress rule itself: a platform-injected credential is minted only for a **webchat** session (§4).
5. ✅ High-risk credential/member/organization/access-control/bot/hook writes excluded from catalog; delegated credential hard-denied server-side.
6. ❌ _[superseded]_ Restricted runtime profile is mandatory; v1 runtime allowlist = claude. Reopened for the successor, whose host is an ordinary shell-capable agent (preset-agents.md §9).
7. ❌ _[superseded]_ Assistant receives no memory tools; sessions isolated by initiator.
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
