# Agent Multi-Repository Authorization, Per-Repository Minting, and a `gh` Wrapper

> **Status:** Implemented. Minting uses numeric `repository_ids` to prevent
> authorization takeover through rename and reuse; serve-stale never revives a
> denied token; the `gh` wrapper gives repository flags precedence over
> environment; and it recognizes every `-R` form.
>
> **Installation grants** (decision 10): the control-plane half is implemented —
> the table, the owner-only routes, the projected `additionalInstallations`, the
> mint and hook gates, the refusal that names the grant, and the roster request
> for a grant marked `decision`. The daemon offers a grant's repositories on
> demand or to the repository selector, and the console lists grant rows with
> **Authorize an installation** and an **On demand** / **By decision** checkout
> in Edit workspace, shows chips on the Workspace card, and counts covered
> repositories as authorized in the GitHub hook editor and on the agent page.
>
> Scratch workspaces use the same explicit repository allowlist and have no
> implicit repository. Converting a scratch workspace to GitHub makes the target
> repository the implicit workspace authority and removes any redundant
> explicit grant.
>
> The runtime does not inject a spawn-time `GH_TOKEN`. Hidden local helper
> commands use a temporary, in-memory, per-agent capability for `gitcred.sock`.
> This prevents an ordinary shell from obtaining a token using only an agent ID,
> but processes owned by the same host user still share one trust domain.
>
> The design solves three problems together:
>
> 1. The **cross-repository gap** in write-back. A token scoped only to
>    `acme/primary-service` cannot serve a hook targeting the synthetic
>    cross-account repository `example-co/shared-library`.
> 2. It supplies on-demand `gh` token refresh and an explicit additional
>    repository allowlist; see
>    [github-app-git-credentials.md](github-app-git-credentials.md).
> 3. It gives one agent explicit access to multiple repositories through the
>    same authorization for Git clone, fetch, and push and for GitHub API calls
>    through `gh`.
>
> The authorization model is an **explicit per-agent allowlist** presented as
> additional repositories in the UI. A GitHub hook can watch only an authorized
> repository. Delivery uses a repository-parameterized `gitcred/request`,
> per-repository token minting, and a `gh` wrapper shim. These layers are
> orthogonal: the allowlist answers which repositories may receive credentials,
> while the wrapper and minting path answer how credentials reach Git and `gh`.

## Background and constraints

Repository-scoped authorization routes Git and `gh` requests by repository
rather than injecting one process-lifetime token. The Control Plane still
resolves agent, authorization, installation, and repository identity; the
daemon may request only the workspace repository or an explicitly authorized
additional repository.

Two hard constraints determine the design:

1. **An installation token cannot cross installations.** A GitHub App is
   installed per account, whether organization or user. Restricting a token's
   `repositories` can select only repositories within that installation. The
   synthetic example crosses accounts, from `acme` to `example-co`, so one
   multi-repository token cannot fix it. Even within one owner,
   a token has one permission set for every selected repository and would grant
   `contents:write` to repositories intended only for reading and commenting.
2. **`gh` accepts one token per host.** It resolves authentication for
   github.com from `GH_TOKEN` or `hosts.yml`, with no per-repository token
   selector or credential-helper extension. `hosts.yml` persists credentials to
   disk and violates the daemon's no-persistent-credential invariant. Multiple
   environment-token variables have nowhere to attach.

Two existing facts make the design possible:

- **The Git credential helper already receives a repository path.**
  `cli/git-credential.ts` configures `useHttpPath=true`, parses the repository
  path, and forwards it as `repoFullName`. Git therefore requests a credential
  for the exact repository selected by the remote URL.
- **Identity attestation is available.** `github/user-authz.ts` uses the
  installation metadata token to determine a user's effective permission on a
  repository. Adding an authorization can therefore verify that the operator
  personally holds it.

## Goals and non-goals

**Goals**

1. Explicitly authorize one agent for multiple GitHub repositories outside its
   workspace, with an independent access level per repository. Git transport
   and the `gh` API share the authorization, including issue and pull-request
   operations and GitHub Actions under write access.
2. Require a GitHub hook's watched repository to belong to the authorized set:
   workspace plus additional repositories. Triggering may not run ahead of the
   credential surface.
3. Support cross-installation access naturally by resolving and minting each
   repository independently.
4. Fetch a fresh `gh` token per invocation, eliminating the spawn-time one-hour
   expiration window.
5. Preserve every invariant: no credential persistence in the daemon,
   single-repository token scope, no Control Plane in the message hot path,
   never log secrets, clamp agent-visible credentials by `gitAccess` and access
   level, and never let a daemon request an unauthorized repository.

   A P3 daemon-owned `GithubPoster` token for hook replies is a narrow
   exception. It never enters the agent environment. The relay-delivered
   `hookId` returns to the Control Plane, which validates the enabled hook and
   `repoId` and authorizes exactly one final comment.

**Non-goals**

- GitHub Enterprise Server, another GitHub host, or another provider such as
  GitLab. Installation grants (decision 10) are GitHub-only in this version; a
  GitLab group or Gitea organization analogue is future work.
- Automatically nominating submodules from `.gitmodules`. This design provides
  the authorization mechanism; nomination remains future work.
- A generic PATCH that silently rewrites workspace identity. Ordinary agent
  edits do not change a workspace. A dedicated cold action may switch between
  scratch and GitHub, repository, branch, `agentDir`, read or write access, or
  App installation after an explicit irreversible warning. Additional
  repositories remain detachable grants.
- Per-hook credentials or named tokens. Authorization belongs to an agent, not
  a hook.

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Agent-visible authorization is an explicit per-agent allowlist** stored in `AgentRepoAuthorization` and edited on the agent detail page. It is **not derived from hooks**. The only exception is `purpose: github_hook_reply`, a daemon-owned poster token that never enters the agent environment and authorizes one final comment in the triggering thread.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Deriving general credentials from a hook would make hook creation a silent privilege expansion. The allowlist is centralized, visible, and auditable. The poster has a fixed consumer and behavior rather than giving the agent a general repository credential, so it is modeled separately instead of requiring workspace contents write access.                                                                                                                                                                                                                                                            |
| 2   | **Minting is parameterized by repository.** `gitcred/request` gains optional `repoFullName`. A GitHub App workspace defaults to its existing workspace repository; scratch **must specify a repository**. A specified repository is checked against workspace plus explicit grants, then resolved and minted through that repository's owner. `purpose: github_hook_reply` also carries relay-delivered `hookId`; the Control Plane verifies the enabled hook by immutable `repoId` and mints issue and pull-request write without contents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | General consumers may specify only an authorized repository, while the poster is authorized by the actual enabled hook. Scratch has no repository-less default authority. Per-repository minting naturally crosses installations and permits different permission sets.                                                                                                                                                                                                                                                                                                                                       |
| 3   | **Three access levels per repository: `read`, `comment`, and `write`.** Default to `read`; see the clamp matrix.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Two levels following workspace `gitAccess` would force `contents:write` merely to comment. The three real cases are a reference repository, a watched repository with replies, and a secondary working repository. Workspace access keeps existing read/write semantics and adds no comment level.                                                                                                                                                                                                                                                                                                            |
| 4   | **A `gh` wrapper shim.** On each boot the daemon writes a secret-free wrapper into a bin directory placed first in PATH. It resolves the target repository from `-R/--repo`, then from the target the command already names (a `gh repo <sub>` positional, the `gh api` endpoint path, a pull-request or issue URL), then `GH_REPO`, then the current repository remote, matching `gh` flag-over-environment precedence. It accepts `-R owner/repo`, `-Rowner/repo`, `-R=owner/repo`, and `--repo=owner/repo`, fetches a repository token from `gitcred.sock`, and executes real `gh` with `GH_TOKEN`. Resolution itself is a pure function invoked by the hidden CLI; the shell wrapper only locates real `gh` and forwards argv. A user-supplied `GH_TOKEN` passes through. **Both execution modes:** a self-hosted daemon writes the wrapper on its own PATH, while the sandbox runtime image ships the real `gh` plus a wrapper of its own, rendered from the same generator with the image's paths and prepended to the runtime's PATH by the shim; its token comes over the same tunnelled `gitcred` socket the in-pod Git helper uses.                                                                                                                                                                                                                                                                                                                                           | `gh` has no per-repository authentication extension. A wrapper is the only way to inject a token without persistence or configuration changes. Fetching per call also removes the one-hour expiry. Matching `gh` precedence prevents minting for `GH_REPO` when `-R` selects another target. Reading the command's own target matters most where the environment is empty: a review session whose working directory holds no checkout would otherwise mint the workspace token for `gh api repos/OWNER/REPO/…` and get a 404.                                                                                 |
| 5   | **Turn the Git-helper path from validation into routing.** Forward the helper's `path` as `repoFullName`. Return a token for an authorized path and reject an unauthorized one with guidance to add the repository in agent settings.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `useHttpPath=true` already supplies the path, so this adds no mechanism. Git and `gh` then share the authorization and cache. A missing path falls back to the workspace, and GitHub's own 403 remains a final safeguard.                                                                                                                                                                                                                                                                                                                                                                                     |
| 6   | **Require the watched repository on GitHub hook create or repository edit to be authorized**, otherwise return 409. Existing out-of-bound hooks are grandfathered: they continue triggering; general Git and `gh` credentials remain denied, while the daemon-owned poster may reply to the same thread through the enabled-hook authorization. Scratch may create a GitHub hook after explicitly authorizing the repository.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Triggering must not grant general credentials. The fixed poster does not enter the agent environment, so preserving existing conversations does not expand agent authority. Deleting existing hooks would unnecessarily break the trigger surface.                                                                                                                                                                                                                                                                                                                                                            |
| 7   | **Anchor by numeric `repoId` and resolve installations dynamically.** Store immutable numeric ID plus `repoFullName` for display. On a request, resolve owner/repository through the Control Plane's installation metadata token, match by ID, and find a live installation by current owner rather than binding one permanently.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Dynamic installation resolution heals uninstall/reinstall changes, while numeric identity prevents repository rename or name-reuse confusion. The Control Plane trusts its own resolved ID rather than a daemon string. Cache the resolved result because the extra metadata read is on a cold path.                                                                                                                                                                                                                                                                                                          |
| 8   | **Run identity attestation when granting access.** If the user-authz gateway is enabled, `read` and `comment` require the operator to have at least read access, while `write` requires write. Without the gateway, degrade to the organization model and require installation coverage, matching existing `POST /agents` semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Prevent organization members from authorizing an agent to a repository they personally cannot access. The same user-authorization gate and cache serve credential minting. Comment-to-read amplification is explicit in the security boundary below.                                                                                                                                                                                                                                                                                                                                                          |
| 9   | **Retire spawn-time `GH_TOKEN`; hide local helper commands and require a runtime-only per-agent capability.** The daemon injects only `AC_GITCRED_CAPABILITY` into the matching managed runtime and Git subprocess — plus `AC_GITCRED_SOCKET` for a runtime in a sandbox pod, which has no daemon root to derive a socket path from and reaches it through the shim's tunnel. Socket requests require agent ID and capability, and remove or detach revokes it. A user-configured `GH_TOKEN` still passes through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | A long-lived bearer is visible through environment and public CLI and expires after an hour. The capability is absent from shims, configuration, disk, and logs, preventing an ordinary shell from obtaining a token with only an agent ID. A same-user process inspector can still recover it, so this is defense in depth, not a new host boundary. Raw token consumers other than `gh` are no longer implicitly supported.                                                                                                                                                                                 |
| 10  | **An installation grant authorizes every repository a live GitHub App installation covers, at one access tier.** Stored in `AgentInstallationAuthorization`, separate from the per-repository rows, keyed `(agentId, installationId)`. Only an organization `owner` may create, change, or delete one; no per-repository identity attestation runs, and the tier defaults to `read`. At mint time a request for `owner/repo` that matches no explicit row falls through to the grant whose installation account is `owner`: the Control Plane resolves the repository through that installation (`repoRefFor`), mints by numeric id as for any row, and denies a repository the installation does not cover. An explicit row for the same repository wins over the grant, so a per-repository `write` may sit on top of a `read` grant. Hooks may watch any covered repository, and formal reviews and auto-merge take the grant's tier as they take a row's; control-plane-owned Checks do not, because revoking a row retires its Checks and a grant has no per-repository cleanup. The grant is never expanded into `AgentSpec.workspace.additionalRepos`; the spec carries it as `additionalInstallations: [{ provider, accountLogin, access, materialize }]`, where `materialize` is `decision` or `on-demand` and never `always`, and a daemon whose grant is `decision` asks for the roster ([multi-repository-workspaces.md](multi-repository-workspaces.md), decisions 13–15). | An organization with hundreds of repositories cannot add rows one at a time, and a list that long would be wrong the day a repository is created. The reference model is the App installation itself: the person who installs an App on "all repositories" is a GitHub organization owner, so the organization owner who claimed the installation is the right actor for a grant of the same shape, and a per-repository check of that person's access has nothing to add. Keeping the grant out of `additionalRepos` keeps every consumer that reads rows as roots from cloning an installation by accident. |

### Capability clamp matrix

Every mint is for one repository and one permission set determined by the
authorization row. Wire `capabilities` describes categories; the Control Plane
chooses levels:

| Access    | contents | workflows | issues | pull_requests | actions | Scenario                                                               |
| --------- | -------- | --------- | ------ | ------------- | ------- | ---------------------------------------------------------------------- |
| `read`    | read     | None      | read   | read          | None    | Reference repository: clone, fetch, `gh issue view`                    |
| `comment` | read     | None      | write  | write         | None    | Hook watching and `gh issue comment` replies                           |
| `write`   | write    | write     | write  | write         | write   | Secondary working repository: push, edit workflows, run GitHub Actions |

The workspace retains `gitAccess: read|write`, corresponding to the read and
write rows. It has no additional-repository comment level. The only exception,
`purpose: github_hook_reply`, never enters the agent environment. An enabled
hook authorizes fixed `{issues: write, pull_requests: write}` with no contents,
so an always-on hook reply works in a read workspace without letting the agent
push.

Using `actions:write` and `workflows:write` requires the deployment GitHub App
to declare **Actions: Read and write** and **Workflows: Read and write**, and
each installation owner to approve the permission change. An installation token
can only narrow approved App permissions; it cannot expand them.

## Security boundary

Retain all five git-credential trust assumptions: one daemon and OS user form a
single trust domain, placement implies trust, exfiltration remains a residual
risk, `contents:write` defines the repository blast radius, and installations
are visible at organization scope. Add three constraints:

1. **The authorization set multiplies the blast radius of agent-visible
   credentials and must therefore be explicit.** A compromised or injected
   agent can exercise the sum of its workspace and additional-repository
   permissions. The explicit allowlist, minimum per-repository access defaulting
   to read, and centralized UI govern that multiplier. This is why hooks do not
   derive general credentials. The `GithubPoster` token never enters the agent
   environment and is hard-coded to one comment in the triggering thread.
2. **Comment-level App amplification is explicitly accepted.** An App token with
   `issues:write` can edit, close, or label other users' issues, exceeding what
   an attested user with only read permission can personally do. Authorization
   is anchored to the operator while runtime identity remains the App. Requiring write would exclude legitimate
   triage users because GitHub collapses triage to read in this check; tightening
   remains an open option.
3. **Untrusted hook input compounds multi-repository authorization.** On a
   public repository, anyone can open an issue that instructs an agent which may
   now hold multiple credentials. Existing defenses remain: prompt boundaries,
   permission mode, and token scopes. When an agent with a public-repository
   hook receives a write grant, the Console should display a combined-risk
   warning.
4. **An installation grant multiplies the blast radius by the installation.**
   Its tier applies to every repository the App can reach, including ones
   created after the grant. That is why it is `read` by default, owner-only, and
   shown in the console as "All repositories in `<account>`" with the tier
   beside it and the write warning above; the combined-risk warning of
   constraint 3 applies to it as to any write grant.

**Gates and error semantics:** reuse existing `ErrorCode` values for a
repository-parameterized request:

- `SCOPE_DENIED` means the agent is not on that daemon, manual GitHub credential
  mode forbids it, scratch omitted a repository, or the **repository is not
  authorized**.
- `LEASE_DENIED` means there is no live installation for the repository owner,
  the installation is suspended, or the repository left its scope.
- `RATE_LIMITED` and `INTERNAL` retain their meanings.

The daemon distinguishes two kinds of `SCOPE_DENIED`. An **agent-level** denial
for a request without a repository retains existing terminal behavior: clear
cache, stop polling, and wait for a spec replication to unlock. A
**repository-level** denial gets only a **60-second negative cache**, so adding
authorization in the UI heals the next Git or `gh` call within a minute without
spec replication or restart.

## Prisma data model

GitLab's arrival made this row a two-host one
([gitlab-com-integration.md](gitlab-com-integration.md) §8.3): it carries the
provider beside its numeric id, and identity is the pair. Everything below that
says GitHub is now that host's arm of a shared shape.

```prisma
/// Explicit agent access to one code-host repository outside the workspace.
/// Authorization belongs to the agent, not a hook. (provider, repoId) is the
/// rename-immune match key — the hosts number their repositories independently;
/// repoFullName is for display. A GitHub installation is resolved dynamically by
/// owner at mint time, a GitLab project through its managed binding. Rows are
/// detachable and do not change workspace identity.
model AgentRepoAuthorization {
  id              String   @id @default(uuid()) @db.Uuid
  agentId         String   @db.Uuid
  provider        String   @default("github")  // 'github' | 'gitlab'
  repoId          BigInt            // Numeric repository/project ID; match key
  repoFullName    String            // "owner/repo" or "group/subgroup/project"; display and fast-path match
  access          RepoAccess        // read | comment | write
  materialize     RepoMaterialization @default(always) // how a session stands in the repository
  createdByUserId String?           // Audit: who granted it and was attested
  createdAt       DateTime @default(now()) @db.Timestamptz(6)

  agent     Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)
  createdBy User? @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)

  @@unique([agentId, provider, repoId])
  @@index([agentId])
  @@map("agent_repo_authorization")
}

enum RepoAccess {
  read
  comment
  write
}

enum RepoMaterialization {
  always
  decision
  on_demand @map("on-demand") // the column and the wire both spell it on-demand
}
```

An installation grant (decision 10) is its own model rather than a row with a
null `repoId`: every reader of `AgentRepoAuthorization` treats a row as one
repository, and a grant that expands to a roster must not be mistaken for one.

```prisma
/// Agent access to every repository a GitHub App installation covers, at one tier.
/// The installation is the organization's claimed one; coverage is resolved live at
/// mint time, so repositories created or removed on GitHub follow without a write here.
model AgentInstallationAuthorization {
  id              String     @id @default(uuid()) @db.Uuid
  agentId         String     @db.Uuid
  provider        String     @default("github") // GitHub-only in this version
  installationId  BigInt     // GitHub installation id; the org's claim is checked on every use
  accountLogin    String     // display; refreshed from the installation row
  access          RepoAccess // read | comment | write, default read
  materialize     RepoMaterialization @default(on_demand) // decision | on_demand; never always
  createdByUserId String?
  createdAt       DateTime   @default(now()) @db.Timestamptz(6)

  agent     Agent @relation(fields: [agentId], references: [id], onDelete: Cascade)
  createdBy User? @relation(fields: [createdByUserId], references: [id], onDelete: SetNull)

  @@unique([agentId, provider, installationId])
  @@index([agentId])
  @@map("agent_installation_authorization")
}
```

`AgentRepoAuthorization` carries the same column, `materialize
RepoMaterialization @default(always)` (landed; existing rows became `always`),
over the enum above, whose `on_demand` member is mapped to the wire spelling
`on-demand` so the column, the DTOs and the protocol agree. A grant's value is
validated to the two it may take
([multi-repository-workspaces.md](multi-repository-workspaces.md), decisions
13–14). Audit insert and delete under the existing `agent_repo_change` kind with
the installation named in the payload. A revoked or suspended installation leaves
the row in place and denies at mint (`LEASE_DENIED`), as a row whose owner lost
its installation does today.

- Add **no visibility column**. The authorization belongs to its agent, like
  `HookDef`, and access is gated by the owning agent's `canView`.
- Audit insert and delete through a new `AuditEvent` kind,
  `agent_repo_change`, and retain `createdByUserId` on the row.
- `HookDef` needs **no schema change**.

## Protocol changes in `packages/protocol`

Add one optional, fully backward-compatible field to `GitCredRequest`:

```ts
export const GitCredRequest = z.object({
  agentId: z.string().uuid(),
  reason: z.enum(['clone', 'fetch', 'pull', 'push', 'helper']).optional(),
  capabilities: z.array(GitCredCapability).nonempty().optional(),
  // Omitted means the workspace repository. When present, the Control Plane
  // verifies membership in workspace plus additional repositories and mints
  // for this "owner/repo".
  repoFullName: z.string().optional()
})
```

The current frame also carries optional `purpose: 'github_hook_reply'`,
`hookId`, and `forceRefresh`. The poster uses `forceRefresh` once after a GitHub
401 or 403 to bypass the Control Plane installation-token cache; ordinary Git
and `gh` requests ignore it. The authoritative schema is
`packages/protocol/src/frames/gitcred.ts`.

`GitCredGrant` remains unchanged and already includes `repoFullName` and
`access`.

**Mandatory protection for a new daemon talking to an old Control Plane:** an
old Zod decoder strips unknown `repoFullName`, mints the workspace token, and
returns a workspace grant. Before caching, the daemon must compare
`grant.repoFullName` with the requested repository case-insensitively. On
mismatch, do not cache and return a non-retryable "control plane too old" error.
Never give the target consumer a workspace token.

**To make that protection correct, a new Control Plane grant must echo the
requested name, not GitHub's canonical name.** Additional-repository scope is
based on immutable `repoId`, but `grant.repoFullName` reports the exact daemon
request. If GitHub renames `owner/a` to `owner/b`, an old clone may still use
`owner/a` and follow GitHub's redirect while the authorization row stores
`owner/b`. The slow path matches the correct ID. Returning `owner/b` would make
the daemon misclassify a valid grant as an old-Control-Plane mismatch forever.
Update only the authorization row's canonical display name. On the wire, the
guard becomes a pure equality check: an old Control Plane returns a different
workspace name and is rejected; a new one echoes the request and passes.

**Installation grants on the wire (decision 10).** `AgentWorkspace` gains, on
every variant beside `additionalRepos`, an optional
`additionalInstallations: [{ provider: 'github', accountLogin, access, materialize }]`,
defaulting to `[]` so an older peer decodes unchanged, and each
`additionalRepos` entry gains `materialize`, defaulting to `always` so an older
Control Plane's list still means what it meant. A grant carries no roster: the
daemon needs the accounts for the standing context and nothing else. A daemon
whose grant is marked `decision` asks for the roster with a new control request
pair, negotiated by `repo-candidates-v1`: `repo-candidates/request { agentId }` →
`repo-candidates/reply { candidates: [{ provider, repoFullName, repoId,
description?, pushedAt? }], partial }`. The Control Plane answers a daemon that
serves the agent from each `decision` grant's cached installation roster,
leaving out a repository with its own row (the rows are already in the spec)
and the workspace repository, most recent push first, bounded to 512 entries
and one frame, with `partial` when a bound cut anything. The reply is control
metadata and never message content. `GitCredRequest` and `GitCredGrant` are
unchanged: a request still names one repository, and the grant still echoes it.

## Control Plane

### Mint gate in `github/service.ts`

Add optional `repoFullName` to `mintForAgent`, forwarded by the WebSocket
handler:

1. If omitted or equal case-insensitively to
   `gitRepoLabel(agent.workspace.gitRepo)`, use the existing workspace path
   unchanged.
2. Otherwise load
   `AgentRepoAuthorizationRepo.listForAgent(agentId)`:
   - **Fast path:** a row's `repoFullName` equals the request
     case-insensitively.
   - **Slow rename path:** find a live installation for the requested owner
     with `liveByOrgAndAccount`, resolve numeric ID through `repoRefFor`, and
     match `repoId`. On success, update the row's stale `repoFullName` on a
     best-effort basis.
   - No match returns repository-level `SCOPE_DENIED`, naming the repository and
     directing the user to authorize it in agent settings.
3. For a match, resolve a live installation for **that repository's owner**,
   independently of the workspace, and call
   `tokens.mint(iid, repo, permission levels from the clamp matrix,
capabilities)`. This naturally supports another installation.
4. Reuse the existing mint bucket keyed by daemon and organization. The token
   cache already keys by `(installationId, repo, access, caps)`, so it is
   repository-specific.
5. **Installation grants (decision 10)** are consulted after the explicit rows
   and the private skill sources, before the final denial: a grant whose
   installation account equals the requested owner case-insensitively, is
   claimed by the agent's organization, and is live justifies the `repoRefFor`
   probe that the "never probe an unrelated owner" rule otherwise forbids. A
   resolved repository mints by its numeric id at the grant's tier; an
   unresolved one is `SCOPE_DENIED` "not covered by the installation". An
   explicit row matched earlier keeps its own tier. A grant whose installation
   is suspended, or revoked with nothing claimed in its place, is
   `LEASE_DENIED`. The by-id resolver behind hook effects, formal reviews, and
   auto-merge takes the same fallback; control-plane-owned Checks do not.

`InstallationTokenService.mint` must support **per-capability levels**. Comment
access means `contents:read`, `issues:write`, and `pull_requests:write`, so
replace the single `access` parameter with a level map without changing
workspace caller semantics.

### REST API in the organization subtree

Implement in `http/routes/agents.ts` or a new `agent-repos.ts`:

| Route                                                   | Gate                                                            | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /orgs/:orgId/agents/:agentId/repos`                | Agent `canView`, otherwise 404                                  | List `repoFullName`, access, creator, and creation time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `POST /orgs/:orgId/agents/:agentId/repos`               | `denyViewerWrite` + agent `canEdit`                             | Body `{ owner, repo, access, materialize? }` (`materialize` defaults to `always`; `decision` needs the agent's `repositorySelector`, else 409 `REPOSITORY_SELECTOR_MISSING`, and the agent's daemon, or every ready member of its group or the pool, advertising `repo-selector-v1`, else 409 `DAEMON_FEATURE_MISSING`; the same rule applies to the gitlab and gitea arms). Require a live installation claimed by the organization, resolve `repoId`, run decision 8 identity attestation, and enforce unique `(agentId, repoId)`. A GitHub App workspace cannot explicitly reauthorize its implicit repository. Scratch may authorize any covered repository. A manual GitHub workspace may explicitly authorize only its own workspace repository for Control Plane-owned review and Checks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `DELETE /orgs/:orgId/agents/:agentId/repos/:id`         | Same                                                            | Delete and audit. A previously minted token remains valid until expiration, at most one hour, matching git-credential revocation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PATCH /orgs/:orgId/agents/:agentId/repos/:repoAuthId`  | Same                                                            | Body `{ access?, materialize? }`, at least one present (an empty body is 400). Access moves either way between `read`, `comment` and `write`. Raising re-runs identity attestation, requiring write for write, and requires a live owner installation. Lowering needs neither and is refused with 409 `AGENT_REPO_INTEGRATION_CONFLICT` while an enabled GitHub hook on the repository needs the tier (Checks and non-comment reviews need `write`, a comment review `comment`), the rule a workspace access edit enforces; it is checked under the agent lifecycle and agent/repository advisory scopes every GitHub hook write takes, and a hook write re-checks the row under them. A lowered tier serves the next credential request; a token the daemon already holds lives out its expiry of at most one hour, and a GitLab project role re-converges. `materialize` moves freely between `always`, `decision` and `on-demand` (moving to `decision` has the create route's preconditions, 409 otherwise, checked before the tier) and, because it is projected, advances the agent's config revision and re-pushes the spec; an access-only change does neither. Leaving `always` retires the root in place once the daemon honors the field ([multi-repository-workspaces.md](multi-repository-workspaces.md), decision 13). When both fields are sent, access is applied first, so a denied tier leaves the row untouched. Audit `agent_repo_change` (the create and change payloads carry `materialize`; a change also carries `previousMaterialize` or `previousAccess`).                                                                                                                                                                                           |
| `PUT /agents/:agentId/workspace`                        | `denyViewerWrite` + agent `canEdit`                             | Body is `{ mode: 'scratch' }` or `{ mode: 'github', repoFullName, gitBranch?, agentDir?, gitAccess? }`. An unstated `gitAccess` takes the highest tier the target can carry, as at creation: write where credentials are minted for it, read for an anonymous checkout, which has none to push with. Switch workspace type in either direction or change repository, branch, directory, or access. A GitHub target covered by a live organization installation must pass user permission for target access, but **does not require an explicit grant first**. A target no installation covers is accepted on the same terms agent creation accepts it: cloned anonymously, so `gitAccess: 'read'` only (write returns 409) and carrying no catalog repository identity, and available with no GitHub App configured at all. Nothing verifies the repository first, exactly as at creation — a non-public target fails at clone time, where the daemon reports it. A covered owner is different: an installation token reads any public repository, so a repository the covering installation does not resolve is private-and-ungranted or absent, and still returns 409 with the grant it needs rather than degrading to a clone that cannot succeed. A placed agent requires a READY daemon with `workspace-edit-v2` and an acknowledged cold lifecycle. Mode, repository, or branch changes irreversibly replace daemon-local files; access-only or `agentDir`-only changes retain the checkout. Any change removing write authority required by enabled formal reviews or Checks returns 409. Transaction locking shares an agent/repository fence with hook writes. On success, the GitHub workspace becomes implicit authority and a redundant explicit grant is removed. |
| `GET /orgs/:orgId/agents/:agentId/installations`        | Agent `canView`, otherwise 404                                  | List installation grants: `accountLogin`, `installationId`, access, creator, creation time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `POST /orgs/:orgId/agents/:agentId/installations`       | `denyViewerWrite` + agent `canEdit` + organization role `owner` | Body `{ installationId, access?, materialize? }`, where `installationId` is the GitHub-side id the organization's installation list reports. An unknown, revoked, or other organization's installation is 400 and a suspended one 409; default access `read`, default `materialize` `on-demand` (`always` fails the schema; `decision` has the repository routes' preconditions, 409 otherwise); a second grant on one installation is 409; audit. No per-repository identity attestation (decision 10). A non-owner receives 403 with a message naming the role, not 404.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `DELETE /orgs/:orgId/agents/:agentId/installations/:id` | Same                                                            | Delete and audit. Minted tokens remain valid until expiration, at most one hour.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PATCH /orgs/:orgId/agents/:agentId/installations/:id`  | Same                                                            | Body `{ access?, materialize? }`, at least one present. Access moves either way; lowering is refused with 409 `AGENT_REPO_INTEGRATION_CONFLICT` while an enabled GitHub hook needs the tier on a repository only the grant serves (owned by the installation's live account, with no row of its own and not the workspace repository), under the agent lifecycle scope every GitHub hook write takes, and a hook write re-checks the grant under it. `materialize` may move either way between `decision` and `on-demand` (moving to `decision` has the same preconditions), and `always` is rejected. A change re-projects the spec, whose changed `additionalInstallations` makes the daemon drop the agent's cached repository credentials, and audits; an unchanged body does neither.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Every route has OpenAPI `tags`, `summary`, `description`, and `operationId`,
classified under Agents. The repository picker reuses existing installation and
repository routes, including list filtering and `/access` identity preflight.

### Enforce authorization on hook create in `http/routes/hooks.ts`

For a GitHub-kind hook, add a check during creation or repository change that
the watched numeric `repoId` belongs to workspace plus additional repositories.
Otherwise return 409 and direct the user to authorize it in agent settings.
Existing hooks remain grandfathered. A repository covered by one of the agent's
installation grants (decision 10) passes: the gate resolves the repository's
installation and matches it against the grants after the explicit rows. A hook
that reports Checks on such a repository is 409 until the repository itself is
authorized.

## Daemon

### Cache in `cp/git-credential.ts`

- Generalize keys from `agentId` and `gh\0agentId` to
  `(agentId, repo?, plane)`, where plane is `git|gh` and omitted repository
  means workspace. Single-flight, the ten-minute handoff threshold, and
  serve-unexpired-cache degradation during Control Plane outage remain per key.
- Split `denied` into terminal agent-level denial and 60-second
  repository-level negative caching. `agent/remove` clears every key for the
  agent through existing prefix traversal.
- Before caching, require `grant.repoFullName == requested repo`, implementing
  the old-Control-Plane mismatch guard.

### `gitcred.sock` in `cp/gitcred-server.ts`

Extend requests additively:
`{ op: 'get'|'erase', agentId, capability, repoFullName?,
plane?: 'git'|'gh', password? }`. A repository-specific `get` fetches that key;
repository-specific `erase` invalidates it. Generate the capability in daemon
memory per agent, compare it in constant time, and pass it only through the
managed subprocess environment. Reject missing values, values for another
agent, and stale values after remove or detach, leaving only secret-free logs.
A failed `get` replies `{ ok: false, error, denied? }`, where `denied` is
`repository` or `agent` when the Control Plane refused and is absent when it
could not be asked; see "Denial guidance" below.

### Git credential helper in `cli/git-credential.ts`

Replace path matching with routing. Send
`normalizeRepoPath(input.path)` as `repoFullName` on the socket request. An
absent path omits the field and retains workspace behavior. For an authorized
repository, return that token. On `SCOPE_DENIED`, use the existing clean failure
path with the Control Plane's reason, which names the remedy. Preserve rename
guidance for a slow-path mismatch.

**Denial guidance.** A repository-level refusal must read as one, or a model
reports "no GitHub access at all" for a repository that merely lacks a row:

- The helper appends "(the daemon must be running and connected to the control
  plane)" only when the socket reply carries no `denied`, that is when the
  daemon or Control Plane could not answer. A refusal prints the Control
  Plane's reason alone.
- The Control Plane's first by-name refusal names the remedy: "`owner/repo` is
  not authorized for this agent — add it under Additional repositories in the
  agent's workspace settings", or, for a repository its owner's installation
  does not cover, that the GitHub App needs access to it first. The daemon's
  60-second negative cache replays that same reason rather than a wording of
  its own. When the owner has a live installation the organization claimed, the
  refusal adds ", or authorize its installation" (decision 10).
- The `gh` token command exits 3 on a refusal, and the wrapper then exits
  without running `gh`, whose unauthenticated run would only add "not logged
  in" advice. It still falls through to the real `gh` when the daemon could not
  be reached, where the user's own `gh` configuration may legitimately apply.

### New `gh` wrapper in `cp/gh-shim.ts`

- On every boot, rewrite secret-free `run/bin/gh` with mode 0755, following
  `writeGitcredShim` quoting discipline. Put `run/bin` **first** in the host
  spawn PATH in a must-win environment layer beside `sessionGitEnv`, so agent
  configuration cannot override it.
- POSIX shell behavior:
  1. If `GH_TOKEN` already exists, execute real `gh` unchanged.
  2. Resolve the repository from the last `-R/--repo` flag, supporting
     `-R x`, `-Rx`, `-R=x`, and `--repo=x`, with owner/repository and URL
     forms; then from the target the command already carries — a `gh repo <sub>`
     positional, the repository segment of a `gh api` endpoint path, or a
     pull-request or issue URL given to `gh pr`/`gh issue`; then from `GH_REPO`;
     then from `git remote get-url origin` in the current directory. If all
     fail, omit the repository and use the workspace key. Flags override
     environment exactly as in `gh`. This resolution is a pure function in
     `cp/gh-target.ts` that the hidden CLI calls, not shell: the wrapper passes
     its argv through untouched, so endpoint and URL parsing stays unit-tested.
  3. Through a hidden CLI command, send
     `{ op: 'get', agentId, capability, plane: 'gh', repoFullName? }` to
     `gitcred.sock`.
  4. On success, execute real `gh` with `GH_TOKEN=<token>`. On a denial of the
     named repository, print the token-free reason to stderr and exit without
     running `gh` (see "Denial guidance"). On any other failure,
     inject no token and allow real `gh` to try its own configuration while
     printing a token-free reason to stderr that the agent can report.
  5. Locate real `gh` by searching PATH while skipping the wrapper's own
     directory. If absent, report "gh not installed," matching current behavior.
- `ensureHost` no longer mints or injects an AgentConnect `GH_TOKEN`.
  `sessionGitEnv` injects only `AC_GITCRED_CAPABILITY`. A user-provided token in
  agent environment remains preserved by spread ordering and makes the wrapper
  pass through.

## Web

1. **Workspace card in the agent's Workspace tab, for GitHub and scratch:**
   - The card heads the Workspace tab itself, above the file browser; there is no
     workspace summary row in Configuration to navigate from. Show `read|write`
     next to a GitHub repository and "Scratch workspace" for scratch.
   - A `Source` segment switches between scratch and GitHub, and one Edit action
     chooses a repository, branch, `agentDir`, and access. Mode, repository, or
     branch changes show an irreversible warning and "Replace workspace."
     Access-only or directory-only changes retain the checkout.
   - The repository fields render whatever the App state is — no App configured, or
     none installed, still edits an anonymous workspace, because a public repository
     needs no installation. The install prompt sits above them rather than in place
     of them.
   - The repository picker is the one agent creation uses, so both offer the same
     candidates on the same credentials: the synced installation roster, one exact
     `owner/repo` resolved through an installation on its own account (reaching past
     a truncated roster), and public GitHub for anything no installation grants. A public pick is badged
     `public` and pins access to read, because its clone carries no credential.
     The anonymous GitHub reads behind it are UX only; nothing gates on them.
   - Because the editor now sits above the live browser, a replacement must
     remount that browser: its cached tree, preview, and git status may never
     outlive the workspace they were read from.
   - Every change uses the cold lifecycle to clear daemon credential cache.
     Return 409 when it would remove workspace write authority required by an
     enabled formal review or Check.
   - Beside it, summarize each additional repository with `repoFullName` and its
     access tier, badging read-only a checkout other than **Always**. The
     workspace repository itself appears here only when the workspace is
     App-backed, where the installation makes it implicit; a manual checkout is
     represented solely by its explicit grant, if one exists.
   - The same Edit workspace dialog lists, adds, and deletes additional repository
     grants, and sets each row's checkout (**Always**, **By decision** or **On
     demand**) from a compact menu that shows the current choice, so a long
     repository name keeps its room. Card and hook-editor shortcuts open that dialog directly at its
     authorization step, so every context keeps the fast path without creating a
     second repository-management surface.
   - "Authorize repository" reuses the installation/repository picker and list
     filtering, offers access options defaulting to read, describes each level,
     warns on write blast radius, and reuses `/access` preflight. Beside access it
     offers the checkout (**Always**, **By decision** or **On demand**),
     defaulting to **Always**; shortcuts keep that default.
   - The card is visible under `canView`; add, delete, and a checkout change
     require `canEdit` and a non-viewer role.
   - The same section lists installation grants as "All repositories in
     `<account>`" with the GitHub mark, the tier badge, the checkout menu and a
     revoke action, and "Authorize an installation" offers the organization's
     live, unsuspended installations the agent does not hold yet, with the same
     **Read only** / **Read & write** choice (default read) whose write option
     names every repository as its reach. The Workspace card shows each grant
     as a read-only chip beside the repository chips. Both are visible under
     `canView` and enabled only for an organization `owner`; other editors see
     the rows and a disabled action whose tooltip names the role. As on a
     repository row there is no inline tier change: lowering or raising a
     grant's tier is revoke and authorize again (the route still accepts an
     upward `PATCH`). Every row carries its materialization:
     **Always**, **By decision** or **On demand** on a repository row, **By
     decision** or **On demand** on a grant (an owner's menu), and the
     authorize step offers the same two, defaulting to **On demand**. **By
     decision** is disabled, its tooltip naming the reason, while no Decision
     provider is ready on the daemon, group or pool that runs the agent, or
     while the agent has no repository selector; in the dialog that second
     case reveals the **Repository selector** under the rows instead — the
     Decision editor's Provider · model picker limited to models that answer
     Choice questions, saved through agent `PATCH` `repositorySelector` and
     clearable — which stays shown while any entry is **By decision** or a
     selector is set. A refused change (409) is named in the section's error
     line ([multi-repository-workspaces.md](multi-repository-workspaces.md),
     decisions 13–15 and 18).
2. **GitHub hook editor:** candidates are workspace plus additional
   repositories. An unauthorized target shows inline guidance and, for an
   editor, an "Authorize for this agent" shortcut that POSTs the grant and
   resumes hook creation. A repository whose owner matches one of the agent's
   installation grants counts as authorized at the grant's tier (an explicit row
   keeps its own), both there and for the badge in item 3; Checks on such a
   repository still need the repository authorized on its own, and the
   editor surfaces the control plane's 409 like any other.
3. **Grandfathered out-of-bound hook badge:** if the watched repository is
   outside authorization, show a yellow "write-back unauthorized" badge with a
   tooltip pointing to Edit workspace.
4. Keep mobile branches synchronized.
5. Scratch conversion needs no prior explicit grant. The picker may select any
   installation-covered repository for which the user has target access, or a
   public repository outside every installation. Explain that only an empty
   workspace is accepted.

Every scratch-workspace repository authority is explicit. The daemon injects a
secret-free helper and `gh` wrapper, but rejects repository-less requests.
Only a target repository in the allowlist receives a token. When a grant is
promoted to the GitHub workspace, it becomes implicit after activation ACK and
the explicit row is deleted. Other grants, memory, sessions, integrations, and
agent configuration remain unchanged.

A manual GitHub workspace may explicitly grant only its workspace repository as
a narrow exception. This gives Control Plane-owned formal review and Checks an
auditable repository allowlist without changing manual daemon credentials or
authorizing any other repository.

## End-to-end flows

**A. Cross-account repository authorization**

On an agent whose workspace is `acme/primary-service`, open Edit workspace,
choose "Authorize repository", add `example-co/shared-library` from the
installation claimed by the organization, choose read access, attest that the
operator has at least read access, and persist the row.

**B. Hook trigger and write-back**

An issue event reaches the relay, matches, and becomes `rd/msg`. The agent runs
`gh issue view 42 -R example-co/shared-library`. The wrapper resolves `-R`,
calls the socket, and on cache miss the daemon sends:

```text
gitcred/request {
  repoFullName: "example-co/shared-library",
  capabilities: [contents, issues, pull_requests, actions]
}
```

The Control Plane confirms placement, matches the read grant, resolves the
`example-co` installation, and mints a single-repository token with contents,
issues, and pull requests read and no actions permission. The wrapper executes
`gh` with that token, which reads the issue and its existing comments but cannot
post to either. Any reply uses the separate daemon-owned `github_hook_reply`
poster token, not this agent-visible grant. **Every invocation fetches as needed,
with no one-hour stale window.**

**C. Git transport to a secondary repository**

The agent runs
`git clone https://github.com/acme/tools.git`, where `acme/tools` has write
authorization. The host-scoped helper receives path `acme/tools`, routes to its
token, and clone succeeds; push follows the same path. An unauthorized
repository fails cleanly with guidance. Existing prevention of personal
credential leakage through helper reset remains.

**D. Revocation**

Deleting an authorization makes the next request repository-level
`SCOPE_DENIED`. A token already cached in the daemon or Control Plane remains
valid until its one-hour maximum expiration, matching existing git-credential
revocation. Uninstalling or suspending the GitHub App installation immediately
invalidates existing tokens, which is stronger.

**E. Version skew**

- Old daemon with new Control Plane: no `repoFullName`, so the existing
  single-workspace behavior is byte-for-byte unchanged.
- New daemon with old Control Plane: Zod strips the field, returns a workspace
  grant, and the daemon mismatch guard reports "control plane too old" rather
  than misusing it.

**F. Installation grant and an on-demand clone**

An organization owner opens Edit workspace on an agent whose primary is
`acme/primary-service`, chooses "Authorize an installation", picks the `acme`
installation at read access, and persists the grant. In a session the agent
runs `git clone https://github.com/acme/tools.git`. The helper sends
`repoFullName: "acme/tools"`; the Control Plane finds no row, finds the `acme`
grant, resolves `acme/tools` through that installation, and mints a
single-repository read token. A repository the installation does not cover
fails with "not covered by the installation" and the hint to authorize it.

## Compatibility

- Every change is additive: a new table, optional frame and socket fields, and
  new REST routes. Nothing breaks.
- Repository authority is never inferred from an existing GitHub hook.
  `AgentRepoAuthorization` rows remain explicit.
- An installation grant is additive too: a new table, a defaulted
  `additionalInstallations` field, new routes, a defaulted `materialize` on each
  `additionalRepos` entry, and a new request pair a daemon sends only for a
  grant marked `decision`. A Control Plane without the pair answers
  `UNSUPPORTED`, which the daemon reports as a configuration error when any
  authorization is marked `decision` (no fallback) and never meets otherwise.
  A daemon without `repo-selector-v1` never meets `decision` either: the
  Control Plane refuses to mark a row or grant `decision` while one would run
  the agent.

## Tests

- **Protocol:** round-trip `repoFullName` when absent and present; old frames
  still decode.
- **Control Plane unit:** three access levels across three capabilities; fast
  and slow matches including case and rename fallback by ID; identity mapping
  from read/comment to read and write to write, with gateway fallback;
  token-free `SCOPE_DENIED` messages.
- **Control Plane integration:** three REST routes with `canView` 404,
  `canEdit`, uniqueness, and audit; independent minting for two repositories
  across installations; 409 for an unauthorized hook plus grandfathered
  compile and fire; repository minting for a restricted agent remains available
  because data-plane placement is exempt.
- **Daemon:** cache keys and repository negative TTL; grant mismatch guard;
  helper path routing for authorized, unauthorized, and missing path; shell
  wrapper precedence, user `GH_TOKEN` pass-through, real-`gh` lookup skipping
  itself, and refusal without capability or token injection.
- **Manual:** exercise cross-installation hook write-back; confirm rename
  healing through the slow path; confirm
  authorization addition heals within the 60-second negative-cache window.
- **Installation grants:** owner-only create and delete (403 for a
  collaborator, 404 under `canView`); mint through a grant for a covered
  repository, denial for an uncovered one, an explicit row's tier winning over
  the grant; the hook gate accepting a covered repository; `additionalRepos`
  unchanged by a grant; `materialize` round-tripping on rows and grants with a
  grant's `always` rejected; `decision` refused without the agent's selector
  or on a daemon or group member without `repo-selector-v1`, and the
  selector's clear refused while any entry is `decision`; a row leaving `always` retiring its root and
  returning un-retiring it; the roster reply bounded and ordered; the helper and
  wrapper denial output without the daemon-unreachable line and without running
  `gh`.

## Open questions

1. **Should comment identity attestation require write rather than read?**
   Current behavior accepts the explicit App amplification delta. Tightening it
   later is a one-line change if abuse appears.
2. **Automatic `.gitmodules` nomination:** the Control Plane could parse
   workspace submodules, offer candidates, and persist rows after operator
   confirmation. This design supplies the mechanism; only nomination UI is
   missing.
3. **Periodic re-attestation:** if a grant creator loses repository access,
   automatically downgrade or alert. The Control Plane already has the check;
   only scheduling is missing.
4. **Per-repository minting observability:** decide whether authorization hit
   rate and repository-level `SCOPE_DENIED` belong in
   `heartbeat.degradedScopes` or only in logs, alongside the broader
   git-credential observability design.
5. **Group-level grants on other hosts:** a GitLab group or Gitea organization
   is the natural analogue of an installation grant. The table already carries
   `provider`; the resolver and the console surface are what a second host
   would add.
