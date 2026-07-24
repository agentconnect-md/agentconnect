# Resource Visibility and Sharing

> **Status:** Implemented. The schema, server predicates, Console enforcement,
> sharing controls, and referenced-resource validation all use the same
> visibility contract. User-facing labels are **Everyone** and **Selected**.
>
> **Scope:** control-plane + web. The daemon execution data plane is unaffected.
>
> `McpProvider` uses the same `visibility` and `sharedWith` model, including
> pruning on member removal. Webchat ingress runs through the relay; the
> `canView` gate executes when minting a webchat token in
> `http/routes/webchat-token.ts`.

## 1. Background and goals

Organization role checks alone do not provide per-resource authorization:
`org-scope.ts` resolves a role, and guards such as `denyViewerWrite` in
`rbac.ts` permit writes by role. Resource visibility adds a second,
resource-specific gate.

This design adds **per-resource visibility**:

- A new resource is **visible to everyone in its organization by default** with
  `visibility = org`.
- It may instead be **restricted to selected users** with
  `visibility = restricted`. Whether a selected user can only view or also edit
  depends on their **organization role**: viewers are read-only, while
  collaborators and owners can edit.

### Decided policy semantics

| Decision                                   | Choice                                                                                                                                                                  | Meaning                                                                                                                         |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| How is the access level determined?        | **Derived from the organization role**                                                                                                                                  | Sharing controls who can see a resource. Existing roles determine editing. There is **no per-grant view/edit field**.           |
| Does an owner have a governance exception? | **Owners can see and edit everything**                                                                                                                                  | Restrictions hide from peers and lower roles, while organization owners retain complete governance, audit, and recovery access. |
| Which resource types carry visibility?     | **Agent, Daemon, and Cron are independent.** Integration, Session, Usage, CronRun, and daemon API keys derive from a parent. Bot is shared organization infrastructure. | See the taxonomy in section 2.                                                                                                  |

### Authoritative predicates

```ts
canView(res, { userId, role }) =
  role === 'owner' || // Governance exception
  res.createdByUserId === userId || // Creator forever, including after removal and reinvitation
  res.visibility === 'org' || // Visible to everyone by default
  res.sharedWith.includes(userId) // Explicit share

canEdit(res, ctx) =
  ctx.role === 'viewer'
    ? false // A viewer is always read-only
    : ctx.role === 'owner'
      ? true
      : /* collaborator */ canView(res, ctx)

canManageSharing(res, ctx) = canEdit(res, ctx) // Relaxed in section 13.3
```

The unit-test truth table follows directly. After relaxation,
`canManageSharing` equals `canEdit` on every row:

| Scenario                                                | Role         | Creator? | In `sharedWith`? | Visibility | `canView` | `canEdit` | `canManageSharing` |
| ------------------------------------------------------- | ------------ | -------- | ---------------- | ---------- | --------- | --------- | ------------------ |
| Default resource, any collaborator                      | collaborator | No       | N/A              | org        | Yes       | Yes       | Yes                |
| Default resource, viewer                                | viewer       | No       | N/A              | org        | Yes       | No        | No                 |
| Restricted, unshared collaborator                       | collaborator | No       | No               | restricted | No        | No        | No                 |
| Restricted, shared collaborator                         | collaborator | No       | Yes              | restricted | Yes       | Yes       | Yes                |
| Restricted, shared viewer                               | viewer       | No       | Yes              | restricted | Yes       | No        | No                 |
| Restricted, creator, necessarily collaborator or higher | collaborator | Yes      | N/A              | restricted | Yes       | Yes       | Yes                |
| Restricted, unshared owner                              | owner        | No       | No               | restricted | Yes       | Yes       | Yes                |

**Sharing management was relaxed to "any editor may change sharing."**
`canManageSharing` now equals `canEdit`. An owner, or a collaborator for whom
`canView` is true, may change `visibility` and `sharedWith`. Only viewers remain
read-only.

This has two consequences:

1. **Restriction strength depends on shared collaborators.** A collaborator can
   share onward or switch the resource to organization-wide visibility. A
   creator who needs tighter control should share only with viewers.
2. **Any collaborator can change an `org` resource to restricted and select
   only themselves**, hiding it from other collaborators. The creator retains
   access through the creator branch, and an owner retains the governance
   exception, so either can restore it.

Both are accepted under a model of collaborator trust within an organization
and owner governance.

## 2. Resource taxonomy

| Category               | Resource                                    | Own `visibility` and `sharedWith`? | Source                                               |
| ---------------------- | ------------------------------------------- | ---------------------------------- | ---------------------------------------------------- |
| **Visibility carrier** | `Agent`, `Daemon`, `CronDef`, `McpProvider` | Yes, independent columns           | Itself                                               |
| **Derived**            | `Integration`                               | No                                 | Its `Agent`                                          |
| **Derived**            | `SessionMeta`, `SessionUsage`               | No                                 | Its `Agent`                                          |
| **Derived**            | `CronRun`                                   | No                                 | Its `CronDef`                                        |
| **Derived**            | daemon `ApiKey`                             | No                                 | Its `Daemon`; key minting is a credential operation  |
| **Infrastructure**     | `Bot`                                       | No                                 | Always organization-visible and cannot be restricted |

**Agent and daemon visibility are independent.** An agent may be visible while
its hosting daemon is not; see section 7.

## 3. Data-model changes in `packages/control-plane/prisma/schema.prisma`

Define this enum beside `OrgRole`, following the lowercase-member convention:

```prisma
enum ResourceVisibility {
  org
  restricted
}
```

Each visibility carrier stores two columns beside `createdByUserId`:

```prisma
visibility  ResourceVisibility @default(org)
sharedWith  String[]           @default([])  // app_user.id values; meaningful only when restricted
```

`String[] @default([])` is an established repository pattern used by
`Agent.capabilities` (`schema.prisma:277`), `Daemon.degradedScopes`
(`schema.prisma:145`), and `ApiKey.scopes` (`schema.prisma:192`). It requires no
new table, repository, or service. Prisma
`sharedWith: { has: userId }` becomes Postgres `@> ARRAY[$1]`, so list
filtering stays in one `findMany` without a join.

**Do not add `@@index([orgId, visibility])`.** After backfill, nearly every row
has `visibility = 'org'`, making the column almost constant. A composite B-tree
cannot cover the three-branch OR predicate and only adds write amplification.
Section 6 defines the index strategy.

Update `ports.ts`:

- Add `export type ResourceVisibility = 'org' | 'restricted'` beside
  `OrgMemberRole`.
- Add `visibility`, `sharedWith`, and a new scalar
  **`createdByUserId: string | null`** to `AgentRecord` (`ports.ts:264`),
  `DaemonRecord` (`ports.ts:106`), and `CronRecord` (`ports.ts:542`).
- Add optional `visibility?` and `sharedWith?` to `CreateAgentInput`
  (`ports.ts:204-220`), `UpdateAgentInput` (`ports.ts:222-237`), and
  `UpsertCronInput` (`ports.ts:504-527`). Add
  `setSharing(daemonId, { visibility, sharedWith })` to `DaemonRepo`
  (`ports.ts:111-145`), which has eleven methods but no generic update and only
  `rename` for manual editing.
- Map the columns in every `toRecord` in `agent.repo.ts:40-67`,
  `daemon.repo.ts:21-51`, and `cron.repo.ts:22-47`, and write them in create,
  update, upsert, and setSharing. A sharing write also stamps
  `lastModifiedByUserId` and `lastModifiedAt`, because `last_modified_audit`
  added those columns to the same three tables at
  `schema.prisma:133-134/283-284/519-520`.

> **The scalar `createdByUserId` is mandatory.** Existing persistence
> `*Record` types expose a nested
> `createdBy: { userId, displayName, email } | null`, not the scalar. The HTTP
> DTO's `createdBy: z.string().nullable()` sends a user ID, and routes read
> `record.createdBy?.userId`; the persistence record shape is different.
> Reading `r.createdByUserId` without mapping it would always yield `undefined`,
> so the creator branch would never match and a creator would receive 404 for
> their own restricted resource. `Shareable.createdByUserId` must be an
> independently mapped scalar taken directly from the database column, not the
> joined object that becomes null when the creator's User row is `SetNull`.

After the schema change, run
`pnpm --filter @agentconnect.md/control-plane prisma:generate` to regenerate the
committed client.

## 4. Authorization layer: pure predicates in `src/http/visibility.ts`

Keep it independent of Fastify so `test:unit` can cover it with no I/O, like
`orchestrator/fencing.ts`:

```ts
import type { OrgMemberRole } from '../persistence/ports.js'

export type Visibility = 'org' | 'restricted'
export interface ViewCtx {
  userId: string
  role: OrgMemberRole
}
export interface Shareable {
  createdByUserId: string | null // Scalar, independent of a nullable joined object
  visibility: Visibility
  sharedWith: string[]
}

export function canView(r: Shareable, c: ViewCtx): boolean {
  return (
    c.role === 'owner' || r.createdByUserId === c.userId || r.visibility === 'org' || r.sharedWith.includes(c.userId)
  )
}

export function canEdit(r: Shareable, c: ViewCtx): boolean {
  if (c.role === 'viewer') return false // Viewer-first preserves denyViewerWrite
  return c.role === 'owner' || canView(r, c)
}

// Relaxed in section 13.3: every editor may change sharing; viewers are read-only.
export const canManageSharing = canEdit

// Reusable Prisma WHERE fragment with an owner short circuit.
export function visibilityWhere(v?: ViewCtx) {
  if (!v || v.role === 'owner') return {} // Owner governance or unfiltered internal caller
  return {
    OR: [
      { visibility: 'org' as const },
      { createdByUserId: v.userId },
      { sharedWith: { has: v.userId } } // Postgres @> ARRAY[$userId]
    ]
  }
}
```

`Shareable`, `ViewCtx`, and `visibilityWhere` live in `persistence/ports.ts`
beside the record types, preventing repositories from depending backward on
`http/`. `http/visibility.ts` defines `canView`, `canEdit`, and
`canManageSharing` and re-exports the other types.

The only context-pipeline change is adding `userId` to `OrgCtx` in
`org-scope.ts:14-17` and setting it in `makeOrgScope` at `org-scope.ts:37`,
where `req.principal!.userId` is already available:

```ts
export interface OrgCtx {
  orgId: OrgId
  role: OrgMemberRole
  userId: string
}
// ...
req.orgCtx = { orgId: OrgId(orgId), role, userId: req.principal!.userId }
```

`humanAuth` and `org-scope` are mounted as **preValidation** hooks at
`server.ts:129-130`, not preHandler, because Zod validation strips the
undeclared prefix `orgId` parameter. New guards preserve that mounting.

Add one helper to `rbac.ts`:
`ctxOf(req): ViewCtx = { userId: req.orgCtx!.userId, role: req.orgCtx!.role }`.
Every downstream guard consumes it.

## 5. Enforcement points

The following are the Console's read and referenced-write paths.

### 5.1 Agent: direct repository access

- In `getOrgAgent` at `agents.ts:156-159`, extend
  `agent.orgId === orgCtx.orgId` with `canView(agent, ctxOf(req))`. An invisible
  agent produces null and the common 404. Every get, patch, and delete through
  this helper inherits the check.
- Change `AgentRepo.list(orgId, viewer?)` to
  `where: { orgId, ...visibilityWhere(viewer) }`.
- After `denyViewerWrite` and `getOrgAgent` in PATCH (`agents.ts:292-293`) and
  DELETE (`agents.ts:320-321`), return 403 when
  `!canEdit(existing, ctxOf(req))`.
- **Referenced write:** `POST /agents` requires `canView(daemon)` after checking
  that `body.daemonId` belongs to the organization. Failure is indistinguishable
  from a nonexistent ID to avoid a presence oracle.
- Workspace `gitstatus`, `gitpull`, and file routes all resolve through
  `getOrgAgent`, enforcing both organization boundary and visibility.

### 5.2 Daemon: `DaemonRegistryService`, not `DaemonRepo.list`

Console daemon routes call `deps.registry.list(orgId)` and
`deps.registry.get(...)`, backed by `DaemonRegistryService`, rather than
`DaemonRepo.list`. The service is assembled at `container.ts:134`, and the
routes call it at `daemons.ts:82,:89`. Changing only the repository would never
deliver the viewer context and would leave restrictions ineffective.

- Add optional `viewer?: ViewCtx` to `DaemonRegistryService.list/get`, pass it
  into `this.daemons.list(orgId, viewer)`, and apply `canView` in
  `registry.get`.
- Pass `ctxOf(req)` from daemon routes.
- Extend `getOrgDaemon` at `daemons.ts:88-91` with
  `canView(view, ctxOf(req))`.
- Filter the agent sublist on a daemon detail page by agent visibility.
- **Daemon-key route family:** `GET/POST /daemons/:id/keys` and DELETE apply
  `canView` while resolving the daemon and require `canEdit` for issuance and
  revocation, because credential minting is stricter than metadata read access.

### 5.3 Cron: repository access

- Consolidate organization checks at `crons.ts:189, 212, 247, 289`, plus the
  fifth check in the PUT upsert at `crons.ts:91`, into one
  `getOrgCron(req, id)` helper that includes `canView`.
- Change `CronRepo.listForOrg(orgId, viewer?)` to
  `where: { orgId, ...visibilityWhere(viewer) }`.
- For PUT and DELETE, add `canEdit` after `getOrgCron`.
- **`POST /crons/:id/run` is an executing write.** It requires both
  `getOrgCron` and `canEdit`; organization membership alone is insufficient.
- **Referenced write:** `PUT /crons/:id` requires `canView(agent)` after
  validating `body.agentId`, with failure indistinguishable from a nonexistent
  ID.

### 5.4 Integration: derived from Agent and a first-class route family

`integrations.ts` contains complete list, get, patch-channel, delete, and
install routes. Every route derives visibility from the parent agent.

- Change `IntegrationRepo.listForOrg(orgId, viewer?)` from
  `findMany({ where: { orgId } })` at `integration.repo.ts:150-153` to
  `where: { orgId, agent: { ...visibilityWhere(viewer) } }`, and pass
  `ctxOf(req)` from the list route at `integrations.ts:184-201`, whose repository
  call is at `integrations.ts:196`.
- Route get, patch-channel, and delete through one
  `getOrgIntegrationAgent` helper that loads the parent through `getOrgAgent`.
  The existing organization checks are at `integrations.ts:222-225` for get and
  patch-channel and `integrations.ts:258-261` for delete. Invisible means 404.
  Patch and delete additionally require `canEdit(parentAgent)`.
- **Referenced write:** `POST /integrations` must also require `canView` for its
  parent agent rather than checking only the organization at
  `integrations.ts:116-118`.

### 5.5 Session: daemon fan-out, not `SessionRepo.list`

The Control Plane does not store sessions. `GET /sessions` at
`sessions.ts:52-96` fans out to online daemons through
`deps.control.sessionList` at `sessions.ts:71` and merges results in memory by
platform and channel. `SessionRepo.list` at `session.repo.ts:69-80` had zero
callers, so putting a filter there would be dead code.

- Filter fan-out results **at the route**. After merging, parse each session's
  `agentId`, load the corresponding records in one `agent.list(orgId)` call,
  and discard rows for which `canView(agent, ctxOf(req))` is false. For
  `?agentId=`, validate `canView` before the query so a client cannot enumerate
  UUIDs.
- Apply the same gate before proxying the transcript from
  `GET /sessions/:id/messages`, whose organization check is at
  `sessions.ts:116-119`, and `GET /sessions/:id/tool-body`.
- **Transcript body boundary:** `getOrgSessionAgent(req, agentId)` requires both
  `agent.orgId === req.orgCtx.orgId` and `canView`, closing the cross-tenant
  leak.
- **SSE `GET /orgs/:orgId/stream`:** filter every `event/session` milestone by
  agent visibility, not only by daemon organization. An envelope
  includes `agentId`, `phase`, `link`, and a short human-readable,
  content-derived `summary`; see `protocol/src/frames/telemetry.ts:25-33`. Both
  the existence of a restricted agent's session and its summary would leak.

Three filtering options were considered:

1. **Drop the entire envelope, recommended for existence hiding.** Resolve
   `agentId -> canView` per envelope and omit an invisible event. This reveals
   not even activity and matches list/get 404 semantics. Following the existing
   per-connection `daemonOrg` memo at `stream.ts:51-59`, memoize
   `agentId -> canView` so each connection loads an agent only once.
2. **Forward without `summary`, exposing existence but hiding content.** The
   observer still sees `agentId`, `phase`, `link`, and timing. This blocks the
   human-readable milestone but leaks the restricted resource and activity.
3. **Organization-wide, with no filtering.** This is unacceptable because
   `summary` derives from content.

**Decision: option 1, drop the whole envelope.** It is consistent with
"restricted means invisible" and costs one `AgentRepo.get` per agent ID per
connection.

### 5.6 Usage: `usage.ts -> sessionUsage.aggregate`

`usage.ts` passes viewer context into `sessionUsage.aggregate`; otherwise a
restricted agent's tokens and spend would leak existence and cost through an
organization aggregate.

- Add `viewer?` to `SessionUsageRepo.aggregate(orgId, since, viewer?)` at
  `session-usage.repo.ts:48` and pass `ctxOf(req)` from `usage.ts`. Owners
  short-circuit to an empty filter. Both internal queries, groupBy at `:51` and
  distinct currency at `:91`, already organize by agent relation.
- For performance, compute the visible agent ID set for the viewer once with
  one indexed query by `orgId`, then pass `agentId IN (...)` to both queries.
  Avoid placing a three-branch OR relation subquery into every groupBy.

### 5.7 CronRun

Route run-history reads at `crons.ts:198-225`, including the inline organization
check at `crons.ts:211-214`, through the `getOrgCron` gate. `listRuns` at
`cron.repo.ts:152-167` currently filters only by cron ID. If a direct query is
needed, use `where: { cron: { ...visibilityWhere(viewer) } }`.

### 5.8 Sharing writes through dedicated `/api/v1` endpoints

Sharing writes use the **same gate as content edits**, because section 13.3
relaxed `canManageSharing` to `canEdit`. There is no separate governance guard.
Register three route pairs with prefix-relative paths inside the existing
organization subtree, for example `r.put('/agents/:id/sharing', ...)`. The
organization routes are mounted at `server.ts:143-146`, and `API_V1_PREFIX` is
defined at `version.ts:26`. Public paths are
`/api/v1/orgs/:orgId/{agents|daemons|crons}/:id/sharing`.

- `PUT .../agents/:id/sharing` accepts
  `{ visibility, sharedWith: string[] }`, then runs `denyViewerWrite`,
  `getOrgAgent`, and
  `if (!canEdit(existing, ctxOf(req))) return 403`. Transactionally write
  `visibility` and `sharedWith`, stamp
  `lastModifiedByUserId`, and make it idempotent. The paired GET returns
  `{ visibility, sharedWith: string[], canManageSharing: boolean }`, where the
  boolean is the caller's `canEdit` result.
- `/daemons/:id/sharing` uses `DaemonRepo.setSharing`, and
  `/crons/:id/sharing` follows the same shape.
- **Validate `sharedWith` on write:** every ID must currently belong to the
  organization. Otherwise return 400, or intersect silently and return the
  resolved set from GET, to avoid a silent lockout from external or stale IDs.
- Return raw `string[]` user IDs for `sharedWith`. Web has a user-ID-to-name
  member directory through `setMemberDirectory` and
  `creatorLabel` at `api.ts:607-631`; server hydration to `MemberDto[]` is
  redundant.

**OpenAPI and Zod requirements:**

- Control Plane responses are serialized through Zod schemas in
  `http/dto/index.ts` by `fastify-type-provider-zod`. Add `visibility`,
  `sharedWith`, and `canManageSharing` to `AgentDto` at `dto/index.ts:156`,
  `DaemonViewDto` at `dto/index.ts:31`, and `CronDto` at `dto/index.ts:405`, or
  the serializer silently strips fields even if web types declare them.
- Give every new endpoint a schema with the appropriate `Tag.Agents`,
  `Tag.Daemons`, or `Tag.Crons`; summary; description; camelCase verb-object
  `operationId`: `getAgentSharing`/`updateAgentSharing`,
  `getDaemonSharing`/`updateDaemonSharing`, and
  `getCronSharing`/`updateCronSharing`; `params: IdParam`;
  `body: UpdateSharingBody`; and
  `response: { 200: SharingDto, 400/403/404: ErrorDto }`. The `Tag` map is at
  `openapi.ts:55-69`. Do **not** declare `orgId` in params because
  `backfillPrefixPathParams` at `openapi.ts:138-162` adds it automatically. Place
  `SharingDto` and `UpdateSharingBody` in `http/dto/index.ts`.
- These endpoints publish to the public API documentation on the next release
  through `.github/workflows/release.yaml:60-76`.
- Existing `UpdateAgentBody` is `.strict()`, so putting `visibility` or
  `sharedWith` into the existing PATCH returns 400; see
  `dto/index.ts:141-153`. That confirms the section 13.1 decision to use
  dedicated sharing endpoints.

## 6. List filtering and performance

The WHERE clause for a non-owner is:

```sql
WHERE "orgId" = $1
  AND ("visibility" = 'org' OR "createdByUserId" = $2 OR "sharedWith" @> ARRAY[$2])
```

For an owner, `visibilityWhere` returns `{}`, reducing the query to
`{ orgId }`. Owners see every row, including unshared restricted rows, with no
per-row post-filter.

**Index requirements:**

- Do **not** create `[orgId, visibility]`. Visibility is nearly constant, cannot
  accelerate the three-column disjunction, and adds write amplification.
- **Create GIN indexes immediately.** Array containment on `sharedWith` is on
  the default non-owner path, not an edge case. Add
  `CREATE INDEX ... USING GIN ("sharedWith")` to all three tables. Empty arrays
  are cheap, and the index removes a sequential scan from the default path.
  Optionally add a partial B-tree on
  `createdByUserId WHERE visibility='restricted'` for the creator branch.
- Do **not** apply a second in-memory `.filter` at runtime. SQL WHERE is
  authoritative. Assert in tests that SQL rows equal
  `rows.filter(canView)`, rather than adding another O(n) scan to unpaginated
  lists, especially for owners.

## 7. Derived visibility and cascading rules

- **Integration, Session, and Usage derive from Agent** and are filtered by a
  parent relation or route-level `canView`.
- **CronRun derives from CronDef** through `getOrgCron` or a nested relation.
- **Daemon API keys derive from Daemon** through `canView` and `canEdit` in
  `keys.ts`.
- **Agent and daemon are independent.** It is valid for an agent to be visible
  while its daemon is not. The agent displays as running, while daemon detail
  returns 404. Agent DTOs already expose a daemon only by ID and name and never
  expose its host, so no extra redaction is needed.
- **Cron and agent are independent.** A cron has its own creator and visibility.
  When the agent is deleted, `CronDef.agentId` becomes null through `SetNull`
  and the cron retains its visibility. If a cron viewer cannot see the target
  agent, gate or omit the agent field in the DTO.
- **Uniform referenced-write rule:** any create or upsert field that references
  a visibility carrier--cron `agentId`, integration `agentId`, or agent
  `daemonId`--must pass `canView` on the target. Its failure response must match
  a nonexistent ID so the endpoint cannot become an existence oracle.

## 8. Member removal and creator semantics

### 8.1 Remove a member from `sharedWith` in the same transaction

Users are provisioned just in time from OIDC `sub`, and `app_user.id` is
**stable**. Reinviting a removed member reuses the same ID. If pruning were only
best-effort hygiene, a stale ID could survive a failure or skip and silently
restore shared access upon reinvitation.

**Pruning is a correctness dependency, not hygiene.** Run these updates in the
same transaction as membership deletion:

```sql
UPDATE "agent"    SET "sharedWith" = array_remove("sharedWith", $userId) WHERE $userId = ANY("sharedWith") AND "orgId" = $orgId;
UPDATE "daemon"   SET "sharedWith" = array_remove("sharedWith", $userId) WHERE $userId = ANY("sharedWith") AND "orgId" = $orgId;
UPDATE "cron_def" SET "sharedWith" = array_remove("sharedWith", $userId) WHERE $userId = ANY("sharedWith") AND "orgId" = $orgId;
UPDATE "mcp_provider" SET "sharedWith" = array_remove("sharedWith", $userId) WHERE $userId = ANY("sharedWith") AND "orgId" = $orgId;
```

### 8.2 Creator semantics and orphaned resources

Removing an organization member deletes only the membership row.
`createdByUserId` remains intact; `onDelete: SetNull` runs only when the
**`app_user` row is deleted**, which occurs only in the placeholder-email merge
path.

Correct semantics:

- **"Creator forever" is an explicit policy.** After the creator is removed,
  `createdByUserId` still points to them. Organization scope denies access while
  they are absent. **If invited again, the creator branch automatically
  restores view and sharing management over resources they created.** This
  matches section 1. The transaction in section 8.1 removes only the grant
  vector, not the creator vector. This is accepted behavior. If the product
  rejects it, member removal must re-home restricted resources by changing
  `createdByUserId` or switching them to `org`.
- **The orphan scenario is narrower than first assumed.** If the creator is
  removed and everyone in `sharedWith` also leaves, no non-owner can see the
  restricted resource. The owner's governance exception is the only recovery
  path and can re-home or change visibility. A truly null `createdByUserId`
  after a user-row merge is rare and has the same owner recovery.
- Document that an organization with **no owner** cannot recover such resources,
  even though they continue running on a daemon as described in section 9.
  A future owner view may list restricted resources whose creators are no
  longer members.

## 9. Data-plane isolation: visibility never enters the daemon wire

`AgentSpec`, `CronUpsert`, `RouteAssign`, and the `RegisterOk` reconciliation
snapshot under `packages/protocol/src/frames/` have no owner or visibility
fields, and this design adds none. `agentRecordToSpec` in
`orchestrator/agentSpecAssembler.ts` and `cronToUpsert` in
`orchestrator/placement.ts` copy explicit fields and never read `createdBy`, so
wire bytes do not change after adding database columns. The browser obtains a
short-lived token only after the CP visibility check; webchat content then
travels through relay `rd/*` frames, which also carry no visibility fields.

**Placement and reconciliation reads must remain unfiltered.**
`AgentRepo.listForDaemon` with `where: { daemonId }`,
`CronRepo.listForDaemon` with `where: { agent: { daemonId } }`,
`AssignmentRepo.activeForDaemon`, `IntegrationRepo.activeForDaemon`,
`SecretLeaseRepo.activeForDaemon`, and `reconcile()` at `placement.ts:242`
converge on the complete set physically placed on that daemon. They accept no
viewer and apply no `visibilityWhere`. Filtering them by Console visibility
would make a daemon stop serving a restricted but active agent or cron after
reconnect, which is a **graceful-degradation correctness bug**, not a security
feature.

Add a regression comment beside these signatures: "placement query - MUST NOT
take a viewer; filtering here breaks graceful degradation." Retain a test that
a restricted but active agent remains in the daemon reconciliation roster.

Visibility is purely a **Console read-model concern**, enforced only on Control
Plane REST, WebSocket, and SSE read paths. A daemon neither knows nor needs to
know who can see a resource.

## 10. Schema Compatibility

The current schema baseline is
`prisma/migrations/20260712000000_v1_baseline/migration.sql`, which preserves
GIN indexes Prisma cannot express. Later changes require new forward-only
migrations and must not rewrite that file:

```sql
-- Per-resource visibility for Agent, Daemon, and CronDef.
-- 'org' is the current default visible to everyone.
-- 'restricted' means creator + owners + sharedWith.
-- DEFAULT 'org' and an empty array backfill every row in place without a null
-- intermediate.
CREATE TYPE "ResourceVisibility" AS ENUM ('org', 'restricted');

ALTER TABLE "agent"    ADD COLUMN "visibility" "ResourceVisibility" NOT NULL DEFAULT 'org',
                       ADD COLUMN "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "daemon"   ADD COLUMN "visibility" "ResourceVisibility" NOT NULL DEFAULT 'org',
                       ADD COLUMN "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "cron_def" ADD COLUMN "visibility" "ResourceVisibility" NOT NULL DEFAULT 'org',
                       ADD COLUMN "sharedWith" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- GIN indexes from section 13.2 remove array-containment sequential scans from
-- the default non-owner read path.
CREATE INDEX "agent_sharedWith_gin_idx"    ON "agent"    USING GIN ("sharedWith");
CREATE INDEX "daemon_sharedWith_gin_idx"   ON "daemon"   USING GIN ("sharedWith");
CREATE INDEX "cron_def_sharedWith_gin_idx" ON "cron_def" USING GIN ("sharedWith");
```

Backfill is implicit because `DEFAULT 'org' + NOT NULL` applies in place with
no separate UPDATE.

**Schema compatibility invariant:** a generated Prisma client lists its known
columns explicitly rather than using `SELECT *`. A client built before these
columns tolerates their presence; a client that requires them fails if they are
absent. Migration sequencing and rollback procedure are operator concerns,
separate from the schema compatibility contract.

If future per-grant levels or authorization audit are needed, add
`resource_share(resourceType, resourceId, userId, level, grantedBy, grantedAt)`,
backfill it with `INSERT ... SELECT unnest(sharedWith)`, change
`visibility.ts` to receive the resolved set, then drop the three arrays. Because
all member reads converge in `visibility.ts` and the repository WHERE builder,
this changes roughly four files and no route handler.

## 11. Web Console

- **DTOs and Console:** `AgentDto`, `DaemonViewDto`, and `CronDto` carry
  `visibility`, `sharedWith`, and server-computed `canManageSharing` in
  `http/dto/index.ts`; web `api.ts` mirrors them:
  `AgentDto` at `:82-100`, `DaemonViewDto` at `:309-325`, and `CronDto` at
  `:183-197`. Map them through `agentFromDto` at `api.ts:639` and
  `daemonFromDto` at `api.ts:744`. Add
  `fetchSharing(kind, id)` and
  `updateSharing(kind, id, { visibility, sharedWith })`.
- **Compute `canManageSharing`, equal to `canEdit`, on the server.** It depends
  on scalar `createdByUserId` and `sharedWith`, while `dto.createdBy` may be null
  for a synthetic-email creator because of the
  `isSyntheticEmail` gates at `agents.ts:69`, `crons.ts:44`, and
  `daemons.ts:61`. Client derivation would diverge from the server predicate.
- **Member selector:** store and transmit raw user IDs. Reuse the ID-to-name
  directory through `setMemberDirectory`, `creatorLabel`,
  `useConsoleData().members`, `Avatar` at `ui.tsx:39`, and
  `memberDisplayName` at `api.ts:607`. The member data comes from
  `data-context.tsx:69-70,:209`. Follow the role-tile interaction in
  `InviteMembersModal`.
- **Visibility control:** radio options are Everyone and Selected. Selecting
  Selected expands member multi-selection.
- **Locations:** agent creation in `AddAgentModal`; agent edit and detail in
  `EditAgentModal` and the General card; cron in `AddCronModal`, which is also
  the edit modal through its `cron?` prop and is opened by `ScheduleDetailView`;
  daemon in the Details card. Sessions derive visibility and have no control.
- **Mobile:** modals use one responsive JSX tree, but the General and Details
  cards in `AgentDetailView` and `DaemonDetailView` have separate desktop and
  `isMobile` JSX branches; see `AgentDetailView.tsx:34,49` and `useIsMobile`.
  Add the sharing control and badge to both.
- Gate enabled controls client-side by `dto.canManageSharing`, which now equals
  the caller's `canEdit`, while treating server 403 as authoritative. A viewer
  who can see but not edit sees read-only visibility state and the
  `sharedWith` member list.

## 12. Test plan

**Unit test in `visibility.test.ts`, with no database:** follow the truth table
from section 1. A shared viewer still has `canEdit=false`; an owner views and
edits an unshared restricted resource; the creator always views and edits; a
shared collaborator views and edits; a shared viewer only views; a
non-creator, non-owner collaborator has `canManageSharing=false`; and
`visibilityWhere(owner)` plus `visibilityWhere(undefined)` both equal `{}`.

**Integration tests against real Postgres, per resource type:**

1. An unauthorized collaborator does not receive a restricted agent from
   `list`, and `get` returns 404.
2. An authorized collaborator, creator, and owner can see it.
3. An owner sees a restricted resource never shared with them.
4. An authorized viewer gets 200 from GET and 403 from PATCH.
5. An authorized collaborator can edit content but receives 403 from
   `PUT /sharing`; creator and owner receive 200.
6. Sessions from the **real fan-out route** and usage for a restricted agent do
   not appear for a non-viewer; a restricted cron gates `CronRun` history.
7. SQL WHERE results equal `.filter(canView)` for a mixed viewer.
8. After `migrate deploy`, existing rows have `visibility='org'` and
   `sharedWith=[]`.
9. Unauthorized users get 404 from workspace `gitstatus` and `gitpull`.
10. Removing a member removes their ID from every `sharedWith` in the same
    transaction.
11. `tool-body` returns 404 for both a cross-organization agent ID and a hidden
    restricted agent in the same organization.
12. A restricted but active agent remains in the daemon reconciliation roster;
    `listForDaemon` and `reconcile` do not filter.
13. Exercise Prisma `has:` against real Postgres for
    `sharedWith @> ARRAY[$uid]`, guarding against a `has` versus `hasSome`
    mistake.
14. `POST /api/v1/orgs/:orgId/agents/:agentId/webchat/token` returns 404 to an
    unauthorized collaborator for a restricted agent; no relay WebSocket
    credential is minted.
15. A restricted agent's milestone does not appear in an unauthorized viewer's
    SSE stream.
16. Cron-upsert `agentId`, integration-create `agentId`, and agent-create
    `daemonId` reject invisible targets in a way indistinguishable from missing
    IDs.
17. For an invisible daemon, `GET /keys` returns 404 and credential-minting
    `POST /keys` returns 403 or 404.

## 13. Decisions

1. **Sharing writes use dedicated `/sharing` endpoints.** Existing
   `UpdateAgentBody` is strict and returns 400 for extra fields, and the
   architecture supports a separate surface.
2. **Add GIN indexes immediately** for `sharedWith` on all three tables.
3. **Relax `canManageSharing = canEdit`.** An owner or collaborator who can view
   and edit a resource can change sharing; only a viewer is read-only. Section 1
   documents the two consequences. Creator and owner access is the restoration
   safety net.
4. **Preserve `sharedWith` when changing `restricted -> org`** so switching
   back restores the selection. The `org` predicate already ignores shares.
5. **Accept "Creator forever."** A removed and reinvited creator automatically
   regains access through the creator branch. Member removal prunes only the
   grant vector, not the creator vector.
6. **Show non-managers read-only sharing state.** Anyone for whom `canView` is
   true sees visibility and the `sharedWith` members. Edit controls use
   `canEdit`, equal to the relaxed `canManageSharing`. After relaxation only
   viewers can view without editing. Showing co-sharees read-only is accepted
   as minor information disclosure within the same resource.
7. **Drop the entire SSE `/stream` envelope for an invisible agent.** Resolve
   `agentId -> canView` per envelope and send nothing when false. A restricted
   agent remains completely invisible, matching list/get 404 semantics.
