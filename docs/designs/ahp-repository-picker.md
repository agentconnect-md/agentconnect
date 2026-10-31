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
entries. A `partial` reply from the CP is shown as listed; typing narrows it.

Authorization does not widen. The connection is already authorized for this
agent; a repository outside these sources is never listed, and `createSession`
re-checks the choice against a fresh candidate set.

## 5. Creating a session

`createSession.workingDirectories[0]` selects the pin:

| Chosen folder          | Session                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| absent or `/@agent`    | Unchanged: primary repository or scratch, secondaries and the selector as today.                                                                |
| the primary repository | Same as `/@agent`.                                                                                                                              |
| another repository     | That repository becomes the session's working directory (`cwd`), materialized like a selector hit, and the selector is skipped for the session. |
| anything else          | `InvalidParams` naming the folder; no session is created.                                                                                       |

- The pin is stored with the session binding (the provider-neutral form of
  `GithubHookMetadata.repoFullName`) and survives cold resume.
- The primary repository and `always` rows stay mounted as secondaries, so
  cross-repository work behaves as it does elsewhere.
- Base branch is the repository's default branch. The agent opens its PR from a
  session branch as it does from Webchat.
- The session summary reports the pinned folder as its working directory, so
  VS Code's session list shows which repository each session is about.

## 6. Where it runs

- **Daemon AHP service:** `resourceList`, `resourceResolve` and
  `defaultDirectory`, backed by a candidate port over the daemon's existing CP
  client. `createSession` validates the pin and hands it to the session start.
- **Daemon workspace preparation:** accepts a session pin the same way a GitHub
  hook pins a subject repository.
- **Relay and CP:** no change. The relay forwards bound requests; the CP already
  serves `repo-candidates`.

## 7. Out of scope

- Choosing a branch other than the default.
- Browsing or reading files inside a repository.
- Matching the user's local git remote; VS Code's remote picker never sees local
  folders.
- A catalog across agents on one connection.

## 8. Verification

1. Unit tests for the namespace, the candidate cap and cache, and each
   `createSession` row of §5.
2. On test, from VS Code: the picker opens on the agent's repositories, typeahead
   filters them, a session pinned to a non-primary repository starts in that
   checkout and opens a PR there, and `/@agent` behaves as today.
