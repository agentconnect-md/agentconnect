# Organization Knowledge and Dream Suggestions

> **Status:** Approved for implementation, 2026-07-31
>
> **Scope:** protocol, control plane, daemon, and web console
>
> **Related:** [memory-dreaming.md](memory-dreaming.md),
> [shared-skills.md](shared-skills.md),
> [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md)

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
`/[slug]/knowledge`, beside Tools & Skills. It has two tabs:

1. **Organization** lists accepted, non-archived knowledge. A row shows title,
   summary, tags, revision, provenance, author/reviewer, and timestamps; opening
   it loads a revision selector and renders the selected immutable Markdown plus
   its provenance. Owners may create, edit, archive, and restore. Editing creates
   a new immutable revision.
2. **Suggestions** lists Dream candidates. Each card shows its title or skill
   name, rendered Markdown or complete file tree, proposing agent, source Dream
   and sessions, operation (`create` or `update`), creation time, and review
   state. Owners may accept or reject a pending item. Rejected items remain in
   history.

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
  organization artifact;
- agents have a read-only knowledge discovery tool; there is no agent publish
  tool.

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
   the agent's standing context budget.
6. **No automatic skill activation.** Approval only creates a managed skill.
   Per-agent enablement is a separate human action.

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
  in the trusted organization context supplied to this Dream; a skill update
  additionally requires the exact unchanged name from the agent's CP-authored
  managed-skill binding;
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

1. An owner inspects a pending suggestion. The control plane resolves the source
   agent's current daemon, requests the body over `knowledge/suggestion/read`,
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
  id, orgId, title, currentRevision, archivedAt/by, createdAt, updatedAt

OrganizationKnowledgeRevision
  knowledgeId, revision, content, summary, tags, digest,
  source(manual|dream), sourceAgent/Dream/candidate/sessionIds,
  createdByUserId, reviewedByUserId, createdAt

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
names are unique per organization; suggestion source identity is unique.

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
issues `knowledge/search`. PostgreSQL search uses the `simple` full-text
configuration plus a case-insensitive title/content fallback. Ranking favors an
exact/prefix title match, then full-text rank, then recency. A GIN expression
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

The existing containment-safe skill materializer reconciles cached managed
skills into the runtime-visible skills tree using its ownership marker. An
accepted agent-local Dream skill wins a same-name collision; the managed skill
is skipped and reported. Disabling removes only materialization owned by the
marker, not arbitrary user files. The canonical cache may remain for reuse and
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
inspection response.

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
- **Repository:** migration from empty and existing PostgreSQL, protocol/daemon/
  control-plane/web tests, typecheck, lint, formatting, production build, and
  desktop/mobile browser smoke.
