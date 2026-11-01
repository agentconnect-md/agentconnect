# AHP repository picker: choose an agent's repository from an AHP client

> **Status:** Proposal for review.
> **Related:** [ahp-adoption.md](ahp-adoption.md), [ahp-client-sign-in.md](ahp-client-sign-in.md),
> [multi-repository-workspaces.md](multi-repository-workspaces.md).

## 1. Problem

The target VS Code flow is: pick a team agent, pick one of its repositories,
describe a task, and receive a PR. VS Code's Agents window cannot create a
session without a workspace folder. For a remote agent host it browses the
**host's** filesystem: it starts at `InitializeResult.defaultDirectory` (else a
recent session's folder, else `/`), lists entries with `resourceList`, offers
typeahead over the directories under that start, and sends the chosen folder as
`createSession.workingDirectories[0]`.

Today the daemon answers `resourceList` with `Unknown method`, sends no default
directory, and ignores `workingDirectories` (#3520). The picker is empty and the
choice has no effect.

## 2. Decision

Serve a small **virtual filesystem of the agent's repositories** over the
standard resource commands, and treat the chosen folder as the session's
repository pin. No VS Code change and no extension are needed; any AHP client
with a folder picker gets the same behavior.

## 3. Namespace

Paths are `file:` URIs on the per-agent connection. Nothing maps to the daemon's
real disk.

| Path                     | Meaning                                                           |
| ------------------------ | ----------------------------------------------------------------- |
| `/`                      | Lists `@agent` and one directory per code host with candidates.   |
| `/@agent`                | The agent's configured workspace, with no pin (today's behavior). |
| `/<host>`                | `github`, `gitlab` or `gitea`; lists owners or top-level groups.  |
| `/<host>/<owner>/<repo>` | One authorized repository. GitLab subgroups add path segments.    |

- `@` cannot start a code-host owner name, so `@agent` never collides.
- `defaultDirectory` is `/<host>` when the agent's candidates come from one host,
  so typeahead shows owners first; otherwise `/`.
- A repository directory lists as empty. Browsing a repository's files is out of
  scope (§7).
- `resourceResolve` answers `directory` for every listed path and `NotFound`
  otherwise; other `resource*` writes answer `PermissionDenied`.

## 4. Candidates

The listing is the set the agent may already work in, from existing sources:

- the primary repository (`agent.workspace.gitRepo`);
- every `AgentRepoAuthorization` row, whatever its mode (`always`, `decision`,
  `on-demand`);
- the rosters of installation grants, through the existing
  `repo-candidates/request { grants: 'all' }` frame.

The daemon caches the result per agent for 60 seconds and caps one listing at 500
entries. Typeahead filters only that returned set: `repo-candidates` has no
search or pagination, so a repository beyond the cap, or omitted by a `partial`
reply, cannot be picked here. The agent can still reach it in the turn when its
mode allows (on-demand or the selector). Search over grants is separate work.

Authorization does not widen. The connection is already authorized for this
agent; a repository outside these sources is never listed, and `createSession`
re-checks the choice against a fresh candidate set.

## 5. Sessions over several repositories

A task often spans repositories (frontend and backend, a service and its
library). AHP models that directly: a session owns an ordered
`workingDirectories` set, chats use the whole set unless they narrow it, and a
host advertises the shape it supports in
`AgentCapabilities.multipleWorkingDirectories`. AgentConnect sessions already
run with one working directory (`cwd`) plus secondary roots, so the mapping is:

| AHP                         | AgentConnect                                                                    |
| --------------------------- | ------------------------------------------------------------------------------- |
| `workingDirectories[0]`     | The repository whose checkout is the session's `cwd`.                           |
| `workingDirectories[1..]`   | Further repositories, materialized as secondary roots (additional directories). |
| One chat over the whole set | One agent turn making coordinated changes, one PR per changed repository.       |

The agent advertises `multipleWorkingDirectories: { immutablePrimary: true }`:
the runtime is rooted at `cwd` when the session starts, so index `0` never
changes.

### 5.1 Creating a session

`createSession.workingDirectories` is the user's explicit set:

| Set                               | Session                                                                          |
| --------------------------------- | -------------------------------------------------------------------------------- |
| absent, empty, or `[/@agent]`     | Unchanged: primary repository or scratch, secondaries and the selector as today. |
| `[R]`, `R` the primary repository | Same as `/@agent`.                                                               |
| `[R, S...]`                       | `R` is `cwd`; each `S` is a pinned secondary root.                               |
| any entry not a listed repository | `InvalidParams` naming it; no session is created.                                |

- At most five repositories, the selector's own cap; duplicates collapse.
- Picks are a floor, not a ceiling. The primary repository and `always` rows stay
  mounted, and the selector still runs over the remaining `decision` candidates
  for anything the task needs that the user did not pick. Picks never count
  against what the selector may add beyond the cap.
- The pinned set is stored with the session binding (the provider-neutral form of
  `GithubHookMetadata.repoFullName`, extended to a list) and survives cold resume.
- Base branch is each repository's default branch. The agent opens a PR from a
  session branch in each repository it changes, as it does from Webchat.

### 5.2 Reporting and changing the set

- Session state reports the complete root set it runs with, `cwd` first, as
  namespace URIs: picks, the primary, `always` rows and selector hits. VS Code's
  session list therefore shows every repository the session touches.
- v1 rejects `session/workingDirectorySet`, `session/workingDirectoryRemoved` and
  `session/workingDirectoryReplaced` with `InvalidParams`: secondary roots are
  materialized when the session starts. Adding a repository mid-session reuses
  the on-demand clone path and is follow-up work.

## 6. Where it runs

- **Daemon AHP service:** `resourceList`, `resourceResolve` and
  `defaultDirectory`, backed by a candidate port over the daemon's existing CP
  client. `createSession` validates the set and hands it to the session start; session state reports the root set.
- **Daemon workspace preparation:** accepts a pinned `cwd` the way a GitHub
  hook pins a subject repository, and pinned secondaries ahead of the selector.
- **Relay and CP:** no change. The relay forwards bound requests; the CP already
  serves `repo-candidates`.

## 7. Out of scope

- Choosing a branch other than the default.
- Adding or removing repositories after the session starts (§5.2).
- Browsing or reading files inside a repository.
- Matching the user's local git remote; VS Code's remote picker never sees local
  folders.
- A catalog across agents on one connection.

## 8. Verification

1. Unit tests for the namespace, the candidate cap and cache, and each
   `createSession` row of §5.1, and the reported root set.
2. On test, from VS Code: the picker opens on the agent's repositories, typeahead
   filters them, a session pinned to a non-primary repository starts in that
   checkout and opens a PR there, a two-repository session changes both and opens
   one PR in each, and `/@agent` behaves as today. Confirm how the target VS Code
   build lets a user pick more than one folder; if it offers only one, the second
   repository is reached through the selector.
