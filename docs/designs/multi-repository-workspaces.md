# Multi-Repository Workspaces: Secondary Roots and Cross-Repository Review

> **Status:** Implemented, on self-hosted daemons (phases 1–6) and on cluster
> (pod) daemons (phase 7), `gh` in the pod included. Per-authorization
> materialization below is implemented for `always` and `on-demand` rows
> (decisions 13 and 20); installation grants (decision 14) have their
> control-plane half, and the repository selector (decisions 15–19) is
> **proposed, not implemented**.
>
> Before this design an agent's workspace was exactly one repository.
> Additional repositories existed only as an authorization allowlist
> ([agent-multi-repo-authorization.md](agent-multi-repo-authorization.md)) —
> `git` and `gh` could reach them, but nothing was checked out locally. Two
> consequences: a GitHub review of an authorized-but-secondary repository had no
> trusted checkout and degraded to a "revision-only" empty directory, and an
> ordinary session could not read the secondary repositories at all except
> through the network. Neither is the case any more, on either driver.
>
> This design turns the allowlist into **workspace roots**: one primary root
> (today's workspace) plus zero or more secondary roots, materialized by the
> daemon and handed to the runtime as `additionalDirectories` — the same shape as
> Claude Code's `--add-dir` and Codex's multi-directory project, both of which the
> daemon's ACP runtimes already accept. A hook-driven review whose subject lives
> in a secondary root gets an exact, verified checkout of that root as its `cwd`,
> with the other roots alongside as reference.

## Background

- **What already exists.** `AgentRepoAuthorization` rows (agent-level allowlist,
  `read|comment|write`), per-repository token minting keyed by numeric repo id,
  URL-routed `git` credentials, an argv-routed `gh` wrapper, and the GitHub hook
  gate that only lets an agent watch workspace ∪ authorized repositories.
- **What the runtime supports.** ACP `session/new` and `session/load` take
  `additionalDirectories`; the daemon already sends them
  (`AcpHost.newSession`, `WorkspaceManager.additionalWorkspaceDirectories`) but
  today only to widen a sub-directory `agentDir` back to its repository root.
  Both shipped adapters advertise `sessionCapabilities.additionalDirectories`
  (Claude maps it to `--add-dir`; Codex to sandbox roots and skill discovery).
- **What review needs.** `prepareGithubReviewWorkspace` produces an exact
  checkout only when the hook repository equals the workspace repository
  (`githubWorkspaceMatches`); `fetchReviewRevision` and `addSessionWorktree` are
  written against `agent.workspace.path`, the primary clone. Any other
  repository falls to `useRevisionOnlyWorkspace`, an empty directory plus a
  prompt telling the model to inspect the revision through GitHub reads only.

## Non-goals

- A second list beside the authorization rows saying which of them to check
  out. Authorization already answers which repositories belong to the agent; a
  separate materialization list would drift from it. Decision 13 puts the
  choice on the authorization itself, so there is still one list.
- Nesting every repository under one synthetic parent `cwd`. It would change
  the working directory of every existing agent, break `agentDir`, and gain
  nothing the runtimes' own multi-root support does not already give.
- Cluster (pod) daemons in the first phase. Their workspace layer materializes
  one checkout through the shim tunnel; secondary roots there follow once the
  self-hosted shape is proven — see "Phase 7: cluster daemons" below.
- Submodule nomination, daemon-managed submodule initialization, sparse or
  partial clones, and per-root `agentDir`.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Why                                                                                                                                                                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Authorized ⇒ present, for a row whose materialization is `always` (the default).** Every such `AgentRepoAuthorization` row is a secondary workspace root. There is no separate materialization list; decision 13 lets a row choose `decision` or `on-demand` instead, on the row itself. Removing the row retires the root (decision 12); a root that is a submodule of another root is materialized but not listed as an additional directory (decision 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Mirrors `--add-dir`, where granting access and adding the directory are one act. One list to reason about; the console's Workspace card already presents the rows as "additional repositories."                                                                                                                                                                      |
| 2   | **The daemon learns the set from the agent spec.** `AgentSpec.workspace` (both `github` and `scratch` variants) gains `additionalRepos: [{ repoFullName, repoId }]`, projected by the CP spec assembler from the rows. `agent.json` carries the same field. Branch is not projected: the daemon resolves `origin/HEAD` at clone time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The CP is the authority on the rows; the daemon needs the set before a session starts, not at first token mint. Numeric `repoId` keeps the root stable across renames, matching the minting path.                                                                                                                                                                    |
| 3   | **One `WorkspaceRoot` abstraction in the daemon; the primary is just the first root.** A root is `{ repoFullName, cloneUrl, path, worktreesPath, gitCredential }`. `prepareRoot`, `fetchReviewRevision`, `addSessionWorktree`, `removeSessionWorktree`, origin convergence, and the safe-config audit are parameterized by root instead of reading `agent.workspace.path`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Every guarantee the primary earned (trusted-origin convergence, unsafe-config refusal, exact-SHA verification, symlink checks) applies to secondaries by construction rather than by copy.                                                                                                                                                                           |
| 4   | **Isolation applies to every root uniformly.** `shared` ⇒ every root's clone is the session directory; `session` ⇒ every root gets its own per-session worktree keyed by the same session id. Review sessions already force `session`. Under an OS boundary the per-session directory is a clone rather than a worktree, one per root under `sessions/<sid>/` — [git-workspace-model.md §11](git-workspace-model.md#11-session-isolation-under-an-os-boundary-decided-2026-09-02).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A session-isolated agent that could still scribble on a shared secondary clone would defeat the isolation it asked for. Uniformity also keeps cleanup one rule.                                                                                                                                                                                                      |
| 5   | **`cwd` is the root the session is about; the others ride as `additionalDirectories`.** Ordinary sessions: primary (or its `agentDir`) is `cwd`, secondaries additional. A GitHub hook session whose repository is a secondary root: that root's checkout is `cwd`; the primary and remaining secondaries are additional. A scratch workspace with secondaries: the scratch dir is `cwd`, secondaries additional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The prompt's "verify `git rev-parse HEAD`" contract and every path-relative tool assume the reviewed repository is where the runtime stands. Additional directories widen scope without moving that anchor.                                                                                                                                                          |
| 6   | **Cross-repository review = the same-repository review with the root swapped.** `prepareGithubReviewWorkspace` resolves the hook repository to a root; found ⇒ `fetchReviewRevision(root, …)` + exact worktree as `cwd`, prompt unchanged ("Trusted review workspace"); not found (grandfathered hook, clone failure) ⇒ today's revision-only fallback, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | With the hook gate requiring workspace ∪ authorized, every legitimately configured review lands on a root; the fallback shrinks to a safety net.                                                                                                                                                                                                                     |
| 7   | **Lazy materialization, eager membership.** A secondary root is cloned on the first session that needs it (same as the primary today), never at row creation. An `always` row is needed by every session; decisions 13–17 narrow "needs it" to a per-session selection for `decision` rows. Clone failure of a secondary does not fail the session: that root is omitted from `additionalDirectories`, logged, and retried next session; a review whose subject root failed to clone falls back to revision-only.                                                                                                                                                                                                                                                                                                                                                                                                                                   | Authorizing a large repository for comment-tier access must not stall the console or block unrelated sessions. Degradation stays local to the affected root.                                                                                                                                                                                                         |
| 8   | **Layout is self-similar.** Primary: `<agentDir>/workspace` + `<agentDir>/worktrees/<id>` (unchanged). Secondary `acme/infra`: `<agentDir>/repos/acme/infra/checkout` + `<agentDir>/repos/acme/infra/worktrees/<id>`, with the same `<id>` across every root of a session. A root that leaves the set is retired, never deleted outright (decision 12). See "Directory layout" below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Existing paths, console links, and idle-sweep logic keep working; secondaries are readable to a human and to the model (`additionalDirectories` are shown by basename), and a rename simply produces a new directory while the old one is retired.                                                                                                                   |
| 9   | **Credentials do not change.** `git` in a secondary root routes by URL, `gh` by argv (with the cwd origin now resolving inside secondary worktrees), both to the existing per-repository minting with the row's tier clamp. A `read`-tier root is writable on disk but cannot push.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | The authorization design already solved delivery; this design only adds a place for the files to live.                                                                                                                                                                                                                                                               |
| 10  | **The prompt names the roots.** The session's standing context lists each additional directory with its repository and branch, and — for review — states that only `cwd` is the reviewed revision while the rest are default-branch references.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | The model must not mistake a secondary's default branch for the PR's base or head; the trust text stays revision-addressed.                                                                                                                                                                                                                                          |
| 11  | **A submodule root is not an additional directory.** After a root is cloned or pulled the daemon reads its `.gitmodules`; an authorized repository whose URL matches a submodule of an existing root keeps its own root (materialized lazily, decision 7) but is **never handed to a session as an additional directory** — inside an ordinary session it is reachable only through the parent's submodule path. A hook whose subject is that repository's own pull request still resolves to its root and gets the exact checkout as `cwd` like any secondary (decision 6). Initializing the submodule inside the parent stays the agent's job (`git submodule update --init`, credentials routed by URL as today); the daemon runs no submodule commands.                                                                                                                                                                                         | Listing it as an additional directory would give the model two copies — one pinned by the superproject, one at the default branch — and a review of a submodule bump would look at the wrong one. Keeping the root preserves the guarantee that every authorized repository's pull requests review against an exact checkout, without taking on submodule lifecycle. |
| 12  | **Retirement, not deletion.** When a row disappears (or a rename produces a new directory) the root is marked retired: it drops out of every future session's `cwd`/`additionalDirectories` immediately, but nothing on disk is removed. Removal happens only from the idle sweep and only through the existing safe caller: a root's worktree or clone is a candidate solely when **no session or turn holds the root** (as `cwd` or an additional directory — `sessionRetentionActive`), rechecked under `withWorkspaceAdmissionFence` so a session admitted during the awaited Git operations blocks it; then the dirty/unique-commit checks of `removeSessionWorktree` apply (⇒ retained and reported), and the clone is removed only once no worktree remains and it passes the same checks itself. A shared clone with no worktree is protected by the same fence, not by directory presence. A re-authorized repository un-retires in place. | A retired root can still be a live session's `cwd`, and a shared checkout can hold unsaved work; unconditional subtree removal would break the running runtime or discard work that the per-worktree rules already promise never to auto-delete. One cleanup rule for worktrees and clones alike.                                                                    |

## Directory layout

The agent directory today (`<root>/agents/<agent>/`), with only the entries this
design touches:

```
<agent>/
├── .workspace.workspace-materialization.json   # {mode, repo, branch} fingerprint; a change rebuilds workspace/
├── workspace/                                  # primary clone (the .git lives here)
└── worktrees/<sid>/                            # primary's per-session worktree (isolation = session)
```

Proposed — one new subtree, everything else unchanged:

```
<agent>/
├── workspace/                                  # primary root, as today
├── worktrees/<sid>/                            # primary's session worktree, as today
└── repos/                                      # secondary roots, one subtree per authorized repository
    ├── example-co/shared-library/
    │   ├── .materialization.json               # {provider, repoId, repoFullName, branch}: rename / branch change rebuilds
    │   ├── checkout/                           # secondary clone at origin/HEAD (the .git lives here)
    │   └── worktrees/<sid>/                    # its per-session worktree, same <sid> as the primary's
    └── _gitlab/4455667/                        # a GitLab project, keyed by numeric id (see below)
        └── …                                   # the same three entries
```

`(workspace, worktrees)` and `(repos/o/r/checkout, repos/o/r/worktrees)` are the
same shape, which is what lets one `WorkspaceRoot` drive both. A submodule root
(decision 11) has the same entry but is never listed as an additional directory;
ordinary sessions reach its content through the parent's submodule path.

For confined sessions, decision 11 uses each session root's own tree, never a
shared checkout: the selected revision before a fresh checkout or review reset,
and the retained working directory on ordinary resume. Discovery precedes the
next root while checkout may overlap it. An exclusion takes effect only after the
parent finishes successfully; an unavailable parent leaves the authorized root
eligible for its own clone. See [the confined preparation sequence](git-workspace-model.md#the-clone).

The `repos/` subtree above is the agent's own, materialized for shared and
worktree-tier sessions and the console. A confined session does not materialize
it: its clone of each root is taken from the remote at that remote's
current default branch and carries its own attestation, the same
`{provider, repoId, repoFullName, branch}` as `.materialization.json`, inside its
`.git` ([git-workspace-model.md §11](git-workspace-model.md#what-changes-for-a-confined-session)).
An agent whose sessions are all confined therefore has no checkout of a secondary
root, and the console's agent-level view of it reads as an empty checkout, as any
root not yet materialized does.

A GitLab project's subtree is `repos/_gitlab/<project id>` rather than its path
([gitlab-com-integration.md §13.1](gitlab-com-integration.md)): a namespaced
path has any depth, and the numeric id is what a rename cannot change, so the
same directory follows the project and only its origin is converged. `_gitlab`
is not a legal GitHub login, so no GitHub row can collide with it, and the
attestation records `provider` because the two hosts number their repositories
independently. Everything a session or the console sees names the root by its
`repoFullName`; the subtree name is the daemon's placement key alone.

What the runtime is handed at `session/new` (`cwd` plus `additionalDirectories`):

| Session                                                | `cwd`                                                     | `additionalDirectories`                                                             |
| ------------------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| ordinary, isolation `session`                          | `worktrees/<sid>` (or its `agentDir`)                     | every `repos/o/r/worktrees/<sid>` at the default branch                             |
| ordinary, isolation `shared`                           | `workspace`                                               | every `repos/o/r/checkout`                                                          |
| review of a secondary (`example-co/shared-library#42`) | `repos/example-co/shared-library/worktrees/<sid>` (exact) | `worktrees/<sid>` and the other secondaries' `worktrees/<sid>`, default-branch refs |
| scratch workspace with secondaries                     | `workspace` (the scratch dir)                             | secondaries per the isolation rule above                                            |

## Flows

**A. Ordinary session, agent with primary `acme/primary-service` and secondary
`example-co/shared-library`, isolation `session`.**
Daemon prepares the primary worktree (as today) and the secondary worktree at
its default branch, then `session/new { cwd: <primary worktree>,
additionalDirectories: [<secondary worktree>] }`. The model can read and edit
both; pushes to the secondary are governed by its tier.

**B. Pull-request review on the secondary.**
Hook fires for `example-co/shared-library#42`. `prepareGithubReviewWorkspace`
resolves the repository to the secondary root, fetches base/head/merge into
`refs/agentconnect/reviews/<id>/*` of that root's clone, verifies the SHAs,
creates the exact worktree, and starts the session with `cwd` = that worktree
and `additionalDirectories` = [primary worktree]. The prompt reads "Trusted
review workspace … verify `git rev-parse HEAD`", exactly as a same-repository
review. `gh api repos/example-co/shared-library/…` and `git` both route to the
secondary's token.

**C. Row removed.**
The CP re-projects the spec without the row; the daemon marks the root retired
and drops it from every future session immediately. At idle sweep, and only
when no session or turn holds the root (rechecked under the workspace admission
fence), its worktrees go through the existing dirty/unique-commit rules (with
the review-snapshot exemption those rules carry); the
checkout is removed only once no worktree remains and it is itself clean,
otherwise retained and reported. Re-adding the row un-retires the root in place.

## Implementation sketch

1. **Protocol / CP** — `AgentWorkspace.additionalRepos` on both variants; spec
   assembler joins the rows; `agent.json` schema mirrors it. Rows already carry
   `repoId` and `repoFullName`.
2. **Daemon workspace-manager** — introduce `WorkspaceRoot`; route the existing
   primary through it unchanged; add `secondaryRoots(agent)`,
   `prepareRoot(root)` (clone / pull / converge origin / audit), root-keyed
   worktree helpers, and the retire → sweep → remove lifecycle of decision 12.
   `additionalWorkspaceDirectories` returns the other roots' session paths (plus
   today's `agentDir` widening).
3. **Daemon review orchestrator** — `githubWorkspaceMatches` becomes
   `reviewRootFor(agent, github)`; `prepareGithubReviewWorkspace` passes the
   root into the existing exact-checkout path; the revision-only branch stays as
   the fallback.
4. **Prompt** — root listing in the standing context; review text gains one
   sentence about additional directories being references only.
5. **Web** — Workspace card wording ("Additional repositories … checked out
   alongside the workspace"), plus the Workspace tab's root selection: the file
   browser and the git panel read ONE root at a time, chosen by the repository
   dropdown that replaced the breadcrumb's root label. The two scopes are
   independent and both live in the URL — `?repo=owner/repo` names the root (absent
   ⇒ the agent's own workspace) and `?worktree=<sessionId>` names the checkout
   within it — so a link reproduces exactly what its author was looking at. A
   `repo` the agent no longer authorizes falls back to the workspace, and a root
   the agent has not materialized yet reads as an empty checkout rather than an
   error. Editing stays scratch-workspace-only, so a secondary root is read-only
   like any other repository checkout; the pull follows the selected root.
6. **Tests** — workspace-manager multi-root (layout, isolation, GC),
   review-orchestrator cross-repository exact checkout and its fallback,
   spec-assembler projection, prompt snapshot.

## Phase 7: cluster daemons

On a cluster daemon the workspace lives on the sandbox pod's volume, mounted at
the root the pod reports (`/agent` today), and the daemon process runs on
another machine. Every `node:fs` call in `workspace-manager.ts` therefore
inspected the daemon's own disk, which is why the session-worktree path was
refused there (`refuseSessionIsolationInCluster`, a migration guard from the
cwd-coordinates fix, not a design choice) and why phases 3–5 skipped
`sandboxMode`.
Nothing about the pod forbids any of it: the pod's ACP runtime already takes a
per-session `cwd`, `git worktree` is in the exec allowlist, the volume survives
suspend/resume, and git credentials in the pod are routed by URL through the
tunnelled helper — a secondary repository authenticates today.

What was missing is one seam, the filesystem twin of `GitRunner`:

| Op                                                  | Used for                                                | Local         | Sandbox                                                                                                                                     |
| --------------------------------------------------- | ------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `stat` (no symlink follow) → `file / dir / missing` | is `.git` there, does the checkout exist, symlink guard | `lstatSync`   | the memory-fs channel (an added `stat` op; the channel is fd-anchored and already symlink-safe)                                             |
| `readdir`                                           | list `repos/*/*`, judge an empty leftover               | `readdirSync` | memory-fs `readdir`                                                                                                                         |
| `mkdir`                                             | worktrees root, `repos/<owner>/<repo>`                  | `mkdirSync`   | memory-fs `mkdir`                                                                                                                           |
| bounded `readFileBytes` / atomic `writeFile`        | materialization marker, the session-cwd attestation     | `node:fs`     | memory-fs `read` / `commit`                                                                                                                 |
| `rename`                                            | publishing a staged clone                               | `renameSync`  | memory-fs `rename`                                                                                                                          |
| `rmTree`                                            | a broken worktree, a retired subtree                    | `rmSync`      | memory-fs `rm` (fd-anchored, recursive; not the `clearPath` sink, which empties a directory's children by absolute path and keeps the root) |

The memory-fs channel already serves every one of those primitives except
`stat` — including the recursive `rm` that `rmTree` needs — anchored at the
pod's mount and accepting any root below it; it is "memory" only by its current
caller. `clearPath` is not a substitute: it removes a directory's children by
absolute path and keeps the directory, so it can neither retire a subtree nor
leave a rename target absent, and it is not fd-anchored. The channel is renamed (or aliased) to a general
workspace-fs channel rather than duplicated. Containment on the sandbox side is
the shim's fd-anchored descent, which is stronger than the daemon's lexical
checks; the daemon keeps only path composition in the pod's coordinates
(`<mount>/worktrees/<sid>`, `<mount>/repos/<owner>/<repo>/{checkout,worktrees/<sid>}`).
The exec allowlist gains `symbolic-ref`, `branch`, `show-ref` and `ls-remote`,
which the worktree and secondary-root paths already use locally (`show` has no
caller and stays out).

With the seam in place the worktree, secondary-root, retirement and review-cwd
code no longer touches `node:fs` directly and runs unchanged on both drivers;
`refuseSessionIsolationInCluster` and the `sandboxMode` short-circuits are gone,
and the hand-out and GC entry points that used to answer from a synchronous
`existsSync` are asynchronous so the pod can answer them. Shipped as two PRs:
the seam plus session worktrees on the pod (which also gives pool agents an
exact same-repository review checkout for the first time), then secondary roots
and cross-repository review on the pod, then `gh` in the pod: the runtime image
now carries the real `gh` and a wrapper rendered from the daemon's own generator
with the image's paths, which the shim prepends to the runtime's PATH. The token
still comes from the daemon — over the same tunnelled `gitcred` socket the
in-pod Git helper uses, with the same per-repository authorization. The
console's own workspace browsing stays a separate item, and still answers with
no root for a secondary repository on a cluster agent.

## Materialization modes and on-demand repositories

> **Status:** in progress. Decisions 13–20 extend the design above. Change-map
> step 1 has landed: the `materialize` column, its REST surface and its
> projection (`always` and `on-demand` only), the daemon checking out only
> `always` rows with decision 20's clone directory, and **Always** or **On
> demand** on each row in the console. Decision 14 has its control-plane half
> (change-map step 2); decisions 15–19 have not landed.

Decision 1 scales with the number of rows. An organization with a few hundred
repositories that authorizes them all — or that holds an installation grant
covering them all ([agent-multi-repo-authorization.md](agent-multi-repo-authorization.md),
decision 10) — makes every session's preparation clone every root: the agent
checkout pass is sequential with no overall deadline, every confined session pod
clones the whole set again onto its own volume, and a failed root is retried on
every later preparation. The alternative of letting the agent clone what it
needs during the turn fails on quality rather than mechanics: the roots handed
to the runtime at `session/new` are where its instructions (`CLAUDE.md`,
`AGENTS.md`) and skills are read from, and a runtime whose permissions are
fixed at spawn cannot commit in a clone it was not told about. What a session
is about must therefore be known **before the runtime starts**; what it turns
out to need later can be cloned on demand.

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Why                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 13  | **Materialization is chosen per authorization: a repository row is `always` (default), `decision`, or `on-demand`; an installation grant is `decision` or `on-demand`.** `always` is decision 1 unchanged for that row. `on-demand` materializes nothing: the agent clones the repository during the turn when it needs it. `decision` makes the repository a candidate for a selection that runs once per new session, before the runtime starts, and picks which candidates become that session's secondary roots; the other candidates stay on demand for that session. The choice is a `materialize` column on `AgentRepoAuthorization` and on the installation grant, projected into `AgentSpec.workspace` beside each entry. Changing it re-projects the spec: a row leaving `always` retires its root in place (decision 12), and returning to `always` un-retires it. | The set is what grows, and the rows are already the one list the console shows; how much of it a session should stand in belongs on each entry, not in a second list (the non-goal above). An installation grant has no single repository to stand in, so `always` is not one of its options.                                                                         |
| 14  | **An installation grant cannot be `always`.** Its roster is every repository the installation covers, so `always` would clone an installation; the grant chooses `decision` (its roster feeds the selector) or `on-demand` (credentials only), defaulting to `on-demand`. A repository row for a covered repository is independent of the grant and may be `always`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Cloning an installation is exactly the failure this section exists to prevent. A pinned repository inside a covered account is expressed the way it always was: as its own row.                                                                                                                                                                                       |
| 15  | **The selector is a built-in Decision consumer at workspace preparation.** Its candidates are the rows marked `decision` plus the rosters of the installation grants marked `decision`. The agent chooses the evaluator once, `{ providerId, model }` on the Workspace card through the Decision editor's Provider · model picker over the daemon catalog, shown as soon as any authorization is marked `decision`; the daemon generates the question. Candidates are split into chunks of at most 31, each chunk one Choice question of those repositories plus a `none` option, evaluated concurrently within the evaluator's own caps. Following [decisions.md §1](decisions.md), the consumer lives here, in the feature that owns the action; the typed answer is evidence, and the `materialize` choice is the authority that turns it into clones.                     | A saved Decision carries a fixed question of at most 32 options; the candidate list is the agent's and changes with its grants, so the question must be built from it. Chunking is what makes a few hundred candidates one bounded stage rather than one evaluation per repository.                                                                                   |
| 16  | **State is the model-selection state.** The selector reads the same input as [Agent runtime and model selection](decisions.md#106-agent-runtime-and-model-selection): a chat's opening message with the gate's bounded history, or a PR/MR hook's description, commit messages and diff prefix, plus `workspace.primary` naming the primary repository. Candidates appear only in the question's criteria, never in the state.                                                                                                                                                                                                                                                                                                                                                                                                                                                | One state builder for both once-per-session consumers, one set of budgets and truncation rules, and the request stays within the evaluator's 32 KiB.                                                                                                                                                                                                                  |
| 17  | **Selection is relative to `none`, bounded by a cap.** Within a chunk every option whose probability exceeds `none`'s is a hit; hits across chunks are ordered by probability and at most 5 are materialized (a proposal to measure). A chunk in which `none` leads contributes nothing. The primary is always present, and a review session's subject root is always its `cwd` (decision 6) whatever the selector said.                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Probabilities within a chunk sum to one, so a request about two repositories in the same chunk splits its mass between them; an absolute threshold would drop both, while beating `none` keeps both. The cap bounds preparation time the way the clone budget bounds one root.                                                                                        |
| 18  | **No fallback.** When any authorization is marked `decision`, an evaluator that is not ready (`DecisionReadiness` other than `ready`) or an `unavailable` evaluation fails the session's start with a visible error naming the cause. The daemon never treats a failed selection as `always` or as `on-demand`. The console offers **By decision** on a row or grant only while at least one provider is ready, and disables it otherwise.                                                                                                                                                                                                                                                                                                                                                                                                                                    | A silent downgrade would make which repositories a session stands in depend on provider health that nobody can see. The operator chose by decision; a failure of its precondition is theirs to see and fix, exactly as a runtime that cannot start is.                                                                                                                |
| 19  | **The selection is per session and recorded.** The selected set is saved in the session's Decision snapshot beside the model selection, so restart and resume re-materialize the same roots and a later turn does not re-evaluate. The evaluation is recorded as evidence with the session's other Decision evaluations. Widening a running session's roots is a follow-up (see below).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | The runtime's directories are fixed at `session/new`; re-selecting on a later turn would need a host restart to take effect, which is a separate design.                                                                                                                                                                                                              |
| 20  | **On-demand clones live in the session's own directory, and the prompt says where.** A confined session clones into `sessions/<leaf>/repos/<owner>/<repo>`, the place a daemon-materialized secondary would occupy; a worktree-tier or shared session clones into `<agentDir>/clones/<sid>/<owner>/<repo>`, a subtree nothing else enumerates. The daemon makes it only for a session with something to clone and hands it to the runtime as an additional directory. Both go with the session, shared ones too, under a session clone's rules, and are carved into the OS-sandbox boundary like `repos/`. The standing context names the directory, gives one clone command with the host's own URL, says credentials for those repositories are automatic, and lists what is authorized but not checked out (at most 100 rows by name; installation grants by account).     | A clone inside the primary's worktree would show up as untracked work; one under `repos/<o>/<r>/checkout` would race the daemon's own staging. Using the confined session's `repos/` lets the console browser and a key-server host's clone listing find it without new code. Telling the model the rule is what makes on-demand cloning reliable instead of a guess. |

### The selector

**Candidates.** The rows marked `decision` are already in the spec. For the
installation grants marked `decision` the daemon asks the Control Plane once
per selection, over the control WebSocket, for each grant's roster from the
Control Plane's cached `/installation/repositories` pages — `{ provider,
repoFullName, repoId, description?, pushedAt? }`. The reply is control metadata
(names, ids, the descriptions GitHub already publishes), never message content.
It is bounded: at most 512 candidates in all, rows first and rosters ordered by
most recent push, and a roster beyond that is cut with `context.partial` set on
the evaluation's evidence. The daemon caches the reply for the roster's own TTL.

**Question.** One Choice question per chunk. Criteria keys are `r1…r31` plus
`none`, because a full name can exceed the 64-character key limit; each
criterion's text is the repository's full name followed by its description,
trimmed so the whole question stays within its 16 KiB limit. The instructions
are fixed text: choose the repositories this request is about, or `none` when
it is about none of these. The primary repository is named in the state, not
offered as an option.

**Evaluation.** Chunks are evaluated concurrently through the existing
`DecisionEvaluator` with the agent's `{ providerId, model }`, so its four
active evaluations per daemon and five-second deadline per request apply
unchanged; seven chunks are two rounds. The stage runs where the
model-selection evaluation runs: on the serving daemon, before executor
placement and workspace preparation, so on a cluster daemon the session pod
clones only the selected roots. Provider results stay on the data plane.

**Result.** The hits of decision 17 join the `always` rows as the session's
secondary roots and are prepared exactly as the confined or worktree tier
prepares a root today, including per-root failure handling (decision 7). Every
other candidate and every `on-demand` authorization is on demand for that
session. The recorded snapshot holds `{ repoFullName,
repoId, provider }` per selected root, and the prompt's "Additional
repositories" block lists the selected roots as it lists every root today, then
the on-demand rule of decision 20.

### Cluster daemons

Nothing here needs a new pod primitive. The selection runs on the pool member;
`prepareClusterConfinedSession` receives the selected roots instead of the
whole set, so a session pod's clone pass is bounded by the cap rather than by
the number of grants, and the agent pod's `prepareSecondaryRoots` pass prepares
only the `always` rows. The candidate request is a control-plane round trip on the
turn's path, in the same class as `gitcred/request` and the model-selection
`decision/get`.

### Change map

1. **Protocol, Control Plane, web — `materialize` on the row.** The column,
   its REST and console surface, and its projection beside each
   `additionalRepos` entry; `always` and `on-demand` first. The daemon prepares
   only `always` rows, adds the on-demand directory rule and its sweep, extends
   the standing context, and carves the new directory into the OS-sandbox
   boundary. _Landed:_ the protocol and control-plane half — the column
   (default `always`), `materialize` on `POST`/`PATCH` repository grants and on
   each projected entry, a config-revision bump on change, and `decision`
   refused with 400 until step 3; the daemon half — only `always` rows are
   prepared on every tier (`decision` is on demand until step 3), a review
   still checks its subject out as `cwd`, a session with anything on demand is
   handed its clone directory and told of it, and retention judges that
   directory with the session, a shared one included; and the console surface
   — **Always** or **On demand** beside each additional repository in Edit
   workspace and in the add flow, badged read-only on the Workspace card and
   the root picker.
2. **Installation grants** — [agent-multi-repo-authorization.md](agent-multi-repo-authorization.md)
   decision 10, independently mergeable; `on-demand` only until step 3.
   _Landed:_ the control-plane half — the grant table, its owner-only routes,
   `additionalInstallations` projected beside `additionalRepos` (never expanded
   into it), the mint and hook gates, and the refusal that names the grant.
   _Pending:_ the daemon reading the field (standing context, on-demand clones)
   and the console.
3. **`decision`** — the evaluator pair on the agent, the roster request and
   reply frames, chunked question generation, the selection rule, the snapshot,
   evidence recording, the readiness gate, and **By decision** on rows and
   grants in the console.
4. **Public documentation** travels with steps 1 and 3.

Follow-ups filed together once the above lands: re-selection on a later turn
and widening a running session's `additionalDirectories` (a host restart);
whether `comment`-tier rows should be candidates at all; the console's
per-root status for on-demand clones; GitLab group and Gitea organization
analogues of the installation grant.

## Open questions

- Should a `comment`-tier row materialize at all? It exists for agents that
  only talk on threads. Decision 1 says yes for simplicity; revisit if disk cost
  shows up in practice.
- Ordering of `additionalDirectories` when there are many roots — alphabetical
  by full name is the proposal.
- Whether the console's session detail should render the root list. The AGENT's
  Workspace tab now names its root explicitly (the repository dropdown above), so
  what is left open is only the session surface, where a root list would have to
  say which roots that session was actually handed.
- The selector's cap (decision 17) and whether a hit should also need a minimum
  absolute probability. Five roots and "beats `none`" are starting points to
  measure against real sessions, not tuned values.
- Whether a selection that picked nothing should tell the user so in the session,
  or only appear in the evaluation evidence.
