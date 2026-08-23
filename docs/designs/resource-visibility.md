# Resource Visibility and Sharing

> **Status:** Implemented. The schema, server predicates, Console enforcement,
> sharing controls, and referenced-resource validation all use the same
> visibility contract. User-facing labels are **Everyone** and **Selected**.
> Resource and session decisions converge through
> [`authorization-policy.md`](authorization-policy.md). A Selected member list
> is the complete human audience; immutable creation attribution grants no
> access. Normal member removal prunes all five visibility carriers atomically
> and repairs only audiences that would otherwise become empty.
> Section 14 (platform conversation gating) extends the same model to platform
> ingress and is implemented.
>
> **Scope:** control-plane + web. The daemon execution data plane is unaffected
> except for §14, which extends restricted visibility to platform ingress via a
> derived per-conversation gate (protocol + daemon + web).
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

| Decision                                   | Choice                                                                                                                                                                                                                                                                                                              | Meaning                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| How is the access level determined?        | **Visibility first, then organization role**                                                                                                                                                                                                                                                                        | Everyone/Selected controls who can see a resource. Existing roles determine editing. There is no per-grant edit flag. |
| Does an owner have a governance exception? | **No**                                                                                                                                                                                                                                                                                                              | Organization ownership grants org administration, never access to another member's restricted resource.               |
| Which resource types carry visibility?     | **Agent, Daemon, Cron, MCP provider, and skill source carry Team visibility independently.** Session has a separate audience boundary. Integration derives from Agent; Usage intersects Agent visibility with Session audience; CronRun and daemon API keys derive from their parent. Bot is shared infrastructure. | See the taxonomy in section 2.                                                                                        |

### Authoritative predicates

```ts
canView(res, { userId, role }) =
  res.visibility === 'org' || // Visible to everyone by default
  res.sharedWith.includes(userId) // Complete Selected audience

canEdit(res, ctx) =
  ctx.role === 'viewer'
    ? false // A viewer is always read-only
    : canView(res, ctx)

canManageSharing(res, ctx) = canEdit(res, ctx)
```

The unit-test truth table follows directly:

| Scenario                              | Role         | In `sharedWith`? | Visibility | `canView` | `canEdit` | `canManageSharing` |
| ------------------------------------- | ------------ | ---------------- | ---------- | --------- | --------- | ------------------ |
| Everyone resource, collaborator       | collaborator | N/A              | org        | Yes       | Yes       | Yes                |
| Everyone resource, viewer             | viewer       | N/A              | org        | Yes       | No        | No                 |
| Selected, unshared collaborator       | collaborator | No               | restricted | No        | No        | No                 |
| Selected, shared collaborator         | collaborator | Yes              | restricted | Yes       | Yes       | Yes                |
| Selected, shared viewer               | viewer       | Yes              | restricted | Yes       | No        | No                 |
| Selected, unshared organization owner | owner        | No               | restricted | No        | No        | No                 |

A collaborator or organization owner for whom `canView` is true may change
`visibility` and `sharedWith`. Viewers remain read-only. Creation attribution
and the organization Owner role never create a hidden visibility arm.

This has two consequences:

1. **Restriction strength depends on selected collaborators.** A collaborator
   can share onward or switch the resource to Everyone. Use viewers when the
   selected members should remain read-only.
2. **Any collaborator can change an Everyone resource to Selected** and choose
   a non-empty audience. The creator and organization owners retain no implicit
   access if omitted.

Both are accepted under a model of collaborator trust within an organization.

## 2. Resource taxonomy

| Category                 | Resource                                                   | Own audience fields?                                        | Source                                               |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------- |
| **Visibility carrier**   | `Agent`, `Daemon`, `CronDef`, `McpProvider`, `SkillSource` | `ResourceVisibility` + `sharedWith`                         | Itself                                               |
| **Independent audience** | `SessionMeta`                                              | `SessionVisibility` + owner/external scope; no `sharedWith` | Itself; see `session-visibility.md`                  |
| **Derived**              | `Integration`                                              | No                                                          | Its `Agent`                                          |
| **Derived intersection** | `SessionUsage`                                             | No                                                          | Its `Agent` and `SessionMeta`                        |
| **Derived**              | `CronRun`                                                  | No                                                          | Its `CronDef`                                        |
| **Derived**              | daemon `ApiKey`                                            | No                                                          | Its `Daemon`; key minting is a credential operation  |
| **Infrastructure**       | `Bot`                                                      | No                                                          | Always organization-visible and cannot be restricted |

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

Each visibility carrier keeps immutable creator audit separate from access:

```prisma
createdByUserId String? // immutable attribution
visibility  ResourceVisibility @default(org)
sharedWith  String[]           @default([])  // complete, non-empty app_user.id audience when restricted
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

`Shareable` carries only `visibility` and `sharedWith`. Persistence records
additionally retain raw `createdByUserId` for audit and the joined creator used
by Console DTOs. New resources default to Everyone. A Selected create or
sharing write locks the actor and requested audience memberships, intersects
the submitted IDs with current organization members, deduplicates them, and
rejects the write if the resulting audience is empty. A database CHECK
constraint also prevents a persisted Selected row with an empty array.

After the schema change, run
`pnpm --filter @agentconnect.md/control-plane prisma:generate` to regenerate the
committed client.

## 4. Authorization layer: one OSS policy seam

`src/authorization/policy.ts` is independent of Fastify so `test:unit` can
cover it with no I/O. It owns the action vocabulary and the single
`can(principal, request)` decision point:

```ts
can(principal, { action: 'organization.write' })
can(principal, { action: 'organization.manage' })
can(principal, { action: 'resource.view', resource })
can(principal, { action: 'resource.edit', resource })
can(principal, { action: 'resource.sharing.manage', resource })
can(principal, { action: 'session.view', resource, identitySet })
can(principal, { action: 'session.visibility.change', resource, identitySet })
```

Readable `canView`/`canEdit`/`canManageSharing` adapters delegate to `can`.
`rbac.ts` delegates its role guards to the organization actions, and the
session visibility-change predicate also lives in this module. The
`visibilityWhere` SQL projection is colocated with the in-memory rule; only an
undefined principal, reserved for daemon/orchestration reads, is unfiltered.
See [`authorization-policy.md`](authorization-policy.md) for the boundary.

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

### 5.5 Session: an independent audience boundary

Sessions now have their own persisted audience and are not child resources of
the owning Agent for human reads. The current contract is authoritative in
[`session-visibility.md`](session-visibility.md): list, detail, transcript,
tool-body, relationships, and SSE all use the Session predicate plus the active
organization boundary. A readable Session may project its owning Agent's name,
but it does not make a restricted Agent resource, configuration, or workspace
readable. Analytics remains resource-scoped and keeps the Agent intersection.

### 5.6 Usage: `usage.ts -> sessionUsage.aggregate`

`usage.ts` passes viewer context into `sessionUsage.aggregate`; otherwise a
restricted agent's tokens and spend would leak existence and cost through an
organization aggregate.

- Add `viewer?` to `SessionUsageRepo.aggregate(orgId, since, viewer?)` at
  `session-usage.repo.ts:48` and pass `ctxOf(req)` from `usage.ts`. Every human
  role uses the same visibility filter. Both internal queries, groupBy at `:51` and
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

Sharing writes use the **same gate as content edits**:
`canManageSharing = canEdit`.
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
- **Validate `sharedWith` on write:** intersect IDs with current organization
  membership, return the resolved set, and reject Selected with 409 when the
  resolved audience is empty.
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

The WHERE clause for every human role is:

```sql
WHERE "orgId" = $1
  AND ("visibility" = 'org' OR "sharedWith" @> ARRAY[$2])
```

Only internal callers that omit the principal receive an unfiltered
`{ orgId }` query. Organization owners use the same predicate as every other
human principal.

**Index requirements:**

- Do **not** create `[orgId, visibility]`. Visibility is nearly constant, cannot
  accelerate the three-column disjunction, and adds write amplification.
- **Create GIN indexes immediately.** Array containment on `sharedWith` is on
  the default human-read path, not an edge case. Add
  `CREATE INDEX ... USING GIN ("sharedWith")` to all five tables. Empty arrays
  are cheap, and the index removes a sequential scan from the default path.
- Do **not** apply a second in-memory `.filter` at runtime. SQL WHERE is
  authoritative. Assert in tests that SQL rows equal
  `rows.filter(canView)`, rather than adding another O(n) scan to unpaginated
  lists.

## 7. Derived visibility and cascading rules

- **Integration derives from Agent** and is filtered by a parent relation or
  route-level `canView`.
- **Session is independent from Agent Team visibility** for human reads and
  uses its own audience plus the active organization boundary.
- **Usage is a resource-scoped intersection:** Agent visibility and the
  corresponding Session audience both apply to session-backed aggregates.
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

## 8. Member removal and audience repair

### 8.1 Prune and repair sharing in the same transaction

Users are provisioned just in time from OIDC `sub`, and `app_user.id` is
**stable**. Reinviting a removed member reuses the same ID. If pruning were only
best-effort hygiene, a stale ID could survive a failure or skip and silently
restore shared access upon reinvitation.

**Pruning is a correctness dependency, not hygiene.** For Agent, Daemon,
CronDef, McpProvider, and SkillSource, the transaction:

1. removes the departing ID from every `sharedWith` array;
2. for a Selected resource that would otherwise have no current member, adds
   the deterministic repair member from §8.2;
3. leaves `visibility` and `createdByUserId` unchanged;
4. deletes the membership last.

Owner demotion, removal, and invited-identity role merge first lock the
organization `FOR NO KEY UPDATE`. That lock serializes owner transitions and
conflicts with organization deletion, while remaining compatible with the
parent `FOR KEY SHARE` held by ordinary resource writes. Any member may remove
their own membership; removing someone else remains owner-only. Removal then
rechecks the actor's membership and any required owner role, chooses the
repair member from an authoritative membership snapshot, and locks the
departing and repair rows inside the same transaction. Every resource create
and dedicated sharing write uses the matching
persistence seam: in the same transaction as the resource mutation it first
protects the parent organization `FOR KEY SHARE`, then locks the current actor
and requested audience members `FOR SHARE`, rechecks membership, and
intersects `sharedWith` again. The parent-first order remains compatible with
organization deletion; the shared/exclusive membership lock pair establishes a
commit order:

- if the resource write commits first, removal waits and then prunes or repairs
  that row;
- if removal commits first, the queued write observes the missing actor and
  fails, while a departed audience member is omitted.

The Selected-audience migration folds every former resource owner into
`sharedWith`, intersects all five arrays with current membership, deduplicates
them, and deterministically backfills a current member only for legacy
Selected rows that would otherwise be empty. It then adds non-empty CHECK
constraints and drops the obsolete ownership columns and indexes.

This is a coordinated, **forward-only** deployment boundary. Older Control
Plane binaries still read and write `ownerUserId`, so drain them before
applying the migration and start the new version only after `migrate deploy`
completes. Recovery uses a forward fix or coordinated database restore, not an
old-binary restart.

The HTTP `resolveShareSet` call remains useful early normalization, but it is
not the correctness boundary because membership can change before the resource
write commits.

The last-owner check runs under the same organization transition lock and
rejects before either a demotion or membership deletion commits. No
post-transaction compensation is used.

This workflow covers managed membership removal only. Direct deletion of an
`app_user` row is unsupported and does not run audience repair.

### 8.2 Choosing the repair member, and showing it before the fact

Most removals only prune one ID because another current member remains selected.
Only an audience that would become empty needs a repair member. No additional
organization owners are added.

Two cases use deterministic rules:

- **An Owner removes someone else** — add the acting Owner where repair is
  required. They can immediately re-share or re-classify the resource.
- **A member leaves on their own** — add the organization's
  **longest-standing remaining Owner**: `membership.createdAt` ascending, ties
  broken by `userId`.

`membership.createdAt` exists for this. Before it, the table carried no
timestamps, so both this choice (`ORDER BY "userId"` over timestamp-prefixed
cuids) and the console's "joined" column silently ranked **global account signup
order** — a property of the person's first day on the platform, unrelated to the
organization they are leaving. Existing rows were backfilled from the cuid in
`membership.id`, which encodes the row's own creation instant, so the ordering
is historically accurate rather than merely well-defined going forward; rows
whose id is not a cuid fall back to `max(account, organization)` creation.

Because the repair choice is consequential, it is **shown before it happens**.
`GET /members/:id/removal-preview` returns `replacement` plus per-kind
`selected` and `reassigned` counts. `selected` counts affected Selected
audiences; `reassigned` counts the subset that would otherwise become empty.
The preview takes no locks and is never an authorization input: removal
re-derives the repair member and counts inside its transaction.

A resource stays Selected throughout repair. Organization roles do not widen
its audience afterwards.

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

Section 14 introduces one deliberate, **derived-form** exception: for a
restricted agent the CP assembles different integration bind rules and a
boolean `gated` flag. The invariant that survives is that **no owner, viewer,
or `sharedWith` identity ever crosses the wire** — the daemon learns that an
integration is fail-closed, never who may see the agent — and placement reads
stay unfiltered exactly as above.

## 10. Schema Compatibility

The current schema baseline is
`prisma/migrations/00000000000000_init/migration.sql`, which preserves
GIN indexes Prisma cannot express. Later changes require new forward-only
migrations and must not rewrite that file:

```sql
-- Per-resource visibility for Agent, Daemon, and CronDef.
-- 'org' is the current default visible to everyone.
-- 'restricted' means the complete, non-empty sharedWith audience.
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
-- the default human read path.
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
`authorization/policy.ts` to receive the resolved set, then drop the three
arrays. Because all member reads converge in that policy and its
`visibilityWhere` projection, this changes roughly four files and no route
handler.

## 11. Web Console

- **DTOs and Console:** `AgentDto`, `DaemonViewDto`, and `CronDto` carry
  `visibility`, `sharedWith`, and server-computed `canEdit` /
  `canManageSharing` in
  `http/dto/index.ts`; web `api.ts` mirrors them:
  `AgentDto` at `:82-100`, `DaemonViewDto` at `:309-325`, and `CronDto` at
  `:183-197`. Map them through `agentFromDto` at `api.ts:639` and
  `daemonFromDto` at `api.ts:744`. Add
  `fetchSharing(kind, id)` and
  `updateSharing(kind, id, { visibility, sharedWith })`.
- **Compute `canManageSharing` on the server.** It equals `canEdit`, while
  `dto.createdBy` may be null for a synthetic-email creator because of the
  `isSyntheticEmail` gates at `agents.ts:69`, `crons.ts:44`, and
  `daemons.ts:61`. Client derivation would diverge from the server predicate.
- **Member selector:** store and transmit raw user IDs. The selected IDs are the
  complete audience; `createdBy` is display-only audit. Reuse the ID-to-name
  directory through `setMemberDirectory`, `creatorLabel`,
  `useConsoleData().members`, `Avatar` at `ui.tsx:39`, and
  `memberDisplayName` at `api.ts:607`. The member data comes from
  `data-context.tsx:69-70,:209`. Follow the role-tile interaction in
  `InviteMembersModal`.
- **Visibility control:** radio options are Everyone and Selected. Selecting
  Selected expands member multi-selection. When switching from Everyone with
  no saved selection, the Console initially selects the current user. Any
  selected member can be replaced, but the final one cannot be removed until
  another current member is selected.
- **Locations:** agent creation in `AddAgentModal`; agent edit and detail in
  `EditAgentModal` and the General card; cron in `AddCronModal`, which is also
  the edit modal through its `cron?` prop and is opened by `ScheduleDetailView`;
  daemon in the Details card. Sessions are outside these Team-sharing controls
  and use the independent audience UI in `session-visibility.md`.
- **Mobile:** modals use one responsive JSX tree, but the General and Details
  cards in `AgentDetailView` and `DaemonDetailView` have separate desktop and
  `isMobile` JSX branches; see `AgentDetailView.tsx:34,49` and `useIsMobile`.
  Add the sharing control and badge to both.
- Gate enabled controls client-side by `dto.canManageSharing`, which equals the
  caller's `canEdit`, while treating server 403 as authoritative. A viewer sees
  read-only visibility state and the `sharedWith` member list.

## 12. Test plan

**Unit test in `authorization/policy.test.ts`, with no database:** follow the
truth table from section 1. A shared viewer still has `canEdit=false`; an
unshared organization owner cannot view or edit a restricted resource; the
creator has no implicit access; a shared collaborator views and edits; a shared
viewer only views; and `visibilityWhere(owner)` matches every other human principal
while `visibilityWhere(undefined)` equals `{}`.

**Integration tests against real Postgres, per resource type:**

1. An unauthorized collaborator does not receive a restricted agent from
   `list`, and `get` returns 404.
2. Exactly the explicitly selected members can see it; the creator has no implicit access.
3. An unshared organization owner receives the same hidden result as any other role.
4. An authorized viewer gets 200 from GET and 403 from PATCH.
5. A shared collaborator can edit content and sharing; a shared viewer cannot.
6. Session list/detail/body reads follow the Session audience even when the
   owning Agent is restricted; usage for that Agent remains absent to an
   unshared viewer, and a restricted cron gates `CronRun` history.
7. SQL WHERE results equal `.filter(canView)` for a mixed viewer.
8. After `migrate deploy`, existing rows have `visibility='org'` and
   `sharedWith=[]`.
9. Unauthorized users get 404 from workspace `gitstatus` and `gitpull`.
10. Removing a member repairs all five Selected audiences, preserves creator
    audit, and removes their ID from every `sharedWith` in the same transaction.
11. `tool-body` returns 404 for both a cross-organization Session and a Session
    outside the caller's audience.
12. A restricted but active agent remains in the daemon reconciliation roster;
    `listForDaemon` and `reconcile` do not filter.
13. Exercise Prisma `has:` against real Postgres for
    `sharedWith @> ARRAY[$uid]`, guarding against a `has` versus `hasSome`
    mistake.
14. `POST /api/v1/orgs/:orgId/agents/:agentId/webchat/token` returns 404 to an
    unauthorized collaborator for a restricted agent; no relay WebSocket
    credential is minted.
15. SSE forwards a visible Session milestone even when its Agent is restricted,
    while a Session outside the caller's audience remains absent.
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
3. **Use `canManageSharing = canEdit`.** An Owner or collaborator who can view
   and edit a resource can change sharing; only a viewer is read-only. Role
   never widens resource visibility.
4. **Preserve `sharedWith` when changing `restricted -> org`** so switching
   back restores the selection. The `org` predicate already ignores shares.
5. **Creation attribution is audit-only.** `createdByUserId` remains immutable
   history and never grants access; `sharedWith` is the full Selected audience.
6. **Show non-managers read-only sharing state.** Anyone for whom `canView` is
   true sees visibility and the `sharedWith` members. Edit controls use
   `canManageSharing`, which equals `canEdit`. Showing co-sharees read-only is accepted as minor
   information disclosure within the same resource.
7. **Drop the entire SSE `/stream` envelope for an invisible agent.** Resolve
   `agentId -> canView` per envelope and send nothing when false. A restricted
   agent remains completely invisible, matching list/get 404 semantics.

## 14. Platform conversation gating (private agents)

> **Status:** Implemented.
> Scope: protocol + daemon + control-plane + web. Slack is the driving case;
> the mechanism is platform-generic (Telegram / Discord / Lark / Feishu integrations
> share the same bind-rule shape).

### 14.1 Problem

The sections above protect a restricted agent in the Console, but the moment it
gets a platform integration the IM surface is fail-open: **any workspace member
can invite the bot into any channel, or DM it, and talk to the private agent.**

The platform cannot fix this for us. Slack's app approval governs who may
_install_ an app, not who may _use_ it; there is no per-user invite ACL. Once
installed, every member can add the bot to channels they are in and can open a
DM with it. Native mitigations (private channels, disabling the App Home
Messages tab) are coarse, app-global, and do not compose with per-agent
semantics — especially not for a shared (whole-pool) bot serving many agents.
So authorization must live in AgentConnect's own routing layer.

### 14.2 Product design

**Per-conversation tri-state.** The existing per-channel trigger
(`mention` | `any`) gains a third state:

| State            | Meaning                                                  |
| ---------------- | -------------------------------------------------------- |
| **Off**          | The agent does not activate in this conversation at all. |
| **Mention**      | Activates on explicit @-mention (today's default).       |
| **All messages** | Activates on any message (today's `any`).                |

**Gating applies only to restricted agents.**

- **Org-visible agents keep the same routing defaults.** Unscoped mention
  default everywhere, DMs open to the whole workspace, per-channel "All
  messages" opt-in. Observed direct conversations now have rows so an editor
  can explicitly turn those defaults Off.
- **Restricted agents are gated: every conversation defaults to Off.** When
  the bot is invited to a channel, the channel appears on the integration card
  in a pending/Off state. An **editor must enable it in the Console**, choosing
  Mention or All messages. Because the Console is itself protected by this
  design's predicates, the set of people who can enable a conversation is
  exactly the private group — the two ACL worlds meet here without any
  Slack↔AgentConnect identity mapping.

**DMs are conversations too.** Every observed DM is listed as its own row
(platform DM conversation id, displayed with the counterpart's name). The
integration card groups rows into **Channels** and **Direct messages**; 1:1 DM
rows are binary (Off / On — a DM needs no mention distinction). Org-visible
agents default new DMs On; restricted agents default them Off. Both expose the
same control, and both enforce it. Classic integrations keep these controls per
integration. A shared HTTP bot converges each observed conversation to one
default owner and projects its trigger across all sibling integrations, the same
way it handles an enumerated channel.

**Behavior of an Off conversation.**

- The bot stays in the channel (no auto-leave) but does not activate: plain
  messages, keyword/auto triggers, thread follow-ups, and bot-authored
  activations are all dropped.
- An **explicitly addressed** message — an @-mention of the bot, or a DM —
  receives a **one-time per-conversation notice** ("This agent isn't enabled in
  this conversation. Ask an admin to enable it in the AgentConnect console.")
  so the bot never appears silently broken, and access pressure is routed to
  the editors. Subsequent addressed messages in the same conversation are
  dropped silently.
- The Console shows a pending indicator on conversations awaiting a decision.
- Optional (nice-to-have): a "Leave channel" action on a channel row for
  unwanted invites (`conversations.leave`).

**Trust model — authorize places, not people.** Enabling a channel entrusts
that channel's **entire current and future membership**. That is a deliberate
trade-off: the unit of authorization is the conversation, and Slack-native
membership (especially private channels) governs who is inside it. The daemon
does not add a separate per-user allowlist at ingress.

**Inbound only.** Gating governs **inbound activation** exclusively. Outbound
deliveries — cron and hook targets posting into a conversation — are already
editor-configured and keep working regardless of the conversation's state.

### 14.3 Mechanism

**Enforcement points.** The Console is only a configuration surface; where the
gate executes depends on the transport:

- **Direct (socket) integrations** terminate in the daemon's `routeRules`
  arbitration over the merged rule set — the scoped-rules mechanism below is the
  complete gate.
- **Shared (http) integrations do NOT pass through `routeRules`**: the relay
  arbitrates from the CP-compiled attributed route table and forwards
  pre-addressed (`handleRelayIm` dispatches without local routing). The gate is
  therefore two-layered: (1) **primary — CP route compilation + relay
  arbitration**: an Off conversation compiles no route, a gated agent is
  excluded from the unscoped keyword rule and from `defaultAgentId` (the two
  rungs that make a shared bot fail-open for a bare `@bot` and DMs), the relay's
  thread-continuity rung honours a binding to a gated agent only while it still
  has a channel-scoped route in the conversation (`gatedAgentIds` rides
  `rc/bot-assign`/`rc/routes`), and the CP's `rc/thread-lookup` backstop applies
  the same check; (2) **backstop — the daemon's `handleRelayIm` admission
  check**: the shared spec carries the gated install's conversation-scoped
  bindRules + `gated`, and the last hop refuses (with the one-time notice) any
  conversation those rules don't cover, so a stale relay route snapshot cannot
  activate a private agent. The in-Slack config modal (`rc/set-channel-agent`)
  is reachable by any workspace user, so assigning a channel to a gated agent
  creates its row **Off** — only a Console editor can enable it.

Control commands (`!stop`, `/status`, …) resolve their target outside
`routeRules`' scope filter (latest-session fallbacks), so the daemon repeats the
conversation-admission check in its command authorization.

**Scoped rules instead of unscoped defaults.** Today the CP ships every
integration `DEFAULT_BIND_RULES` — an **unscoped** `mention` rule and an
**unscoped** `dm` rule — plus one channel-scoped `auto` rule per "All messages"
channel (`orchestrator/placement.ts`). For a **gated** integration the CP stops
emitting the unscoped defaults and emits only conversation-scoped rules for
enabled conversations:

- channel enabled as Mention → `{ channel: C…, match: { kind: 'mention' } }`
- channel enabled as All → `{ channel: C…, match: { kind: 'auto' } }`
- DM conversation enabled → `{ channel: D…, match: { kind: 'dm' } }`

An unknown conversation then matches **no rule**, so nothing routes — the
fail-closed default (including the window between the bot joining a channel and
the membership report landing) falls out of the existing scope matching in
`router/routing-table.ts` with zero new enforcement machinery. Thread affinity
is already scope-filtered (`scopeCandidates`), so follow-ups in an Off
conversation are blocked by the same mechanism. Non-gated integrations keep
`DEFAULT_BIND_RULES` verbatim.

_Implementation check:_ confirm the daemon's normalized DM messages carry the
platform DM conversation id as `msg.channel` on every platform, so a
channel-scoped `dm` rule matches. (True for Slack `D…` ids; verify Telegram /
Discord / Lark / Feishu DM id shape when extending.)

**Spec flag: `gated`.** `IntegrationSpec` gains a boolean (working name
`gated`) so the daemon knows this integration is fail-closed. The daemon needs
it to send the one-time notice when an explicitly addressed message matches no
rule and to discover unknown/Off restricted channels. Direct-conversation
reporting is visibility-independent. This is the §9 derived-form exception:
the flag carries no identities.

**Conversation reporting.** The `integration/channels` D→C EVT and
`IntegrationChannel` protocol shape gain `kind: 'channel' | 'im'` (absent =
`'channel'` for wire compatibility). Slack channel rows keep coming from
authoritative membership events. Platforms that cannot enumerate every
conversation send `authoritative: false`; these reports upsert observed rows
without deleting absent ones — so such a reporter names what it has LEFT in
`removed`, the only way it can retire a row at all (its omissions carry no
meaning). A named removal deletes whatever the row's kind, including a DM row
that no authoritative snapshot could ever drop. An explicitly addressed Off group is reported
before routing, because it deliberately creates no session. Direct rows are
reported on first inbound conversation for every integration, carrying the
counterpart's display name where available. An optional boot-time sweep
(`conversations.list types=im`) can backfill DMs opened while the daemon was down.

_Shared bots:_ the relay's membership snapshot drops IMs, so direct rows take
the incremental path there too — every human DM (and addressed group DM) makes
the relay emit `rc/bot-conversation` (conversation id + best-effort `users.info`
counterpart name), which the CP fans across **every install** and converges to
one owner plus one effective trigger. A new conversation uses the earliest
active install as owner; restricted rows start Off, org-visible 1:1 DMs start On,
and group DMs start on Mention. The relay also
posts the one-time
per-conversation notice (chrome-marked; the unrouted @-mention case included)
since no daemon is involved before arbitration. Because a channel mention
arrives as two independent Events API POSTs that the pool LB may hand to
different relay pods, the CHANNEL notice is posted only by the bot's
**`noticeAuthority`** — a relayId the CP stamps deterministically from the
connected roster at (re)assign time and re-converges on relay join, disconnect,
and sweep (config-time orchestration; the CP is never a per-message
round-trip) — with a local per-conversation latch on that pod. A DM has a
SINGLE event copy, so the RECEIVING pod posts its notice; the pool-wide latch
is the **`noticedDmConversations`** set, which records notices ACTUALLY
DELIVERED (reported via `rc/notice-posted` after the post, then re-stamped to
every pod) — deliberately not derived from conversation rows, since a mixed
bot's DM routed by its public default creates a row with no notice and must
still receive one if it later becomes unroutable. Enabling a shared conversation
compiles one conversation-scoped route for its selected owner; it does not fan
out to every install or create per-agent DM slug routes. Unscoped keyword
remains forbidden for gated agents.

**Control-plane and web.**

- `IntegrationChannel` (table `integration_channel`): `ChannelTrigger` enum
  gains `off`; new `kind` column (`channel` | `im` | `mpim`). Row creation
  derives the default from visibility and kind: restricted conversations Off,
  org-visible 1:1 DMs On, and other org-visible rooms Mention.
- The existing per-conversation trigger PATCH route accepts `off` and reuses the
  existing recompute-bindRules-and-push flow. A direct integration requires edit
  rights on its parent agent. A shared bot's conversation state is bot-scoped, so the
  route additionally requires edit rights on the effective owner and on a newly
  selected owner; changing a visible sibling cannot enable a hidden restricted
  owner. Mutations are serialized per bot/channel and fenced to the owner that
  passed authorization, so a concurrent in-Slack owner move makes the Console
  request retry instead of applying its trigger to the new owner.
- `gated` is **derived** from `agent.visibility === 'restricted'` at spec
  assembly; there is no separate stored toggle (see §14.7).
- Web `IntegrationChannelList`: tri-state segmented control per conversation row
  (Off / Mention / All messages) — offered for every agent, not only a gated
  one — a Direct-messages section with binary rows, pending badges, and a
  banner on restricted agents' integration cards explaining the gate.
- Off cannot always be expressed by withholding a rule, because some rungs are
  unscoped and additive — `@-mention` anywhere and DMs on a daemon-arbitrated
  integration; the agent-slug keyword and the group's `defaultAgentId` on a
  relay-arbitrated bot. The CP therefore ships an explicit `mutedChannels` fence,
  applied ahead of every rung, which the two arbiters populate differently
  because their unscoped rungs differ:
  - **Daemon** (`IntegrationSpec.mutedChannels`, per integration): the Off
    conversations of an UNGATED integration, including direct rows. A gated one leaves it empty — it ships
    no unscoped defaults at all, so its Off already is the absence of a scoped
    rule, and stating the same fact twice would let the two drift apart.
  - **Relay** (`rc/bot-assign` / `rc/routes`, per bot): every bot-scoped Off
    conversation, including an observed DM or group DM.
    A gated owner's missing route is not enough here: an
    ungated sibling's unscoped rungs are still in the same table, so on a
    mixed-visibility bot a bare `@bot` would otherwise reach the public default
    in a channel the console shows as Off.
    An enabled conversation whose canonical owner is active but unplaced is
    also muted until that owner has a daemon placement; it must not fall
    through to another agent's unscoped default. This availability fence is
    not included in `gatedOffChannels`, because the conversation is On rather
    than Off and must not receive the gated-owner notice.
- Because the relay fence covers both, it also has to say which Off conversations
  still deserve the §14.3 notice. `gatedOffChannels` carries that subset — the
  muted conversations whose owner is gated, i.e. Off because nobody has enabled them
  rather than because an operator silenced them. The relay posts the notice only
  for those; an operator's Off is silent (see "Per-conversation trigger" in
  product-conventions.md). The two states share a trigger value and the relay
  cannot infer conversation ownership from a table that holds no route for them, so
  this is explicit wire state rather than something derived.

### 14.4 Visibility transitions

- **org → restricted:** gating turns on. Existing known channel rows keep
  their current trigger (grandfathered enabled) so running setups are not cut
  mid-conversation; a Console banner prompts the editor to review them. Every
  known direct row is reset Off in the same transaction as the visibility change,
  before the gated route/spec push; newly observed direct conversations also start
  Off.
- **restricted → org:** gating turns off; unscoped defaults return. Rows and
  their trigger values persist so flipping back restores the previous
  decisions — the same preservation principle as Decision 4. Direct and channel
  rows remain visible and effective, including Off.

### 14.5 Rollout / migration

Existing integrations already attached to restricted agents follow the same
grandfathering as the org → restricted transition: known channels keep their
triggers, DMs close. Closing DMs is the one behavior break for incumbent DM
users; the one-time notice tells them what happened and the pending row gives
editors a one-click re-enable. (The strict alternative — everything Off on
migration — was considered and rejected as needlessly disruptive to channels
that editors demonstrably already configured.)

Existing org-visible direct rows were previously hidden and forced Off, so the
migration seeds them to the new visible defaults: 1:1 DMs On and group DMs on
Mention.

### 14.6 Out of scope / future overlays

- **Identity mapping at ingress.** Resolving platform senders to AgentConnect
  users so ingress could enforce agent visibility itself — making "private" mean
  the same set of people on every surface — remains out of scope as a general
  mechanism. §14.8 takes the one case where the mapping is an identity
  ASSERTION rather than an inference, and applies it to a default rather than to
  admission. Conversation gating neither depends on nor conflicts with the rest.
- **Auto-leave policy** (bot automatically leaves channels it is not enabled
  in), **user-group-based grants**, and webchat/GitHub surfaces (already gated
  by Console auth / repo authorization respectively).

### 14.7 Open questions

1. Does `gated` need a per-integration override (e.g. force-gate a public
   agent's integration), or is derivation from visibility enough for v1?
   Current call: derivation only.
2. Exact notice copy and whether the notice deduplication window should reset
   (e.g. after 24 h) or be strictly once per conversation per daemon lifetime.
3. Whether the DM boot-sweep ships in v1 or first-message reporting alone is
   enough.

### 14.8 A private agent's DM follows its audience's linked identity

**Status:** Implemented.

**Problem.** §14.2 makes every conversation of a restricted agent default Off,
including a DM. That is right for a channel and wrong for the person the agent
was shared with: they can already see, edit and run it in the Console, yet their
own DM with it answers a "not enabled" notice until an editor — often the same
person — goes and enables it. The gate protects nobody there; it just makes a
private agent feel broken to its own audience.

**Rule.** A 1:1 DM row of a gated agent seeds to the ordinary DM default (On)
instead of Off when its counterpart is BOTH:

1. in the agent's own `sharedWith` audience, and
2. carrying a linked Slack identity in that bot's workspace.

Both arms are load-bearing. An unlinked audience member and a linked
non-member each keep §14.2's Off. The link is Logto's — a Slack sign-in, or an
Account API link driven by the user's own authenticated session — never an email
guess, which is what keeps this an assertion rather than the inference §14.6
parks.

**Why only a 1:1 DM.** It is the one conversation whose entire human membership
is known at discovery: one bot, one person. A channel's membership is a place
and may change after the fact, which is exactly why §14.2 sends it to an editor;
a group DM is a room by the same argument. Neither is seeded.

**Why only Slack.** It is the driving case, and the one platform whose linked
identity names the same id space a DM report carries. A Feishu link asserts a
cross-app `union_id` while its messages carry an app-scoped `open_id`; matching
there needs a resolution step that does not exist yet, and guessing would
silently widen a private agent.

**Mechanism.** The reporter adds the counterpart's platform member id to the
conversation report (`IntegrationChannel.dmUserId`, persisted on the row as
control metadata of the same class as `name`); both report paths — the daemon's
`integration/channels` and the relay's `rc/bot-conversation` — carry it. The CP
resolves the audience's own linked identities (one cached per-subject read each)
and matches the reported counterpart against them; there is deliberately no
reverse index from a platform member id to a console account. Every unresolvable
case fails CLOSED to §14.2: no sign-in configured, no workspace on the bot, an
oversized audience, or an upstream that cannot answer all leave the row Off.

This report is also the one place where a CP write turns a daemon's own report
into an ENABLED conversation, so it is the one that has to push: the reporting
daemon still holds the `bindRules` it was given before the row existed, and it
has already cached the conversation, so nothing re-reports and repairs it.
Opening a row therefore re-converges the agent's integrations, the same push a
visibility flip performs. (The shared-bot path already did this — `syncRoutes`
recompiles the relay routes _and_ re-pushes the send-only specs.)

**Order independence.** A seed decided at discovery would fire only for people
whose link and audience seat both predate their first DM — which is the opposite
of what happens, since people link _because_ they were refused. So the two
writes that can make the answer true later — a landed identity link, a widened
audience — re-ask it for the Off DM rows already on record. The rule that
results does not depend on the order the three events arrive in.

**A catch-up only ever touches a row still at its DEFAULT.** That is what
`integration_channel.triggerChosen` exists for: it is set the moment a human
picks a conversation's trigger, in the Console or the in-Slack modal, and never
cleared.

It has to be as complete as the trigger it accompanies, because on a shared bot
the trigger is CONVERSATION-level state repeated across one row per install. So
the marker replicates exactly the same way: a human decision marks every sibling
row, including one that already carries the value and one the same call
backfills with it; ownership convergence reads the flag from ANY row of the
conversation and carries it onto siblings it backfills later. That last part is
what survives the owner-removal lifecycle — the row that RECORDED the decision
is deleted with its integration while siblings live on, and reading provenance
from the owner row alone would lose the decision on precisely the path the
backfill exists for. For the same reason **a decided conversation is never
re-derived**: a gated agent inheriting one keeps its trigger instead of
recomputing the §14.2/§14.8 default over it. Without it a stored Off is indistinguishable from an operator's own
choice — §14.2 lets an editor close a DM §14.8 opened — and a catch-up would
reopen that DM on the next sharing edit or profile refresh, turning a DEFAULT
into a standing rule that overrides the per-conversation control.

The marker is load-bearing rather than an optimization, because **neither call
site can prove it is the moment a link appeared.** The browser-driven Account
API flow writes the link at the provider BEFORE calling the Console's refresh
route, so a "was it linked before?" read on this side is only pre-link when a
cache entry happens to survive the round trip — cold cache, a CP restart, or a
link slower than the identity lease all make it read the already-linked
identity and conclude nothing changed. Inferring novelty after an external
mutation is not available here, so the catch-up runs unconditionally and leans
on `triggerChosen` to be idempotent. (A widened audience still reconciles only
the members it GAINED — there the diff IS available, and it bounds the work.)

Rows that predate the marker are left at `false`: for a gated agent Off is the
universal default, so before §14.8 a deliberately-closed DM required an editor
to turn one On and then Off again. Marking the whole backlog "chosen" would be
safer on paper and would keep the feature from ever reaching the DMs that
already exist, which are exactly the ones it is for.

**One-way even so: a catch-up never closes a row.** A close cannot be derived
from absence — an audience seat lost, an unlink, and an editor's own Off all
present the same way to the reconciler. So an opened DM stays open: a gated bind
rule is conversation-scoped (`{channel, match:'dm'}`) with no user dimension, and
losing the seat does not close the conversation the seat opened; an editor
turning the row Off does, and that Off is now sticky. This is the same durability
§14.2 already gives an editor-enabled conversation, with the difference that the
grant originated from a membership that can later change. Revoking on seat loss
is now expressible — `triggerChosen` tells the two apart — and is left to a
change that can decide what should happen to the session history behind it.

**Known edge.** The daemon and relay decide admission before the CP has the row,
so the very first message of a brand-new DM is still refused with the §14.3
notice; the conversation is open from the next message on. Closing that gap
means shipping the authorized member ids to the edge in the integration spec,
which is a separate change with its own recompute-and-push triggers.
