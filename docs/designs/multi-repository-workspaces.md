# Multi-Repository Workspaces: Secondary Roots and Cross-Repository Review

> **Status:** Implemented, on self-hosted daemons (phases 1–6) and on cluster
> (pod) daemons (phase 7), `gh` in the pod included.
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

- A per-repository "check out locally" toggle. Authorization already answers
  which repositories belong to the agent; a second list would drift from it.
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
| 1   | **Authorized ⇒ present.** Every `AgentRepoAuthorization` row is a secondary workspace root. There is no separate materialization list and no toggle. Removing the row retires the root (decision 12); a root that is a submodule of another root is materialized but not listed as an additional directory (decision 11).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Mirrors `--add-dir`, where granting access and adding the directory are one act. One list to reason about; the console's Workspace card already presents the rows as "additional repositories."                                                                                                                                                                      |
| 2   | **The daemon learns the set from the agent spec.** `AgentSpec.workspace` (both `github` and `scratch` variants) gains `additionalRepos: [{ repoFullName, repoId }]`, projected by the CP spec assembler from the rows. `agent.json` carries the same field. Branch is not projected: the daemon resolves `origin/HEAD` at clone time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | The CP is the authority on the rows; the daemon needs the set before a session starts, not at first token mint. Numeric `repoId` keeps the root stable across renames, matching the minting path.                                                                                                                                                                    |
| 3   | **One `WorkspaceRoot` abstraction in the daemon; the primary is just the first root.** A root is `{ repoFullName, cloneUrl, path, worktreesPath, gitCredential }`. `prepareRoot`, `fetchReviewRevision`, `addSessionWorktree`, `removeSessionWorktree`, origin convergence, and the safe-config audit are parameterized by root instead of reading `agent.workspace.path`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Every guarantee the primary earned (trusted-origin convergence, unsafe-config refusal, exact-SHA verification, symlink checks) applies to secondaries by construction rather than by copy.                                                                                                                                                                           |
| 4   | **Isolation applies to every root uniformly.** `shared` ⇒ every root's clone is the session directory; `session` ⇒ every root gets its own per-session worktree keyed by the same session id. Review sessions already force `session`. Under an OS boundary the per-session directory is a clone rather than a worktree, one per root under `sessions/<sid>/` — [git-workspace-model.md §11](git-workspace-model.md#11-session-isolation-under-an-os-boundary-decided-2026-09-02).                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A session-isolated agent that could still scribble on a shared secondary clone would defeat the isolation it asked for. Uniformity also keeps cleanup one rule.                                                                                                                                                                                                      |
| 5   | **`cwd` is the root the session is about; the others ride as `additionalDirectories`.** Ordinary sessions: primary (or its `agentDir`) is `cwd`, secondaries additional. A GitHub hook session whose repository is a secondary root: that root's checkout is `cwd`; the primary and remaining secondaries are additional. A scratch workspace with secondaries: the scratch dir is `cwd`, secondaries additional.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | The prompt's "verify `git rev-parse HEAD`" contract and every path-relative tool assume the reviewed repository is where the runtime stands. Additional directories widen scope without moving that anchor.                                                                                                                                                          |
| 6   | **Cross-repository review = the same-repository review with the root swapped.** `prepareGithubReviewWorkspace` resolves the hook repository to a root; found ⇒ `fetchReviewRevision(root, …)` + exact worktree as `cwd`, prompt unchanged ("Trusted review workspace"); not found (grandfathered hook, clone failure) ⇒ today's revision-only fallback, unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | With the hook gate requiring workspace ∪ authorized, every legitimately configured review lands on a root; the fallback shrinks to a safety net.                                                                                                                                                                                                                     |
| 7   | **Lazy materialization, eager membership.** A secondary root is cloned on the first session that needs it (same as the primary today), never at row creation. Clone failure of a secondary does not fail the session: that root is omitted from `additionalDirectories`, logged, and retried next session; a review whose subject root failed to clone falls back to revision-only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Authorizing a large repository for comment-tier access must not stall the console or block unrelated sessions. Degradation stays local to the affected root.                                                                                                                                                                                                         |
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
    └── example-co/shared-library/
        ├── .materialization.json               # {repoId, repoFullName, branch}: rename / branch change rebuilds
        ├── checkout/                           # secondary clone at origin/HEAD (the .git lives here)
        └── worktrees/<sid>/                    # its per-session worktree, same <sid> as the primary's
```

`(workspace, worktrees)` and `(repos/o/r/checkout, repos/o/r/worktrees)` are the
same shape, which is what lets one `WorkspaceRoot` drive both. A submodule root
(decision 11) has the same entry but is never listed as an additional directory;
ordinary sessions reach its content through the parent's submodule path.

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
| `readFile` / atomic `writeFile`                     | materialization marker, the session-cwd attestation     | `node:fs`     | memory-fs `read` / `commit`                                                                                                                 |
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
