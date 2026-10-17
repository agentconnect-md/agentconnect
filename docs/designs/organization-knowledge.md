# Organization Knowledge and Dream Suggestions

> **Status:** Implemented, with one revision being built (2026-10-17): agent visibility on every
> entry and the organization record, §15, decided in
> [assistant-mode.md](assistant-mode.md) §5.16. Its Control Plane and daemon sides shipped on
> 2026-10-18 (assistant-mode.md §5.16 "As shipped, change 1" and "change 2"); the console's is to
> come.
>
> **Scope:** protocol, control plane, daemon, and web console
>
> **Related:** [memory-dreaming.md](memory-dreaming.md),
> [shared-skills.md](shared-skills.md),
> [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md),
> [assistant-mode.md](assistant-mode.md) §5.15–§5.17,
> [resource-visibility.md](resource-visibility.md) §11

## 1. Problem

Managed memory is deliberately scoped to one agent. Dreaming can consolidate
that memory and propose agent-local skills, but it cannot currently preserve a
fact, runbook, or reusable procedure for the whole organization. Operators also
have no review queue in which to decide which model-mined material becomes
shared organization context.

This design adds two centrally approved artifact kinds:

- **Organization knowledge** — immutable revisions of approved Markdown that
  every agent in the organization can find on demand.
- **Managed organization skills** — immutable, digest-addressed Agent Skills
  bundles that an owner can approve and then explicitly enable for selected
  agents.

Dream remains a proposal engine. It may stage candidates but can never publish
organization content or enable a skill.

## 2. Product contract

The console gains a separate top-level **Knowledge** destination at
`/[slug]/knowledge`, beside Tools & Skills. Since the 2026-10-17 revision the
page has two groups (§15.5): **Handbook** first, the organization record's
three entries under a status line, and **Library** below it, which is the
Library and Suggestions described here, Suggestions staying a tab inside it. Every row in both groups has a
visibility cell saying which agents read the entry.

The **Library** lists accepted knowledge, with archived entries on request. A
row shows title, summary, tags, current revision, the last update and the
visibility cell, and opens the entry page at `/[slug]/knowledge/[id]`. The
entry page renders the current immutable Markdown with its provenance — source,
proposing agent,
author or reviewer, date — and lists every revision beside it; selecting an
older revision renders it in place while the entry keeps pointing at the
current one. Owners publish new entries from the library and publish new
revisions, archive, and restore from the entry page. Editing always creates a
new immutable revision. Internal identifiers (digests, Dream and session ids)
are not shown.

**Suggestions** is an owner-only tab that lists Dream candidates by review
state, with the pending count on the tab. Each row shows its title or skill
name, the proposing agent, source-session count, creation time, and whether it
updates an existing artifact. Opening a pending row is the inspection: the body
— rendered Markdown or the complete file tree — is fetched from the source
daemon the moment the row opens, never for rows nobody opens, and the two
decisions sit beside it in the opened row rather than on the list. Acceptance
carries the token that the fetch mints (§7.3), so `Accept` stays disabled until
the complete body has rendered; opening a row is not a decision, so a stray
second click on it only closes the row. Rejecting needs no body: it installs
nothing, so it is available as soon as the row opens. A reviewed row keeps one
line of outcome: the accepted revision, with the row linking to its entry, or
the rejection and its reason. Rejected items remain in history.

Managed organization skills appear in the existing **Skills library** card on
Tools & Skills, alongside Git-backed sources. A managed tile is labeled as an
immutable managed bundle; opening it loads the revision history and shows the
selected bundle's manifest, sizes, digest, and provenance. Knowledge/Organization
contains organization knowledge only.
Pending skill candidates remain reviewable from Knowledge/Suggestions;
accepted bundles are never enabled automatically. An agent editor must select
each managed skill explicitly.

Authorization is intentionally simple:

- every organization member may read accepted knowledge and managed-skill
  metadata;
- owners alone may create, edit, accept, reject, archive, or restore an
  organization artifact, and alone set which agents read an entry (§15.1);
- agents have a read-only knowledge discovery tool, which returns only the
  entries the calling agent may read; there is no agent publish tool. The one
  exception is the organization record (§15.2): its three entries are written
  directly by the organization's assistant-mode agents through their memory
  tools, under rules the daemon enforces, and by nothing else.

## 3. Core invariants

1. **Pending bodies stay at their source daemon.** PostgreSQL stores the bounded
   suggestion index and terminal review state, not the unapproved body. If the
   source daemon is offline, metadata remains visible but content and acceptance
   report a clear unavailable state.
2. **Approved artifacts are central product content.** Knowledge Markdown and
   bounded `.skill` ZIP revisions are stored in PostgreSQL. This is an explicit
   exception to the historical metadata-only rule; message, transcript, and
   agent-memory bodies remain daemon-local.
3. **Revisions are immutable.** A logical artifact points at its current
   revision. An update accepts only against the exact revision shown to Dream or
   the editor; stale updates fail with a conflict.
4. **The daemon and authenticated connection establish scope.** A model never
   supplies an organization or agent ID. The daemon injects the current agent ID
   and the control plane proves the agent is placed on that authenticated daemon
   before searching, syncing, or serving a bundle.
5. **No automatic prompt injection.** Version one exposes on-demand
   `findKnowledge`; it does not copy the whole library to every daemon or consume
   the agent's standing context budget. The one exception is the organization
   record for an assistant-mode agent, which keeps the three index lines it had
   when the record was in its memory (§15.4); no other entry and no other agent
   gets standing context from knowledge.
6. **No automatic skill activation.** Approval only creates a managed skill.
   Per-agent enablement is a separate human action.
7. **An entry is read by the agents it is visible to.** `all` or a `selected`
   list of agents (§15.1); the Control Plane filters every agent read by the
   requesting agent it has proved, and the People entry is further withheld in
   conversations with outsiders by the daemon, which alone knows a
   conversation's audience (§15.3).

## 4. Structured Dream output

The new Dream JSON contract names every output class explicitly:

```json
{
  "agentMemory": {
    "index": "# Memory\n...",
    "files": [{ "path": "deploys.md", "content": "..." }]
  },
  "agentSkills": [
    {
      "name": "safe-deploy",
      "description": "Deploy with the organization guardrails",
      "files": [
        { "path": "SKILL.md", "content": "---\nname: safe-deploy\ndescription: ...\n---\n..." },
        { "path": "scripts/deploy.sh", "content": "#!/bin/sh\n..." }
      ],
      "sessionIds": ["s1", "s2"]
    }
  ],
  "organizationKnowledge": [
    {
      "operation": "create",
      "title": "Release process",
      "content": "# Release process\n...",
      "summary": "How production releases are cut",
      "tags": ["release"],
      "sessionIds": ["s1"]
    },
    {
      "operation": "update",
      "targetId": "0af...",
      "targetRevision": 3,
      "title": "Release process",
      "content": "# Release process\n...",
      "summary": "Updated rollback step",
      "tags": ["release"],
      "sessionIds": ["s2"]
    }
  ],
  "organizationSkills": [
    {
      "operation": "create",
      "name": "release-service",
      "description": "Release a service safely",
      "files": [
        { "path": "SKILL.md", "content": "---\nname: release-service\ndescription: ...\n---\n..." },
        { "path": "references/runbook.md", "content": "..." }
      ],
      "sessionIds": ["s1", "s2"]
    },
    {
      "operation": "update",
      "targetId": "7c1...",
      "targetRevision": 2,
      "name": "release-service",
      "files": [{ "path": "SKILL.md", "content": "---\nname: release-service\ndescription: ...\n---\n..." }],
      "sessionIds": ["s3", "s4"]
    }
  ]
}
```

The parser temporarily accepts the prior `{index, files, skills}` shape and
maps it to `agentMemory` plus `agentSkills`; its organization arrays are empty.
All new prompts demand the explicit shape.

Validation rules:

- candidate IDs are daemon-generated UUIDs; model IDs are never authoritative;
- an organization knowledge candidate cites at least one actually mined
  session; a skill continues to require two distinct mined sessions;
- a knowledge update target is accepted only when its ID and revision appeared
  in the trusted organization context supplied to this Dream, and is never one
  of the organization record's entries (§15.2), which are written directly; a
  skill update additionally requires the exact unchanged name from the agent's
  CP-authored managed-skill binding;
- organization candidate bodies pass existing secret masking and byte limits;
- organization knowledge excludes personal preferences, one-off task progress,
  credentials, host-specific details, and agent-local instructions;
- organization artifacts are independent review units and are never covered by
  memory auto-adopt.
- agent-local skills remain one-frame review units: UTF-8 `SKILL.md` plus at
  most four flat UTF-8 `scripts/<name>` files, each at most 16,000 bytes. They
  cannot contain references, assets, nested scripts, or binary content;
  organization skills use the chunked full-tree format below.

## 5. Agent Skills bundle format

Managed skills follow Anthropic's open-source
[`skills/skill-creator`](https://github.com/anthropics/skills/tree/main/skills/skill-creator)
and the [Agent Skills specification](https://agentskills.io/specification): a
skill is a directory whose required `SKILL.md` carries YAML frontmatter, with
optional `scripts/`, `references/`, `assets/`, or other files. A distributable
`.skill` file is a ZIP containing that one root directory.

Dream-authored organization candidates contain UTF-8 text by default and may use canonical
base64 for genuine binary assets. The model proposes the complete relative
tree, including `SKILL.md`; the daemon does not collapse it to a prompt plus a
special scripts array. The acceptance service validates the tree, builds a
deterministic ZIP, and stores its SHA-256 digest.

The reference validator checks manifest shape but is not an archive security
boundary. AgentConnect additionally rejects:

- absolute paths, `..`, `.`, empty components, NULs, backslashes, duplicate
  normalized paths, case-colliding paths, and file/directory ancestor
  collisions;
- symlinks, hard links, devices, sockets, FIFOs, encrypted entries, and nested
  archive expansion;
- more than 64 files, a compressed bundle over 512 KiB, an expanded bundle over
  4 MiB, an individual file over 512 KiB, or a suspicious compression ratio
  measured against compressed entry payload bytes on both trust boundaries;
- a root directory/frontmatter `name` mismatch, invalid manifest frontmatter,
  invalid UTF-8 `SKILL.md`, or malformed/non-canonical base64.

The accepted revision stores the canonical ZIP, its compressed and expanded
sizes, file count, manifest name/description, and digest. The daemon repeats
safe extraction and digest verification before caching or installing it.

## 6. Organization context during Dream

Before an extraction session starts, the daemon issues a bounded
`knowledge/search` request using transcript-derived terms. The control plane:

1. finds the authenticated daemon's organization;
2. verifies the trusted requesting agent is currently placed on that daemon;
3. searches accepted, active organization knowledge only;
4. returns stable ID, current revision, title, summary, tags, and bounded
   Markdown.

The daemon inserts at most 64 KiB into a separately delimited untrusted-data
block. Extraction still receives no AgentConnect MCP tools. A control-plane
outage is fail-open for agent-memory consolidation: the Dream continues without
organization context. It may propose new organization artifacts, but it cannot
invent a valid update target.

When skill mining is enabled, the daemon also supplies a bounded list of exact
managed-skill ID/name/revision bindings from the current agent's CP-authored
`AgentSpec`. The model may propose a complete replacement tree for one of those
targets, but the parser independently checks the same trusted binding before it
stages an `update`; offline or invented targets are dropped.

## 7. Suggestion lifecycle

### 7.1 Local staging

Each `DreamInfo` gains organization candidate metadata:

```ts
type OrganizationCandidateInfo = {
  candidateId: string
  kind: 'knowledge' | 'skill'
  operation: 'create' | 'update'
  targetId?: string
  targetRevision?: number
  title: string
  summary?: string
  tags?: string[]
  digest: string
  contentBytes: number
  state: 'proposed' | 'accepted' | 'rejected'
  sessionIds: string[]
}
```

Bodies live below:

```text
<agent-root>/memory-dreams/<dreamId>/organization/<candidateId>.json
```

Each JSON body is the validated discriminated union: Markdown plus display
metadata for knowledge, or the complete path-sorted skill file tree for a
skill. Binary file content is canonical base64 inside that bounded JSON.

Adopting or discarding the memory proposal never deletes an unresolved
organization candidate. Local terminal state is retained until the central
decision has converged.

### 7.2 Central index and reconnect convergence

After Dream completion and on every control-plane reconnect, the daemon emits a
bounded full inventory in `knowledge/suggestions/sync`. The control plane
upserts unseen pending metadata only after proving each source agent is placed
on that connection. A stale sync can never regress `accepted` or `rejected`.
The reply returns terminal decisions the daemon must reconcile locally.

Suggestion identity is `(sourceAgentId, dreamId, candidateId)`. The central row
records kind, operation, target fence, display metadata, digest, byte count,
session provenance, source daemon, review state, reviewer/time, and accepted
artifact/revision. It has no candidate body column.

### 7.3 Accept

1. An owner opens a pending suggestion, which inspects it. The control plane
   resolves the source agent's current daemon, requests the body over `knowledge/suggestion/read`,
   validates it, and returns an opaque snapshot token covering body digest,
   metadata, target fence, and provenance.
2. Acceptance submits that exact snapshot token. The route rejects a token that
   no longer matches the current pending row before fetching executable content.
3. The control plane reads the body again and validates identity, kind, digest,
   limits, and the complete review-visible
   metadata against the indexed snapshot (`title`, nullable `summary`, and
   `tags` for knowledge; manifest `name` and `description` for skills).
4. A PostgreSQL transaction locks the suggestion, rechecks `pending`, applies
   the snapshot token again plus the metadata and target-revision fences,
   rejects archived update targets, creates the immutable knowledge or skill
   revision, advances the logical artifact, and marks the suggestion accepted.
5. A best-effort `knowledge/suggestion/review` command marks the local candidate
   accepted. The next sync is the crash/loss backstop.

Concurrent duplicate acceptance has exactly-once side effects: one request
commits and any contender returns 409. A stale update returns 409 and leaves the
suggestion pending for explicit rejection or a fresh Dream.

### 7.4 Reject

Reject records reviewer, time, and an optional bounded reason, then best-effort
converges the local candidate. Central terminal state always wins over a stale
local `proposed` state. Rejection never creates an artifact.

## 8. Persistence

The logical PostgreSQL model is:

```text
OrganizationKnowledge
  id, orgId, title, currentRevision, archivedAt/by, createdAt, updatedAt,
  visibility(all|selected), readers(agent ids), kind(entry|organization|channels|people),
  readersFollowAssistantMode

OrganizationKnowledgeRevision
  knowledgeId, revision, content, summary, tags, digest,
  source(manual|dream|agent|migration), writerKind(research|first-look|conversation|person),
  sourceAgent/Dream/candidate/sessionIds,
  createdByUserId, reviewedByUserId, createdAt

OrganizationPeopleOptOut
  orgId, key, clearedOn

ManagedSkill
  id, orgId, name, description, currentRevision,
  archivedAt/by, createdAt, updatedAt

ManagedSkillRevision
  managedSkillId, revision, archive(bytea), digest,
  compressedBytes, expandedBytes, fileCount, manifest(jsonb),
  source/provenance/audit fields, createdAt

OrganizationSuggestion
  id, orgId, sourceAgentId, sourceDaemonId, dreamId, candidateId,
  kind, operation, targetArtifactId/targetRevision, title, summary, tags,
  digest, contentBytes, sessionIds, state,
  reviewedBy/At/reason, acceptedArtifactId/revision, createdAt, updatedAt
```

`OrganizationKnowledgeRevision` is unique on `(knowledgeId, revision)`;
`ManagedSkillRevision` is unique on `(managedSkillId, revision)`; managed skill
names are unique per organization; suggestion source identity is unique; the
organization record has one entry per `kind` other than `entry` per
organization (§15.2). The visibility columns follow
[resource-visibility.md](resource-visibility.md) §3: `readers` is a
`String[] @default([])` of agent ids, empty under `all`, and gets no composite
index with `visibility`.

PostgreSQL is the v1 bundle store so review state and accepted content commit in
one transaction and an OSS deployment does not require S3. The caps above keep
the binary payload bounded. A future object-store implementation can replace
the revision blob behind the same repository/API without changing agent or web
contracts.

## 9. Search and the agent tool

Every ordinary agent session receives this read-only descriptor:

```ts
findKnowledge({
  query: string,
  limit?: 1..10,
  maxBytes?: 1..32768,
  tags?: string[]
})
```

The daemon fills `requesterAgentId` from the token-bound session context and
issues `knowledge/search`, or `knowledge/list` for the query-less
`listKnowledge`, with `withOutsiders: true` on either when the session's
conversation holds people from outside the organization or its audience is not
yet known (§15.3). The Control Plane answers only with entries the requesting
agent may read, `all` ones and `selected` ones that list it, and leaves the
People entry out when the flag is set. PostgreSQL search uses the `simple`
full-text configuration plus a case-insensitive title/content fallback. Ranking
favors an exact/prefix title match, then full-text rank, then recency. A GIN
expression
index supports the text query. When tags are supplied, an item must contain
every requested tag. Results are clamped as a whole and individually:

```ts
{
  items: [{ id, title, summary, tags, revision, updatedAt, content, truncated }]
}
```

An unavailable control plane becomes an ordinary MCP tool error and does not
fail the surrounding agent turn.

## 10. Managed-skill enablement and retrieval

`Agent` gains a separate `managedSkills: string[]` binding. Existing Git skill
sources remain unchanged. `AgentSpec.managedSkills` carries only immutable
metadata:

```ts
{
  id: string
  name: string
  revision: number
  digest: string
}
;[]
```

Before starting a host, the daemon ensures every enabled revision is in a
daemon-owned canonical cache. It requests `managed-skill/read` chunks (maximum
128 KiB each), assembles the ZIP, verifies size and digest, safely extracts it,
and atomically renames the verified directory into the cache. A matching cached
revision works offline; a missing or changed revision is skipped with a warning
and never blocks the agent from starting.

The verified cache directory is an immutable local source for the unified skill
installer. Git, managed-cache, and accepted agent-local Dream sources all pass
through the exact same isolated audited `skills@1.5.21` CLI; CLI output supplies
the runtime-directory receipt. Managed revisions remain bound to their published
artifact digest. Accepted Dream sources use a digest-addressed bundle plus an
atomic index, are re-hashed before every activation, and carry that expected
digest through the installer's own source snapshot. One daemon-owned ledger
outside the workspace reconciles exact file digests, preserves unowned/manual
files, and removes old-harness or disabled copies. An accepted agent-local Dream
source has final precedence over a managed/Git source that produces the same
CLI-derived path. The canonical managed cache remains for offline reuse and
garbage collection.

## 11. Wire additions

All additions negotiate `organization-knowledge-v1` through daemon features and
`register/ok.serverFeatures`.

| Direction | Request/event                 | Reply                           | Purpose                             |
| --------- | ----------------------------- | ------------------------------- | ----------------------------------- |
| D→C       | `knowledge/search`            | `knowledge/search/ok`           | scoped accepted knowledge search    |
| D→C       | `knowledge/suggestions/sync`  | `knowledge/suggestions/sync/ok` | reconnect-safe metadata convergence |
| C→D       | `knowledge/suggestion/read`   | `knowledge/suggestion/content`  | live pending body read              |
| C→D       | `knowledge/suggestion/review` | `ack`                           | reconcile terminal decision         |
| D→C       | `managed-skill/read`          | `managed-skill/chunk`           | bounded bundle download             |

The 2026-10-17 revision adds `knowledge-record-v1`, advertised by both sides
(§15.6):

| Direction | Request/event            | Reply                                                | Purpose                                                   |
| --------- | ------------------------ | ---------------------------------------------------- | --------------------------------------------------------- |
| D→C       | `knowledge/record/read`  | `knowledge/record/ok`                                | one record entry, its revision and the opt-out keys       |
| D→C       | `knowledge/record/write` | `knowledge/record/ok` or `knowledge/record/conflict` | a revision-checked write of one record entry by an agent  |
| D→C       | `knowledge/search`       | `knowledge/search/ok`                                | gains the optional `withOutsiders` flag under the feature |
| D→C       | `knowledge/list`         | `knowledge/list/ok`                                  | gains the same optional `withOutsiders` flag              |

No frame exceeds the existing 256 KiB limit. Content replies use byte offsets
and authoritative `nextOffset`; the client never derives offsets from a base64
string length.

## 12. HTTP API

Every route is organization-scoped and OpenAPI-tagged. Cross-organization IDs
read as not found.

```text
GET    /api/v1/orgs/:orgId/knowledge
POST   /api/v1/orgs/:orgId/knowledge
GET    /api/v1/orgs/:orgId/knowledge/:id
PATCH  /api/v1/orgs/:orgId/knowledge/:id
GET    /api/v1/orgs/:orgId/knowledge/:id/revisions
POST   /api/v1/orgs/:orgId/knowledge/:id/archive

GET    /api/v1/orgs/:orgId/knowledge/:id/visibility
PUT    /api/v1/orgs/:orgId/knowledge/:id/visibility
GET    /api/v1/orgs/:orgId/knowledge/organization
GET    /api/v1/orgs/:orgId/knowledge/:id/people/mine
PUT    /api/v1/orgs/:orgId/knowledge/:id/people/mine
DELETE /api/v1/orgs/:orgId/knowledge/:id/people/mine
PUT    /api/v1/orgs/:orgId/knowledge/:id/people/:key
DELETE /api/v1/orgs/:orgId/knowledge/:id/people/:key

GET    /api/v1/orgs/:orgId/knowledge-suggestions?kind=&state=&query=
GET    /api/v1/orgs/:orgId/knowledge-suggestions/:id/content
POST   /api/v1/orgs/:orgId/knowledge-suggestions/:id/review

GET    /api/v1/orgs/:orgId/managed-skills
GET    /api/v1/orgs/:orgId/managed-skills/:id
GET    /api/v1/orgs/:orgId/managed-skills/:id/revisions
POST   /api/v1/orgs/:orgId/managed-skills/:id/archive
```

The archive endpoints take `{ archived: boolean }`. Suggestion rejection takes
`{ decision: "reject", reason? }`; acceptance takes
`{ decision: "accept", snapshotToken }`, where the token comes from the content
inspection response. The visibility pair takes and returns
`{ visibility, readers: string[] }` on the sharing routes' pattern
(resource-visibility.md §5.8), owner-only, with `readers` intersected with the
organization's agents; the `organization` route returns the record's status and
its three entries; the `people` routes are described in §15.5, `mine` for the
caller's own card and `:key` for owners. `GET /knowledge` and `GET /knowledge/:id`
carry `visibility`, `readers` and `kind`.

The agent create/update DTO exposes managed-skill IDs and rejects an archived,
missing, or cross-organization ID. Enabling a managed skill for an agent on an
older daemon returns 409 instead of silently writing an unusable binding.
Accepting a new revision or archiving/restoring a skill fans out a refreshed
`AgentSpec` to every currently placed agent that has the skill enabled, so the
daemon converges without waiting for an unrelated agent edit or restart.

## 13. Rolling upgrades

- Older daemons keep the legacy Dream parser and create no organization
  candidates. The control plane sends them no unknown frames.
- A new daemon connected to an older control plane exposes `findKnowledge`, but
  its call returns a clear unavailable error and Dream continues without org
  context.
- Suggestion acceptance requires a currently connected source daemon that
  advertises the feature; otherwise the route returns 503.
- Managed-skill enablement requires the target daemon feature. Existing Git
  sources and agent-local Dream skills are unaffected.
- A daemon without `knowledge-record-v1` keeps the organization record's three
  files in each assistant-mode agent's memory, as before the revision; the
  Control Plane's one-time move (§15.7) runs again for them, so a mixed fleet
  converges once the daemon is upgraded. A new daemon on a Control Plane
  without the feature does the same.
- `assistantOnboarding.research` on the spec is an optional field; an older
  daemon drops it unread and researches as before, and the move absorbs what
  it writes.

## 14. Verification

- **Protocol:** strict schemas, legacy Dream mapping, caps, frame-size checks,
  codec round trips, unknown and stale targets.
- **Dream:** four sections, grounding, trusted update allowlist, malformed JSON
  and nested fences, secrets, tree traversal, duplicate/case-colliding paths,
  body/file/count caps.
- **Daemon store:** independent candidate lifecycle, memory adoption/discard
  interaction, crash recovery, content reads, reconnect inventory, central
  terminal reconciliation.
- **Control plane:** Testcontainers coverage for tenant isolation, owner RBAC,
  immutable revisions, archive/search exclusion, full-text fallback, offline
  pending content, digest mismatch, stale revision, concurrent exactly-once
  acceptance, and monotonic sync.
- **Managed skills:** deterministic ZIP, safe extraction, digest failure,
  traversal/symlink/ZIP bomb rejection, cache hit/miss/update/offline behavior,
  compression-ratio parity, ancestor-collision rejection, collision precedence,
  and disable cleanup.
- **Web:** separate route/nav, both tabs, Markdown safety, loading/empty/error and
  offline states, role-gated controls, accept/reject refresh, responsive layout,
  knowledge and managed-skill revision selectors/provenance, managed skills in
  the Tools & Skills library card alongside Git sources, and the agent picker.
- **The 2026-10-17 revision (§15):** visibility filtering per requesting agent
  and the `withOutsiders` flag on the search and the list; record writes with a stale
  revision, a failed shape, an agent not in assistant mode and an agent not
  placed on the daemon; the switch-on transaction claiming research once under
  concurrency, creating the record once and adding the agent to People's
  readers, and leaving a hand-edited list alone; agent deletion pruning
  `readers`; a dream update targeting a record entry dropped; the one-time move
  from one and from several copies, idempotent, with the opt-out union; the
  console's two groups, the visibility cell and field, the three file views,
  the own card's Edit and Remove and no control on another's card, owner edits
  refused at the failing line, and the agent page's Knowledge and Tools tabs.
- **Repository:** migration from empty and existing PostgreSQL, protocol/daemon/
  control-plane/web tests, typecheck, lint, formatting, production build, and
  desktop/mobile browser smoke.

## 15. Agent visibility and the organization record (2026-10-17 revision)

Decided by the product owner on 2026-10-17 and recorded in
[assistant-mode.md](assistant-mode.md) §5.16, which holds the reasons, the
decisions and the implementation checklist. This section records what changes
in the knowledge system itself. The Control Plane and daemon sides are built; the
console's is not yet.

### 15.1 Entry visibility

Every entry carries `visibility: all | selected` and, under `selected`,
`readers`, a list of agent ids. `all` is every agent of the organization.
Existing entries become `all` when the column is added. Visibility is for
agents: every member still reads the whole Library, and owners alone edit it
and set the readers. The console reuses its per-resource visibility pattern
([resource-visibility.md](resource-visibility.md) §11) with "All agents" and
"Selected agents" in place of Everyone and Selected and the agent picker in
place of the member picker; the control sits in the publish editor and on the
entry page. Deleting an agent removes it from every `readers` list; a `selected`
list left empty stays `selected` and reads "No agents". The two record entries
whose visibility is fixed (below) show "All agents" with no control.

### 15.2 The organization record

Three entries, one set per organization, with a `kind` beside the ordinary
`entry`; the console calls the set the Handbook:

| Kind           | Entry    | Written as        | Visibility                                                              |
| -------------- | -------- | ----------------- | ----------------------------------------------------------------------- |
| `organization` | About    | `organization.md` | `all`, fixed                                                            |
| `channels`     | Channels | `channels.md`     | `all`, fixed                                                            |
| `people`       | People   | `members.md`      | `selected`: the organization's assistant-mode agents, until hand-edited |

They hold what assistant-mode.md §5.15 and §5.17 give the three files, in the
shapes the daemon checks on every write, with every line's source and date, the
people-directory rules and the opt-out. Channels holds purposes only and names
no agent's place files.

**The direct write path.** These three entries, and only these, are written by
agents: the organization's assistant-mode agents write them through the memory
tools they already have (`createMemoryEntry`, `updateMemoryEntry`,
`listMemoryEntries`, `getMemoryEntry`) under the three names in the shared
layer, as organization research, first looks, internal public channels'
sessions on a person's turn, and a person for their own People entry do today.
The daemon resolves the names to the record and issues `knowledge/record/read`
and `knowledge/record/write` (§15.6); the entry's revision is the knowledge
revision, so a stale write is refused with the current entry and the daemon
re-reads and merges as it does for a shared-layer conflict. Every rule the
daemon runs today (the shapes, §5.17's person and builder rules, the opt-out)
runs before the write leaves it. The Control Plane proves the agent is placed on
the daemon and in assistant mode, runs the shape check again, and records the
writer kind (`research`, `first-look`, `conversation`, `person`) and the agent on
the revision as `source: agent`. The shape parser for `organization.md` and
`channels.md` moves to the protocol package beside `members-directory.ts`, so a
console edit is checked the same way. A Dream never updates a record entry: an
update whose target is one is dropped as an invented target is (§6). Every
other entry keeps the suggestion-and-review path.

**People's readers follow assistant mode.** Switching an agent's assistant mode
on adds it to People's `readers` in the same row-locked write that records the
switch; once a person has edited the list by hand, `readersFollowAssistantMode`
is false and the switch no longer touches it. Research runs once per
organization: the write that first switches the mode on in an organization
claims it, creates the three entries with their title lines, and the spec's
`assistantOnboarding.research` tells the daemon whether this agent researches
or reads what exists.

**The opt-out** is kept per organization beside People (`OrganizationPeopleOptOut`:
key and the day it was cleared), never in the entry's text. A record read
returns the keys with the entry; a write carries the keys it marks or lifts.

### 15.3 The People audience rule

People is withheld in a conversation with people from outside the organization,
whatever its visibility: a fixed property of the entry, not a setting, and one
no other entry has. The daemon alone knows a conversation's audience, so it
applies the rule: it leaves People out of the standing injection (§15.4),
refuses `getMemoryEntry` on `members.md` there with one line, and sends
`withOutsiders: true` on `knowledge/search` and `knowledge/list`, which the
Control Plane honours by leaving People out of both. A conversation whose audience is not yet known counts as
one with outsiders. A DM never turns external, so the directory is always read
there.

### 15.4 The standing-injection exception

An assistant-mode agent keeps the standing injection of the three entries it had
when they were files in its memory: one index line each, synthesized by the
daemon from the record into the shared layer's index, with bodies read on
demand through `getMemoryEntry`, People left out where §15.3 says. No other
agent and no other entry gets standing context from knowledge: every other
agent reaches the record through `findKnowledge`, subject to visibility, as it
reaches any entry.

### 15.5 Console

**Knowledge page.** Two groups on one page. **Handbook** first: a group
heading, a status line saying when research finished and which agent ran it
("Researched 17 Oct by Atlas", "Research running since 14:05", or "Not
researched yet"), then three quiet rows with an icon, the entry's name, a
one-line summary, the visibility cell and the last update. **Library** below
it, with the Suggestions tab beside its own on its heading row and the table
under it; Suggestions stays inside the Library group. Every row in both groups has a visibility cell: "All agents", or up to
three agent marks followed by "+N" when there are more, with "N agents" beside
them. There is no "Research again" button anywhere; research is asked for in the
onboarding DM.

**File views**, opened from the Handbook rows in place of the raw Markdown
render. About is rendered by section, each line's source as a chip and
its date, an inferred line dimmed and tagged. Channels is a list with the
platform mark, the name, the purpose and the source chip or the inferred tag.
People is cards: display name, handles, the four fields with their sources. A
person's own card carries Edit and Remove, and Remove is the opt-out; nobody
else's card shows an edit control to them. Organization owners edit any entry in
place and may clear it; every save is shape-checked in the Control Plane and
refused at the failing line; owner edits and clears of People are audited
without content. Revisions are listed beside the view as on any entry page.
The `people` routes (§12): `mine` reads, replaces and removes only the caller's
own entry, matched by their console key and the chat identities they linked;
`:key` is owner-only. The agent Memory page's own-entry and directory routes and
the `memory/member/clear` frame are retired with the move.

**Agent page.** The "Tools & Skills" tab splits into **Knowledge**, with two
groups, Handbook (the three entries, whether this agent reads each, and a
link to the Knowledge page) and Library (the entries this agent reads), and
**Tools**, which keeps everything else. The Memory tab lists only the agent's
own memory and does not mention the record.

### 15.6 Wire

`knowledge-record-v1`, advertised by both sides (§11):

- `knowledge/record/read { agentId, file }` → `knowledge/record/ok { id, revision, content, optOut: string[] }`;
- `knowledge/record/write { agentId, file, baseRevision, content, writerKind, optOut: { mark: string[], lift: string[] } }`
  → `knowledge/record/ok { id, revision }`, or `knowledge/record/conflict` with the current
  entry;
- `knowledge/search` and `knowledge/list` gain the optional `withOutsiders` flag; both
  return entry content, so both apply the People audience rule.

`file` is one of the three names; the Control Plane maps it to the
organization's entry of that kind. No frame exceeds the 256 KiB limit: each file
is capped by its shape (`organization.md` at 16 KB) or by the existing knowledge
body limit.

### 15.7 Migration

Existing entries default to `all`. An organization whose assistant-mode agents
already hold the three files in memory gets them moved into knowledge once, with
the memory copies removed. Assistant mode keeps memory in the Control Plane, so
the Control Plane does the move at boot with no daemon: per organization with at
least one assistant-mode agent whose shared layer holds any of the three names,
it merges the copies mechanically within each shape (the copy written last as
the base; About taking the other copies' missing lines into the same
section with the summary kept at ten lines; Channels unioned by `#name`, newest
date winning; People unioned by key, then by field and text, each entry kept at
ten lines), unions the opt-out markers with the earliest day kept, creates the
entries at revision 1 with `source: migration`, sets the research status from
the onboarding records, and deletes the copies and their index lines. The
files' change history stays in the memory change log. The move is idempotent and
runs again for copies an older daemon writes during the rollout (§13).
