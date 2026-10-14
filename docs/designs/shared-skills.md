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
> 1. The Tools & Skills page offers **Import from GitHub** and **Import from a
>    Git URL** and records a skills source: a repository, or an install
>    directory inside one, on GitHub, on GitLab, or (public only) on any HTTPS
>    Git host. See section 3, the Control Plane registry in section
>    4, and Web changes in section 7.
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
  remote admission to bounded GitHub repository forms and plain HTTPS Git
  addresses (section 3), acquires them itself, and gives the CLI only a local
  immutable snapshot.
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
- **Cluster sandbox:** the daemon pins every Git source to a commit. A shim
  that advertises `skill-git-in-pod-v1` fetches Git sources itself through the
  Source Cache ([source-cache.md](source-cache.md) §8); for an older shim the
  daemon acquires them and uploads bounded immutable snapshots over the
  dedicated shim capability. Managed and accepted-local sources are always
  uploaded. The runtime image bundles the same `skills@1.5.21` CLI; the shim
  validates bytes, publishes only receipt-owned roots, and returns the applied
  ledger before ACP starts. Shared journal writes are fenced by duty term and
  SandboxClaim UID.
- **Hosts:** Git sources may live on GitHub (public or private through the
  organization's GitHub App), on the deployment's GitLab instance (public, or
  private through a managed project), or on any other HTTPS Git host (public
  only, trusted by URL). See section 3.
- **Failure status:** after each committed reconcile the daemon reports every
  Git source it could not install, by name and an enumerated reason code; the
  console shows the latest code beside the source (section 6.3).

The publisher, durable ledger, and shared shim admit up to 64 installed bundles,
each with 64 files and relative paths of at most 1024 UTF-8 bytes. Byte ceilings follow
the plugin ecosystems skills come from: one CLI cell is one source, i.e. one plugin, and
Claude Code and Codex accept a 50 MB plugin, so a source's installed output may hold up
to 50 MiB; a file is capped at the cluster channel's 16 MiB; an agent's whole published
set at 128 MiB. The two per-skill numbers live once (`skill-limits.ts`) and every
validator on the path reads them — the CLI cell, the snapshot, the ledger's receipt check
and the confined mutation helper — so a bundle one stage admits is never refused by the
next. File and path COUNTS stay tight because a receipt root must fit one control frame. These selected installation limits are separate from the larger source
snapshot manifest.

A source that fails its CLI stage — an oversized asset, too many files, a CLI crash —
is **skipped by name** for that run, on the daemon and inside the sandbox shim alike:
every previously installed bundle is preserved (a Git source id names its commit, so
a skipped revision's prior bundles cannot be matched by id; a run that skipped anything
says nothing about intent and pruning waits for a run that builds every source), the
other sources still install, the run's fingerprint is marked failed so the
next preparation retries, and the reason names the bundle and file (for a cluster
agent it travels back in the reconcile reply's `skipped` list). Only a ledger safety
error refuses host startup; content never does.
`cluster-skills-v3` pages prior receipts, installation results, and verification
requests within the 220 KiB control-message budget. Small receipts still use one
reconcile round trip. Publication checks result capacity before changing workspace
files; older shims retain their single-frame admission until their image is updated.

Serving activation and explicit launch acquire and project execution duty before
preparing a sandbox workspace. Claim admission runs outside the agent lifecycle
queue because installing a granted bundle can use that queue itself. A replica-only
unstage retains its move token but does not claim duty or start a non-holder runtime.

Implementation anchors:

| Building block                          | Location                                                                                                                                                            | Role                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Organization registry and visibility    | `prisma/schema.prisma` and `http/routes/skill-sources.ts`                                                                                                           | Store source metadata, its credential reference, and agent enablement |
| Source admission                        | `normalizeSkillSource` in protocol `git-url.ts`; `gitlab/skill-source.ts` (`resolveGitlabSkillProject`) and `otherHostSkillSource` in `orchestrator/skillSource.ts` | Admit GitHub, GitLab, and other-host sources                          |
| Private-source read grants              | `github/service.ts` (`resolveAgentRepoAuthorizationByName`); `gitlab/gitcred.service.ts` over `resolveGitlabSkillSourceProjects`                                    | Mint read tokens scoped to each enabled private source                |
| Per-agent projection and distribution   | `orchestrator/skillSource.ts` and `AgentSpec.skills`                                                                                                                | Validate/filter rows and reuse `agent/upsert`/`register/ok`           |
| Workspace clone/pull and cold-host gate | `prepareWorkspace` in `workspace/workspace-manager.ts`                                                                                                              | Reconcile skills **after cloning** and before every host              |
| Bounded acquisition and origin policy   | `skills/skill-git-source.ts`, `skills/skill-git-hosted.ts`, and `workspace/git-origin-policy.ts`                                                                    | Produce commit-bound local snapshots on the daemon path               |
| In-pod Git acquisition                  | `skills/sandbox-skill-reconcile.ts`, `skills/pod-skill-ref.ts`, and `shim/skill-git-acquire.ts`                                                                     | Plan, resolve, and fetch Git sources inside the pod                   |
| Cluster journal and shim publication    | `skills/cluster-skill-coordinator.ts` and `shim/skill-handler.ts`                                                                                                   | Upload, replay, publish, and receipt-fence sandbox skills             |
| Failure status                          | `skills/skill-source-failure.ts`; CP `ws/handlers/agent-skill-status.ts` and `GET /agents/:id/skill-source-status`                                                  | Report, store, and serve each source's latest reason code             |

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

One Git source is a credential-free remote repository address plus an optional
ref, subdirectory, and skill selection, and an optional `credential` naming who
vouches for it: `{ provider: 'github' }`, `{ provider: 'gitlab', projectId }`,
or absent for an anonymous source. A code host is a credential variant, never a
separate source kind; the shape follows the workspace contract
([git-workspace-model.md](git-workspace-model.md) §2–§3, and
[source-cache.md](source-cache.md) §5 and §11). The daemon first acquires the
source through its hardened Git path and gives the CLI only a private local
snapshot:

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
  directory or ref inside a GitHub repository. Every other host names the
  repository only; ref and subdirectory travel as separate fields.

**Admission vocabulary.** `normalizeSkillSource` in the protocol's
`git-url.ts` is the one parser for protocol decode and Control Plane
admission; the daemon checks the same rules again at acquisition:

- A source naming github.com keeps the bounded GitHub vocabulary: `owner/repo`,
  canonical `https://github.com/owner/repo[.git]`,
  `https://github.com/owner/repo/tree/<ref>[/<subdir>]`, and the standard
  `git@github.com:owner/repo[.git]` or `ssh://git@github.com/owner/repo[.git]`
  forms. Standard GitHub SSH inputs must canonicalize to the same exact HTTPS
  repository authority before any network effect; if the operator policy does
  not authorize that HTTPS origin, acquisition fails closed. Custom ports and
  other SSH roles on github.com are rejected.
- A source on any other host must be a plain `https://` address with a
  repository path. SSH and scp forms, embedded credentials, query strings,
  fragments, and `.`/`..` path segments are rejected.
- Unsafe ref and subdirectory syntax is rejected on every host, before
  acquisition or CLI effects. Every canonical origin must also pass the daemon
  operator's Git-origin policy (`workspaceGitAllowedOrigins`,
  [git-workspace-model.md](git-workspace-model.md) §10), which is the only host
  list: the Control Plane keeps none.
- `githubRepoId` is present exactly when the source names github.com, and a
  `credential` must match its host: `github` only on github.com, `gitlab` only
  elsewhere. The legacy `private: true` flag is still projected beside a GitHub
  credential so a daemon that predates `credential` acquires as before;
  `skillSourceCredential` reads either spelling.

**GitHub sources.**

- Every installable GitHub entry carries GitHub's canonical positive decimal
  repository ID. The daemon calls the numeric repository endpoint before and
  after the owner/name-based commit lookup and requires the returned ID and
  `full_name` to match exactly. A rename, deletion, or replacement at the old
  name therefore fails closed before archive download.
- Public repositories acquire anonymously. On the daemon acquisition path the
  normal uncached acquisition consumes four GitHub REST requests per source (two
  numeric-identity checks, commit resolution, and archive lookup), plus one
  bounded codeload download. GitHub's anonymous REST limit is 60 requests/hour
  per egress IP, so roughly fifteen cold source acquisitions can exhaust that
  shared budget. Retained and cached commit resolutions avoid paying it on
  unchanged fast paths; operators must still treat anonymous quota exhaustion
  as an availability constraint.
- **Private repositories** are supported when the organization's GitHub App
  installation covers the repository owner. The Control Plane binds such a
  source only through that installation (the anonymous read cannot see it),
  records the `github` credential on the row, and projects it inline on the
  agent entry. **Enabling a private source on an agent is the read grant:**
  the gitcred broker treats every private skill source in the agent's
  enable-list as an implied `read` authorization for exactly that numeric
  repository, next to the workspace repository and explicit additional-repo
  rows, and mints a `contents:read` installation token scoped to that one
  repository. No grant row is stored, so unselecting or deleting the source
  revokes it. The daemon's `gitcred` issues that token only inside a **skill
  credential window** it opens itself ([source-cache.md](source-cache.md) §8):
  the per-agent helper capability, which the agent's runtime also holds, is
  refused for a private skill repository and the refusal is audited, so the
  runtime (including one in a GitHub-App workspace pod) cannot clone an enabled
  private skill repository itself. A repository that is also the workspace or
  an explicit additional-repo row keeps that grant. On the daemon path, the
  anonymous numeric-identity read answers 404 for a private repository; the
  credential fallback then obtains the token through the URL-scoped helper and
  every later API read carries it, while codeload still receives only GitHub's
  short-lived archive query. Authenticated reads count against the
  installation's 5,000 requests/hour rather than the anonymous budget.

**GitLab sources.** A project on the deployment's GitLab instance is stored as
`<base>/<path_with_namespace>`, its current path; a `/-/` route path is
refused. An anonymous project read at admission decides visibility:

- A public project is admitted with no credential and, like any anonymous
  source off GitHub, is trusted by URL and acquired as described below.
- A private or internal project must be a managed project of the organization.
  The row records `{ provider: 'gitlab' }` plus the numeric project id, which is
  the anti-replacement identity, and converges its `CodeHostRepository` catalog
  row. **Enabling it is the read grant**, as for GitHub: each enabling agent's
  GitLab account becomes a Reporter consumer of the project
  ([gitlab-com-integration.md](gitlab-com-integration.md) §7.2), and the GitLab
  gitcred broker serves that project's read token under a `read` clamp when
  neither the workspace nor an explicit grant covers it. The daemon resolves the
  ref through `CodeHostRepository.resolveRef` with that token (identity by
  project id and path, then the ref). On the daemon path it then downloads the
  project archive by project id, so no name-based read follows the identity
  check; in a pod the shim clones it with the token served only through the
  reconcile's skill credential window.
- Without a configured GitLab connection, a GitLab address is just another
  host.

**Other hosts.** A source on any other HTTPS host is public only and, like a
public GitLab project, **trusted by URL**: it carries no identity and no
credential, and nothing proves that the repository behind the address is the
one an administrator meant. The Control Plane admits it on syntax alone and
never contacts it, so a subdirectory needs an explicit ref. An anonymous
source off GitHub is resolved by one anonymous, pattern-scoped `git ls-remote`
and fetched by the bounded Git acquisition: in the pod that will use it when
that pod can run Git, otherwise by the daemon. Neither presents a credential,
follows a redirect, or reads system or global Git configuration; a pod's
answer is used only by that pod's preparation and never cached. Whether such a
source works is learned at its first reconcile and reported as a reason code
(section 6.3).

The CLI discovers skills; the Control Plane **does not parse `SKILL.md` for
installation**. A best-effort preview scans `SKILL.md` for UI assistance: a
GitHub source through the organization's App installation, a GitLab project
through the GitLab API (anonymously when public, through the managed binding's
connection otherwise). A source on another host, or a GitLab scan that fails,
answers `resolvable: false`; the import form then accepts an explicit skill
filter, and an empty filter means all discovered skills.

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
  source          String             // Bounded GitHub input, or a plain HTTPS address on any other host (section 3)
  githubRepoId    BigInt?            // github.com only; nullable for migration; unbound rows never project
  ref             String?            // Optional branch, tag, or commit embedded in source or used for update
  subDir          String?            // Optional install directory inside the repository
  skills          String[] @default([]) // Empty means all skills; non-empty values are passed with -s
  private         Boolean  @default(false) // Legacy mirror of credentialProvider = 'github'
  credentialProvider String?         // 'github' | 'gitlab'; null means anonymous
  credentialRepoId   BigInt?         // That provider's numeric repository or project id
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
cache. There is **no secret side table or repository grant row**: a public
source installs anonymously, and a credentialed source is authorized by the
organization's own code-host access, resolved at mint time from the agent's
enable-list: the GitHub App installation for a `github` row, the managed GitLab
project for a `gitlab` row. `credentialProvider` and `credentialRepoId` are the
source's `CodeHostRepository` reference
([gitlab-com-integration.md](gitlab-com-integration.md) §8.1); the migration
backfilled every private, bound GitHub row as `github`, and `private` is still
written so an older replica or daemon reads a GitHub credential the same way.
`githubRepoId` remains nullable in the database only so rolling upgrades can read
historical rows; a current GitHub row is installable only after it is bound to
GitHub's numeric repository identity. A GitLab or other-host row never carries
one.

**Binding is the Control Plane's job, not the client's.** GitLab and
other-host admission are described in section 3. For GitHub, no console entry
point can know the numeric ID -- it appears in no read the browser makes -- so
the create/patch routes resolve it from `source` themselves: the org installation
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
    "skills": ["review-pr", "safe-deploy"], // Empty means all skills and omits -s
    "credential": { "provider": "github" }, // Optional; absent means anonymous
    "private": true                        // Legacy restatement of the GitHub credential
  },
  {
    "name": "team-skills",
    "source": "https://gitlab.example.test/example-org/example-repo",
    "ref": "main",
    "skills": [],
    "credential": { "provider": "gitlab", "projectId": "4242" } // Numeric project id
  },
  {
    "name": "public-skills",
    "source": "https://git.example.test/example-org/example-repo.git", // Trusted by URL
    "skills": []
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
malformed, duplicate, over-limit, or historical `githubRepoId`-less GitHub rows are
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

| Route                                | Semantics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /skill-sources`                 | List sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `GET /skill-sources/registry/search` | Search the public skills.sh index by skill name for the "Install from skills.sh" modal. Read-only proxy of the index `npx skills find` uses (skills.sh sends no CORS headers); each hit is normalized to `{id, name, source, installs}` and validated against the same `source` / `-s` grammars the create body enforces. Nothing is persisted, and `reachable:false` distinguishes "index down" from "no match".                                                                                                                                                                                                                                                                                         |
| `POST /skill-sources/preview`        | Best-effort UI scan. Given `{installationId, owner, repo, ref?}`, use the selected GitHub App installation; given `{source, ref?, subDir?}` for a GitLab project, read it through the GitLab API (anonymously when public, through the managed binding otherwise). Returns branch/tag choices, candidate `{name,dirPath}` skills, and `resolvable`. A source on any other host is never contacted and answers `resolvable:false` with empty lists, as does a failed GitLab scan. Preview is not persisted or authoritative; an empty list still permits “install all.”                                                                                                                                    |
| `POST /skill-sources`                | Persist a source. GitHub: resolve its numeric repository ID server-side (installation read, then anonymous public read); a private repository is accepted only when the installation read answered and is stored with the `github` credential; a body-supplied ID overrides the lookup. GitLab: a public project is stored anonymously, a private or internal one only as a managed project with the `gitlab` credential and its project id (400 when unmanaged, 503 while GitLab is unreachable). Other hosts: admitted on syntax alone, anonymous, never contacted; a GitHub ID is refused and a subdirectory needs a ref. A source that cannot be bound is refused rather than stored non-installable. |
| `PATCH /skill-sources/:id`           | Change source, numeric repository ID, ref, subdirectory, or skills (name is immutable), then **repush every agent that references it**. Re-binds the GitHub ID when the source changes or the row is unbound (the repair path for historical rows); clearing it is refused. A GitLab source is re-resolved on every edit and keeps its stored credential while GitLab is unreachable; an other-host source is re-admitted on syntax alone.                                                                                                                                                                                                                                                                |
| `PUT /skill-sources/:id/sharing`     | Set `ResourceVisibility`, matching MCP providers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DELETE /skill-sources/:id`          | Delete a source only when no agent references it; otherwise return 409 and require explicit unselection first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `GET /skill-sources/:id/skills`      | Best-effort `SKILL.md` scan for the per-agent skill picker, with the same per-host rules as preview.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

#### Sharing hides a source from the registry, never from the agent that runs it

Sharing governs the **registry**: `GET /skill-sources` and
`GET /skill-sources/:id` apply `canView` on the source, so a restricted source is
invisible to a collaborator it was not shared with. It does **not** govern what an
agent already installs. The definition rides inline on that agent's `AgentSpec`
regardless, so hiding it from the agent's own page buys no confidentiality (a
source string carries no secret; a private source's access is the code host's,
not the row's) and only leaves an unexplained row on the Tools & Skills tab.

`GET /agents/:id/skill-sources` therefore resolves the agent's enable-list refs
gated on **viewing the agent**, returning a slimmer DTO without the source's own
`visibility`/`sharedWith` (seeing an agent does not entitle the caller to the
source's share set). It does carry the source's `credential` as `{provider}` or
`null`, so the console can mark an anonymous other-host source "trusted by URL"
even when it is hidden from the caller's library. Refs to a source that no longer exists resolve to nothing and
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
stricter: every historical row must pass the current `AgentSkillEntry` schema,
so a GitHub row must carry `githubRepoId` and a credential must match its host. A failing row is omitted individually with a warning and is
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
- **Tracking versus pinned refs:** a ref written as a commit SHA is **pinned** —
  it is never re-read, and the retention below is its whole story. Anything else
  (a branch, or no ref at all) is a **tracking** ref: every workspace preparation
  asks where that head is now, so a new session starts on the current content
  without anyone editing the source. Preparation runs on each new session — a
  cold host prepares before spawn, a warm host prepares inside
  `openRuntimeSession` — so an already attached session keeps the skills it
  loaded and the next session gets the new ones.
- **Asking is cheap, moving is not:** the question is one bounded API read (a bare
  SHA), answered from a daemon-wide per-(repository, ref) cache with a short TTL,
  refreshed with a conditional request whose 304 costs no primary rate-limit
  budget, and shared by concurrent askers. Only a moved head invalidates the plan
  and pays for an acquisition; an unchanged head keeps the unchanged fast path.
- **The swap happens under a live host:** a tracking head that moved is applied by
  the preparation the new session runs, which is the one place the installer's
  remove/publish transaction can reach a workspace whose host is already serving
  other sessions. Preparations are serialized per agent, and an attached session
  keeps the skills it loaded, but a turn that invokes a skill during the publish
  itself can see that one bundle briefly absent. Deferring the swap until the
  agent is idle would close that window at the cost of never updating a busy
  agent; a deployment that wants neither pins the ref.
- **Unknown keeps what is installed:** a failed or rate-limited resolution is not
  a change and not a failure. The daemon answers with the last known commit — or
  with nothing on a first install — so a GitHub outage never rebuilds, and never
  costs an agent the skills it already has.
- **Resolution retention:** the first successful acquisition records the exact
  commit for the normalized repository/ref identity. A definition whose head has
  not moved retains that commit even when a local/runtime/display/selection
  change forces the installer to rebuild its output; reacquisition then requests
  that exact commit rather than whatever the branch points at mid-rebuild.
  Changing the repository or ref creates a new acquisition identity and resolves
  it afresh.
- **Byte binding after acquisition:** every successful install is bound to an
  exact source snapshot, CLI-output manifest, and live installed-tree digest.
  Immutable managed/Dream sources also put their upstream content digest in the
  plan fingerprint.
- **Cross-daemon consistency:** a commit SHA or immutable managed revision gives
  deterministic source bytes. Two daemons preparing a tracking ref at different
  moments can sit on different commits, and each one's own sessions are
  self-consistent because a resolved commit is what the acquisition and the
  ledger record. A deployment that needs every daemon on identical bytes pins the
  ref to a SHA, which is exactly what pinning is for.
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
Every source is first copied with a bounded no-follow walker into a private
snapshot, and the CLI never receives a remote URL or credential.

Each Git entry is first resolved to an exact commit
([source-cache.md](source-cache.md) §5): a credentialed source by the daemon
through `CodeHostRepository.resolveRef` with a token scoped to that one
repository, an anonymous github.com source by the daemon's anonymous REST
identity check, and an anonymous source off GitHub by one scoped
`git ls-remote`. Where the bytes are then fetched depends on the runtime:

- **In the pod.** On a pool member whose shim advertises `skill-git-in-pod-v1`,
  the shim clones each Git source itself through the Source Cache
  ([source-cache.md](source-cache.md) §6.1, §8): blobless, at the planned
  commit, checking out only the subdirectory. The pod also runs the
  `ls-remote` for an anonymous source off GitHub, and a credentialed GitLab
  source goes in-pod only to a shim that also advertises `skill-git-gitlab-v1`.
  The staged checkout reaches the CLI only through the same bounded no-follow
  snapshot, with the same limits and the same rejection of links and special
  files. Whatever a pod cannot carry stays on the daemon path.
- **On the daemon.** Self-hosted daemons, executors, and older shims acquire on
  the daemon:
  - A GitHub source begins with anonymous GitHub requests and falls back to the
    agent's repository-scoped read token only for a private source (or a
    GitHub-App workspace hitting a rate limit). It resolves the requested ref to
    an exact GitHub commit, accepts only the matching repository/commit redirect
    to canonical `codeload.github.com`, and downloads that archive.
  - A credentialed GitLab source downloads the project archive by numeric
    project id at the resolved commit, with the agent's GitLab read token in a
    request header and redirects refused.
  - An anonymous source on any other host is fetched by the same bounded Git
    acquisition the shim runs, in a daemon-private directory, at the commit its
    `ls-remote` named.

  Archives are validated for bounded size, expansion ratio, entry count, paths,
  types, and extraction inventory. Links and special files are rejected.
  Repository metadata never enters the local source snapshot.

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
- A changed plan replaces only bundles whose file manifests changed. A desired
  bundle with the same manifest, verified live bytes, recorded directory identity,
  and contained workspace path remains in place while its source record advances.
  Untouched bundles stay in the journal's prior set for rollback and do not spawn
  mutation helpers. A missing or modified bundle still follows the normal
  installation or ownership-refusal path.
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
- **A failure to build a source never costs the agent that skill.** An install that
  cannot acquire a source, or whose CLI faults, says nothing about whether the
  operator still wants the skill — only that this run could not rebuild it — and the
  bytes already published are that same source's own older commit. So:
  - a git source that cannot be acquired keeps its published bundles exactly as they
    are (no republish, no removal); the run records the error, keeps naming the
    installed commit in the ledger, and writes a failed fingerprint so the next
    preparation retries. Its siblings still install normally: one unavailable source
    is not a reason to strand the others;
  - a removal is a different statement and is still enacted: a source the desired set
    no longer names has no candidate and is not preserved, so its bundles go. That
    removal needs no source, which is why it can be honored while another fails;
  - the whole-run failure path (anything that throws past the per-source handling)
    keeps what is published, because a published bundle's source key names its
    acquisition identity rather than its repository — that pass cannot tell a
    re-pinned source from a removed one, and must not guess. Pruning waits for the
    next run that actually computes a desired set. An EMPTY desired set is the
    exception: that is a complete statement, and disabled executable content must not
    survive it.
  - A ref check that cannot be answered is likewise not a failure: it resolves to the
    installed commit and nothing is rebuilt. A refused stale removal, corrupt journal, or failed rollback blocks the
    workspace so disabled executable instructions cannot remain silently active.
- A tracking Git ref is re-resolved per preparation but fetched only when its head
  moved: the resolved commit participates in the plan fingerprint, so an unmoved
  head still takes the unchanged fast path and a moved one cannot be served from
  the previous commit's tree. A pinned ref is never re-read. Local Dream content
  and managed revision digests participate in the plan fingerprint too.
- **Each skipped Git source is reported.** After a reconcile that commits and
  covers at least one Git source, the daemon sends `agent/skill-status` to a
  Control Plane that advertises `agent-skill-status-v1`: every Git source it
  could not install, by name, with one enumerated reason code
  (`resolution_failed`, `access_denied`, `ref_moved`, `commit_unavailable`,
  `sha_fetch_refused`, `fetch_failed`, `limits_exceeded`, `cli_failed`), never
  Git's or the CLI's raw output. Codes come from tagged failures
  (`skills/skill-source-failure.ts`); the in-pod path reports the shim's own
  code. An installed source whose resolution failed keeps its commit and is not
  reported, and a reconcile that throws reports nothing. The Control Plane
  replaces the agent's stored set with each report (`agent_skill_source_status`),
  so a source that installs loses its row, and serves it at
  `GET /agents/:id/skill-source-status`, limited to sources the agent still
  enables ([source-cache.md](source-cache.md) §11).

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
- **Import from a Git URL** (`CreateGitUrlSkillSourceModal` in
  `SkillSourcesCard.tsx`, also in the agent card's Add menu) takes a GitLab
  project or any HTTPS address plus optional ref and subdirectory. Its preview
  either lists the scanned skills to pick from, with branch and tag suggestions,
  or, when the source is not `resolvable`, explains the "trusted by URL" trust
  and keeps a typed skill filter.
- Each Git **Skills library tile** shows the source name, source/ref,
  visibility, and created date, with the existing Edit and Delete controls. An
  anonymous source off github.com carries a **trusted by URL** badge
  (`isTrustedByUrl` in `lib/skill-source.ts`), on the tile and on the agent's
  skill row; a Control Plane that omits `credential` shows no badge.
  Managed-skill tiles expose immutable revision history and archive/restore in
  the same card. There is no separate installer-facts or reinstall UI contract.
- The agent editor includes a **Skills selector** beside MCP server selection.
  Selection is at **skill granularity**: visible sources are groups, with
  individual skill checkboxes below each group. "Select all" on a group means
  `<source>/*`. A source that cannot be scanned takes a typed skill list
  instead and refuses names outside the source's own saved filter. Each source's row shows the
  latest reason code from `GET /agents/:id/skill-source-status` with readable
  text; an older Control Plane's 404 reads as no failures.
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
- **Credentials:** the Control Plane uses a GitHub App token for GitHub
  preview scanning and for binding a private GitHub source, and the managed
  GitLab connection's token for a private GitLab project. Enabling a
  credentialed source is the agent's read grant, and the Control Plane serves
  only a read token scoped to that one repository or project: `contents:read`
  for GitHub, and for GitLab a read token under a `read` clamp, its agent
  account a Reporter member of the project. `gitcred` issues it only inside a
  skill credential window the daemon opens for the pod or for its own fill
  ([source-cache.md](source-cache.md) §8); the per-agent helper capability the
  runtime holds is refused for a private skill repository, and the refusal is
  audited. On the daemon path a GitHub acquisition starts anonymously and
  retries the numeric identity request through the URL-scoped helper when the
  source is private or the agent's workspace is a GitHub-App checkout. The CLI
  cell receives no Git/provider token, proxy, SSH agent, npm config, or
  ambient HOME.
- **Trusted by URL:** an anonymous source off github.com (a public GitLab
  project or any other host) has no identity check, so whoever controls that
  address controls the skill. The console marks such a source, the operator's
  `workspaceGitAllowedOrigins` decides which origins a daemon may contact, and
  every fetch is anonymous, redirect-free, and bounded. **The Control Plane
  makes no network request to a user-typed address**: it admits, previews, and
  lists such a source without contacting it, and the daemon delegates
  resolution to the pod that will fetch the source whenever it can. The Source
  Cache's own boundaries are in [source-cache.md](source-cache.md) §6.
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
  evaluation to use the Linux SRT/bwrap sandbox. The agent's execution strategy
  and the daemon's strategy table (`sandbox.host: false` withdraws unsandboxed
  sessions) remain the operator's isolation controls. The skills CLI and other
  narrowly untrusted helpers retain their own audited isolation cells.
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

| Package       | Files                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Change                                                                                                       |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| protocol      | `frames/agent.ts` for strict and rolling-compatible inline skill entries and `SkillSourceCredential`; `git-url.ts` (`normalizeSkillSource`, `isGitHubSkillSource`) for source normalization; `frames/skill.ts` for `agent/skill-status` and `SkillSourceFailureCode`                                                                                                                                                                                                                                                                                                                                                                                                | **No** `skillsource/*` frame and **no** `RegisterOk.skillSources`; sources are inline in `AgentSpec.skills`. |
| control-plane | `prisma/schema.prisma` for the `SkillSource` registry, its credential reference, `agent_skill_source_status`, and `Agent.skills`; `http/routes/skill-sources.ts`; `orchestrator/skillSource.ts` for per-row projection/filtering, other-host admission, and source-change fan-out; `github/service.ts` for GitHub preview scanning and read grants; `gitlab/skill-source.ts` and `gitlab/gitcred.service.ts` for GitLab admission, preview, and read grants; `ws/handlers/agent-skill-status.ts` and `GET /agents/:id/skill-source-status` in `http/routes/agents.ts` for failure status                                                                            | Sections 3 and 4                                                                                             |
| daemon        | `src/skills/install-skills.ts`, `skills-cli-cell.ts`, `skill-source-snapshot.ts`, `skill-git-source.ts`, `gitlab-skill-source.ts`, `skill-git-hosted.ts`, `pod-skill-ref.ts`, `sandbox-skill-reconcile.ts`, `skill-source-failure.ts`, `skill-install-ledger.ts`, `skill-workspace-mutation-cli.ts`, `skill-workspace-mutator.ts`, `offline-sandbox.ts`, `dream-skills.ts`, and `runtimes/skills-capability.ts`; `shim/skill-git-acquire.ts` and `shim/skill-handler.ts` for in-pod acquisition; `workspace/workspace-manager.ts` as the cold-host trigger; `workspace/git-exclude.ts` for the managed-bundle exclude block (section 6.6); exact bundled dependency | Section 6                                                                                                    |
| web           | `SkillSourcesCard.tsx`, `AgentSkillsCard.tsx`, `ManagedSkillTile.tsx`, `ToolsHubView.tsx`, `lib/skill-source.ts`, `lib/api.ts`, `lib/data-context.tsx`, and the agent editor                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Section 7                                                                                                    |
