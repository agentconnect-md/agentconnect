# Shared Skills: One Isolated `skills` CLI for Git and Local Sources

> **Status:** Implemented. v4 applies the same immutable snapshots, exact CLI,
> receipts, and ownership rules to daemon-local and cluster sandbox workspaces.
>
> **Known trust-model mismatch:** the current v3 daemon implementation also
> forces every ordinary ACP host into the OS sandbox. That enforcement follows
> an obsolete assumption and is pending a separate code correction. The
> normative execution model is
> [architecture.md §9.1](architecture.md#91-execution-trust-model).
>
> **Scope:** protocol + control-plane + daemon + web
>
> **Requirement mapping:**
>
> 1. The Tools & Skills page offers **Import from GitHub** and records a skills
>    source, either a repository or an install directory inside one. See the
>    Control Plane registry in section 4 and Web changes in section 7.
> 2. After the daemon finishes cloning a workspace repository and before it
>    starts an ACP host, it feeds every enabled Git, managed, and accepted-local
>    source through the same exact installed `skills` CLI. The CLI chooses the
>    runtime-specific destination in a private staging cell. See section 6.
> 3. Version management uses refs embedded in source definitions. The daemon
>    records the exact resolved Git commit and retains it while the normalized
>    repository/ref identity is unchanged; immutable local bundles are
>    digest-bound. See section 5.
>
> **Managed artifacts share the installer:**
> [organization-knowledge.md](organization-knowledge.md) defines centrally
> accepted, immutable `.skill` bundles mined by Dream. Those bundles use a
> digest-addressed daemon cache and explicit per-agent enablement. The cache is
> a local source for this same installer; it has no second harness mapper/copier.

## 0. Why this design replaces v1

v1 proposed a custom content-addressed cache plus a separate symlink installer
for every runtime: `.claude/skills` for Claude, `$CODEX_HOME/skills` for Codex,
and system-prompt injection for others. The upstream `skills` CLI from
[vercel-labs/skills](https://github.com/vercel-labs/skills) already implements
that machinery:

- It supports more than 73 agents, including `-a claude-code`, `-a codex`,
  `-a cursor`, `-a opencode`, and `-a gemini-cli`. The CLI maintains each
  agent's directory convention, so AgentConnect need not track destinations per
  runtime.
- Upstream accepts several remote and local source forms. AgentConnect narrows
  remote admission to bounded GitHub repository forms, acquires them itself,
  and gives the CLI only a local immutable snapshot.
- Installation creates a **symlink** to one canonical copy by default;
  `--copy` creates a copy instead.
- Non-interactive flags include `-y` to skip confirmation, `-a` to select an
  agent, and `-s/--skill` to select particular skills.

The daemon's responsibility is one pipeline: **acquire every source into a
private immutable snapshot, run the exact installed CLI against that local
path, validate its filesystem receipt, then transactionally reconcile the
receipt into the workspace before spawning the runtime**. The Control Plane
still records Git source definitions rather than scanning their bodies.

The upstream CLI lockfile is corroborating output only: it contains neither a
complete target receipt nor stable local-source identity. AgentConnect keeps it
inside the disposable cell. A daemon-owned ledger records exact installed file
digests and CLI-derived relative roots outside the agent-writable workspace.

## 1. Implementation state

- **Web and Control Plane:** the Tools & Skills library, organization-scoped Git
  source registry, per-agent bindings, and inline `AgentSpec.skills`
  distribution are implemented.
- **Managed local sources:** centrally accepted immutable bundles and accepted
  agent-local Dream skills are represented as local source descriptors. Their
  canonical copies remain outside the workspace.
- **Daemon:** Git, managed, and accepted-local sources now enter one ordered
  reconcile operation after workspace preparation and before a cold ACP host
  starts. The exact audited `skills@1.5.21` dependency is bundled into the
  released daemon and owns runtime layout in a private staging cell; production
  never invokes `npx` or resolves an installer package from the network. A
  trusted external ledger owns publication and cleanup in the live workspace.
- **Cluster sandbox:** the daemon acquires and pins sources, then uploads bounded
  immutable snapshots over the dedicated shim capability. The runtime image
  bundles the same `skills@1.5.21` CLI; the shim validates bytes, publishes only
  receipt-owned roots, and returns the applied ledger before ACP starts. Shared
  journal writes are fenced by duty term and SandboxClaim UID.

Implementation anchors:

| Building block                               | Location                                                          | Role                                                        |
| -------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------- |
| Organization registry and visibility         | `prisma/schema.prisma` and `http/routes/skill-sources.ts`         | Store public-GitHub metadata and agent enablement           |
| Per-agent projection and distribution        | `orchestrator/skillSource.ts` and `AgentSpec.skills`              | Validate/filter rows and reuse `agent/upsert`/`register/ok` |
| Workspace clone/pull and cold-host gate      | `prepareWorkspace` in `workspace/workspace-manager.ts`            | Reconcile skills **after cloning** and before every host    |
| Bounded GitHub acquisition and origin policy | `skills/skill-git-source.ts` and `workspace/git-origin-policy.ts` | Produce commit-bound local snapshots                        |
| Cluster journal and shim publication         | `skills/cluster-skill-coordinator.ts` and `shim/skill-handler.ts` | Upload, replay, publish, and receipt-fence sandbox skills   |

## 2. Goals and non-goals

**Goals:**

- Make the Control Plane the single source of truth for skill **sources** at
  organization scope, with `ResourceVisibility` matching MCP providers, agents,
  and crons. It stores only the source, not its content.
- Enable skills per agent at **skill granularity**, rather than enabling an
  entire repository unconditionally.
- Use one exact pinned `skills` dependency after clone and before host startup,
  delegating runtime destinations to the CLI without giving it the live cwd.
- Degrade an acquisition/CLI failure to no AgentConnect-managed skill. Refuse
  host startup only when stale executable content cannot be removed or ledger
  recovery cannot prove a coherent state.

**Non-goals:**

- A per-runtime directory mapper or Dream-specific copier. The generic publisher
  consumes CLI receipts and has no harness-name table.
- Automatically following a moving branch on every session. See section 5.
- Editing skill content in the Console. Editing means changing the source
  repository through a pull request.
- A skills marketplace or cross-organization sharing. Dream candidates remain
  uninstalled until explicit review; accepted bundles become ordinary local
  sources for this pipeline.

## 3. Shape of a skill source

One Git source is a credential-free remote repository definition plus an
optional ref, subdirectory, and skill selection. The daemon first acquires it
through its hardened Git path and gives the CLI only a private local snapshot:

- `owner/repo` installs every skill from the repository.
- `owner/repo` with `skills: ["review-pr", "safe-deploy"]` installs only those
  skills through `-s`. Wire selections are canonical leaf names; because the
  CLI matches `-s` against SKILL.md frontmatter names (which may differ from
  the directory name, e.g. `name: Grill Me` inside `skills/grill-me/`), the
  daemon first resolves each canonical selection against its private snapshot
  to the frontmatter name the CLI matches. The resolved set is then closed
  over same-source slash references — a selected body like
  ``Run a `/grilling` session.`` pulls the referenced sibling skill in too,
  transitively, since installing such an alias alone yields a broken skill —
  and the CLI output must be exactly the resolved leaf set.
- `https://github.com/owner/repo/tree/<ref>/<subdir>` points directly to a
  directory or ref inside the repository.
- Accepted remote spellings are `owner/repo`, canonical
  `https://github.com/owner/repo[.git]`, GitHub
  `https://github.com/owner/repo/tree/<ref>[/<subdir>]`, and the standard
  `git@github.com:owner/repo[.git]` or
  `ssh://git@github.com/owner/repo[.git]` forms. Standard GitHub SSH inputs
  must canonicalize to the same exact HTTPS repository authority before any
  network effect; if the operator policy does not authorize that HTTPS origin,
  acquisition fails closed.
- GitLab, other Git hosts, custom ports, other SSH roles, embedded credentials,
  query strings, fragments, and unsafe ref/subdirectory syntax are rejected at
  protocol and Control Plane admission, before acquisition or CLI effects. The
  canonical GitHub origin must also pass the daemon operator's Git-origin
  policy.
- Every installable entry carries GitHub's canonical positive decimal
  repository ID. The daemon calls the numeric repository endpoint before and
  after the owner/name-based commit lookup and requires the returned ID,
  `full_name`, and `private: false` to match exactly. A rename, deletion, or
  replacement at the old name therefore fails closed before archive download.
- Only public repositories are supported. The normal uncached path consumes
  four GitHub REST requests per source (two numeric-identity checks, commit
  resolution, and archive lookup), plus one bounded codeload download. GitHub's
  anonymous REST limit is 60 requests/hour per egress IP, so roughly fifteen
  cold source acquisitions can exhaust that shared budget. Retained commit
  resolutions avoid paying it on unchanged fast paths; operators must still
  treat anonymous quota exhaustion as an availability constraint.

The CLI discovers skills; the Control Plane **does not parse `SKILL.md` for
installation**. A best-effort GitHub preview endpoint can scan `SKILL.md` files
for UI assistance, but the current import form also accepts an explicit skill
filter and an empty filter means all discovered skills.

## 4. Data model and REST API in the Control Plane

The model is **deliberately thin**. The Control Plane records only sources.

### Prisma

```prisma
// Organization-scoped skill-source registry. name is unique within an
// organization and is the key referenced by an agent's enablement list.
model SkillSource {
  id              String             @id @default(uuid()) @db.Uuid
  orgId           String
  name            String             // Set at create; immutable API reference key; @@unique([orgId, name])
  source          String             // Bounded GitHub input: owner/repo, canonical GitHub URL, or tree/<ref>/<subdir>
  githubRepoId    BigInt?            // Nullable only for migration; unbound rows never project to an agent
  ref             String?            // Optional branch, tag, or commit embedded in source or used for update
  subDir          String?            // Optional install directory inside the repository
  skills          String[] @default([]) // Empty means all skills; non-empty values are passed with -s
  visibility      ResourceVisibility @default(org)
  sharedWith      String[]           @default([])
  createdByUserId String?
  createdAt       DateTime           @default(now()) @db.Timestamptz(6)
  updatedAt       DateTime           @updatedAt @db.Timestamptz(6)
  org Org @relation(fields: [orgId], references: [id], onDelete: Cascade)
  @@unique([orgId, name])
  @@map("skill_source")
}
```

There is no `SkillRepoVersion` table, manifest column, or Control Plane content
cache. There is **no secret side table or repository grant**: installation is
public-only. `githubRepoId` remains nullable in the database only so rolling
upgrades can read historical rows; a current row is installable only after it is
bound to GitHub's numeric repository identity.

**Binding is the Control Plane's job, not the client's.** No console entry point
can know the numeric ID -- it appears in no read the browser makes -- so the
create/patch routes resolve it from `source` themselves: the org installation
first when it covers the owner, then an anonymous public read, which is the only
path available for a skills.sh hit whose repository belongs to no installation.
A write that cannot bind is refused (400 when GitHub says the repository does not
exist, 503 while GitHub is unreachable) rather than persisted as a row that looks
enabled in the console and installs nothing. A `PATCH` re-binds when the source
changes or the row never had an identity, which is how a historical unbound row
is repaired; clearing the identity is refused.

**The stored slug is canonicalized with the ID.** GitHub follows rename and
transfer redirects, so the resolved `full_name` may not be the slug that was
typed (`docker/docker` resolves as `moby/moby`). The daemon's numeric-identity
check requires `full_name` to equal the configured source, so the route persists
the canonical owner/repository -- rewriting only that half and preserving any
`.git` suffix or `/tree/<ref>/<subdir>` the source carries. The two fields are
written together or the write is refused; they may never disagree.

### Per-agent binding: inline source definitions in `AgentSpec` and `agent.json`

The key decision is that **all information the daemon needs to acquire and
install a source--URL, ref, subdirectory, and selected skills--is inlined in the
agent spec and persisted to `agent.json`**. Source definitions are not
pushed independently, and the daemon keeps no source-definition cache.
`SkillSource` is only the Control Plane's editing and management surface and
source of truth. When distributing an agent, the Control Plane resolves enabled
sources into self-contained entries in `AgentSpec.skills`:

```prisma
// The Control Plane stores which sources and skills the agent enables by name.
// Distribution resolves references into self-contained entries.
model Agent {
  // Existing fields...
  runtimeOverrides Json?       // Contains skills: ["source/skill", "source/*"]
  managedSkills String[]       // Immutable managed-skill IDs, stored separately
}
```

`AgentSpec.skills`, which is also the shape persisted in `agent.json`, is an
array of **self-contained entries**, not a list of names:

```jsonc
"skills": [
  {
    "name": "platform-skills",             // Source name for display and logs
    "source": "acme/platform-skills",      // Acquired by Git, then snapshotted locally
    "githubRepoId": "123456789",           // Exact decimal ID; never a JS number
    "ref": "v1.2.0",                       // Optional branch, tag, or commit
    "subDir": "skills",                    // Optional directory inside the repository
    "skills": ["review-pr", "safe-deploy"] // Empty means all skills and omits -s
  }
]
```

By reading only `agent.json`, the daemon can acquire and install every entry as
described in section 6, with **no Control Plane dependency**. A Control Plane
outage or daemon restart does
not matter because the definition lives beside workspace and runtime
configuration in the agent file.

During a Control-Plane-first rolling upgrade, the wire decoder can still read
the previous entry vocabulary. Projection and daemon admission then validate
each Git source independently. An unknown source name resolves to nothing;
malformed, duplicate, over-limit, or historical `githubRepoId`-less rows are
omitted with a structured warning, while the remaining valid rows continue to
reconcile. One stale registry row never rejects the entire `AgentSpec` or
`agent.json` roster.

**Replacement of the orphaned field:** the old local-only `workspace.skills`, a
`string[]` preserved verbatim by `write-agent.ts`, is deprecated. The active
field is top-level `Agent.skills`, which is **Control Plane-owned** and written
by `applySpecFields` as `raw.skills = spec.skills`, exactly parallel to
`raw.mcpServers = spec.mcpServers`. Its meaning is a list of self-contained
enabled-source entries rather than the old unused string list.

**Tradeoff against independent definition frames:** changing a source used by N
agents, such as bumping a ref, fans out to N `agent/upsert` frames and
duplicates the definition across their `agent.json` files. In exchange, the
daemon needs **no source cache and no separate reconciliation**, remains
self-sufficient offline, and reuses the existing persistence, merge, and
reconciliation behavior of `agent/upsert`. Skill-source changes are infrequent,
so the fan-out is acceptable.

### REST API: `http/routes/skill-sources.ts`

Every route follows `openapi.ts` requirements for tags, summary, and
`operationId`.

| Route                                | Semantics                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /skill-sources`                 | List sources.                                                                                                                                                                                                                                                                                                                                                                                                     |
| `GET /skill-sources/registry/search` | Search the public skills.sh index by skill name for the "Install from skills.sh" modal. Read-only proxy of the index `npx skills find` uses (skills.sh sends no CORS headers); each hit is normalized to `{id, name, source, installs}` and validated against the same `source` / `-s` grammars the create body enforces. Nothing is persisted, and `reachable:false` distinguishes "index down" from "no match". |
| `POST /skill-sources/preview`        | Best-effort UI scan. Given `{installationId, owner, repo, ref?}`, use the selected GitHub App installation to return branch/tag choices and candidate `{name,dirPath}` skills. Preview is not persisted or authoritative; an empty list still permits “install all.”                                                                                                                                              |
| `POST /skill-sources`                | Persist a public GitHub source, resolving its numeric repository ID server-side (installation read, then anonymous public read). A source that cannot be bound is refused rather than stored non-installable; a body-supplied ID overrides the lookup.                                                                                                                                                            |
| `PATCH /skill-sources/:id`           | Change source, numeric repository ID, ref, subdirectory, or skills (name is immutable), then **repush every agent that references it**. Re-binds the numeric ID when the source changes or the row is unbound (the repair path for historical rows); clearing it is refused.                                                                                                                                      |
| `PUT /skill-sources/:id/sharing`     | Set `ResourceVisibility`, matching MCP providers.                                                                                                                                                                                                                                                                                                                                                                 |
| `DELETE /skill-sources/:id`          | Delete a source only when no agent references it; otherwise return 409 and require explicit unselection first.                                                                                                                                                                                                                                                                                                    |

#### Sharing hides a source from the registry, never from the agent that runs it

Sharing governs the **registry**: `GET /skill-sources` and
`GET /skill-sources/:id` apply `canView` on the source, so a restricted source is
invisible to a collaborator it was not shared with. It does **not** govern what an
agent already installs. The definition rides inline on that agent's `AgentSpec`
regardless, so hiding it from the agent's own page buys no confidentiality (skill
sources are public repositories with no grant and no secret side-table) and only
leaves an unexplained row on the Tools & Skills tab.

`GET /agents/:id/skill-sources` therefore resolves the agent's enable-list refs
gated on **viewing the agent**, returning a slimmer DTO without the source's own
`visibility`/`sharedWith` (seeing an agent does not entitle the caller to the
source's share set). Refs to a source that no longer exists resolve to nothing and
the console renders no tile for them — they install nothing either
(`resolveAgentSkillEntries` drops unknown names), so there is nothing truthful for
a placeholder row to say.

Crossing that boundary requires the source string to be **secret-free**, which is
now enforced rather than assumed. `SkillSourceArg` rejects a scheme URL that embeds
userinfo (`https://<token>@host/repo`, `https://user:pw@host/repo`, including a
password containing `@`) and any query or fragment (`?access_token=…`), which
Git acquisition has no use for. Standard GitHub SSH forms pass only with the
`git` role and canonical `github.com` origin; arbitrary SSH hosts and roles do
not.

Rows stored before that guard are redacted at the agent-scoped response boundary by
`redactSourceCredentials`, which delegates to the protocol's **`redactGitUrlSecrets`**
rather than re-deriving the rules — that codec is total and already handles the last
authority `@`, query/fragment stripping, backslash authority ambiguity, and
malformed historical values. Bare `owner/repo` shorthand is passed through verbatim
(it cannot carry a secret, and the codec would expand it to a full URL). The
registry response remains the migration/audit surface, but agent projection is
stricter: every historical row must pass the current bounded-GitHub schema and
carry `githubRepoId`. A failing row is omitted individually with a warning and is
never copied into `AgentSpec`; valid sibling rows still ship.

Adding an enablement ref is gated on seeing the **source**
(`enablingUnseenSkillDenied` in `http/routes/agents.ts`). A tile the caller reaches only through the agent
is therefore **off-only** and offers no per-skill picker — it can be turned off,
not back on, the same rule `AgentToolsCard` applies to a saved MCP name the runtime
can't attach.

### Distribution inline with `agent/upsert`, without a dedicated frame

There is **no `skillsource/*` frame and no `RegisterOk.skillSources`**. Source
definitions travel inline in `AgentSpec.skills` through the existing
`agent/upsert` and `register/ok` roster reconciliation. Two events trigger
distribution:

1. **An agent's enabled set changes** through its edit page, resulting in the
   normal `agent/upsert`.
2. **A referenced `SkillSource` changes** through its source, numeric repository
   identity, ref, or skill selection. The Control Plane finds every agent whose
   `skills` refer to it, resolves new inline entries, and emits one
   `agent/upsert` per agent, accepting the section 4 fan-out tradeoff.

The daemon gains no new distribution path. On `agent/upsert`,
`writeAgentSpec` merges `skills` with the other Control Plane-owned fields in
`agent.json`. The next session reads the file directly in `installSkills`.

## 5. Pragmatic version management

Source versioning and installer versioning are separate:

- **Git source ref:** acquisition fetches `SkillSource.ref`, including a tag or
  commit SHA, before removing repository metadata and creating the local
  snapshot. A branch, or no ref and therefore the default head, is mutable.
  The Console labels the source accordingly.
- **Resolution retention:** the first successful acquisition records the exact
  commit for the normalized repository/ref identity. An unchanged definition
  retains that commit even when a local/runtime/display/selection change forces
  the installer to rebuild its output; if reacquisition is needed, it requests
  that exact commit instead of silently advancing a moving branch. Changing the
  repository or ref creates a new acquisition identity and resolves it afresh.
- **Byte binding after acquisition:** every successful install is bound to an
  exact source snapshot, CLI-output manifest, and live installed-tree digest.
  Immutable managed/Dream sources also put their upstream content digest in the
  plan fingerprint.
- **Cross-daemon consistency:** a commit SHA or immutable managed revision gives
  deterministic source bytes. The first resolution of a moving branch can
  differ across daemons; each daemon thereafter retains its resolved commit
  until the repository/ref definition changes.
- **Installer pin:** the daemon package and lockfile pin `skills@1.5.21` exactly.
  Upgrading the installer is a reviewed dependency change with golden tests,
  never a floating runtime resolution.

## 6. Daemon: isolated exact CLI after clone and before host startup

### 6.1 Trigger point

`prepareWorkspace` funnels scratch and Git workspaces through one
`installSkills` post-stage before a cold ACP host is created. The daemon supplies
one trusted state root shared across agents, so every exact prepared ACP cwd has
one canonical ownership ledger instead of a workspace-writable marker. Writable
workspace-root overlap is rejected separately by the roster boundary below; the
subdirectory ledger does not claim authority over an arbitrary checkout root.
Every cold-host retry reruns the complete prepare gate; a failed host is stopped
before the next attempt, so no retry can bypass acquisition, cleanup, or ledger
recovery. Reconcile also keeps the agent admission gate closed until a
superseded cold preparation/start promise has settled; aborting its generation
alone cannot release a non-abortable clone, pull, or install into a newer live
host. Warm-host session creation and resume use the same whole-operation,
per-agent preparation queue. A turn-scoped abort may release its caller, but a
replacement generation and daemon shutdown remain fenced until the underlying
managed-cache, clone/pull, snapshot, and reconcile operation quiesces; the new
generation then runs its own final prepare before ACP construction.
A queued warm preparation is also bound to the exact host object that admitted
it and is rejected if that host is superseded. Destructive detach/remove first
gates new agent work, then waits both the preparation tail and any admitted
Dream/editor workspace-file publication lease before archiving or deleting the
agent root.

Preparation is also the durable ownership boundary even when the desired skill
set is empty. The first successful prepare writes a `ready` ledger that claims
that canonical cwd for the agent ID before any executable skill exists. Later
prepares by the same agent may reconcile it; a different agent ID is rejected
rather than inheriting a workspace to which an older live sandbox may still have
write authority.

Before the daemon reconcile path reaches its first `await`, it canonicalizes and
validates the writable workspace authorities from both the current and desired
active-agent sets. Equal paths and ancestor/descendant overlaps across different
agent IDs are rejected. `--agent` single-agent mode still loads the full active
roster from the configured `agentsDir` for this check. Combining current and
desired authorities prevents a batched workspace swap or transfer from taking
effect while an old host still holds kernel write access.

### 6.2 Command

Build an ordered plan: Git entries from `agent.skills`, verified managed-cache
directories, then accepted agent-local Dream directories. Later sources win a
same-path collision, preserving accepted-local > managed > Git precedence.
Every source is first copied with a bounded no-follow walker into a daemon-owned
snapshot. Git acquisition is public-only, begins with anonymous GitHub requests,
and never passes a remote URL or credential to the CLI.

For a Git entry, the acquisition step resolves the requested ref to an exact
GitHub commit, accepts only the matching repository/commit redirect to canonical
`codeload.github.com`, and validates bounded archive size, expansion ratio,
entry count, paths, types, and extraction inventory. Links and special files are
rejected. Repository metadata never enters the local source snapshot.

For every resulting local snapshot, invoke the same locally installed binary:

```text
node <bundled skills@1.5.21 bin> add <absoluteSnapshot> \
    -a <agentId(runtime)> \         # Runtime to skills-CLI agent ID
    -s <skill> [-s <skill> ...] \   # Selected skills; omit -s to install all
    -y --copy \                     # Non-interactive; see section 6.6
    (cwd = private 0700 cell)       # Never the live workspace
```

- The only production runtime mapping is runtime → CLI `-a` identity. The
  wrapper discovers `<hidden-root>/skills/<bundle>` from actual CLI output; it
  never maps a harness to `.claude`, `.agents`, or a future directory.
- The CLI cell has private HOME/XDG/TMP/runtime-home directories, a minimal PATH,
  telemetry disabled, no proxy/Git/npm/provider/SSH environment, bounded output,
  and a timeout. When available, the offline kernel sandbox restricts reads to
  the pinned CLI and source snapshot and writes to the disposable cell. Hosts
  without a working bwrap/Seatbelt provider use a logged private-process
  fallback. The fallback keeps the same private environment, exact dependency,
  output/time limits, source snapshots, receipt validation, external lease,
  audited mutation helper, ownership ledger, and gated publication, but cannot
  provide kernel-enforced filesystem or network confinement.
- `skills` is an exact package dependency. Upgrading is an intentional daemon
  dependency/lockfile change gated by real Claude/Codex/local/Git golden tests.
  The release build emits the CLI and its license notices under `dist/skills`,
  and the self-contained-package check proves it has no runtime package-manager
  dependency. `AC_SKILLS_CLI`, when present, must equal the exact audited
  `skills@1.5.21` spec and cannot select another package or version.

### 6.3 Receipt, ledger, failure, and idempotence

- The wrapper rejects links, hardlinks, special files, path collisions, missing
  manifests, unexpected CLI output, and configured file/byte/depth limits. It
  hashes a canonical `{path, mode, size, sha256}` manifest for each bundle.
- One atomic daemon-owned ledger keyed by canonical cwd records the owning agent
  ID even for an empty skill set, plus the plan fingerprint, exact CLI version,
  source identity, CLI-derived roots, and file manifests. A CLI-derived root is
  canonicalized through contained workspace-local aliases before it is compared or
  recorded, so one directory has one owner no matter which harness named it — a
  repository that exposes `.agents/skills` as a link to `.claude/skills` gets a
  renamed receipt on a runtime switch, not a second installation over the first.
  The unchanged fast path re-hashes every owned live tree; existence alone is
  insufficient.
- An external SQLite lease serializes every process that can mutate the same
  canonical workspace. `BEGIN IMMEDIATE` protects the workspace key,
  owner-PID/token, and optional detached-helper process-group ID. A live owner or
  live helper group fences contenders; a dead owner is reclaimed only after its
  helper group is also dead.
- The confined mutation helper starts detached and waits for a `GO` byte. The
  daemon durably records its process-group ID in the SQLite lease before sending
  `GO`, and clears that ID only after the entire group has exited. A daemon crash
  therefore cannot make an active helper look like an abandoned lock.
- Reconciliation durably writes an `applying` journal, quarantines a previously
  owned tree, and claims the actual final target with atomic no-clobber `mkdir`.
  It records the target and empty operation-marker inode identities before any
  candidate byte is allowed. Support files and their directories are written and
  fsynced first; the runtime-discovery `SKILL.md` is written and fsynced last.
  The final receipt is verified before `ready` commits, after which exact
  quarantine/tombstone cleanup continues forward.
- A recorded inode identity is one half of the ownership proof, never the whole of
  it: inode numbers are recycled, so a re-checked-out directory can be seated on the
  recorded one and only the receipt walk separates it from the tree the daemon
  installed. A quarantine is therefore refused as unowned when either half
  disagrees.
- Recovery with persisted inode authority may touch only the exact reservation
  or receipt-bound tree. Before that authority exists it may remove only
  content-free crash shapes: an empty target directory, or an empty target that
  contains only the expected empty marker. Any other partial tree fails closed.
  Unowned/manual destinations are never overwritten or adopted. A candidate whose
  destination is unowned is skipped and reported as a conflict rather than failing
  the workspace: leaving that path untouched is what the refusal wanted, and one
  foreign directory must not cost the agent its other skills or its host startup.
- A source/CLI failure clears previously owned content and starts without managed
  skills. A refused stale removal, corrupt journal, or failed rollback blocks the
  workspace so disabled executable instructions cannot remain silently active.
- An unchanged Git definition retains the existing cache semantics: moving branch
  heads are not fetched on every session. Local Dream content and managed revision
  digests participate in the plan fingerprint.

### 6.4 Legacy ownership requires explicit cleanup

The pre-unification workspace-local markers
`.agentconnect/skills-install.json` and
`.agentconnect/dream-skills-install.json` are untrusted compatibility hints,
not deletion authority. If a known marker is present, workspace preparation
fails closed and tells the operator to inspect and move or remove every listed
installed path, then remove the marker. A malformed, forged, linked, unbounded,
or otherwise unsafe known marker also blocks preparation. The unified installer
never adopts or deletes legacy paths automatically, even when an external
ledger also exists.

### 6.5 Accepted Dream sources are explicit and immutable

An accepted Dream skill is copied into a digest-addressed bundle directory and
then activated by atomically replacing the bounded `accepted-skills.json`
registry. Index absence means **no accepted sources**; the daemon never scans or
auto-adopts legacy-looking sibling directories. Historical direct directories
must be explicitly accepted again so review produces immutable digest authority.
The unified CLI and publication ledger then treat each accepted revision like
any other local source.

### 6.6 Copy-only publication

- `--copy` is mandatory. The snapshot walker and CLI-cell scanner reject source
  or output links, and the generic publisher copies only receipt-bound ordinary
  files.
- The installer itself still edits no ignore configuration, and `.gitignore` or
  any other tracked ignore file is never touched — repository owners keep ignore
  policy for everything that is theirs. What changed: after installation,
  workspace preparation declares the ledger-owned bundle roots in the checkout's
  common `.git/info/exclude` (`workspace/git-exclude.ts`), inside one marked
  block that is replaced wholesale so it always mirrors the ledger — a bundle
  the agent stops installing stops being excluded, and human-authored entries
  outside the block survive verbatim.
- The exclusion exists because "ordinary workspace changes" was the bug, not a
  neutral stance: untracked daemon-owned bundles read as user work to the
  session-retention GC, which then refuses to reclaim any worktree the installer
  touched. Registrations grow until the runtime's Bash sandbox profile — sized
  per registered worktree — overflows the OS exec argument limit and every
  command in the agent fails to spawn (issue #1603).

### 6.7 Runtime without a CLI identity

For a runtime with no mapped CLI agent ID, the reconciler removes any previously
owned copies and reports managed skills unavailable. It does not invent a neutral
destination or prompt fallback, because either would recreate a second harness
installation contract outside the CLI.

## 7. Web: Tools & Skills page

The implemented surface follows `McpServersCard`:

- The **Skills library** is one card for both source kinds: Git-backed sources
  from this design and centrally accepted immutable managed bundles from
  [organization-knowledge.md](organization-knowledge.md). Managed bundles are
  labeled separately and expose their lazy revision history in place; they do
  use the same isolated CLI pipeline as local sources, while remaining separate
  from the Git source registry.
- **Install from skills.sh** opens a search modal over the public
  [skills.sh](https://skills.sh) index — the same index `npx skills find` reads,
  proxied by `GET /skill-sources/registry/search` because skills.sh serves no
  CORS headers. The user searches by skill name, picks a hit, and the modal
  registers it as an ordinary bounded GitHub source whose `source` is the hit's
  `owner/repo` and whose skill filter is exactly the one skill picked, so it
  installs through the same isolated CLI pipeline as any other source.
- **Import from GitHub** opens the current source form for a bounded GitHub
  source, optional name/ref/subdirectory, optional skill-name filter, and
  sharing. An empty filter installs every skill the CLI discovers.
- Each Git **Skills library tile** shows the source name, GitHub source/ref,
  visibility, and created date, with the existing Edit and Delete controls.
  Managed-skill tiles expose immutable revision history and archive/restore in
  the same card. There is no separate installer-facts or reinstall UI contract.
- The agent editor includes a **Skills selector** beside MCP server selection.
  Selection is at **skill granularity**: visible sources are groups, with
  individual skill checkboxes below each group. "Select all" on a group means
  `<source>/*`.
- The usual data path uses `fetchSkillSources` and related calls in
  `api.ts`, SWR state and actions in `data-context.tsx`, styling under
  `STYLE.md`, and the existing responsive Knowledge-page structure at widths
  of 768 pixels and below.

## 8. Security and trust boundaries

- **A skill is a prompt-injection surface:** imported content enters agent
  context and can drive tool calls. Import and update are therefore
  **privileged operations**, limited to administrators and owners under the same
  permission as MCP-provider management.
- **The CLI never receives the live workspace or live Git URL:** sources come
  from the controlled organization registry, Git is acquired separately, and
  every source becomes a bounded no-follow local snapshot. The exact CLI writes
  only to a private cell; unexpected outputs and links are rejected.
- **Credentials:** the Control Plane uses a GitHub App token only for preview
  scanning. Public acquisition starts anonymously; on a GitHub-App workspace,
  the numeric identity request may retry with the existing URL-scoped helper as
  a rate-limit/identity fallback, but `private: false` remains mandatory. The CLI
  cell receives no Git/provider token, proxy, SSH agent, npm config, or ambient
  HOME.
- **Workspace isolation:** within one daemon-root/configured-`agentsDir`
  authority domain, the external SQLite ownership database, canonical workspace
  claims, active-roster overlap validation, and exact byte receipts govern
  publication/removal. The installer does not mutate repository ignore
  configuration or depend on Git metadata for ownership.
- **Authority-domain runtime trust:** executable skill authority is stored under
  the daemon's UID. Per the normative execution trust model, an unsandboxed ACP
  host is an operator-trusted same-user principal; integrity against that host is
  not an isolation guarantee. Shared skills therefore do not implicitly require
  every ACP host, runtime probe, model enumerator, direct CLI chat, or raw ACP
  evaluation to use the Linux SRT/bwrap sandbox. Per-agent **Run in sandbox** and
  explicit daemon-wide `security.requireSandbox` policy remain the operator's
  isolation controls. The skills CLI and other narrowly untrusted helpers retain
  their own audited isolation cells.
- **Separate-root deployment constraint:** separate daemon roots do not share
  the SQLite workspace-authority database or active-agent roster. Operators must
  not place another daemon root or another daemon's `agentsDir` inside an
  agent-writable workspace. Such nesting crosses authority domains and is not
  made safe by the per-root sandbox marker or lease database.
- **Telemetry:** GitHub archive redirects can contain a short-lived codeload
  query capability. The Undici instrumentation hook canonicalizes trailing-dot
  hostnames and suppresses only exact HTTPS `codeload.github.com` requests before
  `url.full` or `url.query` attributes are created. Application log redaction is
  not relied upon for this boundary.

## 9. Main change index

| Package       | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Change                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| protocol      | `frames/agent.ts` for strict and rolling-compatible inline skill entries; `git-url.ts` for bounded GitHub normalization                                                                                                                                                                                                                                                                                                                               | **No** `skillsource/*` frame and **no** `RegisterOk.skillSources`; sources are inline in `AgentSpec.skills`. |
| control-plane | `prisma/schema.prisma` for the `SkillSource` registry and `Agent.skills`; `http/routes/skill-sources.ts`; `orchestrator/skillSource.ts` for per-row projection/filtering and source-change fan-out; `github/service.ts` for best-effort preview scanning                                                                                                                                                                                              | Section 4                                                                                                    |
| daemon        | `src/skills/install-skills.ts`, `skills-cli-cell.ts`, `skill-source-snapshot.ts`, `skill-git-source.ts`, `skill-install-ledger.ts`, `skill-workspace-mutation-cli.ts`, `skill-workspace-mutator.ts`, `offline-sandbox.ts`, `dream-skills.ts`, and `runtimes/skills-capability.ts`; `workspace/workspace-manager.ts` as the cold-host trigger; `workspace/git-exclude.ts` for the managed-bundle exclude block (section 6.6); exact bundled dependency | Section 6                                                                                                    |
| web           | `SkillSourcesCard.tsx`, `ManagedSkillTile.tsx`, `ToolsHubView.tsx`, `lib/api.ts`, `lib/data-context.tsx`, and the agent editor                                                                                                                                                                                                                                                                                                                        | Section 7                                                                                                    |
