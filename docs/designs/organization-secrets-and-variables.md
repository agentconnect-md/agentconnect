# Organization Secrets and Variables

> **Status:** Implemented
>
> **Scope:** protocol + control-plane + daemon + web
>
> **Requirement mapping:**
>
> 1. Organization owners manage organization-level variables and secrets from
>    Settings. See sections 4, 7, and 8.
> 2. Every entry targets either **All agents** or **Selected agents**. See
>    sections 3 and 6.
> 3. An agent's Variables and Secrets surfaces show assigned organization
>    entries with an **Organization** label. Those rows are read-only there. See
>    section 8.

## 1. Goal

AgentConnect currently stores plain runtime variables on an agent and stores
write-only agent secrets separately in `agent_secret`. Teams therefore repeat
the same value on every agent and must rotate it one agent at a time.

This design adds an organization-owned environment registry. An organization
owner can define a variable or secret once and choose whether it applies to all
agents or a selected set. The Control Plane resolves the assigned organization
entries together with each agent's existing local entries before constructing
the existing `AgentSpec.env` and `AgentSpec.secrets` maps. A monotonic
configuration revision is added beside those maps so a daemon cannot apply
resolved snapshots out of order.

The feature is configuration distribution, not a new secret lease system. The
Control Plane remains off the message hot path, and the daemon continues to
start agents entirely from its locally persisted `agent.json` after receiving
the resolved spec.

## 2. Terminology and non-goals

- An **organization entry** is one organization-owned variable or secret.
- An **agent entry** is the existing variable or secret owned by one agent.
- An entry's **audience** is `all` or `selected`. The Console labels these
  values **All agents** and **Selected agents**.
- An organization entry is **assigned** to an agent when an explicit,
  target-authorized binding exists. `all` controls automatic enrollment into
  those bindings; it does not bypass agent authorization.
- The **effective environment** is the resolved set sent to the daemon.

This version does not:

- expose secret values after they are saved;
- let an agent editor change an organization entry or its audience;
- add per-daemon, per-session, per-conversation, or per-workspace scopes;
- substitute values into other settings;
- give agents a new runtime API for fetching secrets;
- move secret resolution onto the Control Plane message path; or
- provide instantaneous revocation from an already-running OS process.

## 3. Decisions and invariants

### 3.1 One organization keyspace

An organization cannot contain both a variable and a secret with the same key.
Keys are unique by `(orgId, key)` across both kinds and use the existing env-var
name rule:

```text
^[A-Za-z_][A-Za-z0-9_]*$
```

The key and kind are immutable after creation. Renaming or converting an entry
is an explicit delete-and-create operation, which prevents an edit from
silently changing the meaning of the same organization-owned credential.

Variable values are ordinary configuration and may be read by authorized human
APIs. Secret values are write-only: create and replacement requests accept the
value, but no response, log, audit payload, or error echoes it.

### 3.2 Organization entries take precedence without downgrading secrecy

An assigned organization entry normally wins over a same-key agent entry.
Resolution is by key first, then the surviving entries are separated into the
two existing wire maps:

```ts
const effectiveByKey = new Map([...agentVariables, ...agentSecrets])
for (const entry of assignedOrganizationEntries) effectiveByKey.set(entry.key, entry)

const env = variablesOf(effectiveByKey)
const secrets = secretsOf(effectiveByKey)
```

There is one security exception: an organization **variable cannot override an
agent secret**. That transition would move the effective key from the
write-only `secrets` map into the ordinary `env` map. Creating such an
assignment, enrolling an agent into an `all` entry, or adding such an agent-local
secret while the organization variable is assigned is rejected. The operator
must first remove or rename one side. An organization secret may override either
kind, and an organization variable may override an agent variable.

This is deliberately stronger than relying on the daemon's existing
"secrets win over variables" merge. An organization owner assigning `API_KEY`
gets one deterministic result without silently downgrading an existing secret's
classification.

Permitted conflicting agent entries are preserved, not deleted. They are
inactive while the organization entry is assigned and become effective again
if that assignment or organization entry is removed. The agent UI marks such
local rows **Overridden by Organization**. Same-kind fallbacks and an agent
variable beneath an organization secret may retain the same name; the prohibited
agent-secret/organization-variable combination is rejected instead.

### 3.3 Full snapshots remove stale values

`AgentSpec.env` and `AgentSpec.secrets` remain complete resolved maps and are
always emitted, including `{}`. Removing an assignment, deleting an entry, or
changing its kind through delete-and-create therefore clears the prior value
from the daemon instead of relying on a separate remove frame.

Every full snapshot carries the agent's monotonic `configRevision`. A daemon
persists the greatest revision it has applied and refuses an older snapshot, so
full-map removal semantics remain safe when concurrent publishers finish in a
different order.

Because the daemon also refuses an EQUAL revision carrying different content
(section 7), `configRevision` must cover every input the assembled spec is built
from — not only the agent row. `AgentSpec.skills` and `AgentSpec.managedSkills`
are resolved from the shared skill-source registry and the managed-skill bundle
revisions, so a skill-source edit, a managed-skill archive or restore, and an
accepted bundle revision each bump the referring agents in the same transaction
as the change. Omitting any of them would not merely delay convergence: the
daemon would see new content at a revision it has already applied, refuse it as
an invariant violation, and repeat that refusal on every reconnect until an
unrelated agent edit happened to move the revision.

### 3.4 `all` is an authorized enrollment policy

Every effective assignment is represented by an explicit agent binding. An
owner may create one only when the same request is authorized for
`resource.edit` on the target agent. The binding is a durable delegation: once
an authorized agent editor enrolls the agent, organization environment managers
may rotate the entry without gaining visibility into that agent.

`all` is an automatic-enrollment policy, not an authorization bypass. When an
owner chooses it, the transaction creates bindings for every agent the actor may
edit and does not enumerate or change inaccessible restricted agents. Agent
create and later agent-configuration writes also enroll that agent into current
`all` entries in the same transaction, because the actor is already authorized
to edit the target and the Console shows the organization entries that will
apply. `selected` creates only explicitly requested authorized bindings and may
contain zero agents while an owner stages an entry.

Switching `selected` to `all` adds every currently authorized binding and keeps
existing delegated bindings. Switching `all` to `selected` stops future
automatic enrollment; it does not silently revoke bindings to private agents
the actor cannot see. Visible bindings are then edited incrementally.

Deleting an agent cascades its organization-environment bindings. Moving an
agent between daemons does not affect assignments because they are anchored to
the stable agent ID. Agents cannot move between organizations.

## 4. Authorization and visibility

In the current OSS role vocabulary, "organization admin" means a membership
with role `owner` and the `organization.manage` action.

| Operation                                                  | Required authorization                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------ |
| List organization entries in Settings                      | `organization.manage`                                        |
| Create, replace, retarget, or delete an organization entry | `organization.manage`                                        |
| Add or remove one selected-agent binding                   | `organization.manage` plus `resource.edit` for that agent    |
| Auto-enroll one agent into current `all` entries           | existing `resource.edit` on that agent                       |
| See assigned organization rows on an agent                 | normal `resource.view` for that agent                        |
| Edit an agent-local variable or secret                     | existing `resource.edit`; organization rows remain immutable |

Organization ownership must not become a restricted-agent governance or
discovery bypass. Both the `all` enrollment query and selected-agent picker use
the normal `resource.edit` policy; merely being an owner never creates the first
binding to another member's unshared restricted agent. Point assignment requests
for an invisible, non-editable, or foreign agent return the existing
not-found-shaped response.

Every check that runs BEFORE that authorization decision must be non-disclosing,
including the daemon-compatibility preflight. A preflight that inspected all
agents in the organization could answer a guessed restricted agent id with a
conflict naming it, proving both its existence and its name where a not-found was
intended. So a preflight over caller-supplied ids examines only agents the caller
may edit and leaves the rest to the authorization decision, while a preflight over
already-bound agents — where the delegation exists and the write genuinely reaches
them — covers them all but describes an agent the caller cannot view without
naming it.

An authorized binding is the target-level grant that lets future
`organization.manage` operations rotate or delete the bound entry without
granting organization owners visibility into the agent. This delegation is
limited to that exact entry and agent; it does not confer general agent edit or
discovery rights. Creating the binding, changing its target, or re-enrolling a
previously unbound agent always requires a fresh `resource.edit` decision.

Selected bindings are edited as per-agent add/remove commands, not by replacing
one returned array. A Settings response returns only bindings whose agents the
caller can view. Bindings to other restricted agents, if any, are neither
returned nor removed when the owner edits the visible selection. The UI always
explains, without revealing whether hidden bindings exist, that only agents the
viewer can access are listed and other private-agent assignments are unchanged.

Changing `selected` to `all` materializes every newly authorized binding and
retains prior delegated bindings. Changing `all` to `selected` disables future
auto-enrollment and changes only the caller-visible binding deltas submitted
with that operation. Deleting the organization entry exercises the authority
already delegated by each binding and removes the known configuration globally;
it does not disclose the agents that were receiving it.

Human agent DTOs expose only organization entries assigned to that particular
agent. Thus a member who can view agent A may see A's organization variable
values and organization secret key names, but learns nothing about entries
assigned only to agent B. Secret values remain unreadable to every human role,
including owners.

## 5. Persistence and secret-store seams

The metadata and secret value are structurally separated, matching the current
`Agent` / `AgentSecret` discipline:

```prisma
enum OrganizationEnvironmentKind {
  variable
  secret
}

enum OrganizationEnvironmentAudience {
  all
  selected
}

model OrganizationEnvironmentEntry {
  id                   String                          @id @default(uuid()) @db.Uuid
  orgId                String
  key                  String
  kind                 OrganizationEnvironmentKind
  variableValue        String?                         // non-null only for variable
  audience             OrganizationEnvironmentAudience
  version              Int                             @default(1)
  createdByUserId      String?
  lastModifiedByUserId String?
  createdAt            DateTime                        @default(now()) @db.Timestamptz(6)
  updatedAt            DateTime                        @updatedAt @db.Timestamptz(6)

  org         Org                                 @relation(fields: [orgId], references: [id], onDelete: Cascade)
  secret      OrganizationEnvironmentSecret?
  assignments OrganizationEnvironmentAssignment[]

  @@unique([orgId, key])
  @@unique([id, orgId])
  @@index([orgId, audience])
  @@map("organization_environment_entry")
}

model OrganizationEnvironmentSecret {
  entryId   String   @id @db.Uuid
  value     String   // always passes through SecretCipher
  updatedAt DateTime @updatedAt @db.Timestamptz(6)

  entry OrganizationEnvironmentEntry @relation(fields: [entryId], references: [id], onDelete: Cascade)

  @@map("organization_environment_secret")
}

model OrganizationEnvironmentAssignment {
  orgId             String
  entryId           String   @db.Uuid
  agentId           String   @db.Uuid
  authorizedByUserId String?  // actor whose resource.edit decision created the delegation
  createdAt         DateTime @default(now()) @db.Timestamptz(6)

  entry OrganizationEnvironmentEntry @relation(fields: [entryId, orgId], references: [id, orgId], onDelete: Cascade)
  agent Agent                        @relation(fields: [agentId, orgId], references: [id, orgId], onDelete: Cascade)

  @@id([entryId, agentId])
  @@index([orgId, agentId])
  @@map("organization_environment_assignment")
}

model Agent {
  // Existing fields...
  configRevision BigInt @default(0) // monotonic revision of the fully resolved AgentSpec

  organizationEnvironmentAssignments OrganizationEnvironmentAssignment[]

  @@unique([id, orgId])
}
```

The migration adds the composite `Agent` uniqueness needed by the
same-organization assignment foreign key. That database constraint makes a
cross-organization binding impossible even for an internal caller.

`configRevision` is not environment-specific. Every durable mutation that can
change a CP-owned field assembled into `AgentSpec` increments it through the
same writer, including ordinary agent edits and organization-derived changes.
This gives one ordering domain per agent instead of competing revisions for
different feature areas.

`OrganizationEnvironmentSecretStore` is the only value-reading seam for
organization secrets. It receives the same mandatory `SecretCipher` instance
as `AgentSecretStore`; `seal` happens before a transaction and the transaction
persists only the prepared stored representation. Metadata list and human DTO
queries never join the secret table. Rewrap convergence adds this table to the
existing secret-table sweep.

Create, secret replacement, audience change, and bindings update the metadata,
secret row, and assignments atomically. PATCH includes `expectedVersion`; a
competing edit to that entry returns `409` rather than losing a secret rotation
or audience change. Secret sealing that finishes before a losing transaction is
discarded and is never logged.

`expectedVersion` is only an editor-conflict check. Correct admission uses the
organization and agent rows as transaction-time fences:

1. Every organization-environment writer, and agent **create**, first locks the
   parent `Org` row `FOR UPDATE`; this serializes entry-set/enrollment changes
   with agent creation. After that lock, determine the authoritative affected
   agent IDs and current `all` enrollment work.
2. Lock the affected `Agent` rows `FOR UPDATE` in stable ID order.
3. Re-read all local env/secret names, assigned organization metadata and secret
   values, and the candidate mutation while the locks are held.
4. Resolve each complete `AgentSpec`, enforce the cross-kind rule in section
   3.2, and measure it against the exact wire admission budget.
5. Persist the entry/binding/local-agent mutation and increment every affected
   agent's `configRevision` in that same transaction.

Agent **PATCH** joins this fence at step 2 and deliberately does not take the
`Org` row. It affects exactly one agent and the admission budget is per-agent, so
the agent row is already the sufficient serialization point: two PATCHes to one
agent serialize on it, and a PATCH racing an organization-environment writer
serializes on it too, because every such writer locks the agent rows it affects.
Whichever transaction commits second re-reads the other's committed state and is
refused, which is what makes the cross-kind rule enforceable from both write
directions. Taking the `Org` row here would instead serialize every agent edit in
the organization behind one another for no admission benefit. Agent create is the
exception because its row does not exist yet, so a concurrent `all` enrollment
scan cannot see it.

Concurrent updates to different entries, bindings, or agent-local configuration
that affect one agent therefore serialize before final validation; they cannot
each validate against an obsolete partial state and jointly exceed
`MAX_FRAME_BYTES` after persistence.

The resulting lock order is one chain for every writer that touches agent
configuration:

```text
skill-source name scopes → Org row (create / entry writers) → Agent rows (ascending id)
```

The skill-source advisory scopes come first because a skill-source sharing write
holds them and then takes `FOR KEY SHARE` on the same `Org` row; acquiring the
`Org` row ahead of them would put those two writers in a cycle.

Repository reads have two explicit shapes:

- a human metadata read, which may include `variableValue` but never opens the
  secret row; and
- an internal effective-config read, which resolves assignments and opens only
  the secrets needed for the requested agent or agent batch.

## 6. HTTP API

All routes are organization-scoped, use the existing org-scope guard, and must
include OpenAPI tags, summary, description, and a unique `operationId`.

```text
GET    /api/v1/orgs/:orgId/environment
POST   /api/v1/orgs/:orgId/environment
PATCH  /api/v1/orgs/:orgId/environment/:entryId
DELETE /api/v1/orgs/:orgId/environment/:entryId

PUT    /api/v1/orgs/:orgId/environment/:entryId/agents/:agentId
DELETE /api/v1/orgs/:orgId/environment/:entryId/agents/:agentId
```

Create accepts:

```ts
{
  key: string
  kind: 'variable' | 'secret'
  value: string
  audience: 'all' | 'selected'
  agentIds?: string[] // initial resource-edit-authorized selection; selected only
}
```

PATCH accepts `expectedVersion`, an optional replacement `value`, and an
optional `audience`. Audience transitions follow section 3.4: switching to
`all` enrolls every agent the actor may edit, while switching to `selected`
stops automatic enrollment and retains existing bindings. Visible selected
bindings are edited through the per-agent idempotent endpoints, so concurrent
owners adding different authorized agents do not overwrite one another or any
invisible delegated binding.

The list DTO is metadata-only:

```ts
{
  id: string
  key: string
  kind: 'variable' | 'secret'
  variableValue?: string       // present only for variables
  secretConfigured?: boolean   // present only for secrets, never its value
  audience: 'all' | 'selected'
  visibleAgentIds: string[]    // caller-visible explicit bindings only
  version: number
  createdAt: string
  updatedAt: string
}[]
```

PATCH can replace a variable value, replace a secret value, or change audience;
an omitted value leaves it unchanged. It cannot change `key` or `kind`. Empty
strings retain the same validity semantics as existing agent variables and
secrets. The two agent-binding endpoints are valid only while the entry has
`selected` audience and are idempotent. Both require `resource.edit`, not only
`resource.view`, on the target. Cross-kind conflicts return a non-value-bearing
`409`; an `all` enrollment failure never names an otherwise invisible agent.

Agent create/PATCH request bodies remain agent-local. Agent response DTOs retain
the existing `env` and `secretKeys` meanings and add assigned-source fields:

```ts
{
  // Existing, agent-owned fields:
  env: Record<string, string>
  secretKeys: string[]

  // New, effective organization-owned rows assigned to this agent:
  organizationVariables: Array<{ key: string; value: string }>
  organizationSecretKeys: string[]
}
```

The agent DTO path resolves metadata and key names only; it never decrypts an
organization secret. List-agent endpoints use a batch resolver so this does not
become one query per agent.

Input limits use shared env/secret constants and the existing wire-frame budget.
Both organization mutations and agent-local mutations validate the resulting
effective configuration for every directly affected agent. A mutation that
would make an individual resolved `AgentSpec` exceed admission limits is
rejected before persistence rather than producing an unreconcilable agent. This
validation runs under the agent-row locks from section 5, not against a
pre-transaction snapshot.

That measurement is of ENCODED bytes, not raw lengths. JSON escaping is not a
rounding error — a value of quotes doubles and control characters expand six-fold
as `\uXXXX`, so a raw-length counter admits payloads whose encoded frame is
multiples of the ceiling. Values held in memory are measured with the same
serializer the frame uses; a stored value is measured Postgres-side
(`octet_length(to_json(value)::text)`) so its size is known without returning it
and without opening a cipher inside the transaction. The budget also reserves for
what the fence cannot read from those rows — the envelope, the spec's scalar
fields, and the resolved `managedSkills` entries, which expand from the stored
ids. Under an encrypting secret provider the stored measurement is of ciphertext
and therefore approximate; the reserve absorbs ordinary divergence, and opening
values under the transaction is deliberately not done because a transaction must
never wait on a cipher.

Being conservative is the safe direction, but it must not become systematic
over-counting: a fence that refuses configurations the wire carries comfortably is
its own defect. Two specific traps, both of which reject valid writes:

- the agent's `runtimeOverrides` bag CONTAINS `env`, so measuring the whole bag
  while also counting each effective variable charges every local variable twice;
  the bag is measured with `env` removed; and
- an agent must be charged only for the skill sources its own enable-list resolves
  through, never the organization's whole registry — otherwise unrelated source
  metadata accumulates until no agent or environment write can pass at all.

A retarget that omits a replacement value still counts the STORED value, since
that value is what the newly enrolled agents receive.

## 7. Resolution and distribution

`AgentSpecAssembler` gains an injected `OrganizationEnvironmentResolver` and is
still the single producer of CP-to-daemon agent specs:

```ts
interface OrganizationEnvironmentResolver {
  forAgent(orgId: string, agentId: string): Promise<OrganizationEnvironmentValues>
  forAgents(orgId: string, agentIds: readonly string[]): Promise<Map<string, OrganizationEnvironmentValues>>
}
```

The assembler loads agent-local secrets, resolves assigned organization
entries, applies the precedence rule from section 3.2, and emits the same
`AgentSpec.env` and `AgentSpec.secrets` fields used today. It reads the agent,
assignments, values, and `configRevision` from one repeatable database snapshot;
a concurrent writer either appears wholly in that revision or wholly in the
next one. There is no organization-environment registry or runtime lookup on the
daemon.

`AgentSpec` adds one optional rolling-upgrade field, encoded as a decimal string
so JavaScript never rounds it:

```ts
configRevision: z.string()
  .regex(/^(0|[1-9][0-9]*)$/)
  .optional()
```

The CP includes it in `agent/upsert`, `register/ok` roster entries, and
`agent/activate`. The daemon persists the greatest applied revision and a digest
of that revision's CP-owned spec beside `agent.json`:

- a greater revision is applied normally;
- an equal revision with the same digest is an idempotent retry;
- an equal revision with a different digest is rejected as an invariant
  violation; and
- a lower revision is acknowledged as a stale no-op and never reaches
  `writeAgentSpec`.

The CP also coalesces live projection work per agent so ordinary bursts assemble
only the newest pending revision, but that is a load optimization. The persisted
daemon comparison is the correctness boundary across slow assembly, multiple CP
publishers, retries, and reconnects.

An organization-entry mutation computes the union of bindings affected before
and after the transaction:

- `all`: the existing bindings plus newly enrolled agents that passed
  `resource.edit` for the actor;
- `selected`: the old and new bound agent IDs; and
- audience transitions: the union of both interpretations.

After commit, the Control Plane sends the normal full `agent/upsert` to each
affected online daemon. Unplaced agents need no event. Offline daemons receive
the latest resolved maps through the normal `register/ok` roster on reconnect.
Fan-out is best-effort after durable commit and uses the same reconnect backstop
as an ordinary agent edit. An older fan-out that completes later is harmless
because its lower `configRevision` cannot overwrite a newer daemon snapshot.

Agent moves snapshot `effectiveEnv`, `effectiveSecrets`, and `configRevision`,
not only the local agent fields. Move fingerprint stability re-resolves
organization assignments before activation, so an entry rotation or audience
change racing a move causes the move bundle to replay instead of activating
stale credentials on the target. The target daemon independently enforces the
same revision.

On the daemon, an env or secret change already participates in the host-spawn
signature. Reconciliation persists the new full maps and replaces the host
according to the existing background-task-aware lifecycle. An in-flight process
is not mutated. Consequently, deletion or rotation prevents future hosts from
receiving the old value, but cannot claw a value out of a process that has not
yet reached its safe replacement point. The Console warning for deletion and
rotation states this explicitly.

## 8. Console behavior

### 8.1 Organization Settings

Settings adds a **Variables & secrets** card near the other organization-wide
agent policies. Only owners see the registry and its controls.

Each row shows:

- the key;
- **Variable** or **Secret**;
- the variable value, or a fixed mask for a secret;
- **All agents** or **Selected agents**; and
- edit and delete actions.

The add/edit sheet collects key, kind, value, and audience. A saved secret shows a
mask plus an explicit **Replace value** action rather than an empty editable field:
an empty field cannot mean "keep the current value", because the empty string is
itself a value the API accepts, and inferring intent from the field's content would
make it impossible to set. Once replace is chosen, whatever the field contains —
including the empty string — is what gets sent, and a **Keep the current value
instead** link backs out. For the same reason the sheet validates only the KEY:
the Console must not make an API-valid entry unreachable, so an empty value is
accepted on create as well as on rotation. The selected-agent picker uses the
caller's
`resource.edit`-filtered agent list and edits bindings incrementally. Its
standing help text says: "Only agents you can manage are shown. Existing
assignments to other private agents are left unchanged."

The **All agents** option explains that it enrolls every agent the actor can
currently manage and automatically enrolls an agent on later authorized agent
configuration writes; it never reaches an inaccessible private agent merely
because the actor is an organization owner. A variable-to-agent-secret conflict
is shown as a blocking error, not a confirmation that could accidentally
downgrade a write-only key.

Switching to **All agents**, deleting an entry, and rotating a secret use a
confirmation that describes the affected runtime behavior. The UI never claims
that a running process has already discarded an old value.

### 8.2 Agent Variables and Secrets

The agent detail page keeps its existing Variables and Secrets cards and renders
one combined list in each:

- agent-owned rows keep their current appearance and edit path;
- assigned organization rows carry an **Organization** badge;
- organization variable values are visible and read-only;
- organization secret values remain masked and only the key is returned; and
- no organization row has edit, replace, or remove controls.

The cards' counts include both sources. The header **Edit** action continues to
open the agent editor, where organization rows appear in a separate read-only
**From organization** group above the editable agent-owned rows. Owners get a
link to Organization Settings; other members get explanatory text only.

When a local row has the same key as an assigned organization row, the local row
is retained in the editor with **Overridden by Organization** and the
organization row is the one shown as effective on the detail card. Removing the
assignment later makes the local row active without requiring its value to be
entered again.

The responsive page uses the existing single Variables/Secrets tree with mobile
and desktop utility variants; this feature does not introduce a form-factor-only
behavior fork.

## 9. Failure handling and observability

- Secret-cipher failure rejects the write before persistence and never includes
  plaintext or ciphertext in the response.
- A missing secret value row is an invalid entry. Human metadata may show the
  entry as not configured to an owner. Internal resolution still emits the
  assigned key as a reserved/tombstoned key: it removes that key from both
  effective wire maps, thereby suppressing any same-key agent fallback, while
  recording an ID/key-only error. It never treats missing secret material as if
  the organization assignment were absent. Unrelated entries continue to
  resolve normally.
- A historical organization-variable/agent-secret collision is also resolved
  as a tombstoned key and reported without values. It can never downgrade the
  key while an operator repairs the invalid binding.
- A binding whose agent was deleted disappears by cascade. A foreign
  organization binding is prevented by the composite foreign keys.
- If live `agent/upsert` fails, the durable entry remains authoritative and the
  daemon reconnect roster repairs it.
- Logs may include organization ID, entry ID, key, kind, audience, entry version,
  agent config revision, and affected-agent count. They must never include
  variable values in bulk fan-out logs or any secret value.
- Metrics count CRUD outcomes, conflict responses, fan-out attempts/failures,
  and resolver failures without value-bearing labels.

## 10. Rollout and verification

The database migration is additive. Existing agents have no organization
assignments, so their effective env/secret maps are unchanged. The protocol
addition is optional for decoding but required for this feature's ordering
guarantee, so rollout is daemon-first:

1. Deploy protocol readers and daemons that persist `configRevision`, enforce
   the monotonic comparison, and advertise `agent-config-revision-v1`.
2. Deploy the CP schema/writers and begin attaching revisions to every CP-owned
   agent projection.
3. Enable an organization-environment write only when every retained or newly
   affected placed agent is on a compatible daemon. An unplaced bound agent may
   be saved, but placement then requires the same daemon feature.
4. Enable the Settings UI after the API capability is available.

Old daemons may ignore the optional field, but the feature never relies on that
behavior: a bound agent cannot continue on or move to one. This gate closes the
rolling-upgrade interval in which an older full snapshot could otherwise win.

Focused verification covers:

- owner-only registry access and ordinary agent-view access to assigned rows;
- no restricted-agent discovery or first-time mutation through lists, `all`
  enrollment, point binding requests, counts, or replacement-style selection
  updates; plus rotation through an already-authorized durable binding;
- materialized `all`, empty `selected`, selected add/remove, authorized new-agent
  enrollment, agent deletion, and audience transitions;
- organization-over-agent precedence for the three permitted variable/secret
  collision combinations, rejection of organization-variable/agent-secret
  downgrade attempts from both write directions, and fallback restoration after
  unassignment;
- secret write-only DTOs, cipher sealing/opening, rollback, rewrap, logs, and
  OpenAPI examples containing no stored value;
- transaction-time agent locks under concurrent entry, binding, and local-agent
  mutations that would jointly exceed the frame budget;
- batch agent DTO resolution without secret decryption;
- full-map replication on create, rotate, retarget, delete, reconnect, and agent
  move races; deliberately reordered delivery; equal-revision digest mismatch;
  and daemon feature gating;
- missing organization-secret material suppressing, rather than reactivating, a
  same-key local fallback;
- host replacement and stale-value removal while an in-flight/background task
  follows the existing safe-reclaim behavior; and
- one responsive Console tree with Organization badges and no edit affordance
  on inherited rows.
