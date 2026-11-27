# Code hosts: GitHub, GitLab and Gitea

One repository template, three hosts. What changes between them is **who vouches for
the repository** — an App installation, a member's OAuth connection, one organization
bot — and therefore which prerequisite is missing when something refuses. What does
not change: the workspace is an address, the trigger may only watch a repository the
agent already holds, and nothing here is ever fixed by asking for a token in chat.

## Which host, and is it configured at all

| Host       | Configured when the deployment has | Read it with              | Not configured |
| ---------- | ---------------------------------- | ------------------------- | -------------- |
| **GitHub** | a deployment GitHub App            | `listGithubInstallations` | 404            |
| **GitLab** | a GitLab OAuth application         | `listGitlabConnections`   | 404            |
| **Gitea**  | an instance URL (`GITEA_BASE_URL`) | `listGiteaConnections`    | 404            |

A 404 is an **operator** task, not a user one: the deployment needs the App / OAuth
application / instance configured (`agentconnect-setup` skill,
<https://docs.agentconnect.md/docs>). Say so and stop — no dialog fixes it, and
`manageCodeHosts` on that provider answers "not configured on this deployment" rather
than opening onto a card that could only repeat it.

Anything else — no installation yet, no connection yet, a repository outside the
installation, a bot that does not administer the repo — is fixed in the dialog
`manageCodeHosts` opens (`{ provider: 'github' | 'gitlab' | 'gitea' }`, or no argument
for the whole Code hosts surface). Open it, wait for the summary, re-read, continue.

## The workspace address

`createAgent`'s `workspace` (and `setAgentWorkspace`) takes **one address** and derives
everything else server-side — which installation or binding vouches, the numeric id,
the credential. Do not pass ids; there is no field for them.

| Host   | `gitRepo`                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------- |
| GitHub | `owner/repo` shorthand, or the full HTTPS URL                                                  |
| GitLab | the full HTTPS URL on the deployment's GitLab host (`group/subgroup/project` paths are normal) |
| Gitea  | the full HTTPS URL under the instance base (`owner/repo`, no subgroups)                        |

Bare two-segment shorthand is **github.com only** — a dotted host is never
reinterpreted. `access` is a request, not a fact: omit it to take the highest tier the
target carries, and an explicit `write` against a target with no managed credentials is
refused ("write requires managed credentials"). A repository on a host with no
connection at all is cloned anonymously when it is public, and refused when it is not.

On GitLab and Gitea the first write that names a project or repository **binds** it —
provisioning, webhook, the lot — under the acting user's own authority. That is why
those hosts have no create-trigger tool and why the dialog does the binding.

## GitHub

**Read:** `listGithubInstallations` → the installations, each with `accountLogin`,
`repositorySelection`, and the permissions its repositories carry. Then
`listGithubRepositories` for the covering installation (paged, ≤100; no server-side
search — page and filter locally), and `getGithubRepositoryAccess` for the caller's own
effective permission.

| Situation                                                    | What it means                                                   | Fix                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| empty list                                                   | the App is installed nowhere for this org                       | `manageCodeHosts` provider `github` → install                                |
| no installation whose `accountLogin` is the repo's owner     | that owner is not covered                                       | same dialog, install for that account                                        |
| `repositorySelection: 'selected'`, repo absent from the list | the installation does not grant it                              | same dialog: extend the selection on github.com, then **sync**, then re-read |
| `pullRequestsPermission` reads `read` or `missing`           | the installation has not accepted the App's current permissions | same dialog (its `settingsUrl`) — or run the trigger without formal reviews  |

**The caller's own permission matters separately.** The workspace write goes out under
the _user's_ GitHub authority, not the App's, so a caller with read gets a 403 from
`createAgent` after every question has been answered. `getGithubRepositoryAccess`
(installation `id` + `owner` + `repo`) is the preflight; 404 means this deployment does
not gate per user and nothing needs checking.

`canWrite: false` has two very different causes, and naming the wrong one wastes the
user's time:

1. **Their AgentConnect account is linked to a different GitHub user** (or to none).
   The permission is read through the linked sign-in identity, so an unlinked identity
   reads as read/none even on a repository they own. This is the free fix — check it
   first.
2. **The GitHub account genuinely lacks Write.** If they administer the repository:
   `https://github.com/<owner>/<repo>/settings/access` → Add people / change role →
   **Write**. If they do not: give them the copy-pasteable ask — Write on
   `<owner>/<repo>`, or membership of a team that has it. Never paraphrase this as
   "get access".

Then offer the choice in one card: _grant it now, I'll wait_ (re-run
`getGithubRepositoryAccess` and continue from where you paused — permission changes
take effect immediately) or _create it read-only for now_ (say plainly what it costs
and that `setAgentWorkspace` raises it later).

**Trigger:** `createGithubTrigger` — the one host with a create-trigger tool.
Families: `pull_request`, `issues`, `push`, `deployment`; one row per family, a second
on the same family is a 409. Canonical cadences: watched from its opening,
`events: ["<family>:opened"]`; watched on every update, `events: ["<family>:*",
"issue_comment:created"]` with `commentFamilies: ["<family>"]` — GitHub emits one
`issue_comment` stream for both thread kinds, so a row subscribing to it **must** scope
it. A `400` naming the repository means the installation does not cover it after all.

## GitLab

**Read:** `listGitlabConnections` (who has connected a GitLab account, and whether it
is still connected), `listGitlabProjects` (the managed projects, their lifecycle state,
their webhook state, which connection administers each), `listGitlabBots` (the service
accounts the agents act as).

- **No connection** → `manageCodeHosts` provider `gitlab`; the user completes the OAuth
  hop in the dialog. Nothing else can be done first.
- **Connection present, project not managed yet** → that is fine and needs no separate
  step: the workspace write or the trigger wizard binds a project the connection
  administers (**Maintainer or Owner** — a project the user only develops on cannot be
  bound). Binding runs provisioning inline.
- **`state: 'provisioning'`** → the binding has not converged; reviews and run
  reporting will refuse until it has. Wait and re-read rather than retrying the write.
- **`admin_degraded` / `runtime_degraded`** → the connection that administers it is
  gone or its accounts no longer satisfy the role. The dialog's repair and take-over
  controls are the fix; `listGitlabConnections` says which connection went away.
- `webhookState: 'not_needed'` is a resting state (no enabled trigger wants ingress),
  not a fault.

The agent does not act as the user on GitLab: it gets its **own service account** per
top-level group, provisioned automatically from the agent's name. `access: 'write'`
earns that account Developer on the project, `read`/`comment` earn Reporter. A
`service_account_quota` provisioning failure is the group's quota, not a permission
problem — it needs a group Owner.

**Trigger:** no tool. `configureIntegration` with `mode: 'create'`, `provider:
'gitlab'`, `agentId`. Families: `issues`, `merge_request`, `push` — one row per family,
same as GitHub, with the console's two cadences (from opening / on every update).

## Gitea

**Read:** `listGiteaConnections` (the organization's single bot connection: the bot's
identity, the instance, whether it clears the supported-version floor) and
`listGiteaRepositories` (managed repositories, lifecycle and webhook state).

- **No connection** → `manageCodeHosts` provider `gitea`. The dialog takes the bot
  token, with its required scopes and bot-user requirements beside it. The token is
  write-only and never returned; **never** accept one in chat.
- **Version floor not cleared** → the instance is too old; that is an operator or
  upgrade task, and the connection card says so.
- **Repository not bound** → bound implicitly by the first write that names it, as on
  GitLab. The bot must hold `permissions.admin` on it; a repository the bot only reads
  is refused (403), one it cannot see at all is a 400.
- **`token_rejected`** → the bot token was replaced or revoked: replace it in the same
  dialog, then repair the bindings.
- **`webhook_unverified`** → the binding is usable but its test delivery never came
  back. That is almost always the relay's outbound address not being reachable from the
  instance — worth saying at creation time rather than after the first missed PR.

**Trigger:** no tool. `configureIntegration` with `mode: 'create'`, `provider: 'gitea'`,
`agentId`. Families are GitLab's vocabulary — `issues`, `merge_request` (shown as _Pull
requests_), `push`.

## What each host can publish

The template's "review format" choice is only as real as the host allows. Check this
before promising one:

| Effect                             | GitHub                                                       | GitLab                                                       | Gitea                              |
| ---------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------- |
| plain comment on the thread        | yes                                                          | yes                                                          | yes                                |
| formal review with inline comments | needs workspace **write** + App _Pull requests: write_       | yes, once the binding is `ready`                             | yes, once the binding is `ready`   |
| request changes / approve          | same, `write` only                                           | yes (Free tier does not block merges — do not imply it does) | yes                                |
| run reported as a Check / run note | `reportingMode: 'check'` — needs write + App _Checks: write_ | `'check'` publishes a run note                               | **not available** — use `'status'` |
| run reported as a commit status    | not available yet                                            | not available                                                | `reportingMode: 'status'`          |
| a Check that gates the merge       | not available yet (`gateMode: 'required'` refuses)           | n/a                                                          | n/a                                |

A refusal here is a 409 that names the missing piece — quote it, fix the named thing,
and do not downgrade the user's choice silently.

## The rule that catches everyone

**A trigger may only watch a repository the agent already holds** — its workspace
repository, or one granted to it as an additional repository. Otherwise:

```
<repo> is not authorized for this agent — authorize the <repository|project> for it,
or make it the agent's workspace <repository|project>, then create the trigger
```

In this flow `createAgent` sets the workspace to the very repository the trigger
watches, so it is satisfied by construction. It bites when someone asks for a second
repository afterwards: that is an additional-repository grant in the console
(`?tab=workspace`), and it has to land **before** the trigger.
