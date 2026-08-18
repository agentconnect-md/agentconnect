# Multi-Repository Workspaces: Secondary Roots and Cross-Repository Review

> **Status:** Proposal.
>
> Today an agent's workspace is exactly one repository. Additional repositories
> exist only as an authorization allowlist
> ([agent-multi-repo-authorization.md](agent-multi-repo-authorization.md)) —
> `git` and `gh` can reach them, but nothing is checked out locally. Two
> consequences: a GitHub review of an authorized-but-secondary repository has no
> trusted checkout and degrades to a "revision-only" empty directory, and an
> ordinary session cannot read the secondary repositories at all except through
> the network.
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
  self-hosted shape is proven. Reviews on pool members keep the revision-only
  fallback until then.
- Submodule nomination, daemon-managed submodule initialization, sparse or
  partial clones, and per-root `agentDir`.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                 | Why                                                                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Authorized ⇒ present.** Every `AgentRepoAuthorization` row is a secondary workspace root, except one that is a submodule of another root (decision 11). There is no separate materialization list and no toggle. Removing the row removes the root.                                                                                                                                                                    | Mirrors `--add-dir`, where granting access and adding the directory are one act. One list to reason about; the console's Workspace card already presents the rows as "additional repositories."                                                                                                                                             |
| 2   | **The daemon learns the set from the agent spec.** `AgentSpec.workspace` (both `github` and `scratch` variants) gains `additionalRepos: [{ repoFullName, repoId }]`, projected by the CP spec assembler from the rows. `agent.json` carries the same field. Branch is not projected: the daemon resolves `origin/HEAD` at clone time.                                                                                    | The CP is the authority on the rows; the daemon needs the set before a session starts, not at first token mint. Numeric `repoId` keeps the root stable across renames, matching the minting path.                                                                                                                                           |
| 3   | **One `WorkspaceRoot` abstraction in the daemon; the primary is just the first root.** A root is `{ repoFullName, cloneUrl, path, worktreesPath, gitCredential }`. `prepareRoot`, `fetchReviewRevision`, `addSessionWorktree`, `removeSessionWorktree`, origin convergence, and the safe-config audit are parameterized by root instead of reading `agent.workspace.path`.                                               | Every guarantee the primary earned (trusted-origin convergence, unsafe-config refusal, exact-SHA verification, symlink checks) applies to secondaries by construction rather than by copy.                                                                                                                                                  |
| 4   | **Isolation applies to every root uniformly.** `shared` ⇒ every root's clone is the session directory; `session` ⇒ every root gets its own per-session worktree keyed by the same session id. Review sessions already force `session`.                                                                                                                                                                                   | A session-isolated agent that could still scribble on a shared secondary clone would defeat the isolation it asked for. Uniformity also keeps cleanup one rule.                                                                                                                                                                             |
| 5   | **`cwd` is the root the session is about; the others ride as `additionalDirectories`.** Ordinary sessions: primary (or its `agentDir`) is `cwd`, secondaries additional. A GitHub hook session whose repository is a secondary root: that root's checkout is `cwd`; the primary and remaining secondaries are additional. A scratch workspace with secondaries: the scratch dir is `cwd`, secondaries additional.        | The prompt's "verify `git rev-parse HEAD`" contract and every path-relative tool assume the reviewed repository is where the runtime stands. Additional directories widen scope without moving that anchor.                                                                                                                                 |
| 6   | **Cross-repository review = the same-repository review with the root swapped.** `prepareGithubReviewWorkspace` resolves the hook repository to a root; found ⇒ `fetchReviewRevision(root, …)` + exact worktree as `cwd`, prompt unchanged ("Trusted review workspace"); not found (grandfathered hook, clone failure) ⇒ today's revision-only fallback, unchanged.                                                       | With the hook gate requiring workspace ∪ authorized, every legitimately configured review lands on a root; the fallback shrinks to a safety net.                                                                                                                                                                                            |
| 7   | **Lazy materialization, eager membership.** A secondary root is cloned on the first session that needs it (same as the primary today), never at row creation. Clone failure of a secondary does not fail the session: that root is omitted from `additionalDirectories`, logged, and retried next session; a review whose subject root failed to clone falls back to revision-only.                                      | Authorizing a large repository for comment-tier access must not stall the console or block unrelated sessions. Degradation stays local to the affected root.                                                                                                                                                                                |
| 8   | **Layout is self-similar.** Primary: `<agentDir>/workspace` + `<agentDir>/worktrees/<id>` (unchanged). Secondary `acme/infra`: `<agentDir>/repos/acme/infra/checkout` + `<agentDir>/repos/acme/infra/worktrees/<id>`, with the same `<id>` across every root of a session. Roots not in the current set are garbage-collected at reconcile. See "Directory layout" below.                                                | Existing paths, console links, and idle-sweep logic keep working; secondaries are readable to a human and to the model (`additionalDirectories` are shown by basename), and a rename simply produces a new directory while the old one is collected.                                                                                        |
| 9   | **Credentials do not change.** `git` in a secondary root routes by URL, `gh` by argv (with the cwd origin now resolving inside secondary worktrees), both to the existing per-repository minting with the row's tier clamp. A `read`-tier root is writable on disk but cannot push.                                                                                                                                      | The authorization design already solved delivery; this design only adds a place for the files to live.                                                                                                                                                                                                                                      |
| 10  | **The prompt names the roots.** The session's standing context lists each additional directory with its repository and branch, and — for review — states that only `cwd` is the reviewed revision while the rest are default-branch references.                                                                                                                                                                          | The model must not mistake a secondary's default branch for the PR's base or head; the trust text stays revision-addressed.                                                                                                                                                                                                                 |
| 11  | **A submodule is not a root.** After a root is cloned or pulled the daemon reads its `.gitmodules`; an authorized repository whose URL matches a submodule of an existing root is classified as that root's submodule and is **not** materialized under `repos/`. Initializing it stays the agent's job (`git submodule update --init`, credentials routed by URL as today); the daemon does not run submodule commands. | Its content already lives inside the parent checkout, so a standalone root would give the model two copies — one pinned by the superproject, one at the default branch — and a review of a submodule bump would look at the wrong one. Deduplication is enough to keep "authorized ⇒ present" honest without taking on submodule lifecycle. |

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
same shape, which is what lets one `WorkspaceRoot` drive both. A submodule of a
root (decision 11) has no entry here; it lives inside its parent checkout.

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
The CP re-projects the spec without the row; the daemon's next reconcile
removes `<agentDir>/repos/example-co/shared-library*`, prunes its worktrees, and
drops it from future `additionalDirectories`. In-flight sessions keep their
directories until idle sweep.

## Implementation sketch

1. **Protocol / CP** — `AgentWorkspace.additionalRepos` on both variants; spec
   assembler joins the rows; `agent.json` schema mirrors it. Rows already carry
   `repoId` and `repoFullName`.
2. **Daemon workspace-manager** — introduce `WorkspaceRoot`; route the existing
   primary through it unchanged; add `secondaryRoots(agent)`,
   `prepareRoot(root)` (clone / pull / converge origin / audit), root-keyed
   worktree helpers, and reconcile-time garbage collection.
   `additionalWorkspaceDirectories` returns the other roots' session paths (plus
   today's `agentDir` widening).
3. **Daemon review orchestrator** — `githubWorkspaceMatches` becomes
   `reviewRootFor(agent, github)`; `prepareGithubReviewWorkspace` passes the
   root into the existing exact-checkout path; the revision-only branch stays as
   the fallback.
4. **Prompt** — root listing in the standing context; review text gains one
   sentence about additional directories being references only.
5. **Web** — Workspace card wording ("Additional repositories … checked out
   alongside the workspace") and, later, per-root status.
6. **Tests** — workspace-manager multi-root (layout, isolation, GC),
   review-orchestrator cross-repository exact checkout and its fallback,
   spec-assembler projection, prompt snapshot.

## Open questions

- Should a `comment`-tier row materialize at all? It exists for agents that
  only talk on threads. Decision 1 says yes for simplicity; revisit if disk cost
  shows up in practice.
- Ordering of `additionalDirectories` when there are many roots — alphabetical
  by full name is the proposal.
- Whether the console's session detail should render the root list; deferred
  to the web phase.
