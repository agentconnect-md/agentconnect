# Shared Skills: Install Control Plane Sources into the Repository with `npx skills`

> **Status:** Proposed, 2026-07-20. v2 replaces v1's custom cache and
> per-runtime symlink installer with `npx skills`.
>
> **Scope:** protocol + control-plane + daemon + web
>
> **Requirement mapping:**
>
> 1. The Tools & Skills page offers **Import from GitHub** and records a skills
>    source, either a repository or an install directory inside one. See the
>    Control Plane registry in section 4 and Web changes in section 7.
> 2. After the daemon finishes cloning a workspace repository and before it
>    starts an ACP host, it runs `npx skills` to install the skills enabled for
>    that agent into the workspace. The CLI chooses the runtime-specific
>    destination. See section 6.
> 3. Version management uses refs embedded in source URLs plus
>    `npx skills update`, with the weak guarantees documented in section 5.
>
> **Separate managed-artifact path:**
> [organization-knowledge.md](organization-knowledge.md) defines centrally
> accepted, immutable `.skill` bundles mined by Dream. Those bundles use a
> digest-addressed daemon cache and explicit per-agent enablement; they do not
> change this document's Git-source registry or `npx skills` flow.

## 0. Why this design replaces v1

v1 proposed a custom content-addressed cache plus a separate symlink installer
for every runtime: `.claude/skills` for Claude, `$CODEX_HOME/skills` for Codex,
and system-prompt injection for others. The `npx skills` CLI from
[vercel-labs/skills](https://github.com/vercel-labs/skills) already implements
that machinery:

- It supports more than 73 agents, including `-a claude-code`, `-a codex`,
  `-a cursor`, `-a opencode`, and `-a gemini-cli`. The CLI maintains each
  agent's directory convention, so AgentConnect need not track destinations per
  runtime.
- Sources may be an `owner/repo` shorthand, a complete GitHub, GitLab, or
  arbitrary Git URL, a `tree/<ref>/<subdir>` path to a specific skill
  directory, or a local path.
- Installation creates a **symlink** to one canonical copy by default;
  `--copy` creates a copy instead.
- Non-interactive flags include `-y` to skip confirmation, `-a` to select an
  agent, and `-s/--skill` to select particular skills.

The daemon's responsibility therefore reduces to one rule: **after the
workspace is ready and before spawning the runtime, run `npx skills add` once
for each source enabled for that agent**. The Control Plane likewise records
only sources; it does not scan content, store bodies, or mint versions.

**Cost and known weakness:** `npx skills` has **no lockfile or built-in version
pinning** and fetches the source on each installation. This is weaker than v1's
SHA pinning. Mitigations are a branch, tag, or even a commit
`tree/<sha>` embedded in the source URL, plus daemon-side caching and failure
fallback around the `npx` result. The design no longer promises byte-for-byte
consistency across daemons. Sections 5 and 8 describe this deliberate tradeoff
for simplicity.

## 1. Current state and gap

- **Web:** the "Skills library" on the Tools & Skills page at
  `packages/web/src/app/(app)/[slug]/tools/page.tsx` is entirely mocked.
  `ToolsHubView.tsx:17` uses
  `const skills = MOCK_MODE ? SKILLS : []`, and `AddSkillModal` is a placeholder.
- **Control Plane:** there is no skill-related Prisma model, REST route, or
  protocol frame.
- **Daemon:** `workspace.skills: string[]` in `agent-schema.ts:204` is an
  **orphaned field** that is declared but never connected. This design takes it
  over. The daemon never writes skills into any runtime directory today.

Existing building blocks to reuse:

| Building block                                                    | Location                                                       | Reuse                                                         |
| ----------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| Organization registry, visibility, and bidirectional distribution | `McpProvider`, `mcpserver/upsert`, and `RegisterOk.mcpServers` | Copy the data model, wire shape, and reconciliation semantics |
| Workspace clone/pull with simple-git and single-flight            | `prepareWorkspace` in `workspace/workspace-manager.ts`         | Trigger skill installation **after cloning**                  |
| Short-lived GitHub App credential injection                       | `workspace/git-injection.ts` and `cp/gitcred-server.ts`        | Credentials for private repositories fetched by `npx skills`  |
| GitHub repository selector from installation to picker            | `AddAgentRepoModal.tsx` and `http/routes/agent-repos.ts`       | Import-from-GitHub UI and backend                             |
| Per-agent enablement list and distribution                        | `AgentSpec.mcpServers` and `mcp-push.ts`                       | Agent-to-skill binding and push                               |

## 2. Goals and non-goals

**Goals:**

- Make the Control Plane the single source of truth for skill **sources** at
  organization scope, with `ResourceVisibility` matching MCP providers, agents,
  and crons. It stores only the source, not its content.
- Enable skills per agent at **skill granularity**, rather than enabling an
  entire repository unconditionally.
- Use `npx skills` after clone and before host startup to install into the
  workspace, delegating runtime destinations to the CLI.
- Never prevent an agent from starting because installation failed or the
  network is unavailable. Installation is best effort and reported.

**Non-goals for v1:**

- A custom cache or per-runtime symlink installer; v1 considered these and now
  delegates them completely to `npx skills`.
- Strong version consistency through byte-for-byte SHA pinning; see section 5.
- Editing skill content in the Console. Editing means changing the source
  repository through a pull request.
- A skills marketplace, cross-organization sharing, or automatically installing
  a skill derived from a conversation. Owner-reviewed Dream candidates are a
  separate managed-artifact flow.

## 3. Shape of a skill source

One source is a string accepted by `npx skills add`, plus an optional selection
of skills to install:

- `owner/repo` installs every skill from the repository.
- `owner/repo` with `skills: ["review-pr", "safe-deploy"]` installs only those
  skills through `-s`.
- `https://github.com/owner/repo/tree/<ref>/<subdir>` points directly to a
  directory or ref inside the repository.
- Any Git URL or GitLab source is supported by the CLI. The v1 UI optimizes the
  GitHub import flow and falls back to a manually entered URL for others.

The CLI discovers skills; the Control Plane **does not parse `SKILL.md`**. If
the Console wants a checklist of skills, a best-effort GitHub Trees API call
may scan for `SKILL.md` and return candidates as described in section 7. If the
scan fails, the UI falls back to installing all skills.

## 4. Data model and REST API in the Control Plane

The model is **deliberately thin**. The Control Plane records only sources.

### Prisma

```prisma
// Organization-scoped skill-source registry. name is unique within an
// organization and is the key referenced by an agent's enablement list.
model SkillSource {
  id              String             @id @default(uuid()) @db.Uuid
  orgId           String
  name            String             // Defaults to repository name; editable; @@unique([orgId, name])
  source          String             // Passed to `npx skills add`: owner/repo, Git URL, or tree/<ref>/<subdir>
  githubRepoId    BigInt?            // Numeric GitHub ID prevents rename or recreation takeover
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

There is no `SkillRepoVersion` table, manifest column, or cache. There is
**no secret side table or grant** because skills are content. Private repository
access uses the daemon's existing short-lived GitHub App token path through
`gitcred-server`; the Control Plane stores no long-lived credential.

### Per-agent binding: inline source definitions in `AgentSpec` and `agent.json`

The key decision is that **all information the daemon needs to run
`npx skills`--source URL, ref, subdirectory, and selected skills--is inlined in
the agent spec and persisted to `agent.json`**. Source definitions are not
pushed independently, and the daemon keeps no source-definition cache.
`SkillSource` is only the Control Plane's editing and management surface and
source of truth. When distributing an agent, the Control Plane resolves enabled
sources into self-contained entries in `AgentSpec.skills`:

```prisma
// The Control Plane stores which sources and skills the agent enables by name.
// Distribution resolves references into self-contained entries.
model Agent {
  // Existing fields...
  skills Json @default("[]")  // AgentSkillEnable[], or references joined during push
}
```

`AgentSpec.skills`, which is also the shape persisted in `agent.json`, is an
array of **self-contained entries**, not a list of names:

```jsonc
"skills": [
  {
    "name": "platform-skills",             // Source name for display and logs
    "source": "acme/platform-skills",      // Passed directly to `npx skills add`
    "ref": "v1.2.0",                       // Optional branch, tag, or commit
    "subDir": "skills",                    // Optional directory inside the repository
    "skills": ["review-pr", "safe-deploy"] // Empty means all skills and omits -s
  }
]
```

By reading only `agent.json`, the daemon can run
`npx skills add <source> -s ...` for every entry as described in section 6,
with **no external dependency**. A Control Plane outage or daemon restart does
not matter because the definition lives beside workspace and runtime
configuration in the agent file.

**Taking over the orphaned field:** deprecate the old local-only
`workspace.skills`, a `string[]` preserved verbatim by `write-agent.ts`.
Migrate it to top-level `Agent.skills`, which is **Control Plane-owned** and
written by `applySpecFields` as `raw.skills = spec.skills`, exactly parallel to
`raw.mcpServers = spec.mcpServers`. Its meaning changes from an unused string
list to self-contained enabled-source entries.

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

| Route                            | Semantics                                                                                                                                                                                                                                                                                                                        |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /skill-sources`             | List sources.                                                                                                                                                                                                                                                                                                                    |
| `POST /skill-sources/preview`    | Import preview. Given `{repoFullName, ref?}`, use the organization's GitHub App token and Trees API to find candidate `SKILL.md` files and return `{refs, skills:[{name,dirPath,description}]}`. This is **best effort and not persisted**, existing only to populate UI checkboxes. Failure still permits importing all skills. |
| `POST /skill-sources`            | Persist a source in the organization registry.                                                                                                                                                                                                                                                                                   |
| `PATCH /skill-sources/:id`       | Change name, source, ref, subdirectory, or skills, then **repush every agent that references it**.                                                                                                                                                                                                                               |
| `PUT /skill-sources/:id/sharing` | Set `ResourceVisibility`, matching MCP providers.                                                                                                                                                                                                                                                                                |
| `DELETE /skill-sources/:id`      | Delete a source. Return 409 while agents reference it, or support `?force=` to detach it from each agent and repush them.                                                                                                                                                                                                        |

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
`npx skills` has no use for. The scp-like `git@github.com:owner/repo` form has no
userinfo and `ssh://git@host/repo` names a role, so both still pass.

Rows stored before that guard are redacted at the agent-scoped response boundary by
`redactSourceCredentials`, which delegates to the protocol's **`redactGitUrlSecrets`**
rather than re-deriving the rules — that codec is total and already handles the last
authority `@`, query/fragment stripping, backslash authority ambiguity, and
malformed historical values. Bare `owner/repo` shorthand is passed through verbatim
(it cannot carry a secret, and the codec would expand it to a full URL). The
registry response and the `AgentSpec` the daemon clones from are untouched — the
daemon needs the real URL.

Writes are unchanged: adding a ref is still gated on seeing the **source**
(`enablingUnseenSkillDenied`, §9). A tile the caller reaches only through the agent
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
2. **A referenced `SkillSource` changes** through a source, ref, skill
   selection, or forced deletion. The Control Plane finds every agent whose
   `skills` refer to it, resolves new inline entries, and emits one
   `agent/upsert` per agent, accepting the section 4 fan-out tradeoff.

The daemon gains no new distribution path. On `agent/upsert`,
`writeAgentSpec` merges `skills` with the other Control Plane-owned fields in
`agent.json`. The next session reads the file directly in `installSkills`.

## 5. Pragmatic version management

`npx skills` has no lockfile or `@version`/`#ref` pin syntax, and
`skills update` means refetching the latest source. Version management can
therefore provide only these guarantees:

- **Ref embedded in the source:** combine `SkillSource.ref` into
  `https://github.com/owner/repo/tree/<ref>/<subDir>`. A tag such as `v1.2.0`
  or a commit SHA is relatively stable. A branch, or no ref and therefore the
  default branch, tracks a moving head. The Console labels a source as either
  "pinned to tag or commit (stable)" or "tracking branch (may drift)."
- **Updates:** changing `SkillSource.ref` explicitly switches versions and
  repushes agents, so their next installation uses the new ref. For a
  branch-tracking source, "Reinstall on next session" clears daemon cache and
  reruns `npx skills add` or `update`.
- **No byte-for-byte consistency across daemons.** Organizations that require
  it should pin sources to a **tag or commit** and treat tagging the skills
  repository as the release action.

If `npx skills` later adds a lockfile or explicit ref pinning, this design can
adopt strong pins without reshaping the agent entry because `ref` is already
reserved.

## 6. Daemon: run `npx skills` after clone and before host startup

### 6.1 Trigger point

The current session startup path is:
`prepareWorkspace(agent)` in `session-manager.ts:426` clones or pulls and
returns `cwd`; `hostFor` calls `ensureHostAsync`; `AcpHost.start()` spawns the
runtime; and `host.newSession(cwd, ...)` creates the session.

Insert **`installSkills(agent, cwd, runtime)`** after `prepareWorkspace`
returns and before `hostFor` or spawn. It may be a post-stage of
`prepareWorkspace` or a separate immediately following step in the session
manager. This precisely satisfies the requirement to install after repository
clone and before ACP host startup.

### 6.2 Command

Read sources directly from `agent.skills` in `agent.json`; the daemon never
looks up an external definition. Construct one call per entry in the new
`src/skills/install-skills.ts`:

```text
npx --yes skills@<pinnedCliVer> add <source> \
    -a <agentId(runtime)> \         # Runtime to skills-CLI agent ID
    -s <skill> [-s <skill> ...] \   # Selected skills; omit -s to install all
    -y --copy \                     # Non-interactive; see section 6.4
    (cwd = agent.workspace.path)    # Project scope installs in the workspace
```

- **Runtime-to-CLI-agent mapping** in new
  `src/skills/runtime-agent-map.ts`: Claude runtimes identified by
  `isClaudeRuntimeDef` map to `claude-code`; `codex-acp` maps to `codex`;
  OpenCode maps to `opencode`; Gemini and Qwen map to `gemini-cli`; Cursor maps
  to `cursor`. An unmapped runtime skips native installation and uses the
  fallback injection from section 6.5.
- **Project scope** is the default because no `-g` is passed. Skills land in
  agent-specific directories under `cwd`, such as
  `<cwd>/.claude/skills/`. `cwd` equals `agent.workspace.path`, the ACP working
  directory, so the runtime discovers them naturally.
- **Pin the CLI version:** `skills@<pinnedCliVer>` fixes CLI behavior and
  prevents an automatic CLI upgrade from introducing drift. Upgrade it as part
  of a daemon release.

### 6.3 Non-blocking, offline-tolerant, and idempotent

- **Never block startup indefinitely:** following the lesson that platform
  connection must not block boot, give `installSkills` a timeout such as
  20 seconds per source. Failure or timeout starts the host **without that
  skill** and reports the error through `facts/skill-install` in section 6.6.
  The first session may not contain a skill that is still installing; later
  sessions use it after installation succeeds.
- **Idempotence and caching:** hash
  `(agentId, source set + refs + selected skills)` and store it in a new
  `skill_install` table in `state/local.sqlite`. If the fingerprint is
  unchanged and target directories exist, skip all `npx` calls. Rerun only when
  enablement, a ref, or a Console "Reinstall" request changes the fingerprint.
  Normal sessions then incur zero network cost.
- **npx cache:** reuse the host's npm cache. The daemon may optionally warm it
  by running `npx skills --version` at startup.
- **Credentials:** private-source cloning uses the existing
  `git-injection.ts` credential helper. `GIT_CONFIG_GLOBAL` points at
  `agentconnect git-credential`, backed by a short-lived GitHub App token from
  the daemon's `gitcred-server`. The Git call underneath `npx skills` inherits
  it automatically.

### 6.4 Symlinks, `--copy`, and a clean worktree

- Use **`--copy`** by default. Workspaces are often temporary or rebuildable
  clones, while a symlink would target a canonical copy under the user's home
  directory with a different lifecycle. A copy makes the workspace
  self-contained and more hermetic. Deployments prioritizing disk space may
  choose symlinks instead.
- Installing `.claude/skills/`, or the equivalent agent directory, makes a
  Git-backed workspace dirty. Add those paths to `.git/info/exclude` after
  installation rather than changing the tracked `.gitignore`. This keeps
  `git status` clean and prevents an agent from committing skills
  accidentally. From-scratch workspaces do not have this issue.

### 6.5 Fallback for a runtime unsupported by the CLI

For a runtime with no mapped `npx skills` agent ID, copy the skill directory to
the neutral `<cwd>/.agentconnect/skills/` path with `--copy`, or use
`npx skills use` with that destination. Then inject an index through the
existing in-band system-prompt path: Claude uses `_meta.systemPrompt`, while
other runtimes use the inline system block at `session-manager.ts:407`, the
same path as memory-index injection. The index contains only each skill's name,
description, and path and tells the agent to read `SKILL.md` when a task
matches.

### 6.6 Facts reporting

Add an additive `facts/skill-install` frame:
`[{agentId, installs:[{sourceName, state: ok|error|skipped, ref?, error?}]}]`.
`sourceName` is the `name` from the `agent.json` entry because the daemon has no
source ID. The Control Plane persists it against the corresponding
`SkillSource` and agent detail, displaying per-agent installation state for
each source, following `facts/daemon-runtimes`.

## 7. Web: Tools & Skills page

Replace mock data with the real surface, following `McpServersCard`:

- **Import from GitHub** opens a modal that (1) selects or enters a repository,
  reusing the installation-to-picker flow from `AddAgentRepoModal` or accepting
  `owner/repo`; (2) optionally selects a branch, tag, or commit ref and a
  subdirectory; and (3) previews candidate skills from the preview endpoint for
  selection, falling back to "install all" if scanning fails.
- Each **Skills library card** shows one source with its name,
  `source @ ref`, pin state--stable tag or commit versus drifting branch--and
  visibility. Actions are Reinstall on next session, Edit, Sharing, and Delete.
  Expanding it shows per-agent installation state from facts.
- Add a **Skills selector** to the agent editor beside MCP server selection.
  Selection is at **skill granularity**: visible sources are groups, with
  individual skill checkboxes below each group. "Select all" on a group means
  `<source>/*`.
- Extend the usual data path with `fetchSkillSources` and related calls in
  `api.ts`, SWR state and actions in `data-context.tsx`, styling under
  `STYLE.md`, and the existing responsive Knowledge-page structure at widths
  of 768 pixels and below.

## 8. Security and trust boundaries

- **A skill is a prompt-injection surface:** imported content enters agent
  context and can drive tool calls. Import and update are therefore
  **privileged operations**, limited to administrators and owners under the same
  permission as MCP-provider management.
- **`npx skills` lays out remote-source content inside a workspace:** sources
  must come from the controlled organization registry. An agent cannot decide
  from conversation text to fetch an arbitrary repository. Pinning the CLI
  version in section 6.2 limits CLI supply-chain drift, and source refs should
  use tags or commits where possible as described in section 5.
- **Credentials:** the Control Plane uses a GitHub App token only for preview
  scanning. The daemon gives Git under `npx skills` credentials through the
  existing short-lived token path. No long-lived secret or new secret
  distribution is added.
- **Workspace isolation:** `--copy` and `.git/info/exclude` keep skills out of
  the tracked tree and out of agent commits.

## 9. Phases

| Phase  | Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **P1** | Prisma `SkillSource` + `Agent.skills`; preview and CRUD REST routes; inline `AgentSpec.skills` entries with no dedicated frame; persistence through `write-agent.ts` as `raw.skills`, including migration from `workspace.skills`; daemon `install-skills.ts` after clone and before host startup, reading `agent.json`, running `npx skills add`, mapping Claude and Codex, using `--copy`, caching idempotently, and never blocking; Web import/list surface and per-agent skill selection. |
| **P2** | More runtime mappings; fallback injection from section 6.5; facts-based installation-state panel; Reinstall action; npx warming; `skills update` integration.                                                                                                                                                                                                                                                                                                                                 |
| **P3** | Strong version pinning if upstream gains a lockfile; cross-validation of restricted visibility against agent enablement; polished non-GitHub import flows.                                                                                                                                                                                                                                                                                                                                    |

## 10. Main change index

| Package       | Files                                                                                                                                                                                                                                                                                                                                     | Change                                                                                                       |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| protocol      | `frames/agent.ts`, where `AgentSpec.skills` is an inline entry array; new `frames/skill-entry.ts` with the `AgentSkillEntry` schema                                                                                                                                                                                                       | **No** `skillsource/*` frame and **no** `RegisterOk.skillSources`; sources are inline in `AgentSpec.skills`. |
| control-plane | `prisma/schema.prisma` for the `SkillSource` registry and `Agent.skills`; new `http/routes/skill-sources.ts`; `orchestrator/` to resolve sources into `AgentSpec` and fan out `agent/upsert` after a source change; `github/` for Trees API preview scanning                                                                              | Section 4                                                                                                    |
| daemon        | New `src/skills/install-skills.ts` and `src/skills/runtime-agent-map.ts`; top-level `skills` in `agents/agent-schema.ts`; `raw.skills=spec.skills` plus `workspace.skills` migration in `agents/write-agent.ts`; trigger in `workspace/workspace-manager.ts` or `session/session-manager.ts`; fingerprint table in `store/local-store.ts` | Section 6                                                                                                    |
| web           | `ToolsHubView.tsx` without mocks; new `modals/ImportSkillSourceModal.tsx` replacing `AddSkillModal`; `lib/api.ts`; `lib/data-context.tsx`; agent editor                                                                                                                                                                                   | Section 7                                                                                                    |
