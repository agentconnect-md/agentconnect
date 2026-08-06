# Org-Scoped Data Layer

> **Status:** M1 + M2 implemented (the convention, and every org-owned repository
> migrated); M3 (Postgres RLS) is a separate design
>
> **Scope:** Control-plane persistence ports and their HTTP/MCP consumers.
> Related: [`authorization-policy.md`](authorization-policy.md) (the policy layer
> this deliberately does not absorb), [`control-plane-implementation.md`](control-plane-implementation.md)
> §3.2 (the `/orgs/:orgId` path scope and its "cross-org reads as 404" rule),
> [`resource-visibility.md`](resource-visibility.md) (intra-org sharing).

## 1. Problem

The HTTP edge is structurally org-scoped: every `/orgs/:orgId/…` route runs
behind `humanAuth` + `makeOrgScope`, non-members read 404, personal API keys
bind to one organization, OAuth scopes are confined (`http/org-scope.ts`).

The data layer is not. Repository ports address rows by bare id —
`AgentRepo.get(agentId)`, `update(agentId, …)`, `delete(agentId)` — and every
organization fence between the edge and the row is a hand-written route check:

```ts
const agent = await deps.repos.agent.get(AgentId(id))
if (!agent || agent.orgId !== req.orgCtx!.orgId) return null
```

There are ~80 such comparisons across route files. Each is correct today, and
each is a convention, not a structure: one omitted line in a new route handler
silently yields cross-organization read or write on an ID-addressable
resource, with no compile-time or database-level backstop. Lists already take
the organization (`list(orgId, viewer?)`); point reads and mutations are the
gap.

This matters beyond hosted multi-org deployments: a self-hosted instance with
two organizations has the same boundary, and the same one-line failure mode.

## 2. Decision

**Repository port methods that address an org-owned row by id take `orgId` as
their first parameter, and the repository fences the query itself** — the row
is looked up `WHERE id AND orgId` (or the mutation's opening row-lock read is
so filtered), inside the same transaction as the write it guards. A cross-org
id becomes observably identical to a missing row.

**Internal trust domains keep an explicit escape hatch.** Orchestration,
reconciliation, WS handlers, and platform machinery legitimately resolve rows
from system state (a run row, an integration row, signed claims) where the
organization is derived from the row itself. Those callers use reads whose
names end in `Unscoped` (`getUnscoped(agentId)`). The name is the audit
marker: it makes "this read crosses the tenancy axis on purpose" grep-able and
reviewable, and an ESLint fence (§6) keeps it out of the HTTP surface.

Route-level checks thereby become defense-in-depth; the repository is the
authority. The route keeps only what is genuinely policy-layer: visibility
(`canView` / `visibilityWhere`), role checks, and session-tier rules stay in
`authorization/policy.ts` exactly as [`authorization-policy.md`](authorization-policy.md)
§2 drew the boundary.

### 2.1 Alternatives considered

- **Org-scoped repository facade** (`repos.forOrg(orgId)` handed to routes):
  cleaner call sites, but structural only if routes lose access to the raw
  repos, which is a much larger DI surgery — and until then it is discipline,
  not structure. Signature tightening gets the same guarantee from the type
  checker with a mechanical diff.
- **Prisma client extension / AsyncLocalStorage tenant context**: implicit,
  breaks the internal trust domains that genuinely read across organizations,
  and hides the fence from the reader. Rejected for the same reason the
  codebase prefers explicit DI.
- **Postgres RLS**: complementary, not competing — a DB-level backstop under
  the application fence. Out of scope here (§8); the port convention is a
  prerequisite for it either way.

## 3. The convention

For every repository whose rows carry `orgId` (directly or via an owning
parent):

1. **Point read**: `get(orgId, id)` returns `null` for a cross-org id exactly
   as for a missing row. No caller can distinguish the two (the §1 rule:
   cross-org reads as 404).
2. **Mutations**: `(orgId, id, …)` first parameters. The fence lives inside
   the mutation's transaction — on its opening row-lock read where one exists,
   as an added filter where the write is a single statement (`updateMany`-and-
   count where no composite unique is available). A fence miss surfaces as the
   port's existing missing-row behavior (`null` return for CAS-shaped methods,
   a `<Resource>Missing` error for throw-shaped ones).
3. **Internal reads**: `getUnscoped(id)` (and, where genuinely needed,
   `listUnscoped…`). Every call site sits in an internal trust domain and
   should be obvious about why.
4. **System-tier methods stay system-tier.** Methods already fenced by a
   different axis — the daemon roster (`listForDaemon(daemonId)`), CAS fences
   (`movePlacement(expectedDaemonId, …)`, workspace-compensation), placement
   writes driven by the orchestrator — do not grow a tautological `orgId`.
   Each port documents which of its methods are system-tier and why.
5. **Lists are already right**: `list(orgId, viewer?)` is unchanged, and stays
   the pattern for new list methods.
6. **Child rows fence through their parent**: resources without their own
   `orgId` column (agent secrets, assignments, session children) are reached
   through a parent whose method is fenced, or filter with a relational
   `where: { agent: { orgId } }`.

New repositories must follow the convention from their first method; this
document is the review reference.

## 4. Trust domains

Mirrors [`authorization-policy.md`](authorization-policy.md) §2 — the fence a
method carries depends on who is allowed to call it:

| Caller domain                                                      | Org source                           | Data-layer surface                                                                                                      |
| ------------------------------------------------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| Console REST / SSE (human)                                         | `req.orgCtx` from path + membership  | scoped methods only                                                                                                     |
| MCP surface                                                        | the credential's org binding         | scoped methods only                                                                                                     |
| Daemon WS handlers                                                 | the connection's ApiKey row          | daemon-fenced methods (`listForDaemon`, `agent.daemonId === conn.daemonId` guards) — already stronger than an org check |
| Orchestrator / reconciliation / platform machinery                 | derived from the row being processed | `*Unscoped` reads, system-tier mutations                                                                                |
| Public-by-design endpoints (e.g. agent icon PNG, fetched by Slack) | none — intentionally unauthenticated | `*Unscoped` with an inline lint exemption and a justification comment                                                   |

## 5. Exemplar migration: Agent (M1, this change)

`AgentRepo` is the largest and most-referenced port; it sets the pattern.

| Method                                                                   | Callers today                                                      | New shape                                                                                   |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `create(input, …)`                                                       | routes (org inside `CreateAgentInput`)                             | unchanged — already org-carrying                                                            |
| `get(id)`                                                                | routes (via per-file fetch-and-check helpers) + ~30 internal sites | `get(orgId, id)` + `getUnscoped(id)`                                                        |
| `update(id, patch, opts)`                                                | routes only                                                        | `update(orgId, id, …)`; fence replaces the transaction's existing `orgIdOfAgent` derivation |
| `setWorkspace` / `restoreWorkspace`                                      | routes + workspace-move orchestration                              | `(orgId, …)`; the orchestrator passes the org of the record it holds                        |
| `setSharing`, `setCallPolicy`                                            | routes only                                                        | `(orgId, id, …)`                                                                            |
| `delete(id)`                                                             | routes only                                                        | `delete(orgId, id)`; fence on the opening row read                                          |
| `setPlacement`, `movePlacement`, `setWorkspaceRepoId`                    | orchestrator / repair machinery                                    | unchanged (system-tier: CAS- or repair-fenced)                                              |
| `list(orgId, viewer?)`, `orgDirectory(orgId)`, `listForDaemon(daemonId)` | —                                                                  | unchanged                                                                                   |

`AgentConfigWriter` (the row+secrets unit of work behind REST create/PATCH)
follows `AgentRepo`: `update(orgId, id, …)`.

Route consequences: the per-file helper keeps only the policy half —

```ts
const agent = await deps.repos.agent.get(orgOf(req), AgentId(id)) // fence in the repo
return agent && canView(agent, ctxOf(req)) ? agent : null // policy stays here
```

`GET /v1/agents/:id/icon` (public by design — chat platforms fetch it) moves
to `getUnscoped` with the lint exemption and a comment saying exactly that.

## 6. Enforcement

Two structural guards, so the convention cannot silently erode:

1. **ESLint fence.** `no-restricted-syntax` forbids any `*Unscoped` member
   call in `packages/control-plane/src/http/routes/**` and
   `packages/control-plane/src/http/mcp/**`. Public-by-design endpoints carry
   an inline `eslint-disable-next-line` with a justification — the exemption
   is the documentation.
2. **Tenant-isolation contract tests.**
   `test/integration/tenant-isolation.route.test.ts` boots the real app
   against Postgres with a two-organization fixture and asserts, per migrated
   resource: point-GET of the foreign id → 404; PATCH/PUT/DELETE of the
   foreign id → 404 (and the foreign row provably unmodified); list → foreign
   rows absent. The suite is the acceptance gate for every M2 batch: migrating
   a repository adds its resource block here in the same PR.

## 7. Rollout

- **M1 (this change):** the convention; `AgentRepo` + `AgentConfigWriter`
  migrated end-to-end; ESLint fence; contract-suite foundation with the Agent
  block.
- **M2 (mechanical batches, same recipe per repo) — complete.** Each batch
  tightened signatures → followed the type errors → classified every internal
  caller (`Unscoped` or org-threaded) → deleted the now-redundant route
  comparisons → extended the contract suite:

  | Batch | Repositories                                                                                               |
  | ----- | ---------------------------------------------------------------------------------------------------------- |
  | 1     | `DaemonRepo`, `BotRepo` (+ the `DaemonRegistry` read model and `ApiKeyAdmin.mintForDaemon` above them)     |
  | 2     | `IntegrationRepo`, `IntegrationChannelRepo` (child), `CronRepo`                                            |
  | 3     | `HookRepo` (+ `HookSecretStore` / `HookRun` children)                                                      |
  | 4     | `McpProviderRepo`, `SkillSourceRepo`, `OrganizationKnowledgeRepo` (knowledge, managed skills, suggestions) |
  | 5     | `SessionRepo` (+ session children via parent), `WebchatConversationRepo`                                   |
  | 6     | `ExternalMemoryConnectionRepo`, `GithubInstallationRepo`, `ApiKeyRepo.listForDaemon`                       |

  Three patterns recurred often enough to be worth stating as rules for new code:

  1. **A fence must sit ahead of any answer that would confirm the row.** Where
     a method can respond `'referenced'`, `BotStillShared`, `'not_pending'`,
     `'metadata_changed'` or `forbidden` before it writes, the org check goes on
     the read that opens the critical section — not on the write's `where`.
     Otherwise a cross-org id gets a distinguishable refusal, which is the exact
     thing §3 forbids.
  2. **A client-minted id makes an upsert a takeover risk, not a leak risk.**
     `CronRepo.upsert` and `HookRepo.upsert` rewrite `orgId` on their update
     branch. Both fence inside the transaction; the cron one additionally takes a
     transaction-scoped advisory lock keyed on the id ALONE, because the case that
     matters is a row that does not exist yet and no row-level lock can cover it.
  3. **Prefer the row's own `orgId` column when a child table has one.**
     `HookRun` and `CronRun` do, so their history reads fence directly rather than
     resting on the parent. Rosters, revisions and secrets do not, and fence
     relationally through the parent (§3.6).

- **M3 (separate design):** Postgres row-level security as the DB-level
  backstop beneath this fence.

## 8. Non-goals

- **Visibility and role policy** — stays in `authorization/policy.ts`; this
  seam is tenancy only.
- **Wire or DTO changes** — none; this is a pure internal seam.
- **Postgres RLS** — deliberately separate (M3): it wants the port convention
  in place first, and carries its own Prisma/transaction ergonomics
  trade-offs.
- **The daemon WS trust domain** — its fences (connection identity, roster
  scoping, mutation leases) are already stronger than an org parameter and are
  not reshaped here.
