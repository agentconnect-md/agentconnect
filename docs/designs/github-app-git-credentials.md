# GitHub App Repository Selection + Credential-Free Git Operations on Daemons

> **Status:** Implemented. The authoritative wire schema is
> `packages/protocol/src/frames/gitcred.ts`. It includes repository,
> capability, hook-purpose, and forced-refresh fields. Explicit additional
> repositories are described in
> [agent-multi-repo-authorization.md](agent-multi-repo-authorization.md); an
> agent's runtime reaches them through the credential proxy (Phase 2 below).
>
> Workspace changes use the dedicated cold action. Scratch and GitHub modes,
> repository, branch, `agentDir`, and read/write access are editable.
> Mode/repository/branch changes require an irreversible warning and replace
> local files; access-only and `agentDir`-only changes preserve the checkout.
> When the identity-attestation gateway is configured, per-user GitHub access
> gates repository selection and workspace changes.
>
> Configure the GitHub App Setup URL as
> `<PUBLIC_CP_URL>/v1/github/setup/callback`. The origin and edge routing are
> supplied by startup topology.
>
> Credential-degradation telemetry and the corresponding web warnings remain
> planned. [Unified managed Git network operations](#unified-managed-git-network-operations)
> has an implemented path for Azure DevOps, Gitea and GitLab inside execution
> environments. GitHub, scoped source operations and the final host-side decision
> remain later deliveries. Controlled transport tests exercise real Git; they do not
> establish live Cloud/VM/executor validation. The capacity gate is measured on one
> pod only.
>
> The workspace _shape_ this document assumes (a per-host `github` mode) is
> being re-modeled into a host-neutral `git` mode with a credential union —
> see [git-workspace-model.md](git-workspace-model.md). The credential track
> here (installations, minting, gitcred) is unchanged by that design.
>
> This design solves two problems: (1) when selecting git mode for a workspace,
> choose a repository directly in the console through the GitHub App instead of
> manually entering a URL; and (2) when the daemon—and the coding agent running
> inside the workspace—performs git clone/fetch/pull/push operations, the
> machine **requires no persistent git credentials**. The CP mints credentials
> on demand; they are short-lived and exist only in daemon memory.

## Background

AgentConnect supports anonymous public-URL workspaces and GitHub App
workspaces. GitHub App mode lets the console select an authorized repository
and lets both daemon-managed and agent-initiated Git operations authenticate
without a host PAT, SSH key, or credential-manager entry. Both App-backed and
manual workspace URLs remain subject to the daemon operator's exact
`security.workspaceGitAllowedOrigins` policy.

The sign-in and repository-access flows may share one GitHub App while using
independent credential tracks. Sign-in uses the App's user authorization
configuration; repository access uses an App JWT and installation access
tokens. Example identities in this document are synthetic.

`workspace/gitstatus` remains a local read. Its behind/ahead values come from
the local tracking ref and require no credential, although they can become
stale until a network fetch succeeds.

## Design Goals and Non-Goals

**Goals**

1. When creating an agent in the console and selecting GitHub mode for its
   workspace, **select** a repository (and branch) from the repositories
   authorized for the GitHub App installation instead of manually entering a
   URL. Manual entry of a public URL remains an adjacent option.
2. Maintain **zero persistent git credentials** on the daemon host: no PAT, no
   SSH key, no osxkeychain entry, and no token in `.git/config`. Every remote
   git operation uses a GitHub App **installation access token** (fixed 1-hour
   TTL, single-repository scope, narrowed permissions), minted by the CP,
   delivered over WS, and held in daemon memory.
3. **Git operations initiated by the agent must also work without host
   credentials.** A coding agent in the workspace can run `git push` directly
   without requiring the user to sign in to anything on the machine.
4. Preserve the data-plane invariant: the App **private key exists only in
   the CP** and is never delivered elsewhere. A scoped installation token is
   delivered through `gitcred/grant` over the authenticated control WebSocket,
   like other assigned credential material. Webchat content remains on relay
   `rd/*`, and the CP is not on the message hot path.
5. Degrade gracefully when the CP is down: cached tokens remain usable until
   expiry. After expiry, only remote git operations fail; local operations and
   existing sessions remain unaffected.

**Current scope exclusions**

- GitHub Enterprise Server (custom `baseUrl`): reserve an extension point but
  do not implement it.
- Real-time synchronization of installation or repository
  additions/removals: the CP reconciles on demand and fails closed when
  minting shows that authorization changed.
- **Per-organization GitHub Apps as the deployment identity**: the built-in
  App stays instance-level configuration and carries sign-in and the install
  callback. An organization can add GitHub Apps that its agents work through
  one at a time (see "Organization GitHub Apps").
- Other git hosts such as GitLab or Bitbucket: protocol fields retain an
  extension point for providers.
- SSH remotes: use HTTPS exclusively. Relative URLs in `.gitmodules` resolve to
  HTTPS through the parent repository and are unaffected.
- Automatic authorization of private submodules or nested repositories:
  additional repositories require an explicit `AgentRepoAuthorization`.
- **Git LFS:** unsupported. LFS uses a separate batch endpoint
  (`https://github.com/owner/repo.git/info/lfs`). Although it uses the same
  github.com host and invokes the helper, its `/info/lfs` suffix does not match
  the repository path when `useHttpPath` is enabled. The helper reset makes the
  failure clean and prevents fallback to personal credentials.
- Process-level isolation among multiple agents on the same daemon; see
  "Security Boundary: Trust Model."

## Decisions

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Reuse one deployment-wide GitHub App for repository access and sign-in.** Setup Server creates or adopts the App and stores its identity in the typed deployment configuration. Without that provider configuration, the picker is hidden and only public-URL mode remains.                                                                                                                                                                                                                                                                                                                             | An instance can use its own App as a trust boundary, while one entry point for sign-in and repository authorization is natural for users. The App is deployment-wide rather than per organization.                                                            |
| 2   | **Store the private key as a write-only deployment secret.** Ordinary admin reads expose only configured state and a fingerprint. The Control Plane opens the key when assembling the GitHub service and never sends it to a daemon.                                                                                                                                                                                                                                                                                                                                                                      | The database-backed configuration gives self-hosters one managed setup surface while the deployment's `SecretCipher` policy controls protection at rest. Daemons still receive only short-lived installation tokens.                                          |
| 3   | **Pull tokens on demand:** the daemon sends the D->C REQ `gitcred/request`; after minting, the CP returns the REP `gitcred/grant` containing the token itself.                                                                                                                                                                                                                                                                                                                                                                                                                                            | Pulling aligns credential delivery with the operation that needs it and avoids placing an expiring token in a long-lived registration snapshot.                                                                                                               |
| 4   | **Minimize token scope:** mint for one authorized repository and only the requested capability subset. Read access excludes write operations; write access admits the current contents/issues/pull-request/actions matrix, with metadata read always available. See `installation-token.service.ts` for the authoritative matrix.                                                                                                                                                                                                                                                                         | A coding agent needs only the capabilities required for the current Git or GitHub operation. Per-repository, per-capability minting keeps unrelated repositories and actions out of each token. Sensitive use cases can switch to read-only with one control. |
| 5   | **Use git credential-helper injection uniformly on the daemon, through two channels:** (1) repository-local `credential.helper` points to `agentconnect git-credential`, which asks the daemon for a token through a local Unix socket; (2) the agent session process environment injects the same helper at host scope, covering submodules/nested repositories and preventing personal-credential leakage (see "Subrepositories"). Operations such as clone, where repository config does not yet exist, use `GIT_CONFIG_*` environment injection. The token never enters argv, disk, or `.git/config`. | This is the only clean solution that covers git operations initiated by both the **daemon** and the **agent**. The helper script itself contains no secret and is not a credential.                                                                           |
| 6   | **Two layers of token caches plus two layers of single-flight in the CP and daemon, with nested TTL thresholds**; see "TTL and Idempotency" for details.                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Controls GitHub token-minting API traffic and rate-limit pressure, absorbs retransmissions and thundering herds, and ensures the token handed to git has sufficient remaining lifetime.                                                                       |
| 7   | **Resolve the installation dynamically at mint time:** the agent record does not separately store the repository's full name; derive `owner/repo` from `gitRepo`. `installationId` records the selection observation but is not an authoritative binding. At mint time, find a live installation in the organization for the repository owner. The daemon does not need to know the installation; the wire adds only a `gitCredential?: 'github-app'` marker.                                                                                                                                             | Uninstalling and reinstalling an App produces a **new** installation ID. Dynamic resolution lets an existing agent recover without retargeting its workspace. Repository ownership resolution stays in the CP, minimizing the wire surface.                   |

## Security Boundary

### Trust Model

0. **Where "the daemon host" is depends on the mode.** Everything below describes
   the self-hosted shape, where the daemon, the helper it writes and the git that
   runs it share a filesystem and an OS user. Under `--k8s` they do not: the agent's
   git runs in a sandbox pod, and the helper socket exists only on the daemon's
   filesystem. The socket is reached through the shim's `agent` tunnel, the helper
   is the runtime image's own root-owned executable, and every pointer the daemon
   writes — the `credential.helper` line, `GIT_CONFIG_GLOBAL`, the socket path in
   `AC_AGENT_CHANNEL_SOCKET` — is in the POD's coordinates, resolved from the same
   predicate that decides where git executes. What does NOT change is this
   section's substance: the capability is still per-agent and runtime-only, still
   never written to disk, and the pod holds nothing longer-lived than one launch's
   pair. What the pod adds is that the runtime is the untrusted party on the same
   host as the socket's local end, which is why the tunnel names a closed set of
   servers and the helper is unwritable by the runtime. See
   [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) §6.

1. **A daemon host running under one OS user is ultimately a single trust
   domain, but it must not expose an unrestricted token-vending interface.**
   In addition to `agentId`, the helper socket requires a temporary,
   agent-bound capability generated in daemon memory. It is injected only into
   managed runtime/git subprocess environments and is never written into a
   shim, config, or disk. A normal shell therefore cannot retrieve a token
   directly even if it knows the agentId and socket path, and a capability for
   another agent is rejected. This gate is defense in depth that raises the
   extraction barrier; it is not a host security boundary. An operator who can
   inspect or modify another process owned by the same user may still recover
   the capability or bearer token. Mutually untrusted agents/repositories must
   still run on separate daemons (or under separate OS users).
2. **Placing an agent on a daemon means trusting that daemon's operator with
   write access to the agent's repository.** The CP placement check ("this agent
   is currently placed on this daemon") is necessary, but not sufficient
   authorization. Anyone controlling the daemon process can already drive
   `gitcred/request` to obtain 1-hour write tokens for every placed agent, and
   those tokens work off-host. This is an inherent trust assumption at the
   placement layer and must be considered when scheduling sensitive
   repositories.
3. **Exfiltration of an agent's own repository token by a prompt-injected or
   compromised agent is an accepted residual risk.** The agent must be able to
   obtain a token legitimately in order to push. The token is a bearer token
   valid from anywhere for 1 hour. The available controls are the 1-hour TTL,
   single-repository scope, the `access:read` switch, and the GitHub-side App
   audit log (which attributes pushes to the App). Shorter TTLs or human
   approval before push can be added later as gates.
   Phase 2 of "Daemon-Mediated Agent Access" keeps the token out of the
   execution environment, which retires this residual risk for the agent's
   runtime: a session holds only a placeholder the credential proxy exchanges.
4. **Residual blast radius of the write tier, even for a single repository:**
   the token includes `contents:write + workflows:write`. It can push to any
   unprotected branch, rewrite history with force-push, delete branches/tags,
   and modify `.github/workflows`. A push can **trigger an existing or newly
   written CI workflow, potentially with repository/environment secrets**. It
   cannot access Packages. Repositories with sensitive CI secrets should use
   `access:read` or branch protections that constrain the App.
5. **An App installation is an organization-level resource, while repository
   access is checked per user when identity attestation is enabled.** Resource
   visibility closes the content plane: list/get returns 404 for restricted
   agents; session fan-out is filtered; workspace files/gitstatus/gitpull are
   gated by organization + `canView`, and gitpull also by edit access; webchat
   token minting returns 404; and
   unauthorized SSE items are discarded. Only the organization-owner role widens
   restricted-resource visibility (resource-visibility.md §1, owner exception); no
   role widens repository access. The repository picker filters unauthorized private
   repositories, and branch lookup plus agent create/edit fail closed against
   the requesting user's effective GitHub permission. If identity attestation
   is not configured, repository selection uses the organization-level
   installation authorization set, so the AgentConnect organization is the
   corresponding trust boundary.

### Credential Inventory

| Material                            | Location                                                                                               | Lifetime                                                                                        | Notes                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| App private key (PEM)               | Write-only `github.privateKeyB64` deployment secret at rest → CP memory                                | Long-lived; keys can be added, removed, or rotated in GitHub (the App supports multiple keys)   | Admin reads return only configured state and a fingerprint; `SecretCipher` controls at-rest protection; the value never enters HTTP responses, daemon WS, or logs  |
| App JWT (RS256, exp <= 10 min)      | CP memory only                                                                                         | Minutes                                                                                         | Used only to call the GitHub App API (mint tokens and query installations)                                                                                         |
| Installation access token (`ghs_…`) | CP memory cache -> TLS WS (`gitcred/grant`) -> daemon memory cache -> helper stdout pipe -> git memory | Fixed 1 hour, nonrenewable; **GitHub immediately revokes existing tokens on uninstall/suspend** | **Single-repository scope + narrowed permissions**; never log it or place it in argv, `.git/config`, or any file on disk                                           |
| Local helper capability             | Daemon memory -> managed runtime/git subprocess environment for the corresponding agent                | Daemon lifetime; revoked on agent remove/detach                                                 | Bound to an agent; never enters the shim, config, logs, or disk; prevents a normal shell from invoking the hidden helper directly or connecting to the bare socket |
| Helper configuration line / shim    | Daemon disk (repository `.git/config` + `~/.agentconnect/run/`)                                        | Persistent                                                                                      | **Contains no secret**; it is only a signpost telling git to ask the daemon                                                                                        |

### Callback Endpoint Protection

- **The CP callback endpoint is unauthenticated** because GitHub redirects the
  browser to it. `state` is signed with a **domain-separated subkey derived
  from `API_KEY_PEPPER`**
  (`HMAC-SHA256(pepper, 'github-install-state-v1')`, avoiding cross-purpose key
  reuse with API-key hashing). Its contents are orgId + an expiry measured in
  minutes + nonce. **The nonce is persisted and consumed exactly once**;
  replays are rejected.
- For `installation_id`, the setup callback **must** use an App JWT to query
  `GET /app/installations/{id}` and verify that the installation belongs to
  the configured App. GitHub explicitly recommends not trusting the
  installation ID in the callback. Note that this App is publicly installable,
  so anyone can obtain a "valid" installation ID. Signed state, the lookup, and
  organization claiming are all required.
- **Pin the 302 target to the configured console origin by reusing
  `resolveWebAppUrl(config)`.** The resolution chain is
  `PUBLIC_WEB_URL` (`env.ts:42`, optional) -> the first concrete `CORS_ORIGIN`
  -> `PUBLIC_CP_URL` (`env.ts:81-85`). Daemon session deep links use the same
  origin, delivered through `auth/ok.webAppUrl`; when CP sends no override, the
  daemon uses its local `webAppUrl` or the `http://localhost:3000` default.
  **Do not add configuration.**
  Redirect to `<console>/?github=<note>`, where note is
  `installed`/`retry-install`/`pending-approval`, with no orgSlug path segment. If
  no console URL is configured, it falls back to a plaintext informational
  page (`routes/github.ts`). Never accept a redirect destination from request
  parameters or state; that would permit open redirects.
- **Revocation path:** uninstalling/suspending the App or removing repository
  authorization on GitHub makes minting fail immediately **and immediately
  invalidates existing tokens**, rather than waiting 1 hour. On the daemon,
  the helper's `erase` hook and forced refresh invalidate the cache; see the
  daemon section. Revoking a daemon's API key disconnects WS and prevents it
  from obtaining new tokens.

## Configuration and Data Model

The singleton deployment document is the source of truth. Setup Server stores:

- App ID, slug, optional client ID, and webhook state in `values.github`;
- the base64-encoded private key in the write-only `github.privateKeyB64` deployment
  secret; and
- the webhook and OAuth client secrets as separate write-only deployment secrets.

Clearing the GitHub provider removes its stored identity and secrets, disables
the module, and hides the picker. The private key is decoded and validated when
the Control Plane assembles the GitHub service, without logging the key. Public
Web, Control Plane, and Relay service base URLs remain startup topology because
Setup Server uses them to build the App manifest callbacks. Control Plane and
Relay bases may include ingress path prefixes.

`GithubInstallation` separately stores App installation metadata; repository
lists are fetched from GitHub on demand. An installation is
organization-scoped infrastructure and has no
`visibility`/`sharedWith` columns. A restricted agent's `gitRepo` remains part
of the visibility-gated `AgentDto.workspace`.

```prisma
model GithubInstallation {
  id                  String    @id @default(uuid())
  orgId               String
  installationId      BigInt    @unique
  accountLogin        String
  accountType         String
  repositorySelection String
  permissions         Json      @default("{}")
  suspendedAt         DateTime?
  revokedAt           DateTime?
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt
  @@index([orgId])
  @@map("github_installation")
}
```

The agent's inline workspace columns store the GitHub repository, branch,
directory, installation observation, and access level. Changes flow through
the dedicated cold workspace action:

- `installationId?: string`: the `GithubInstallation.id` selected at creation,
  **for observation only**, without FK-binding semantics. At mint time, find a
  live installation in this organization by repository owner, which
  self-heals after uninstall/reinstall.
- `gitAccess: 'read' | 'write' = 'write'`

**Do not persist `repoFullName` separately.** `gitRepo` is already a normalized
full URL (`GitRepo` codec,
`dto/index.ts:114-117`), and the protocol package exports
`packages/protocol/src/git-url.ts:41 gitRepoLabel(gitRepo)`, which cleanly
extracts `owner/repo` while handling https/scp/host prefixes and a `.git`
suffix. **Compute `gitRepoLabel(gitRepo)` at mint time** and treat it as
authoritative, keeping `gitRepo` as the single source of truth. This avoids a
drift where clone uses `gitRepo` while minting uses `repoFullName`, targeting
different repositories. GitHub-App mode asserts that the host is github.com. A
non-GitHub URL produces a null label and is rejected from GitHub-App mode.

## Organization GitHub Apps

Every installation-token operation is attributed to one App's bot. With only
the built-in App (the deployment-level App Setup configures), every agent is
the same GitHub actor: a pull request opened by one agent cannot be approved
or rejected by another, because GitHub refuses a self-review (`422: cannot
approve your own PR`), and branch rules such as "last push must be approved by
someone else" can never be met. An organization GitHub App gives one agent its
own actor.

**Model.** An organization can hold GitHub Apps beside the built-in App
(`GithubApp`: App id, slug, client id, bot user id; the private key and webhook
secret in `GithubAppSecret`, sealed under the org scope). One agent works
through an App at a time (`Agent.githubAppId`, unique); an App no agent uses is
free for any agent of the organization. Agents start on the built-in App, which
any number of them share. Deleting an agent, or moving it back to the built-in
App, frees its App; the App and its installations stay. Deleting an App is
refused while an agent works through it or while a Check it created is not
finished for good (tombstoned and settled at failure, the test organization
deletion uses), because only the App that created a Check can update it.
Deletion cascades to the App's key and installations; the App itself stays on
GitHub until someone deletes it there.

**Each App end to end.** An agent works through exactly one App: that App's
webhook deliveries fire the agent's hooks, its installations hold the
repositories the agent can be given, and every token minted for the agent is
signed by it. `liveByOrgAndAccount` is always App-qualified, so the built-in
App and an organization App installed on the same account never stand in for
each other, and every installation an agent records (its workspace
installation, installation grants, installation-wide hooks, follow-up watches)
is one of its own App's. Agent-attributed paths resolve with the agent's App;
org-level ones (skill sources, the install callback, a new agent's picker) use
the built-in App. Projection cleanup runs without an agent, so it resolves the
App of the projection's last installation, and the reporter writes an existing
Check with that App on the agent path too: an agent that changed App still
closes the Checks its former App created.

**Switching.** An agent changes App only once the target reaches everything the
agent works on: its workspace repository, its authorized repositories and
installation grants, and the repositories and accounts of its GitHub hooks
(`GET /agents/:id/github-app/coverage?app=`). A repository is covered when the
target's live, unsuspended installation on its account selects all
repositories or includes it; an installation grant or installation-wide hook
needs only that installation. `PUT /agents/:id/github-app` refuses with the
uncovered items until all are covered. It then, in one transaction,
compare-and-sets the agent's App and moves every installation the agent
records to the target App's installation on the same account, and recompiles
the organization's GitHub hooks. A daemon keeps a token it already minted
until it expires (up to an hour).

**Creation** uses GitHub's manifest flow, because GitHub creates an App only
after a person confirms it. The console asks the CP for a manifest for an
agent (`POST /agents/:id/github-app/manifest`, agent editors only) and posts it
to GitHub's create page. The user chooses their personal GitHub account or loads
their organizations through a GitHub authorization popup and selects one from
the owner dropdown. Discovery reuses the built-in GitHub App and requires its
organization **Members: read-only** permission to be approved on each organization
installation. Setup includes this permission in the built-in manifest and audits
existing Apps for it. Updating the manifest does not update existing installations:
an administrator must add the permission in GitHub App settings and organization
owners must approve the change, then refresh the account list. The picker is limited
to organizations accessible to the App, not every organization the user belongs to.
Until the update is approved, existing installations retain their previous permissions
and repository features continue to work; organization discovery remains limited.
The popup uses state and PKCE; the authenticated, agent-editor-only
owner endpoints exchange the code, read `/user` and every page of active
`/user/memberships/orgs`, and revoke the temporary token without persisting it or
changing a linked identity. The list includes members as well as owners because
members may have permission to manage all Apps; GitHub checks creation permission.
Manual organization entry remains available when authorization is unavailable or
the desired organization is not returned. The
request carries `organization: null` for the signed-in personal account or the
organization login. Creation does not require an existing repository. New Apps
are public so they can be installed on additional accounts later; repository
access is still granted separately at installation. Existing private Apps keep
their visibility and can be made public in GitHub's App settings. The manifest asks
for the agent-facing subset of the built-in App's permissions and the built-in
App's events, a webhook at the relay's `/webhooks/github` when its public
origin is HTTPS, and a setup URL naming a pre-allocated App row and the agent
(`/v1/github/apps/<id>/setup/callback/<agentId>`). The org, the agent and that
row id ride a signed one-shot state, keyed apart from the install state.
GitHub redirects to `/v1/github/apps/manifest/callback`; the CP converts the
code once (`POST /app-manifests/{code}/conversions`), stores a free App with
its sealed key and webhook secret, and sends the browser to the App's install
page. After the install GitHub redirects to the setup URL, which syncs the App
and returns the browser to the agent, where the console offers the switch.

**Installations.** Every install or update of an App redirects to its setup
URL (`setup_on_update`), and its webhook delivers `installation` and
`installation_repositories`; either re-pulls `GET /app/installations` with the
App's key, at most once every ten seconds per App (an event inside the window
is deferred, not dropped), claiming each installation for the App's org
(`GithubInstallation.githubAppId`) and marking missing ones revoked. This is
the one place a roster pull claims installations: the built-in App's
installations are claimed only through the signed install callback, because
its roster spans every tenant. An organization App belongs to one organization
(its App id is unique), and holding its private key already proves authority
over all its installations, so neither the redirect nor the webhook needs
state.

**Webhook.** Every App posts to the same relay endpoint, `/webhooks/github`;
the relay picks the secret by the `X-GitHub-Hook-Installation-Target-ID`
header, the App id GitHub names the sender with. The header only selects the
secret: a delivery naming an organization App verifies against that App's
secret alone, and an id the relay does not hold falls back to the built-in
App's. The CP pushes each App's id and webhook secret to every relay that
advertises `github-app-webhook-v1` (`rc/github-app-assign` on creation,
`rc/github-app-unassign` on deletion, a `github-app` replay snapshot when a
relay registers). A verified delivery is handled like the built-in App's.
Compiled GitHub hook rules carry the live installations of the App their agent
works through (`installationIds`), so a delivery fires only the agents on the
App that sent it, and an event on a repository both Apps are installed on
fires each agent once. Installation events ring the doorbell with the App id,
so the CP re-pulls with that App's key. A Check re-run or "Request review"
press names the App on `rc/github-rerequest`, and the CP accepts it only when
the Check's projection last resolved to an installation of that App.

**Handles.** A rule's `appSlug` is the slug of its agent's App, so `@<slug>`
and a review request for `<slug>[bot]` reach only the agents on that App.
`internalAppSlugs` lists the organization's other Apps, the built-in App
included: a same-repository pull request one of them opened is the internal CI
lane, so a coding agent and a reviewing agent on different Apps still review
each other's pull requests automatically.

**Signing.** `InstallationTokenService` and the App-JWT reads
(`pullInstallation`, `uninstallInstallation`) ask the `GithubAppRegistry`
which App an installation belongs to and sign with that App's key. Configs are
cached per App because `mintAppJwt` keys its auth cache on the config object;
creation and deletion invalidate the entry. Token caches stay keyed by
installation id, so two Apps never share an entry.

**Commit attribution.** The identity delivered at `register/ok` is the
built-in App's bot. An agent on an organization App carries its own App's bot
on its spec (`AgentSpec.gitCommitIdentity`, `ID+<slug>[bot]@users.noreply.github.com`
from the App row's slug and bot user id), and the daemon pins it in place of
the registered one for the agent's session commits and its console commits.
The field is absent on the built-in App, and when the App's bot user id is
unknown, so the daemon falls back to the registered identity. A switch bumps
the agent's `configRevision` and re-sends its spec, the move bundle pins the
identity with the rest of the spec, and a changed identity respawns the warm
host, because the identity is fixed in the runtime's environment at spawn. The
daemon's revision digest leaves the field out: it changes only with a switch,
which bumps the revision, so a CP that starts shipping it does not conflict
with a revision a daemon already applied without it.

**Limits.**

- An App gets its webhook only when the relay's public origin is HTTPS at
  creation; without one its events never arrive and its installations are
  refreshed only by the setup redirect.
- "Re-run all checks" on an organization App's Check Suite is dropped;
  re-running the Check itself works.
- A relay keeps an App's secret after the organization is deleted until its
  next registration replay; a delivery it still verifies finds no App on the
  CP and does nothing.

## Daemon-Mediated Agent Access

> **Status:** Phase 1 is implemented. Phase 2 is implemented for GitHub,
> GitLab and Gitea (#3382): the credential proxy always runs, with no switch,
> and is the only way a session reaches a code host with a credential, over
> the host, `srt`, executor, `microsandbox` and pool pod transports. GraphQL
> is read-only; the routed-write list is still proposed. Phase 2 replaces
> Trust Model item 3.

Before Phase 2, agents wrote to GitHub with whatever their `gh` wrapper
minted: a capability-clamped installation token at the repository's tier. The
daemon never saw what `gh pr create` sent. A pull request an agent opened that way
carried no attribution footer (#3261), and routing and Decisions that read the
body on `pull_request.opened` saw only what the model chose to write.

Formal reviews and review-thread replies already go through structured tools
(`submitCodeReview`, `replyGithubReviewThreads`). The standing `# GitHub`
context steers the agent to them, but nothing enforces it: the agent's `gh`
token can still write a review or a comment. This design closes both gaps in
two steps:

1. Phase 1 adds tools for the everyday writes: pull requests, issues and
   comments, through the daemon, which adds the footer at creation time.
2. Phase 2 would remove the token from the execution environment and make
   GraphQL read-only, so those writes go through the tools.

### Phase 1: Writes Through the Daemon

**Tools.** GitHub joins the code-host effect surface
(gitlab-com-integration.md §14.2) with three tools, grouped by object rather
than one per command. Each takes an `action` and flat optional fields that the
daemon validates per action: a field the action does not take, or a missing
required one, is refused before any request. A discriminated union is avoided
because some runtimes reject a top-level `oneOf`.

| Tool                | Actions                                     |
| ------------------- | ------------------------------------------- |
| `githubPullRequest` | create, update, merge, close, reopen        |
| `githubIssue`       | create, update, close, reopen               |
| `githubComment`     | create, update, on an issue or pull request |

- `update` changes only the fields given: title, body, base, draft, labels,
  assignees and reviewers on a pull request; title, body, labels and
  assignees on an issue. `create` sets the initial labels and assignees, and
  `update` adds or removes them, as the hosts' CLIs do, so an update never
  clobbers ones it did not read. Reviewers are added to the requests.
- The REST update cannot change draft state, so a draft change runs
  `convertPullRequestToDraft` or `markPullRequestReadyForReview` on the pull
  request's node id. It does nothing when the state already matches.
- `merge` takes a method (merge, squash or rebase) and an optional head sha
  the merge must still match.
- A comment `update` rewrites only a comment this session posted with the
  tool, as on GitLab and Gitea.

GitLab and Gitea have the same three tools in their own words
(gitlab-com-integration.md §14.2), plus their read tools, which stay separate
so a follow-up check, which only reads, never holds a write action.

Any other write stays on `gh`.
By default the target is the turn's trusted repository: the hook's, else the
workspace's. The spec carries no numeric identity for a GitHub workspace, so
the workspace is addressed by its `owner/repo` path. A cross-fork head stays
on `gh`.

**Other repositories.** Like every code-host effect tool, each takes an
optional `repository` (`owner/repo`) naming another repository the agent is
authorized for (gitlab-com-integration.md §14.2). On GitHub that is an
explicit repository grant, or any repository of an account an installation
grant covers, addressed by its path. The lease below re-checks the named
repository at its own tier, so naming one never raises authority.

**Lease.** The broker's token is the agent's own grant on the target
repository, with the `contents`, `issues` and `pull_requests` capabilities, at the tier
the workspace or an explicit grant earns. `contents` rides along because a
grant reports its access from its contents level; without it every lease
would read as `read`. It needs no new gitcred purpose, because that grant is
already what the agent's `gh` receives. The token stays in its own cache
keyspace and never reaches the runtime. A comment needs the comment tier;
every other action needs write. A GitHub grant cannot echo `comment`, so a
comment-tier grant reads `read`; the broker therefore lets a comment through
on a `read` echo and leaves the decision to the token's own issue and
pull-request scopes, which the Control Plane minted from the tier.

**Footer at creation.** When the agent's footer is on, the daemon appends the
attribution footer (agent, runtime, model, session link) to the description
of a pull request or issue it creates, below a hidden marker. It does this
before any host's broker runs, so GitLab and Gitea get the same footer.

Change requests also carry an `Initiated by` line independently of that optional
footer. The session pins an initiator snapshot at creation, separate from its
routing identity; delegation inherits it, and cross-daemon calls carry it through
the relay without changing authorization. A description update reads the current
description through the broker and retains its recorded initiator, so another
session cannot take credit by rewriting the body. Names are escaped plain text,
with no inferred code-host mentions, account IDs or sign-in addresses.

The snapshot also carries verified linked commit identities resolved through
`agent/read-access` for the initiating organization member. GitHub social or
repository identity supplies the account's numeric ID and login for its noreply
address. A GitLab OAuth connection must belong to that console member, and its
authenticated user must match the recorded provider ID; only its explicitly
public email is used. Ambiguous links and lookup failures supply no commit identity.
Azure DevOps uses the console user's linked Microsoft identity. Its email searches
the connected organization's identities; an active human account must match both
the connection's tenant and the linked Entra object ID, with the same email.
The application credential only reads that identity and never supplies its author.
Tasks with fixed initiators receive a `Co-authored-by` trailer per remote host in their standing instructions
for new commits, preserving the bot author and committer. Gitea bot connections
supply no personal identity. There is no mandatory
linking flow or commit hook.

Ordinary conversations have no session-wide coauthor block. Their current
requester is resolved lazily when delegating or opening a PR; ordinary follow-up
turns make no attribution lookup. Attribution reads use one two-second attempt,
leaving normal read-access requests on their existing retry policy.

- A rewrite replaces only the text above the marker and re-appends the footer,
  so an agent that edits its description keeps it.
- A marker block in the agent's own input is dropped first, so a footer is
  never duplicated.
- An edit that does not touch the description leaves it alone.

A pull request opened this way is also recorded on its task
(assistant-mode.md §5.18), as merge requests already are.

**Guidance.** A session offered a host's tools also gets one line of guidance
naming them: "On GitHub, open, edit and merge pull requests, file issues, and
comment with `githubPullRequest`, `githubIssue` and `githubComment`", and
likewise for GitLab and Gitea. The line rides the tool context, so a session that is not
offered the tools, such as a follow-up check, does not get it.

**What stays the same.** `gh` keeps working for every write, but a pull
request or issue opened that way has no footer. Adoption of the tools is
measured before Phase 2 makes GraphQL read-only.

### Phase 2: The Daemon Credential Proxy

**Model.** The daemon would run one egress proxy for agent credentials. The
agent's environment would hold only a session-bound placeholder, so a runtime
that bypasses the proxy holds nothing usable and fails closed.

For each request the proxy would:

1. resolve the session from the placeholder;
2. select the installation and repository;
3. apply the agent's existing tier, GraphQL's read-only rule, and the
   routed-write list below;
4. mint or refresh the real token; and
5. forward the request.

What an agent may do within its authorization would not shrink. Where the
token lives would change, and a write that GraphQL carried today would go
through a tool or REST instead.

**One proxy, one transport per strategy.** Credential logic would exist once,
in the daemon, for every execution strategy. Only how a request reaches the
proxy differs:

| Strategy                              | Transport                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `microsandbox`                        | the `codehost` and `provider` tunnels, from one loopback listener in the VM's shim                 |
| pool pod                              | the `codehost` and `provider` tunnels, from one loopback listener in the pod's shim                |
| `srt` and host                        | a loopback or Unix-socket listener under the daemon root                                           |
| host, placed on an executor           | the `codehost` and `provider` tunnels, from one loopback listener in the executor's shim           |
| `srt`, placed on an executor          | the `codehost` tunnel, from the Unix socket in the executor's shim that `srt` routes code hosts to |
| `microsandbox`, placed on an executor | the `codehost` tunnel, from a loopback listener in the VM's shim, through the executor's pipe      |

**Client configuration.** Every strategy would get the same configuration.
Only the proxy address differs:

- git presents the placeholder through its session credential helper and
  reaches the proxy over HTTPS, as every other client does. `srt`'s route to
  the proxy carries HTTPS, so one path serves every strategy;
- `gh`, which cannot be pointed at another API origin for `github.com`, gets
  `HTTPS_PROXY`, the daemon CA in the usual trust variables, and the
  placeholder as `GH_TOKEN`; and
- every other client sees the same variables, with `NODE_USE_ENV_PROXY=1`,
  since Node's `fetch` and `https` ignore `HTTPS_PROXY` without it.

**The runtime holds no minting credential.** The daemon and the agent runtime
hold separate agent channel capabilities. The runtime's serves only live secrets: a
`get` or `erase` presented with it is always refused with an error saying git
and `gh` go through the proxy, so nothing in a session can obtain a real
token. The daemon's own Git keeps minting with the daemon's capability, and so
does the in-pod auto-merge watcher.

- The session gitconfig and a checkout's `.git/config` both pin a helper that
  answers only with the placeholder in `AC_CODEHOST_CREDENTIAL`, and with
  nothing when the environment carries none. The checkout pin serves only the
  runtime, since the daemon's own Git sets its helper at command scope, so a
  child that resets `GIT_CONFIG_COUNT` still presents the placeholder and
  needs no command-scope override of its own.
- No `gh` or `glab` wrapper stands in front of the real CLI: `GH_TOKEN` and
  `GITLAB_TOKEN` carry the placeholder, and `GITLAB_HOST` names the spec's
  instance for every GitLab-credentialed session. `agentconnect-secrets` has
  its own directory on the `PATH`; a shim (`srt`, a VM, a pod, an executor)
  puts its own copy first.
- A session that does not reach the proxy holds no code-host credential: the
  proxy did not start, its executor's shim serves no `codehost` listener, its
  executor's `srt` boundary does not route all of the agent's code hosts, or
  its VM or pod shim reports no `codehost` listener (for a VM placed on an
  executor, none that keeps its seed's trust files). The daemon logs the
  reason once per session.

**Capture.** The proxy needs no transparent capture, because a client that
bypasses it holds only the placeholder and fails closed. Whether a client
reaches the proxy is therefore a matter of usability, never of exposure:

- Under `srt` the network namespace has no route but `srt`'s own proxy, so a
  client that ignores the proxy variables has no network at all. `srt`'s
  `mitmProxy` option routes the code-host domains to the daemon's proxy over
  a Unix socket, so `srt` keeps setting the proxy variables and the daemon
  only adds the trust variables.
- Elsewhere (the host, the VM, a pool pod) the proxy variables point at the
  daemon's proxy, and a client that ignores them reaches the code host with
  the placeholder and is refused.
- `gh`, `git`, `curl`, Go's `net/http` (and so `glab`), Python's `urllib` and
  `requests` honor `HTTPS_PROXY`; Node's `fetch` and `https` honor it only
  with `NODE_USE_ENV_PROXY=1`, which the daemon already sets for `srt` and the
  pod shim and would set everywhere.

**Trust.** The proxy terminates TLS only for the code-host domains, with a
daemon CA. `SSL_CERT_FILE` replaces the system roots, so it names a bundle of
the system roots, the operator's authorities (the files `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `SSL_CERT_DIR` and `GIT_SSL_CAINFO` name for the daemon,
gitlab-com-integration.md §24.5) and that CA. The proxy verifies the code host
upstream with the same roots and operator authorities, since a self-managed
instance is often signed by a private CA. Python's `requests` reads its own bundle and
needs `REQUESTS_CA_BUNDLE` as well, and git reads `GIT_SSL_CAINFO`. Node adds
the bundle through `NODE_EXTRA_CA_CERTS`. A sandbox may read only the
directory holding the certificate and the bundle; the CA key and the
placeholder key stay outside it. `srt` intercepts only the environments of an
agent with a managed code-host credential, routes only that agent's instance
hosts to the proxy, and every session there gets the trust variables, a
placeholder or not. A session whose own environment names files in those
variables keeps their authorities: it is pointed at a copy of the bundle with
them merged in, keyed by content, which the daemon writes beside the bundle on
its own machine and an executor's shim writes beside its listener bundle on
that machine, skipping a file it cannot read.

A session behind a shim's `codehost` listener (an executor's host session, a
VM, a pool pod) trusts a bundle that shim writes in its own environment: that
environment's roots and the CA certificate the `listen` carried. The `listen`
carries the certificate alone; a whole bundle would not fit a shim frame
(256 KiB). A VM's or pod's launch switches its trust variables to that bundle
at spawn and hands the shim the files they named before, which the shim merges
in as it does a placed session's own. In a VM those include the files
`microsandbox` names for its provider-key substitution (its own CA and the
guest bundle it adds that CA to), so the session trusts both the substitution
and the proxy. A VM placed on an executor gets those variables from its
executor's seed rather than its launch, so its switch asks the shim to merge
the files the seed names.

**Token selection.** The proxy takes the repository from the request path: a
smart-HTTP path for git, and `/repos/{owner}/{repo}/…` for REST, and mints
that repository's token at its tier. A read that names no repository, such as
`/user`, uses the workspace's read-tier token; a write outside a repository is
refused. Because some hosts cannot narrow a token per repository, the proxy
also enforces the git tier by service on every host: `git-receive-pack` and
`info/refs?service=git-receive-pack` are refused with 403 unless the grant is
`write` (`comment` counts as read), and nothing is forwarded. A 401 from the
upstream drops the cache entry that minted the token it carried, as the
helper's `erase` does, so a revoked or rotated token is minted afresh on the
next request; a 403 keeps it. A session that does not reach the proxy holds
no code-host credential at all.

**Instances.** An agent's instances are the hosts its session Git
configuration pins (gitlab-com-integration.md §24.4): GitHub, and the spec's
GitLab and Gitea instances when the workspace or an authorized repository is
on them. Each instance is matched by its host and non-default port, and its
path prefix is stripped on a segment boundary before routing. The proxy
terminates TLS only for the instances of an agent it runs, and over an agent's
own socket only for that agent's.

- GitLab: git at `<namespace…>/<project>(.git)/info/refs`,
  `git-upload-pack` or `git-receive-pack`, with nested namespaces; the API at
  `/api/v4/projects/<id or encoded path>/…`. A numeric id must be the
  workspace's or an authorized project's.
- Gitea: git at `<owner>/<repo>(.git)/…`; the API at
  `/api/v1/repos/<owner>/<repo>/…`.
- A dot segment, an empty segment or any other path that does not name one
  repository unambiguously is refused. A path outside the prefix, or a web
  page, is forwarded without a credential.
- The token comes through the credential helper's own ask (provider, path,
  numeric identity), so it carries the agent's tier on that repository. git
  gets Basic with the grant's user name; the API gets the header and scheme
  the client used (`PRIVATE-TOKEN` or `Bearer` on GitLab, `token`, `Bearer` or
  Basic on Gitea).
- The API is read-only on both hosts: a GitLab API read takes the read
  credential of the `glab` plane, a write is refused
  with an error naming the host's effect tools, and a read naming no
  repository uses the workspace's credential. `glab` receives the placeholder
  as `GITLAB_TOKEN`.

**The placeholder.** The environment's credential is sealed by the daemon: it
names the agent and the hosts it may be presented to, under an HMAC with a
daemon key kept across restarts, so the proxy verifies it without a lookup. A
placeholder that is forged, presented to another host or over plain HTTP, or
issued to an agent this daemon no longer runs is refused with 403. A
credential that is not a placeholder, such as a token the agent was given
itself, passes untouched.

**Listeners.** `srt` reaches the proxy over a Unix socket of the agent's own
in the daemon's run directory, which honors only that agent's placeholder: one
that leaks into another agent's environment buys nothing there. On the host,
the proxy listens on loopback and requires the proxy credential carried in the
`HTTPS_PROXY` URL, so it is no open proxy to other local processes; a host
session has no boundary from another agent's to begin with.

A daemon that reaches the network through its own outbound proxy
(`HTTPS_PROXY`, `NO_PROXY`) sends every listener's upstream leg through it:
terminated code-host and provider requests, the CONNECTs it does not
intercept, and the `srt` sockets alike, with proxy authentication from the
URL and TLS still verified against the daemon's upstream authorities, while
a `NO_PROXY` host is dialed directly. A host session is proxied there too:
its `HTTPS_PROXY` names the loopback listener, and its `NO_PROXY` keeps the
daemon's entries except one that would route an intercepted host around the
proxy. The outbound proxy resolves the names it carries, so on that route the
daemon's address guard sees only an intercepted host named by an IP literal,
which it refuses in denied space on either route; names are left to that proxy.

A host session a daemon-group member placed on another member's executor
(session-executors.md §7) reaches its holder's proxy over the `codehost` shim
tunnel. The holder asks a host-strategy session's shim for it only for an
agent the proxy intercepts, and the `listen` carries the agent's code-host
routes (each SaaS name on 443, a self-managed instance on its own port) and
the proxy's CA certificate:

- The executor's shim shares the machine's loopback with other shims, so it
  serves `codehost` as an HTTP proxy on an ephemeral loopback port, with a
  proxy credential of its own, and reports the port, the credential and a
  trust bundle (that machine's roots and the CA) back. The session's
  `HTTPS_PROXY` names that listener, `NO_PROXY` names loopback, and its trust
  variables name that bundle.
- A CONNECT to one of the routes enters the tunnel as a fresh CONNECT with
  no client header; any other host is connected directly, as the session
  would without a proxy, since `HTTPS_PROXY` cannot be scoped to some hosts.
- Ordinary HTTP proxy requests to other authorities are authenticated and
  forwarded directly, with request and response streaming and no proxy credentials
  forwarded upstream. A credential-tunnel authority requires CONNECT; an HTTP
  request never downgrades that route to a direct connection.
- On the holder, the tunnel ends at a Unix socket of the agent's own that
  honors only that agent's placeholder and refuses a CONNECT to anything but
  its routes, whatever the executor's shim forwards.
- `codehost` streams have their own cap (16 per session) beside the helper
  tunnels' 32, so a burst of clones cannot take `mcp` or `agent` slots, and
  end after five idle minutes. A renewal of the shim channel ends a stream
  with a frame in flight, as for the helpers: a lost or repeated fragment
  corrupts a TLS record, so the client's retry is the only recovery.
- The `provider` tunnel (Provider keys, below) is served by the same listener:
  one `HTTPS_PROXY` per session, whose CONNECTs go into `codehost` for a
  code-host route, into `provider` for a provider route, and straight out for
  anything else. Each `listen` carries its own routes and the proxy's CA, and
  the shim's one trust bundle holds every CA a `listen` carried. The holder
  ends each tunnel at its own socket of the agent's, which exchanges only that
  tunnel's kind of placeholder and CONNECTs only to that tunnel's routes, so a
  code-host placeholder is refused on `provider` and a provider placeholder on
  `codehost`.
- An `srt` session placed on an executor reaches the same tunnel through `srt`.
  Its `prepare` names the agent's code-host names, and the executor starts
  the boundary with `mitmProxy` routing them to a Unix socket in the shim's
  runtime root; a later `prepare` naming others starts it again. The shim
  serves that socket at the holder's `codehost` listen and reports the names.
  A CONNECT to one of the routes enters the tunnel, and any other is refused,
  since the network namespace has no other way out. The session gets the
  placeholder only when those names cover all of the agent's code hosts, and
  every session and the holder's Git there trust the shim's bundle, since
  everything `srt` routes ends at the proxy.
- A VM session placed on an executor switches at spawn, as a local VM's does
  (below): its holder asks the guest shim for `codehost` through the
  executor's pipe, and its launch carries the placeholder variables. Its
  trust variables come from the seed its executor started the shim with,
  naming the substitution authority and the guest bundle, which the holder
  cannot name. So the switch names no files and asks the shim to keep those
  its seed names instead: the shim merges them into its listener bundle
  before exec. A shim whose `codehost` reply does not say it keeps them is not
  switched.
- A session on an executor whose shim does not serve `codehost`, or whose VM
  shim does not say it keeps its seed's trust files, holds no code-host
  credential.

A session in a local `microsandbox` VM or a pool pod reaches its own daemon's
proxy the same way, through the shim inside the VM or pod. The daemon asks
for `codehost` beside `agent` and `mcp` for an agent the proxy intercepts,
and the switch happens at spawn, after the bind:

- The launch carries the placeholder variables beside its env. The driver
  applies them, with the listener's `HTTPS_PROXY` and trust bundle, only when
  the shim it just bound reported a `codehost` listener and the launch names
  no `HTTPS_PROXY` of its own; otherwise the runtime starts with no code-host
  credential. A pod image whose shim predates `codehost` refuses the
  `listen`, so its sessions hold none.
- Inside a VM or pod a non-route CONNECT leaves from that guest's own network,
  so a VM's provider-key substitution still applies to it.

Pool members do not share the proxy's key or CA: each member keeps its own
under its daemon root. None is needed, because the member that seals a pod
session's placeholder is the member whose channel carries that pod's
`codehost` streams. The spawn that receives the placeholder is made over the
channel that member holds. A pod's channel moves to another member only by a
new binding at a higher generation; the old member's hosts end with their
channel, and the new member starts its runtimes with its own placeholder.
That member's `listen` rewrites the pod's trust bundle with its own CA, and a
runtime process that outlived the move presents a placeholder the new member
refuses with 403, so the failure is closed.

A SaaS
code-host name (GitHub's, `gitlab.com`, `gitea.com`) never resolves to
loopback, private, link-local or unspecified space upstream. A self-managed
instance may live at a private address, so its name is refused only loopback,
link-local (cloud metadata) and unspecified space.

**GraphQL is read-only.** A GraphQL request names no repository in its URL,
and GitHub applies a token's permissions to every repository the token lists,
so no single token could carry each repository's own tier. The proxy would
therefore reads the document's operation types and forwards only queries,
with a read-tier token for the repository the query's variables name (`owner`
with `name` or `repo`), else the workspace's. It refuses every mutation, and a
document it cannot read, with an error naming the tool for that write; `gh`
prints the error, so the agent sees it.

This keeps one rule on every host: GitLab's CLI is already read-only and its
writes already go through the daemon. Features that exist only in GraphQL,
such as Projects and Discussions, become unavailable until a tool covers them.

**Writes through tools.** `gh` sends most pull-request and issue writes over
GraphQL (`pr edit`, `pr merge`, `pr ready`, `issue create`, `pr comment`).
Phase 1's tools carry those writes, so the refusal names the tool, and the
agent retries there. An agent's first attempt with `gh` costs that one round.

**REST stays tiered.** A REST write names its repository, so the proxy would
forward it with that repository's token. `gh api` thereby covers any write no
tool has yet, so a missing action never strands an agent.

**Routed writes.** On REST, the proxy would refuse a short list of writes and
name the tool that owns each one:

| Write                              | Owner                                                |
| ---------------------------------- | ---------------------------------------------------- |
| formal reviews                     | `submitCodeReview`                                   |
| opening a pull request             | `githubPullRequest`                                  |
| comments and review-thread replies | the daemon's final reply, `replyGithubReviewThreads` |

The third row would apply only while a delivery turn is active. GraphQL needs
no rows, since it carries no writes.

The list is not a security control: authority comes from the tier. A write
the list misses produces the wrong product behavior, never excess access.

**What it retired.** The daemon's `features.credentialProxy` switch; the
runtime's token helpers, the hidden `gh-token` and `glab-token` commands and
the image's `shim/gh-token.js` and `shim/glab-token.js`; the `gh` and `glab`
wrappers that called them (the daemon's `run/bin` and the image's
`pathbin/gh`) with their argv target resolution (`gh-target.ts`,
`glab-target.ts`); and the runtime's ability to mint credentials over the
helper channel. The channel and its per-agent capabilities stay: the daemon
and the agent runtime each hold their own, the runtime's keeps serving live
secrets, and the daemon's own Git operations keep using the agent channel unchanged.

**What it does not cover.** Runtime sign-ins and provider credentials keep
their own handling (session-executors.md §8), including the VM's
hostname-scoped placeholders. Cluster access is expected through an MCP
server running outside the execution environment, not through this proxy.

#### Provider keys

The proxy's transport is independent of where a credential comes from, so
provider API keys (Anthropic, OpenAI and the like), whether exported from the
host's sign-in or issued by the key server, use it too. That takes the real key
out of the `srt` and host environments, where a command the agent runs can read
it today, and is meant to replace the VM's hostname-scoped placeholders.
Subscription sign-ins (OAuth) stay out: the daemon does not hold or refresh a
person's subscription login on others' behalf.

Organization Provider keys use it in host, `srt`, local `microsandbox` VM and
executor-placed host sessions. When the proxy runs,
a launch with an organization key registers the agent's slot `org:<provider>`
at the key's endpoint, or the provider's default endpoint when none is
configured, and the runtime's key variable holds the slot's placeholder. The
base URL stays the real origin. The organization's extra headers are not put in
the environment (`ANTHROPIC_CUSTOM_HEADERS` stays empty, Codex's auth request
carries only the placeholder); the proxy sets them with the key. Resolving the
slot fetches the key again through the same control-plane request a launch
makes, and a key whose endpoint has since moved is refused, so a new session
picks up the new endpoint. The agent's slots go when the agent leaves this
daemon. A host session reaches the loopback listener through `HTTPS_PROXY`; an
`srt` environment routes the provider host to the agent's socket, and one
started before a slot existed is started again before it serves a new launch.
Both trust the proxy bundle, through `CODEX_CA_CERTIFICATE` for Codex as well.
An endpoint configured over plain `http:` keeps the real key in the
environment, since a placeholder is exchanged only over TLS; the daemon logs
that once.

A VM session and an executor-placed host session reach the proxy over the
`provider` shim tunnel, apart from `codehost` so long-lived model streams and
code-host transfers do not share a budget:

- The launch registers the slot as it is built, then carries the real key and,
  beside it, the variables that would carry the placeholder instead. After the
  bind, the driver asks the shim for `provider` with the slot's routes (again,
  if they changed) and applies those variables, the listener's `HTTPS_PROXY`,
  and the shim bundle (also as `CODEX_CA_CERTIFICATE`) only when the shim
  reported the listener and the launch names no other proxy. An executor
  session already routed to that listener for its code hosts keeps its route.
- A shim that predates `provider` refuses the `listen`, so its sessions keep
  the real key, as they did before.
- `provider` streams have a cap of their own (64 per session), wider than
  `codehost`'s since each session holds several long-lived model connections,
  and end after 30 idle minutes, since a streamed response can be silent for
  minutes and a client keeps its connection for the next turn.

The keys the daemon's own machine supplies use it in `srt` sessions too: an API
key in the daemon's environment or the runtime definition's (Claude's
`ANTHROPIC_API_KEY`, Codex's `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, Copilot's
`COPILOT_PROVIDER_API_KEY` at its `COPILOT_PROVIDER_BASE_URL`, Antigravity's
`GEMINI_API_KEY` at the Gemini API or its `GOOGLE_GEMINI_BASE_URL`), the API key
field of a sign-in file (Claude's `primaryApiKey`, Codex's `auth.json` in API
key mode, the DeepSeek harness's credential files), the API keys
`opencode auth export` lists, and the API keys the other runtimes keep in their
own files: pi's `auth.json` and `models.json`, Grok's model routes in
`config.toml`, Qwen's `settings.json`, Oh My Pi's `agent.db`, Amp's
`secrets.json`, the providers of Kimi's `config.toml`, and the provider entries
of Cline's `providers.json` other than its OAuth sign-ins. The preparers that
protect these keys in a VM find them, with the proxy's placeholder in place of
the VM's, at the hosts they already bind each key to there; a VM protects the
same keys behind its own placeholders, Claude's and Codex's key variables
apart from their sign-in files' keys. Codex's key variable binds where its
`auth.json` key does, at its configured endpoint: the image's pinned Codex
does not route by `OPENAI_BASE_URL`, and in a hosted VM that variable can come
only from the holder's launch, which never authorizes another host for the
executor's key. Devin's
sign-in token travels inside its request bodies, Qoder's personal access token
is exchanged in a request body for a token the runtime then holds, and Qoder's
service account key is checked against a format no placeholder has, so none of
them can go through a proxy that rewrites headers only; they stay in the session
as they are. Each key is a slot
`host:<runtime>:<variable>` at the host the runtime sends it to: the provider's
default, which is `saas`, or the base URL the launch or the runtime's file
configures; a key found in a file is named by the hashed variable its preparer
gives it. The session's variable and its private HOME copy of the file hold the
slot's placeholder, and the file is projected rather than shared. A private copy
an earlier launch left, in `srt` or a VM, has each key the host still binds
replaced by its placeholder, whether it holds that key in the clear or a stale
one, and keeps a key the host no longer binds as it is. Resolving the slot reads
the key again where the machine keeps it, and is refused once the key is gone or
the runtime sends it to another host.
Subscription and OAuth sign-ins are shared or seeded as before. A runtime keeps
its keys as before, and the daemon logs that once, when one of them reaches no
single HTTPS host the proxy recognizes (a cleartext or ported base URL, Codex
with `OPENAI_BASE_URL` set, a DeepSeek endpoint other than its own, a key one
file shares between providers at different hosts, a key read from a command or
a variable, a Grok `auth.json` key or a Qwen key with no base URL, which name no
host), when its sign-in file cannot be read safely, or when a sign-in file would
need projecting on a platform other than Linux. When the proxy did not start, a
launch puts the host's credential back where a private HOME copy holds a
placeholder and keeps the rest of that copy: Claude's saved key, Codex's shared
`auth.json`, the DeepSeek harness's key field, each key field of a JSON, TOML or
YAML file the other runtimes' launches project, taken from the same field of the
host's file, each Oh My Pi API key row, and the host's copy of any other
projected file.

A self-hosted pool's install-wide keys use it in pool pod sessions: the static
pairs (`<PREFIX>MODEL_TOKEN` with its base URL, which `modelEgress.clients`
renders too) and the provider key variables `daemonPool.runtimeEnvironment`
maps (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `DEEPSEEK_API_KEY`,
`COPILOT_PROVIDER_API_KEY`). The pool member reads them from its own
environment, so the pod needs none. A pair is a slot `install:model:<provider>`
and a mapped variable a slot `install:<runtime>:<variable>`, each at the
endpoint the launch's runtime sends that key to, read from the launch's final
environment: its base URL variable, Codex's gateway auth request or configured
base, the base URL an OpenCode or Kilo configuration names for that provider,
else the provider's default. Every variable holding the key must agree on that
one origin, so a token-only pair beside a gateway URL the launch names is
slotted at the gateway. The
launch carries the real key and, beside it, the variables that carry the
placeholder instead (Codex's auth request among them); the driver asks the
pod's shim for `provider` after the bind and applies them only when it reports
the listener, as for a VM, so an image whose shim predates `provider` keeps the
real key. Resolving the slot reads the member's configuration again. A key
stays in the pod's environment, logged once, when its endpoint is plain
`http:`, when its runtime is not known to send it to one endpoint (an
unrecognized runtime, or a variable another OpenCode provider entry reads
too), or when another launch variable also carries it, such as a configuration
document that embeds it. A launch with a key-server grant is unchanged: the
grant is short-lived and scoped to its session. The chart renders a
`modelEgress.clients.<client>.apiKey` into the sandbox template only for a
plain `http:` endpoint, since the member supplies it at launch.

Not covered yet:

- Host-strategy sessions, by design: a process on the host can read the
  machine's own files.
- The pool's runtime probe pod, which lists models with the install's keys as
  they are; it runs no agent.
- Host keys in VM and executor-placed sessions: a VM keeps its own placeholders
  for them, and an executor's sessions use that machine's own keys, which this
  daemon cannot read.
- Keys the key server issues.
- The sign-in files of runtimes without a preparer, and a provider variable the
  session's runtime does not read, which reach an `srt` session as they are.

- **Kind.** A provider placeholder is the same `acph1_` placeholder under the
  same sealing key, with a kind claim `k: provider` and a slot claim `p`. A
  placeholder without `k` is a code host's, so ones sealed before the claim
  existed keep working. The kind is checked first: a code-host placeholder
  presented to a provider origin, or a provider placeholder to a code host, is
  refused with 403.
- **Slots.** An agent's provider keys are slots, each with a stable source
  name (such as `org:anthropic`), its provider, and its upstream origin: host,
  port and an optional path prefix, and whether that origin is the provider's
  own default or an endpoint the operator configured. A placeholder is sealed
  for one slot and its origin, and the daemon resolves the slot's real key, with
  any extra headers the upstream needs, when a request presents it. A resolved
  key is reused briefly; an upstream 401 drops it, so the next request resolves
  it again.
- **Routing.** A request matches a slot by host and port. Under the slot's
  path prefix, the proxy finds the placeholder in `x-api-key`,
  `Authorization: Bearer`, `api-key` or `x-goog-api-key`, puts the real key
  back in the same header, and sets the slot's extra headers. Outside the
  prefix the placeholder is removed and the request forwarded without a
  credential. The body is never read, and a key the agent brought itself
  passes untouched.
- **Boundaries.** As for code hosts, a placeholder is accepted only over HTTPS,
  and over an agent's own socket only that agent's. A provider's default origin
  never resolves into private space; an operator's endpoint is refused only
  loopback, link-local and unspecified addresses. The proxy terminates TLS and
  routes (`srt` domains, the loopback listener) for each agent's slot origins
  alongside its code hosts; a shim tunnel's socket serves one kind only.
- **Streaming.** Responses are piped, so a streamed (server-sent events)
  response reaches the client event by event.
- **Not supported.** A key in the query string, a key in the request body, and
  any Authorization scheme other than Bearer, which is refused with 400.

### Unified managed Git network operations

**Status: Azure-first common path implemented; later migrations proposed.** The
shared preparation path connects Azure daemon workspace Git to the existing proxy
in local SRT/VM, Cloud and remote executor host/SRT/VM environments. Per-operation
route readiness replaces the blanket environment bans in
[Azure DevOps §6.1](azure-devops-integration.md#61-proxy-only). Controlled transport
tests exercise real Git clone, fetch and push through the shim listener and
codehost tunnel, including a direct bundle download and authorization refusals.
These fixtures do not establish the live environment matrix below. Gitea and GitLab
take the same path through the same `proxyOnly` selector. GitHub remains on its
existing daemon-Git path, and the capacity gate is measured on one pod only.

#### Decision and scope

Deliveries 1–3 use the existing daemon credential proxy for managed `ls-remote`,
clone, fetch, pull and push running inside an execution environment: local SRT,
local VM, Cloud pod, or remote executor host/SRT/VM. This includes daemon-authored
workspace preparation there, primary and additional repositories, review refs,
lazy fetches and supported submodule network operations. Scoped skill/source Git
follows with its narrower authorization intact.

Git running on the owning daemon's own machine outside those environments keeps
its current path, including Azure, canonical clones and local host-strategy
preparation. Its migration is a final, measurement-dependent decision, not part
of deliveries 1–3. Agent runtime Git keeps its existing Phase 2 proxy behavior.
The shared rule is the target for migrated operations, not a claim that all Git
callers change in the first delivery.

The migrated Git process receives a placeholder, the route to its owning daemon's proxy,
and the trust bundle for that route. Real upstream tokens stay in trusted service
memory and are attached by the proxy. Migrated Git subprocesses receive neither a real
upstream token nor an agent-channel capability that can retrieve one. The Control
Plane still obtains credentials from the provider; for GitHub it requests the
installation access token from GitHub. Token issuance, provider-specific request
parsing, repository grants and read/write tiers keep their existing owners.

Local-only Git operations keep working without a proxy or Control Plane connection.
Unmanaged SSH credentials and anonymous repository access are outside this managed
credential migration. Managed cleartext HTTP is not a direct-token escape hatch:
it must be rejected with a requirement to configure HTTPS. This change does not
introduce an SSH proxy, a second proxy service, new OS users, or a user-facing switch.
Non-Git REST brokers and watcher API calls are not migrated by changing Git's helper.
In particular, the in-pod auto-merge watcher retains a minting capability until its
separate follow-up; migrating Git does not eliminate same-user credential exposure
from that process.

#### Execution identity and the boundary being protected

The daemon is trusted. The reason to change daemon-authored Git is where that Git
executes, not distrust of the daemon that requested it:

| Execution location | Git and runtime identity today                                                                                   | Existing route to reuse                                                  |
| ------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Owning daemon host | Processes of the daemon's OS user; no same-user security boundary                                                | Keep current daemon Git path; consider loopback proxy in the final step  |
| Local SRT          | Git and runtime are children of the same confined shim                                                           | SRT's code-host route to the daemon socket                               |
| Cloud              | The chart runs the daemon as UID 10002; workspace Git and runtime share UID 10001 in the runtime container       | Pod shim's loopback listener and `codehost` tunnel                       |
| Local VM           | Git and runtime share the shim's image-configured user; canonical preparation outside the VM stays on the daemon | VM shim's loopback listener and `codehost` tunnel                        |
| Remote executor    | Host uses the executor's shim user; SRT and VM put both children inside that strategy's environment              | Executor shim's existing host, SRT or VM route back to the owning daemon |

`shim/exec-handler.ts` runs Git and `shim/acp-runner.ts` runs the runtime without
switching UID between them. `workspace/git-injection.ts` currently supplies the
daemon-holder capability to workspace Git, and `cp/agent-channel-server.ts` keeps
that capability per agent until revocation. A same-user process can potentially
read another process's environment; a daemon label on a bearer capability does not
prove which process is presenting it. Initial preparation before runtime launch
also does not establish isolation for later fetches in a retained environment.

Azure currently refuses token retrieval through a sandbox's helper tunnel even
with a daemon capability. Keep that refusal. Do not enable Azure by relaxing it.
Proxying Git reduces credential exposure; it does not turn unsandboxed host mode
into a boundary against its operator or every same-user process. The trust model
above still applies. During migration, credentials retained by unmigrated callers
remain a documented limitation, not proof that the entire environment is token-free.

A prepared checkout and a successfully configured runtime are different from a
cold start: Phase 2 already supplies runtime Git with the proxy route in these
environments. The Azure-first delivery reuses that transport for daemon workspace
Git and replaces the former blanket host-start refusal with route readiness.
Runtime Git working after a prepared checkout does not prove that startup,
daemon fetches or recovery work. A pre-existing checkout is not a bypass for
missing proxy readiness; live validation must cover the full cold-start path.

#### One operation, one target, one route

Keep authorization and transport separate. The workspace root already carries its
managed provider, repository identity, clone URL and access context. Resolve those
from trusted configuration, not a checkout-controlled `origin` or the agent's main
repository. Resolve the execution location from the same scope/path that selects
the Git runner, including a remote executor's subject and runtime/helper roots.

At the common managed-Git preparation seam, combine that operation's target with
the execution plane's current proxy route. Reuse `proxiedDaemonGitEnv`, the existing
placeholder helper, proxy trust utilities and tunnel listener metadata. Generalize
their inputs as needed; do not add separate Azure Git runners or duplicate token
logic in the Cloud, VM and executor implementations. Provider contracts own address
normalization and authorization; execution planes own listener addresses and paths.
Make this concrete at the existing in-environment Git mapping, including `srtGit`
and `proxyOnlyBases(agentId)`: the new preparation must take the operation's managed
target rather than use an agent-wide list of proxy-only origins as the decision.
The existing scope includes additional repository hosts; preserve that coverage
while checking GitHub-primary/Azure-additional and its inverse explicitly.

The prepared environment must:

- Pin the placeholder helper for the authorized HTTPS origin and supported aliases,
  retaining path-aware provider resolution, including Azure organization/project
  paths and self-managed instance prefixes and ports.
- Replace command-scope pins that currently force a direct connection, including
  `http.proxy` and `remote.<name>.proxy`, with the selected route. Setting only
  `HTTPS_PROXY` cannot override Git's explicit empty proxy settings. Ensure inherited
  `NO_PROXY` entries cannot bypass that route for the managed target.
- Preserve Source Cache routing: `--bundle-uri` downloads its presigned bundle
  from the object-store URL, outside the `codehost` tunnel; only the managed
  remote's top-up fetch crosses it. Use target-scoped Git proxy configuration or
  the existing shim's direct route for non-code-host authorities. A broad proxy
  environment must not send bundle bytes through the pool member. Keep object-store
  authorization, TLS verification and redaction of signed URLs unchanged.
- Preserve TLS verification and the execution environment's required trust roots.
  A pod or executor uses the bundle path its shim reports, never a daemon-local path.
  Preserve existing credential-helper resets and workspace Git hardening.
- Remove token-minting capabilities from migrated Git environments. Do not leave
  a real helper for an unrelated provider in an Azure operation's environment.
  A multi-target operation must have every managed target covered before it starts;
  do not quietly retain a real-token helper to make a partial conversion work.
- Keep configuration per invocation. Concurrent operations must not mutate shared
  process environment or replace the session's Git configuration with one provider's
  credentials. Redact placeholders and proxy authentication from diagnostics too.

The runtime keeps its existing multi-provider proxy configuration. The proxy still
resolves the repository from each request and applies that repository's grant. A
shared listener or placeholder is not a union of all repositories' write permissions.

#### Mixed repositories and an Azure-first delivery

An agent is never classified as an Azure agent or a GitHub agent for routing. A
GitHub primary workspace can have an Azure additional repository, and vice versa.
Scratch workspaces with only additional repositories follow the same rule.

| Operation in the same agent                                | First delivery                                                                 | Final state                                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| In-environment daemon Git targeting Azure, Gitea or GitLab | Shared proxy preparation                                                       | Same path                                                             |
| In-environment daemon Git targeting GitHub                 | Existing helper path, unchanged                                                | Shared proxy preparation after capacity gate                          |
| Git on the owning daemon's own machine, including Azure    | Existing helper path, unchanged                                                | Separate final decision after full-clone measurement                  |
| Agent runtime Git targeting either repository              | Existing multi-provider proxy path, verified in the newly enabled environments | Same path                                                             |
| In-environment private managed skill/source Git            | Existing scoped credential-window path                                         | Proxy path preserving the window's subject, repository set and access |

The first delivery can select proxy preparation at the common operation seam using
the target provider's existing `proxyOnly` contract. Do not inspect whether the
agent has _any_ Azure repository, branch on provider names in execution planes, or
add a second provider rollout flag. The selector is temporary: once ordinary
managed workspace Git inside execution environments is migrated, every such target
takes the shared path. The owning daemon's host-side path remains deferred.
The provider's token-release restrictions remain a separate contract.

Gitea joins the first delivery instead of waiting for the capacity gate. Its one token
is the organization's bot token, which reaches every repository the bot administers
whatever the agent's grant, and its tiers are an AgentConnect clamp rather than a
provider role ([Gitea §5](gitea-integration.md#5-resource-model)). A GitHub token is
one repository for an hour, and a GitLab token is the agent's own account. The gate
still applies before GitHub moves, and its measurement includes Gitea's clones.
Until it is measured, a pool member's Gitea cold clones cross its event loop
unmeasured, as Azure's do. An operator who sees renewal delay approach `T_fence`
under that load moves those agents to a self-hosted daemon's host strategy, whose
Git keeps its direct path, until the measurement exists.

GitLab follows after the single-pod measurement below. Its tokens are the service
account's personal access tokens, which last months and reach every project the
account is a member of
([GitLab §13.2](gitlab-com-integration.md#132-https-credential-helper)), so like
Gitea's they are a standing credential rather than a short-lived one. A member with
several pods cloning at once is still unmeasured, and the same operator fallback
applies to GitLab's cold clones.

A GitHub operation may still carry its existing daemon capability during this
stage. That is transitional exposure for that operation, not permission to retrieve
Azure credentials: retain Azure's refusal on tunneled helper requests and keep the
runtime capability unable to mint. Host mode retains its documented same-user trust
assumption. Do not claim that a mixed agent is entirely free of minting capabilities
until its remaining callers have migrated.

This staging is acceptable only if it needs one selection at the existing target
seam. If implementation requires two session environments, provider-specific tunnel
lifecycles, or mixed real/placeholder helpers inside one Git invocation, migrate the
ordinary in-environment workspace Git callers together instead, subject to the same
capacity gate required for delivery 2. Keep skill/source-window migration as a
separate delivery. The goal is a small shared implementation, not a permanent
provider split merely to make the first PR Azure-only.

#### Readiness, recovery and Azure availability

Prepare/bind the execution environment and its `codehost` listener before the first
managed network operation, without requiring an ACP runtime to be running. The
existing bind path already establishes tunnels. Workspace preparation must await
that readiness and use its reported route; it must not wait for runtime spawn to
inject the proxy environment after the clone has already needed credentials.

Read the route from the current binding for each operation. A reconnect or pool
member change can replace the listener, CA and placeholder owner. Reject stale
bindings; terminate or fail in-flight operations through the existing Git runner
semantics. Preserve the rule that mutations are not automatically replayed after
an ambiguous channel loss. Prewarming may warm the proxy's token cache, but must
not put a token or minting capability in the child environment.

Preparation owns its environment hold and tunnel binding even if no runtime is ever
launched. Release the operation hold in `finally` on success, cancellation or failure;
a prepared environment retained for reuse remains subject to the existing idle policy.
Agent move/retirement or binding replacement must fence the old subject, close its
streams and release its tunnel listeners through the existing lifecycle, without
waiting for an ACP process to exit. Do not close a shared listener still held by
another valid operation or runtime. A retired binding cannot carry later Git requests;
any resumed preparation must acquire the current binding and route again.

A missing proxy, unsupported listener, incomplete trust bundle or uncovered target
fails the network operation with an actionable reason. There is no retry through a
real-token helper or anonymous fallback for a managed operation. Existing callers
that deliberately tolerate an offline fetch may retain their checkout; required
clone/exact-review preparation must not report success with missing content. Local
Git operations and credential-free research/dream hosts remain available.

Replace Azure's blanket Cloud/VM/executor refusal with the same route-readiness
check. A capable pool daemon can advertise Azure support while its proxy is running;
the specific pod/executor must still pass preparation. Existing protocol feature
advertisement cannot prove that an old shim supports a changed request. Prefer the
existing `codehost` contract and runner-side environment mapping; if a shim payload
must change, negotiate that capability and fail explicitly on unsupported peers.
Do not add a compatibility path that hands them real tokens.

Azure CLI setup must also use the existing provider `cli` contract with paths in
the execution environment: the placeholder, fresh CLI state directory and trust
bundle belong there. Do not send a local host's Azure configuration/extension path
into a pod or VM. Validate `az` where the image or executor supplies it; absence of
that optional executable is distinct from Git credential support. Supporting Azure
Git must not silently claim that the Azure CLI is installed in every image.

#### Remaining migration and implementation ownership

1. **Shared route plus Azure:** common managed-operation preparation inside execution
   environments, all their transports, Azure primary/additional repositories and
   hooks/review checkout;
   preserve other providers' helper behavior and all owning-daemon host-side Git.
   Remove the environment bans only after
   the mixed-repository and readiness checks pass. This delivery also updates
   `.oss-scanner/threat_model.md` to record credential-proxy and Azure trust boundaries,
   the changed Git credential path, and the remaining exposure of unmigrated callers.
   Reconcile Azure §6.1 and `proxiedDaemonGitEnv` together: replace the current exception
   that retains a daemon capability when another provider's real helper is present
   with the new rule that every managed target in a migrated invocation uses the
   proxy. A banner alone does not update that contract. Include cleanup of environments
   prepared without launching a runtime in the implementation and its verification.
2. **Other ordinary managed repositories:** after the measured capacity gate below,
   move GitHub in-environment workspace/review and supported nested-repository
   network calls to that same path; Gitea and GitLab moved earlier. Host-side canonical clones
   stay unchanged.
   Remove the temporary selector, audit direct Git call sites, and remove obsolete
   Git token-helper injection from migrated callers, not the helper still needed
   by deferred callers. Keep real tokens available to authorized daemon-side service
   code. Any migrated cleartext managed instance needs HTTPS.
3. **In-environment scoped skill/source operations:** preserve the authorization windows
   in [Source Cache §8](source-cache.md#8-skill-flow), including enabled
   source checks, exact repository set, read/write authority, subject binding,
   closure in `finally` and expiry. An ordinary workspace placeholder must not gain
   permanent access to a private skill repository. Reuse the window lifecycle for
   proxy authorization, carried by a purpose-bound placeholder rather than a helper
   credential that returns a token. This needs a scoped proxy authorization extension;
   a plain environment rewrite is insufficient. Bundle storage authorization and
   non-Git ref-resolution APIs keep their separate contracts. Host-side acquisition
   stays on its current path. Unsupported migrated Git fails without a token fallback.
4. **Owning-daemon host-side Git, last:** after deliveries 1–3, decide whether to
   migrate canonical clones, other host-side preparation and local host-strategy
   daemon Git at all. Extend the capacity measurement to full canonical clones
   through the loopback proxy. These bytes all cross the in-process proxy, while
   this location has no same-user isolation gain; the benefits are consistency and
   eventual helper removal. Retaining the existing trusted-host path is a valid
   measured outcome. Removing the token-returning Git helper waits for this decision
   and migration of every remaining caller that needs it.

**Separate open item: in-pod auto-merge watcher.**
`github/auto-merge/watcher.ts` arms one watcher process per pull request in the runtime
container; `shim/auto-merge-handler.ts` puts the daemon-holder capability in its
environment, and each tick obtains a token through the `agent` tunnel. It can be
long-lived and shares the runtime's OS user. Deliveries 1–3 do not remove this
minting capability. A dedicated follow-up must decide how to broker the watcher
without that capability, preserve its merge authorization and lifecycle, and fix
the stale `AutoMergePayloadSchema.capability` comment that calls it runtime-only.
Do not claim the environment contains no minting capability until this follow-up
and any other credential-bearing callers have been addressed.

The first delivery primarily touches `workspace/git-injection.ts`, common Git runner
preparation, the execution planes' route accessors, and daemon readiness/advertisement.
It should reuse `credential-proxy/`, `remote/codehost-spawn.ts`, `remote/tunnel-binder.ts`
and the existing provider registry. No database migration is expected. Later scoped
source authorization work is explicitly outside the Azure-first acceptance claim.

#### Acceptance and evidence

Use real Git against controlled HTTPS remotes with fake upstream credentials for
repeatable transport tests, then verify each newly enabled environment against an
Azure test connection. Never place live identifiers or credentials in fixtures.
Extend existing end-to-end transport tests rather than duplicating the implementation
with a large matrix of mocked predicates. Each implementation PR records which rows
it actually exercised; source inspection alone is not a successful environment test.

**Capacity gate, required before delivery 2 (or any earlier expansion to all
providers).** The `codehost` tunnel uses 32 KiB chunks encoded as base64 in JSON,
eight unacknowledged frames per stream, and sixteen simultaneous code-host streams
per shim (`shim/tunnel.ts`). Additional-repository and submodule fetches share that
per-shim ceiling; it is not a pool-member-wide load limit. A CONNECT past the ceiling
waits for a stream to end rather than being refused, since Git does not retry a
refused CONNECT. At the ceiling it is refused with 503 only when four times the ceiling are already
waiting, or after 120 seconds without a free stream. An opened CONNECT the daemon has not
answered within 30 seconds is refused with 503 too: after a member takes a sandbox over,
its shim has no bound channel until the next session binds one, and Git would otherwise
wait out its own timeout. TLS termination and tunnel
processing share the member's event loop with ACP delivery and duty renewal. Load
that delays renewal can self-fence all its duties at `T_fence` under D7 in
[the pool design](k8s-daemon-pool.md#5-the-duty-ledger-and-lease-service-d6-d7).

Measure concurrent cold session clones of a representative large repository on one
member while existing sessions stream ACP updates and duty renewals continue. Before
the run, record the member's CPU/memory limits, repository pack bytes/object count,
clone filters, intended maximum concurrent clones and active sessions, renewal cadence
`R`, and configured `T_fence`. Compare the current direct route with the proposed
route under the same load, including increasing concurrency up to that intended
maximum and parallel fetches within a shim. State numeric limits for every run;
do not treat sixteen streams per pod as proof that the whole member is bounded.

The proposed acceptance budgets are: added p99 ACP forwarding latency no more than
100 ms against the same-load direct-route baseline; maximum renewal scheduling delay
less than `R`; maximum age of the last CP-confirmed renewal less than `T_fence / 2`;
and zero load-induced self-fences, dropped ACP updates or out-of-memory failures.
Record p50/p95/p99/max latency, renewal send/ack delays, event-loop delay, CPU, peak
memory, tunnel bytes and clone throughput. These are requirements to measure, not
results claimed by this document. A failing budget blocks delivery 2; reduce and
enforce the admitted concurrency or improve the shared transport and remeasure,
rather than increasing the lease deadline to hide contention.

**Single-pod result.** Concurrent full clones of a large repository through one
pod's shim on one pool member, from 1 to 16 at once, with that member's other
sessions live: its health endpoint's p99 rose by at most about 24 ms, the last
confirmed renewal was never older than one 5-second heartbeat (the sampling
resolution), no duty self-fenced, peak memory rose from 256 MiB to 549 MiB under a
2 GiB limit, and CPU peaked near 1.7 cores. Sixteen concurrent clones took 25.1 s
through the proxy against 22.2 s direct. At 32, half were refused at the stream
ceiling, which the queue above now holds instead. Not yet measured: several pods
cloning on one member, ACP forwarding latency itself, a Source Cache hit, and a full
clone through the loopback proxy.

Measure Source Cache hit and miss separately. On a hit, verify bundle bytes travel
from the bundle URI directly to the execution environment and that tunnel bytes
contain only managed-remote negotiation and top-up fetches. On a miss, measure the
full session fetch that actually crosses the tunnel. For the final host-side decision,
repeat with a full canonical clone through the loopback proxy as well as concurrent
session traffic. Run capacity experiments in a controlled environment with explicit
resource/concurrency bounds; this documentation change launches no load test.

- Azure primary plus GitHub additional, GitHub primary plus Azure additional, and
  scratch plus both: clone, fetch and authorized push on local SRT, local VM, Cloud,
  and remote executor host/SRT/VM. Include concurrent operations, two Azure
  organizations on the same authority, and different tiers on different repositories.
  Verify owning-daemon host-side preparation remains unchanged through deliveries
  1–3, including Azure canonical clones and host-strategy Git.
- Azure read grants reject receive-pack discovery and push; an unauthorized repository,
  alternate supported hostname, crafted path or redirect cannot escape the grant.
  Gitea and GitLab read grants are refused the same way. In the first delivery,
  GitHub daemon Git retains its existing authorization.
- Captured migrated Git argv/env/config and helper output contain no upstream token
  or token-minting capability. The fake remote receives the token only after proxy
  authorization. A concurrent same-user probe sees at most the scoped placeholder
  for that migrated Git process. This is not an assertion about the entire host.
- Cold preparation works before runtime spawn. Missing listener/proxy, stale binding,
  revoked access, token expiry and reconnect fail or recover through existing bounded
  semantics without direct-token fallback or mutation replay. Local Git stays usable.
  Cancel preparation before runtime launch, then move or retire the agent: the old
  binding must reject requests and release its resources, while unrelated live
  operations retain their listeners. Also verify idle cleanup of an unused prepared
  environment and successful preparation on a newly acquired binding.
- Source-cache hit/miss and fallback behavior, exact review refs, approved submodules
  and lazy fetches preserve their own authorization. During later source migration,
  a closed/expired/wrong-subject skill window must deny even with a previously issued
  placeholder, and an ordinary runtime placeholder must not acquire source-only access.

Completion of the first delivery means Azure works in the newly enabled environments;
completion of deliveries 1–3 means managed Git inside execution environments uses
the proxy. It does not cover owning-daemon host-side Git or eliminate the auto-merge
watcher's minting capability. The final host-side decision determines whether all
managed Git operations can share the rule and the old Git helper can be removed.
Update Azure's §6.1 and this document's helper/trust sections with the implementation that changes
them, and keep the distinction explicit in PRs and release notes.

## Protocol Contract (`packages/protocol`)

`src/frames/gitcred.ts` is registered in both `FRAME_SCHEMAS` and the `AnyFrame`
union and re-exported from `index.ts`. Codec tests cover the request and grant.

```ts
/** D->C REQ: the daemon requests credentials before a Git or GitHub operation.
 *  The CP resolves agentId -> authorized repository -> installation. A named
 *  repository is admitted only when it is the workspace or an explicit grant. */
export const GitCredRequest = z.object({
  agentId: z.string().uuid(),
  reason: z.enum(['clone', 'fetch', 'pull', 'push', 'helper']).optional(),
  capabilities: z
    .array(z.enum(['contents', 'issues', 'pull_requests', 'actions']))
    .nonempty()
    .optional(),
  purpose: z.literal('github_hook_reply').optional(),
  hookId: z.string().uuid().optional(),
  forceRefresh: z.boolean().optional(),
  repoFullName: z.string().optional()
})

/** C->D REP: the token itself. Plaintext; never log it. */
export const GitCredGrant = z.object({
  username: z.literal('x-access-token'),
  token: z.string(), // ghs_…; single-repository scope
  ttlSec: z.number().int(), // Remaining seconds calculated by the CP after a 60-second clock-skew allowance
  // The daemon records expiry using the monotonic clock: receivedAt + ttlSec
  expiresAt: z.string().datetime(), // Absolute time is for observation only, never comparison, to tolerate daemon clock skew
  repoFullName: z.string(), // owner/repo, used by the helper to validate path matching
  access: z.enum(['read', 'write'])
})
```

Failures use the existing `error` REP and `ErrorCode`, with explicit semantics
and retry behavior:

- `SCOPE_DENIED` (nonretryable): the workspace is not in GitHub-App mode, **or
  the agent is no longer placed on this daemon**. On receipt, the daemon
  immediately clears the agent's cache and stops requesting again.
- `LEASE_DENIED` (nonretryable, but recoverable through an operational action):
  the installation was uninstalled/suspended or the repository is no longer
  authorized.
- `RATE_LIMITED` / `INTERNAL`: GitHub API rate limiting / other failure, with
  retryability marked in the frame.

The GitHub variant of `AgentWorkspace` (`frames/agent.ts`) includes:

```ts
gitCredential: z.enum(['github-app']).optional(), // Absent means anonymous, preserving the current public-repository path
```

## CP Side

### GitHub Module: `src/github/`

- `api.ts`: use `@octokit/auth-app` to sign an App JWT from the configured PEM
  (`iss` is the client ID when configured, otherwise the App ID; RS256,
  lifetime no longer than 10 minutes), with a very thin fetch wrapper for
  `Accept: application/vnd.github+json`, timeouts, and rate-limit response
  parsing. Inject `fetch` so integration tests can stub it.
- `installation-token.service.ts`: minting + cache + **single-flight**:
  - `mint(installationId, repoFullName, access)` calls
    `POST /app/installations/{iid}/access_tokens` with body
    `{ repositories: [repo], permissions: { contents: access==='write'?'write':'read', ...(access==='write' ? {workflows:'write'} : {}), metadata: 'read' } }`.
    The REST limit for installation tokens is at least 5,000/hour and increases
    with repository/member count, leaving ample headroom after caching. The
    service derives the concrete permission matrix from the requested
    capabilities and authorization tier.
  - In-memory cache key = `(installationId, repoFullName, access)`. Treat
    **less than 15 minutes remaining as a miss**. This nests with the daemon's
    10-minute handoff threshold, ensuring a grant sent to the daemon has at
    least 15 minutes remaining. Cache-expiry comparison uses GitHub's
    `expires_at` **minus a further 60-second clock-skew allowance**.
  - **Cache the in-flight minting promise as well.** Concurrent requests for the
    same key collapse into one GitHub call. This also solves idempotency for WS
    retransmission (see below) and cold-start thundering herds.
  - **Rate-limit per daemon + organization.** Because a
    **single App is shared by the entire instance**, GitHub's minting quota is
    a **cross-tenant shared resource**. A daemon caught in a crash/restart loop,
    or a compromised agent flooding `gitcred/request`—which ReqRep also
    retransmits every 5 seconds—could push every other organization into
    `RATE_LIMITED`. Single-flight blocks only concurrent calls for the same
    key, not distinct keys or serial retries. The mint path in
    `ws/handlers/gitcred.ts` therefore needs a **cache-independent token
    bucket**, keyed by `conn.daemonId` + `orgId`, returning `RATE_LIMITED` when
    exceeded. The daemon's 5-second retransmission must honor that backoff and
    cannot bypass it. `src/github/rate-limit.ts` owns this limit and is wired
    into the mint path.
- When the persisted GitHub provider configuration is absent, do not assemble
  the module at all. Treat it as an optional dependency in `buildContainer`;
  related routes return 404 and the picker is hidden.

### Persistence Layer

- `GithubInstallationRepo` in `persistence/ports.ts` includes
  `liveByOrgAndAccount(orgId, accountLogin)` for mint-time resolution. Its PG
  implementation lives in `persistence/repositories/github.repo.ts` and is
  registered in `container.ts`.

### HTTP Routes: `http/routes/github.ts`

The REST surface uses `/api/v1` versioning (`http/version.ts`; only
`GET /health` and `/daemon/ws` are unversioned), organization scoping through the
`/orgs/:orgId` path (`server.ts:123-152`, organization subtree `:129-149`),
and RBAC. The organization subtree uniformly applies `humanAuth` +
`makeOrgScope` preValidation hooks; routes read the organization from
`req.orgCtx.orgId`, and nonmembers receive 404. RBAC is
`owner|collaborator|viewer` in `rbac.ts`, with `denyViewerWrite` on write
operations. The GitHub routes are therefore registered as two plugins:

| Route                                                                  | Authentication/RBAC                                                                                       | Behavior                                                                                                                                                                                                                                                                                                |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/orgs/:orgId/github/app`                                   | Organization-subtree hooks + `denyViewerWrite` (issuing installation state initiates a connection change) | App metadata (slug and enabled status) + installation deep link `…/installations/new?state=…`; state is a domain-separated HMAC signature over **orgId = path organization** + exp + one-time nonce                                                                                                     |
| `POST /api/v1/orgs/:orgId/github/installations/sync`                   | Organization-subtree hooks + `denyViewerWrite`                                                            | Use an App JWT to refresh every durable claim already belonging to the **path organization**; mark missing installations with `revokedAt`, **never delete their rows**, and never discover or claim from the deployment-global App roster                                                               |
| `GET /api/v1/orgs/:orgId/github/installations`                         | Organization-subtree hooks (viewers can read; organization-level resource, **not visibility-filtered**)   | List live installations for this organization, providing the picker's first level                                                                                                                                                                                                                       |
| `GET …/github/installations/:id/repositories?page`                     | Same                                                                                                      | Mint a token -> `GET /installation/repositories`; paginated with `per_page <= 100`. **This endpoint has no server-side search**; filter in the CP/frontend                                                                                                                                              |
| `GET …/installations/:id/repositories/:owner/:repo`                    | Same                                                                                                      | Resolve one exact name, covering private repositories and ones past the listing's first page. **The owner must be the installation account:** an installation token reads any public repository, so resolving blind reports a repository on an unrelated account as App-backed — it answers 404 instead |
| `GET …/repositories/:owner/:repo/branches`                             | Same                                                                                                      | Branch picker. **Requires a `contents:read` token** because metadata-only returns 403, exactly reusing the token-cache key `(iid, repo, 'read')`                                                                                                                                                        |
| `GET /api/v1/github/setup/callback?installation_id&setup_action&state` | **Unauthenticated** because GitHub redirects the browser                                                  | See "Setup Callback Semantics" below                                                                                                                                                                                                                                                                    |

- **Callback mount point:** it cannot enter the organization subtree because
  it has neither a bearer token nor `:orgId`. Export it as the **second plugin**
  from `http/routes/github.ts`, for example `githubCallbackRoutes`, and
  register it in the `API_V1_PREFIX` block of `server.ts` alongside
  `orgRoutes`/`meRoutes`. A route at the version root is unauthenticated when
  it does not install `preHandler: app.humanAuth`: auth is an opt-in decorator,
  registered but not enabled globally at `server.ts:70-74`. The organization
  to claim comes from signed state, not the path.
- **Authentication surface:** the organization subtree accepts both OIDC JWTs
  and **personal API keys** (a dot-free Bearer handled
  by `withApiKeyAuth` in `plugins/auth.ts`). A key is hard-bound to its
  organization (`org-scope.ts:39-41`), while the role still comes from
  membership. GitHub routes require no special handling. A headless key can
  initiate state minting and Sync without changing security: state is still
  bound to orgId and a one-time nonce.
- **OpenAPI:** every organization-scoped route
  must have a zod schema; `tags:[Tag.GitHub]`, with an entry added to both the
  `Tag` map and `TAG_DESCRIPTIONS` in `openapi.ts`;
  `summary`/`description`/`operationId`; and a response DTO in
  `http/dto/index.ts` that never contains a token. The `:orgId` prefix
  parameter is added automatically by `backfillPrefixPathParams` and need not
  be declared. **Set `schema: { hide: true }` on the setup callback.** It is a
  browser redirect endpoint and must not appear in the public API
  documentation.

**Setup callback semantics:**

- Forwarding `state` from `installations/new?state=…` to the Setup URL is
  undocumented GitHub behavior. When state is present and verifies successfully,
  verify App ownership, upsert the installation, and claim it into the
  organization in state. When state is missing, redirect with 302 to the console
  and ask the user to restart the org-bound install. The App installation roster
  is deployment-global, so an authenticated organization path alone is not proof
  that an unclaimed installation belongs to that organization; Sync must never
  guess or create the claim.
- `setup_action === 'request'` means a nonadministrator initiated the request
  and an organization administrator must approve it. There is **no usable
  `installation_id`** at this point. Redirect with 302 directly to the console
  and display "Pending administrator approval"; after approval, restart the
  org-bound install so a signed callback can create the claim.
- No branch trusts callback parameters themselves. The only path into the
  database is an App-JWT lookup that confirms ownership.

Strengthen `POST /agents` validation. In GitHub-App mode, identified by
`installationId`, derive `owner/repo` with `gitRepoLabel(gitRepo)` and verify
that the installation belongs to this organization and, in `selected` mode,
that the repository is authorized. Otherwise, return 409. **Ordering relative
to the visibility gate:** run this validation after the organization +
`canView` gate on `daemonId`, following reference-write semantics in visibility
section 5.1, where invisible and nonexistent both return 404. The create path
returns 404 based on organization + `canView`, matching the analogous
cron-to-agent and integration-to-agent gates. A 409 from
installation/repository validation is not a visibility oracle because the
installation and authorization set are already visible at organization scope;
see Resource Classification.

### Minting Path (WS Handler)

- In `ws/handlers/gitcred.ts`, handle `isFrame('gitcred/request')` -> verify
  against `conn.daemonId` that **the agent is currently placed on this daemon**
  (otherwise `SCOPE_DENIED`) -> read the agent's workspace configuration ->
  return `SCOPE_DENIED` unless it is in GitHub-App mode -> resolve a live
  installation for the `repoFullName` owner in this organization (missing or
  suspended means `LEASE_DENIED`) -> call
  `installationTokenService.mint(...)` ->
  `conn.replyTo(frame, 'gitcred/grant', …)`.
- **This handler is a data-plane path and is exempt from resource visibility
  (load-bearing).** Read the agent through viewer-free
  `AgentRepo.get(agentId)`, which already has no viewer parameter, and compare
  placement. **Never apply `canView`/`visibilityWhere`.** This is the same class
  as placement reads such as `listForDaemon` (visibility design section 9; see
  guardrail comments at `ports.ts:69-72` and `schema.prisma:83-86`: "enforced
  only on console read/write surfaces, never on the daemon<->CP wire").
  Restricted agents remain placed, receive messages, and need to push. **Their
  credential minting must continue normally;** filtering would be a
  graceful-degradation correctness bug. A WS handler has no `req.orgCtx` and
  structurally cannot accept a viewer. Preserve that property. Add an
  integration test proving that a restricted agent's `gitcred/request`
  receives a grant normally.
- **Idempotency:** the daemon's ReqRep retransmits the same ID every 5 seconds.
  CP ingress **does not deduplicate** REQs initiated by the daemon:
  `connection.ts:54-92` only settles REPs to the CP's own REQs. A
  retransmission invokes the handler again. The token service's in-flight
  single-flight collapses those invocations into the same GitHub call and
  returns the same grant. The daemon correlator settles the first REP; later
  REPs fall through to the default no-op in `dispatchControl`. **Do not add
  protocol-level deduplication;** accept duplicate REPs at minimal cost.
- The handler is registered through `ws/handlers/index.ts` and receives its
  dependency through `ws/deps.ts`. `agentRecordToSpec` derives
  `gitCredential:'github-app'` for the `agent/upsert` and `register/ok`
  delivery paths.

The GitHub App requires the permissions represented by the token matrix and a
Setup URL matching the public callback contract.

**Tradeoffs of reusing the sign-in App:**

- **The sign-in track is unaffected.** A GitHub App's **user access
  token does not use scopes; it uses fine-grained permissions and represents
  the intersection of App permissions and user authorization**. Sign-in is
  user-to-server, while git uses installation tokens. They are independent
  tracks. Adding `Contents:write` / `Workflows:write` to the App **does not
  magically give the sign-in token write access to repositories**. The claim
  that the two tracks do not interfere is mechanically correct.
- **There is, however, a hard gate: after permissions are added, an
  organization administrator must approve the new permissions on GitHub for
  every existing installation before the App can mint a
  `contents:write + workflows:write` token.** Until the administrator approves,
  the organization's daemon Git path receives a **silent 401**, mapped to
  `LEASE_DENIED`. Write credentials must remain disabled until the approval is
  complete.
- **Should git use a dedicated App?** Sharing means sign-in and repository
  writes use **one trust principal, one private key, and one audit identity**.
  Leaking the git private key also leaks the sign-in App's private key. Because
  the sign-in token cannot obtain write permissions, as described above, the
  incremental **security** risk is limited. The main costs are that a
  permission increase triggers an administrator-approval gate for every
  organization and that the identities are coupled. Reuse is the default;
  instances that need separate trust principals can configure a dedicated
  instance-level Git App.

## Observability

> Credential-specific `heartbeat.degradedScopes` reporting and its web
> presentation are not implemented. The logging, `CP_UNREACHABLE`, and token
> handling rules below apply to the implemented credential path.

The never-log rule protects the token itself, but the minting/WS/git chain will
inevitably fail in production and must be diagnosable. The following fields are
**safe to log:** `installationId`, `repoFullName`, `access`, mint latency in
milliseconds, GitHub HTTP status/error code, **only the token's `ghs_` prefix
and length** (never the token itself), the `reason` enum, and
`SCOPE_DENIED`/`LEASE_DENIED`/`RATE_LIMITED` codes. In addition:

- **Feed credential health into the existing `heartbeat.degradedScopes`**
  only after adding a visibility-safe DTO. Entries contain bare agent IDs, so
  the CP must filter each one through `canView(agent, viewer)` before returning
  it. Show a per-agent degradation badge on the visibility-gated agent detail
  page; a daemon page may show only an aggregate. This preserves the
  creator-forever rule and avoids leaking a restricted agent's existence to a
  member who can see the daemon but not the agent.
- **`CP_UNREACHABLE` is not a protocol `ErrorCode`.** It appears only as a
  daemon-local degradation semantic in this design: WS is not READY, or the
  cache expired and cannot be refreshed. It does not travel on the wire. Do
  not treat it as a wire error code. The wire `ErrorCode` values
  are `SCOPE_DENIED`/`LEASE_DENIED`/`RATE_LIMITED`/`INTERNAL`.
- **Token format:** current installation tokens use a stateless format with
  the `ghs_` prefix, two dots, and approximately 520
  characters. Every buffer, regex, and length assumption must be
  length-independent. `token: z.string()` in the WS frame and line buffering
  in `agent.sock` are both acceptable; do not introduce fixed-length limits.
  Redactors must not use a fixed short-token prefix rule.

## Daemon Side

### Credential Cache and WS Pull: `cp/git-credential.ts`

- `GitCredentialCache`:
  `agentId -> { token, receivedAtMono, ttlSec, repoFullName, access }`, held in
  memory and never persisted. **Determine expiry using the monotonic-clock
  expression `receivedAt + ttlSec`**. Do not compare the absolute `expiresAt`,
  because host clock skew could make a dead token appear live.
- `get(agentId)`:
  - **Handoff threshold: a hit requires more than 10 minutes remaining.** This
    nests with the CP's 15-minute refresh threshold and guarantees that a token
    handed to git has approximately 10 minutes of life remaining.
  - On a miss, pull a token through the **public, state-gated**
    `requestGitCred()` method on CpClient; see below. Use **per-agentId in-flight
    coalescing**, following the `cloneInFlight` pattern, so concurrent
    helper/pull/prefetch calls send only one WS REQ.
  - If the CP is unreachable but the cached token **has not expired**, use the
    old token for graceful degradation. If it has expired and cannot be
    refreshed, throw an error with `CP_UNREACHABLE` semantics.
  - `invalidate(agentId, presentedPassword?)` supports helper `erase` and
    forced refresh.
- **Invalidation hooks:** GitHub **immediately**
  revokes existing tokens when an App is uninstalled/suspended, so it must be
  possible to break through the daemon cache.
  - When git rejects credentials, it invokes the helper's **`erase`** action.
    The helper forwards that action to the daemon. If the presented password
    matches, the daemon clears the agent's cache so the next `get` mints again.
  - If a daemon-initiated clone/pull/fetch encounters an authentication failure,
    **force one refresh** by invalidating and calling get again, then retry
    once. Report the failure only if that retry also fails.
  - On `SCOPE_DENIED`, clear the cache and **stop requesting** for that agent
    because it has moved.
  - **`agent/remove` must also call `invalidate(agentId)`.** When an agent is
    deleted from the **online, current
    daemon**, the remove path in `cp-agent-registry.ts` calls
    `write-agent.ts:176 rmSync`, clearing the clone directory and the
    repository-local helper line. The **token in memory does not disappear on
    its own**. It is a bearer credential valid worldwide for up to 1 hour,
    pointing to the private repository of an agent that no longer exists. The
    deletion path must call the existing, low-cost `invalidate` method while
    cleaning the directory. Add a test that "`agent/remove` clears the cache."

### `CpClient.requestGitCred()`: Post-Handshake D->C Business REQ

`requestGitCred()` sends only in `READY | DRAINING`. Every other connection
state fails immediately so the cache can degrade or fail fast instead of
queuing behind reconnection. The helper path uses one send with a 10-second
timeout, keeping the request inside the outer Git operation budget. Closing the
transport rejects pending requests, clears the transport reference, and keeps
retry sends from escaping as uncaught exceptions.

The connection contract guarantees that a correlated REP settles **before**
the daemon's valid-state gate
(`client.ts:352`). Inbound C->D dispatch is a nonblocking promise chain
(`:417-424`, workspace paths `:494-524`), so emitting `gitcred/request` while
handling `workspace/gitpull` cannot deadlock. Closing the socket rejects every
pending REQ (`:379`). On the CP side, a daemon-initiated REQ without corr
passes the valid-state gate normally, enters FrameRouter, and can receive a REP
through `conn.replyTo` (`connection.ts:157-160`).

### Local Helper Channel: Credential-Free Agent-Initiated Git

1. **Unix socket:** `~/.agentconnect/run/agent.sock`, mode 0600, in a 0700
   directory. Use line-delimited JSON:
   `{ op:'get'|'erase', agentId, capability, password? } ->
{ username, password } | { ok } | { error }`. The daemon generates a capability
   per agent in memory and validates it in constant time. Reject a missing
   capability, a capability for another agent, or an old capability after
   agent detach.
2. **Hidden CLI subcommand**
   `agentconnect git-credential <agentId> <action>`: use **positional arguments,
   not a `--agent` flag**. In development, the shim invokes a `.ts` entrypoint
   through the tsx CLI, and tsx consumes flags it does not recognize.
   Positional arguments are reliable in both development and production. The
   command does not appear in normal
   `--help`. It reads the local capability from `AC_AGENT_CHANNEL_CAPABILITY` and
   implements the git credential-helper protocol: `get` reads
   `protocol/host/path` from stdin and verifies `host==github.com`.
   **Agent identity resolution:** the agentId positional argument is a value
   baked into the config file. It can become a dead ID when an agent is deleted
   and recreated under the same name while the checkout survives; the daemon
   then rejects it because its capability does not match. Prefer the
   `AC_AGENT_CHANNEL_AGENT` environment variable from `gitCredentialEnv`, injected as
   a **co-minted pair** with the capability, and use argv only as a fallback
   when no environment value exists. The presented identity therefore always
   matches the accompanying capability. When multiple agents share a checkout,
   each still obtains a token as its actual caller identity.
   **Path-matching prerequisite:** git defaults to
   `credential.useHttpPath=false`, which **strips the path from the credential
   description** for HTTPS. The helper otherwise never receives a path.
   Therefore:
   - Inject
     **`credential.https://github.com.useHttpPath=true` together with the
     helper in all three channels** so git includes the path.
   - Only then can the helper compare path == `repoFullName`,
     **case-insensitively and tolerating a `.git` suffix**. On mismatch, report
     both paths and say "the repository may have been renamed; recreate the
     agent."
   - **Security still holds if the setting is absent or no path is received:**
     the helper answers for github.com, but it hands over a token with
     **single-repository scope**. GitHub returns 403 when it is used against
     another repository, and no personal credential leaks. Path matching
     therefore provides a clean error; token scope is the security foundation.
     After obtaining a token, write
     `username=x-access-token\npassword=<token>\n` to stdout. **Forward `erase`
     to the daemon to invalidate the cache**, as described above. `store` is a
     no-op.
3. **CLI cold-start budget:** keep `git-credential` on a lightweight path by
   lazy-loading heavyweight commands inside their `.action()` handlers. If
   helper startup no longer fits the Git operation budget, split it into a
   dedicated lightweight binary.
4. **Shim script** `~/.agentconnect/run/git-credential-helper.sh`: the daemon
   rewrites it on every startup. Its only content is
   `exec '<node>' ['<tsx/cli>'] '<entrypoint>' git-credential "$@"`; it
   **contains no secret**. **Single-quote every path.** A `.ts` entrypoint in
   development is routed through the tsx CLI automatically; a built `.js`
   entrypoint runs directly under node. This avoids drift when the CLI install
   path changes during an upgrade. The helper config value itself is
   `!'<absolute shim path>' <agentId>`. Git gives the `!`-prefixed value to
   `sh -c`, so the shim path **must be single-quoted**. Otherwise, a home
   directory or username containing spaces, such as macOS
   `/Users/example user/…`, is word-split and authentication breaks.

### Git Operation Injection: `workspace/workspace-manager.ts`

- **Source of the decision:** `workspace.gitCredential` in `agent.json`.
  `placement.ts agentRecordToSpec`, `agents/write-agent.ts applySpecFields`,
  and `agents/agent-schema.ts AgentSchema.workspace` must all carry the field.
- **Clone, before repository config exists:** first **pre-warm** credentials
  with `await cache.get(agentId)` outside the git timer, then run with
  injection through simple-git `.env()`. Two simple-git >=3.36 behaviors are
  load-bearing:
  1. `.env()` replaces the entire subprocess environment rather than merging
     it. Spread a base environment, or PATH/HOME are removed.
  2. `blockUnsafeOperationsPlugin` performs vulnerability checks on both argv
     **and the subprocess environment**. Configuring `credential.helper`,
     including its URL-scoped variant, requires the explicit
     `unsafe: { allowUnsafeCredentialHelper: true }` opt-in, which is
     appropriate because helper injection is the feature itself. Meanwhile,
     host-shell variables for `GIT_EDITOR`, pagers, and SSH commands are
     rejected directly.

  Therefore, build the base environment from a **sanitized** `process.env`,
  removing editor/pager/SSH variables, stray `GIT_DIR`/`GIT_WORK_TREE`, and
  host `GIT_CONFIG_*`, rather than spreading it raw. Add
  `GIT_TERMINAL_PROMPT=0` so git never hangs waiting for input; clear
  `GIT_ASKPASS`/`SSH_ASKPASS` to prevent bypass; and use
  `GIT_CONFIG_COUNT/KEY_n/VALUE_n`—configuration injection through environment
  variables, available in git >= 2.31 and never placed in argv—to set:
  `credential.helper=` first, clearing global/system helpers so osxkeychain or
  cached credentials cannot intervene;
  `credential.helper=!'<shim>' <agentId>`; and
  `credential.https://github.com.useHttpPath=true`. The remote URL remains the
  clean `https://github.com/owner/repo.git`. **If clone fails, remove the
  partial directory before throwing** so the next clone cannot collide with a
  leftover `.git`.

  For the initial clone of a very large repository, recommend
  `--filter=blob:none`. **A single git operation must complete within the
  token's remaining lifetime.** With a fixed 1-hour maximum, git that reaches
  expiry halfway through does not ask the helper again. This inherent
  constraint also applies to agent-initiated `fetch --unshallow` and deep
  history backfills and must be documented.

  **Prefetch must receive the same injection.** During reconciliation,
  `prefetchWorkspace` (`workspace-manager.ts:57-63`) starts a fire-and-forget
  pre-clone as soon as agent/upsert arrives, using the same `cloneRepo`.
  Injection and pre-warming must apply there too. WS is necessarily READY for
  **prefetch triggered by
  upsert**, because the spec just arrived over WS. **Prefetch triggered by
  loading disk state at boot** occurs before the CP connection; pre-warming
  fails fast and prefetch fails, preserving the existing nonfatal behavior and
  allowing the first session to recover. Gitcred initialization must precede
  agent loading and therefore runs at the beginning of daemon `start()`.

  **The first clone of a private repository usually happens in prefetch, not on
  the first message.** Changing only prepareWorkspace and not prefetch would
  make every reconciliation attempt a guaranteed-failing anonymous clone of
  the private repository.

- **After clone succeeds, write repository-local config containing no secret:**
  `credential.helper=` to reset the list,
  `credential.helper=!'<shim>' <agentId>`, and
  `credential.https://github.com.useHttpPath=true`. From then on, **every
  `git push/pull/fetch` the agent runs in the workspace automatically invokes
  the helper.** This is the mechanism that lets an agent push while the machine
  has no credentials. When multiple agents share one checkout, the agentId in
  this file is the last writer. Identity follows the helper's environment
  resolution rule: `AC_AGENT_CHANNEL_AGENT` takes precedence over this baked-in ID;
  see "Local Helper Channel." **prepareWorkspace idempotently rewrites this
  config for an existing checkout**, best-effort. If an agent is deleted and
  recreated under the same name, it takes over the surviving checkout by agent
  name. Without repinning the baked-in old agentId, calls not covered by the
  environment channel would be rejected forever as a dead identity.
- **Clone must use the repository's actual default branch.** `cloneRepo` runs
  `clone --branch <branch> --single-branch`, while `gitBranch` defaults to
  `'main'` in both the protocol frame and daemon schema
  (`agent.ts:28` / `agent-schema.ts:78`). For a repository whose default is
  `master`, `trunk`, or `develop`, `--branch main` **fails fatally** with
  "Remote branch main not found" and directly fails session creation. The
  repository picker must prefill `gitBranch` with the repository object's
  `default_branch`, returned at no extra cost for every repository by
  `GET /installation/repositories`, rather than hard-coding `main`.
- **Pull, initiated by the daemon through `workspace/gitpull` or
  `pullOnNewSession`:** repository config already contains the helper. Always
  add `GIT_TERMINAL_PROMPT=0`. **Pre-warm credentials before starting the
  timer.** The current 4.5-second budget for `pullOnNewSession` and 20-second
  budget for console gitpull cannot cover a cold-cache WS round trip; without
  pre-warming, timeouts become routine. A `Promise.race` timeout also **does not
  kill the git subprocess**. An orphaned pull can rewrite the worktree and hold
  `index.lock` after the agent has begun editing. In GitHub-App mode, **a
  timeout must kill the subprocess**. Preserve existing behavior in anonymous
  mode.
- At daemon startup, probe `git --version`. The minimum is 2.32 because the
  session channel uses `GIT_CONFIG_GLOBAL`; daemon-controlled clone injection
  also uses the `GIT_CONFIG_COUNT` family. Below 2.32, log a warning and fail
  GitHub-App mode with a clear error while leaving anonymous mode unaffected.
  The URL-scoped empty-helper reset is implementation behavior rather than an
  explicit gitcredentials contract, so keep a compatibility test at the
  minimum supported version.

### Subrepositories and Nested Repositories (Submodules / Agent-Initiated Clones)

Repository-local helper config covers only the primary workspace repository.
Git runs submodule network operations in the subrepository's own context, and
a nested repository created by an agent starts without local helper config.
The session-level helper therefore applies a host-wide reset so a machine
credential manager cannot silently take over. Helper path matching routes each
repository independently: the primary workspace is admitted automatically,
and a private subrepository requires an explicit `AgentRepoAuthorization`.
Ungranted repositories fail cleanly without falling back to a personal
credential; anonymous access to a public submodule remains possible.

Injection uses **two channels**:

1. Repository config, described above, is the normal path for the primary
   repository. **Note:** multiple agents can share a checkout; the clone lock
   in `workspace-manager.ts:9-12` is keyed by cwd. The agentId in shared
   `.git/config` is therefore only the **last writer**. In a shared checkout,
   **channel 2 is authoritative**, because each process carries its own
   `--agent`.
2. **Agent session-environment injection:** when the daemon starts the agent's
   ACP runtime process, inject the host-scoped helper for every managed runtime.
   **ACP hosts are cached by agentId**
   (`daemon.ts`, `hosts: Map<string, AcpHost>`). `startHostWithRetry` recreates
   the host on every retry and recomputes
   the environment, so injection remains effective across retries. Each host
   subprocess serves only one agent. On spawn, `env` is merged directly into
   the subprocess (`acp-host.ts:225-255`; opts.env is the outermost layer at
   `:239`; `CLAUDE_CODE_EXECUTABLE` at `:243-249` is set only if absent, so it
   does not overwrite injection). The entire process tree inherits it. When a
   runtime adds its own nested tool sandbox, the daemon must deliberately keep
   the credential socket reachable without exposing credential files. On Linux,
   Codex couples Unix `connect()` to its network permission, so AgentConnect
   enables that inner layer only for a configured GitHub credential channel;
   when enabled, the outer SRT sandbox remains authoritative for egress and
   host-socket visibility. If the operator disables the outer sandbox, the
   runtime-native profile still receives the same channel permission within
   that explicitly unconfined launch.
   - **Do not carry the session-level credential-helper injection through
     `GIT_CONFIG_COUNT`.**
     `GIT_CONFIG_COUNT` does **not compose across
     processes**. If the agent's own toolchain sets `GIT_CONFIG_COUNT`, it
     replaces the pairs we injected, removing the helper reset and reopening
     the leakage edge case. Instead, **generate a configuration file** and
     point `GIT_CONFIG_GLOBAL` to it. Its contents first use
     `[include] path=<original ~/.gitconfig>` to preserve other host settings,
     then reset `credential.https://github.com.helper=`, point it at the shim,
     and set `useHttpPath=true`. The CP queries the numeric user ID of the
     `<slug>[bot]` corresponding to the deployment-configured App slug and
     caches it in-process; if the query fails, do not deliver an identity. It
     then delivers the public bot identity in
     `ID+<slug>[bot]@users.noreply.github.com` form through
     `register/ok.gitCommitIdentity`. The daemon pins ordinary commit
     attribution through `GIT_AUTHOR_*` / `GIT_COMMITTER_*`, so each instance
     automatically uses its own App bot; an agent on an organization App
     uses that App's bot instead (§Organization GitHub Apps, Commit
     attribution). Git always reads global config;
     children inherit the path, and no indexed-count conflict exists. Reserve
     indexed `GIT_CONFIG_*` variables for **short-lived subprocesses directly
     controlled by the daemon, such as clone**.
   - **The ambient hook policy rides the same file, not the indexed channel.**
     The generated gitconfig sets `core.hooksPath=/dev/null` (or `NUL`) and
     `core.fsmonitor=false` after the host `[include]`, for every configured Git
     workspace — including one the daemon issues no managed credential to, which
     gets the file for the policy alone. The indexed channel was tried first and
     is unusable for anything the model's git must read: it does not merge across
     processes, and a child that inherits `GIT_CONFIG_COUNT` without the indexed
     pairs makes **every** git invocation fail to parse its command-line config.
     The cost is precedence — `GIT_CONFIG_GLOBAL` is global
     scope, which repository-local config outranks, where command scope outranked
     everything. Daemon-run Git keeps its command-scope pins
     (`workspaceGitConfigPairs`), so the exposed case is a runtime's own git in a
     checkout that sets `core.hooksPath` locally. That is accepted: `srt` isolates
     environments, not trust, and a runtime may write its checkout's
     `.git/config` ([session-executors.md](session-executors.md) §5).
   - **The file is keyed by what it contains, not by the host that asked for
     it.** A credential-stripped host (a dream) coexists with the warm host and
     shares its pod on the pool, so it writes a separate policy-only name rather
     than the credentialed one: landing policy-only content on the credentialed
     path would strip the live runtime's helper and reset until it rebuilt.
     Content is a pure function of (agent, class) — scope comes from the agent
     spec and the commit identity rides the environment, not the file — so
     every writer of a path writes identical bytes, and an agent never owns
     more than these two files.
     Per-host names were rejected for the opposite reason: nothing reaps these
     files, so they would accumulate one per host indefinitely.
   - This injection must be spread **last, at the highest precedence** in the
     spawn-environment merge: after
     `{ ...agentChildEnv(agent), ...cpRuntimeEnv(agent) }` in `ensureHost` at
     `daemon.ts:775`. AcpHost merges opts.env as the outermost layer at
     `acp-host.ts:239`. This prevents user-configured `runtimeOverrides.env`
     from overriding the values.
   - The primary repository receives a token normally; the helper cleanly
     rejects other github.com repositories. The same `.env()` injection covers
     daemon-initiated `clone --recurse-submodules`.
   - Assumption: the runtime does not scrub the environment for tool
     subprocesses. Neither claude-acp nor codex does so.

Private-submodule and multi-repository access uses explicit
`AgentRepoAuthorization` rows and `gitcred/request.repoFullName`; see
[agent-multi-repo-authorization.md](agent-multi-repo-authorization.md). Each
repository is resolved and minted independently, and helper path matching
routes the request. The Control Plane admits only the workspace repository or
an explicit grant, so the daemon cannot name an arbitrary repository.

### Failure Semantics

- If clone cannot obtain credentials, clean the directory, throw, and fail
  session creation. Errors from `sessions.handle()` are caught by
  `surfaceTurnFailure`
  (`daemon.ts:1258`); the Slack thread receives
  "⚠️ Agent failed to respond: <reason>", the webchat playground receives
  `webchat/done{error}`, and the session row returns to idle. The three startup
  retries in `startHostWithRetry` **cover only host
  spawn/initialize and do not retry clone**. The host starts before clone:
  `session-manager.ts:90 hostFor` -> `:94 prepareWorkspace`. **Consequently,
  gitcred-related error messages—the `LEASE_DENIED` subcases, "CP too old," CP
  unreachable, and the path-mismatch message "the repository may have been
  renamed"—reach the end user verbatim. They must be readable and actionable.
  The never-log discipline also applies to these user-facing error strings,
  which must never contain the token itself.**
- **Headless cron-triggered sessions have no response surface:** `replyConn` is
  empty and there is no webchat. Failures appear only in cron run history
  (`status:'failed'`, `cron/report`) and logs. The
  `heartbeat.degradedScopes` wiring from Observability is therefore the
  **only** live signal for a cron-only agent.
- For `pullOnNewSession`, retain the existing best-effort error swallowing.
- After the CP has been unreachable for an extended period, an agent's
  `git push` causes the helper to emit an error and git to report
  `Authentication failed`; the agent surfaces that failure to the user. This
  matches "CP outage degrades functionality without disabling the system."
- When a new daemon talks to an old CP that does not recognize
  `gitcred/request`, the CP returns an `UNKNOWN_FRAME` error REP and the
  correlator settles. Map this specifically to a "control plane too old" error
  instead of a generic failure.

## Web Side

1. **GitHub connection management** on the Integrations page or in Settings:
   - If the CP has no App configured and
     `GET …/orgs/:orgId/github/app` reports it disabled, show "Not enabled;
     operator configuration required."
   - When enabled, show an "Install on GitHub" deep link with state, the
     installation list with accountLogin, repositorySelection, and
     suspended/revoked states, and a "Sync" button that refreshes only the
     organization's durable claims. Missing state or administrator approval
     requires restarting the signed install flow; Sync never claims from the
     deployment-global App roster.
2. **AddAgentModal workspace step:** in GitHub mode, offer two alternatives:
   - **"Select from GitHub App":** installation selector -> searchable
     repository selector with pagination and client-side filtering, because
     GitHub provides no server-side search on this endpoint -> branch
     selector. **Prefill the repository's `default_branch`**, not a fixed
     `main`. If an empty repository has no branches, say "This repository has
     no commits; choose a nonempty repository or use scratch," rather than
     sending a guaranteed-failing `--branch main` clone. Show guidance when
     the feature is disabled or no installation exists.
   - **"Public repository URL":** preserve the existing free-form input.
     **However,** if normalization produces the github.com host without an App
     selection, show an inline hint: "Does this look like a private GitHub
     repository? Use 'Select from GitHub App'." Otherwise it attempts an
     anonymous clone and a private repository produces an opaque git
     authentication error.
   - An **"Allow push (write)"** switch is enabled by default.
   - Submit `installationId` / `gitAccess` in the workspace body. Do not
     send `repoFullName`; the CP derives it from `gitRepo`. Put these fields on
     the GitHub variant of `AgentWorkspaceBody`, the discriminatedUnion at
     `dto/index.ts:120-128`, whose GitHub variant is `:122-127`. Persist them
     through `CreateAgentBody.workspace` and return them through
     `AgentDto.workspace`. A dedicated cold action edits workspace type,
     repository, branch, `agentDir`, and `gitAccess`. Changes to
     mode/repository/branch replace daemon-local files; access-only and
     `agentDir`-only changes preserve the checkout.
3. The corresponding fetch functions and DTOs live in `lib/api.ts`; DTOs never
   contain tokens or secrets.
4. **Planned version-skew warning:**
   on the agent detail page, warn when the workspace uses GitHub-App mode but
   its daemon is too old; the CP knows the daemon version. An old daemon
   degrades to anonymous clone and, **on a machine with personal git
   credentials such as an osxkeychain PAT, can silently push as the operator's
   personal identity**. That is exactly the behavior this feature is designed
   to eliminate, so it must be visible.
5. **Planned visible credential degradation:** consume
   `heartbeat.degradedScopes`, described under
   Observability, and distinguish `LEASE_DENIED` caused by a
   suspended/uninstalled installation from **a repository removed from the
   authorization set**. For the latter, say: "This repository is no longer
   authorized by the GitHub App installation. Select it again on GitHub or
   recreate the agent." Because the workspace was immutable, this was a dead
   end and required clear guidance rather than an opaque 401.

## End-to-End Flows

**A. Connect GitHub (once per organization; the App is already configured for
the instance)**

The console's "Install on GitHub" deep link with one-time state -> the user
selects an organization and repository scope on GitHub -> 302 to the CP setup
callback -> verify state and ownership with an App JWT -> upsert the installation
and claim it into the organization -> 302 to `<console>/?github=installed`,
visible in the console. The callback has no orgSlug path segment. A missing or
invalid state returns a retry-install prompt instead of guessing ownership from
the deployment-global App roster. A nonadministrator installation uses
`setup_action=request` -> pending-approval prompt -> after approval, restart the
signed install flow.

**B. Select a repository while creating an agent**

AddAgentModal -> installation -> repository search, proxied by the CP with a
minted token -> branch -> `POST /agents`, where the CP verifies installation
ownership and repository authorization -> `agent/upsert` carrying
`workspace{ mode:'github', gitRepo, branch, gitCredential:'github-app' }`,
derived through `agentRecordToSpec` -> daemon `write-agent` persists
`agent.json` with the credential field.

**C. First clone**

All trigger sources—Slack message, cron fire, webchat playground, or agent API
tab—use the **same** `dispatch -> SessionManager.handle` path. Gitcred is keyed
only by agentId + placement and is independent of the integration. The host
starts before clone. First session -> `prepareWorkspace` ->
**pre-warm**, with a cache miss ->
`gitcred/request(agentId,'clone')`, a single send inside the READY gate with a
10-second timeout -> CP placement validation -> resolve a live installation by
repository owner -> single-flight mint a 1-hour, single-repository token, using
the 15-minute cache threshold -> `gitcred/grant{token,ttlSec,…}` -> daemon
monotonic-clock cache -> helper-injected clone through `GIT_CONFIG_*` -> write
repository-local helper config -> start the session normally.

**D. Agent pushes code**

The agent runs `git push` in the workspace -> git reads repository config and
invokes the shim -> the CLI takes the agent's temporary capability from the
managed runtime environment and connects to `agent.sock` -> after daemon
validation, the cache hits if more than 10 minutes remain, otherwise it pulls
through WS on demand -> stdout hands the token to git -> push completes.
Neither the token nor capability ever enters disk or argv.

**E. CP outage**

While the cached token remains valid, everything continues normally. After
expiry, only remote git operations fail, with an error that identifies the CP
as unreachable. Local git, existing sessions, and the Slack message path remain
unaffected. Recovery of the CP and WS reconnection heal the path automatically.
The cron promise that jobs continue to fire during a CP outage
(`frames/cron.ts:8`) has a carve-out for GitHub-App workspaces: a new clone
during the outage or a remote operation after token expiry fails, recorded in
cron run history as `status:'failed'` through `cron/report`, and heals after the
CP recovers.

**F. Uninstall/revoke**

Uninstalling/suspending the App or removing repository authorization on GitHub
**immediately invalidates** existing tokens and makes minting fail. The next git
operation receives 401 -> git invokes helper `erase` -> the daemon clears its
cache -> a repeated request receives `LEASE_DENIED` -> a clear error is
reported instead of retrying the stale cache for up to 1 hour. Unsuspending or
reinstalling heals automatically on the next request. Dynamic resolution by
owner absorbs the new installation ID created by reinstall, so the agent does
not need to be recreated.

**G. Agent migration (re-placement)**

After the agent moves to daemon B, old daemon A may miss `agent/remove` while
offline. Its cached token can still push for up to 1 hour: a **dual-write
window, accepted and documented as a degradation cost**. When A's cache expires
and it requests again, placement validation returns `SCOPE_DENIED`; A clears
the cache and stops requesting.

## Compatibility

- A daemon that does not understand `gitCredential` strips the optional field
  and falls back to anonymous Git. On a host with personal credentials, that
  fallback can use the operator's identity, so the console must warn before a
  GitHub-App workspace is assigned to an incompatible daemon.
- A CP that does not recognize `gitcred/request` returns an `UNKNOWN_FRAME`
  error reply. The daemon surfaces this as an incompatible-control-plane error
  instead of retrying indefinitely.
- Public-URL workspaces remain anonymous because `gitCredential` is absent.
- The CP loads the App private key at startup, and GitHub permits overlapping
  keys for rotation. Key rotation is operator-managed.

## Testing

- **Unit (CP):** App JWT with `@octokit/auth-app`, choosing
  iss=clientId/appId and limiting lifetime to <=10 minutes; token cache with an
  injected Clock to verify the 15-minute threshold and 60-second skew
  deduction; single-flight, proving concurrent requests for the same key
  collapse into one GitHub call; domain-separated state-HMAC subkey, one-time
  nonce, and expiry; `SCOPE_DENIED`/`LEASE_DENIED` mappings, including
  placement mismatch.
- **Integration (CP, Testcontainers):** the three setup-callback branches, with
  and without state and with `setup_action=request`; mark-revoked semantics on
  sync; the 409 path for `POST /agents`; the full `gitcred/request` path with
  stubbed GitHub fetch; **retransmission idempotency**, proving two frames with
  the same ID mint only once while producing two REPs; pagination in the
  repository proxy; and a contents:read token for branches.
- **Daemon:** credential-helper protocol for get/erase/store, case-insensitive
  path and tolerant `.git` matching, and the rename error text; socket round
  trip; monotonic-clock cache expiry and the 10-minute handoff threshold;
  forced refresh after erase/auth failure; stopping requests after
  `SCOPE_DENIED`; CP-disconnect degradation; the `requestGitCred` state gate,
  proving DEGRADED fails fast without sending a frame; and workspace-manager
  pre-warm ordering, timeout kill, failure cleanup, and `GIT_CONFIG_*`
  injection with fake simple-git.
- **Manual:** the complete A-G flow with a private repository; the error on a
  machine with git < 2.32, including the narrow 2.31 version that has
  `GIT_CONFIG_COUNT` but not `GIT_CONFIG_GLOBAL`; behavior of the URL-scoped
  empty-helper reset on 2.32; suspend -> immediate push invalidation ->
  self-healing after unsuspend; recovery of an existing agent without
  recreation after uninstall/reinstall produces a new installation ID; the
  `--filter=blob:none` path for a large clone lasting >1 hour; and
  **subrepository scenarios:** a public submodule can clone, an explicitly
  authorized private submodule obtains its own scoped token, an unauthorized
  repository is rejected, and a machine configured with personal
  osxkeychain credentials does not silently fall back to the personal
  identity.

## Current Behavior and Remaining Questions

1. **GitHub API capabilities:** the runtime's `GH_TOKEN` is the credential
   proxy's placeholder; the proxy mints each request's token from the
   repository it names, scoped by `GitCredRequest.capabilities` (Phase 2).
2. **Multi-tenancy / per-organization self-managed Apps.** The built-in App
   stays one instance-level App shared with sign-in. Organization GitHub Apps
   (see "Organization GitHub Apps") keep each App's key and installation set in
   the owning organization's trust boundary; they give agents distinct actors
   and do not replace the built-in App.
3. Search experience in the picker for an organization with
   `repositorySelection: all` and thousands of repositories. GitHub provides
   no server-side search on this endpoint, so the CP would need caching and
   filtering. The current UI uses pagination + client-side filtering.
4. **Workspace editing and the GitHub permission boundary:** a normal
   `PATCH /agents/:id` must not silently rewrite the workspace. A dedicated
   `PUT /agents/:id/workspace` cold action owns that operation, while
   `lastModifiedBy/At` continues to record the security-relevant actor. The
   setup-callback installation claim row could similarly add `createdByUserId` for
   aligned auditing.
   PATCH is gated by `canEdit`. A viewer can never edit; any collaborator can edit an
   organization-visible agent, and any **shared** collaborator can edit a
   restricted agent. A recipient therefore cannot use CP collaboration rights
   to bypass GitHub. Every GitHub target still fail-closes through
   `githubUserAuthz.assertAccess` at the requested access level.
   `UpdateAgentBody` is `.strict()` and excludes workspace. Every workspace
   retargeting operation is consolidated into the dedicated endpoint and its
   acknowledged cold lifecycle.
   Current `gitAccess` editing through the
   `PUT /agents/:id/workspace` cold action supports **read<->write** on the same
   repo/branch/agentDir, or binding a manual checkout to the App.
   drain/activate clears the daemon credential cache. The target access remains
   fail-closed behind identity attestation through
   `githubUserAuthz.assertAccess`. If an enabled GitHub hook configures formal
   review or Checks, a downgrade to read returns 409 both in route preflight
   and at the shared transaction fence. Concurrent creation of a
   write-requiring hook is rejected at the same fence. Scratch/GitHub mode,
   repository, branch, `agentDir`, and access are all editable. A GitHub target
   does not require an explicit additional-repository grant, while identity
   attestation still gates the requested access. Changes to mode/repo/branch
   irreversibly replace daemon-local files and require an explicit warning
   first. Access-only or `agentDir`-only changes preserve the existing
   checkout. Route preflight and the shared transaction fence continue to
   protect workspace write authority required by enabled formal reviews or
   Checks.
5. When is it worthwhile to add approval-before-push or a shorter TTL, with
   more frequent minting, as tighter gates against the risk that an agent
   exfiltrates its own token?
   "Daemon-Mediated Agent Access" proposes removing the token from the agent
   instead.
6. **Private submodules / multi-repository workspaces:** explicit
   `AgentRepoAuthorization` rows provide three per-repository access levels and
   independent per-repository minting. Each repository may resolve through a
   different installation. Automatic nomination from `.gitmodules` remains a
   follow-up in
   [agent-multi-repo-authorization.md](agent-multi-repo-authorization.md).
7. **Per-user repository authorization:** runtime uses an installation token,
   while create and workspace-edit authorization attest the requesting user's
   GitHub access. The CP reads the user's GitHub login from identity metadata
   and never persists a social access or refresh token.

   Resource visibility continues to govern agent content independently:
   `visibility('org'|'restricted')` and the complete Selected audience in
   `sharedWith[]`; `createdByUserId` is audit-only. Organization role is not a visibility
   bypass, so an owner reaches repository content through a restricted agent
   only when they are explicitly selected.

   Personal API keys retain their bound `userId`; the CP resolves that user's
   `oidcSubject` and GitHub identity without requiring a live browser session.

   **Repository permission checks use an App installation token.** The CP
   prefers the user's existing GitHub identity from the Logto Management API.
   It then uses an installation metadata token to
   query
   `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, which
   includes team- and organization-derived access. Read operations accept an
   effective permission or a public repository; write operations require
   write/admin. Missing identity metadata does not remove public read access;
   private repositories and write operations still require the user to link a
   GitHub profile and never silently gain access.

   Installing the GitHub App is not a human-identity assertion. The setup
   callback proves an organization-bound installation claim, but it does not
   identify the person who completed an organization install. AgentConnect
   therefore never infers a Profile link from an installation account or
   callback. Profile linking remains an explicit social authorization through
   the existing sign-in-method flow.

   If that flow fails specifically with `user.identity_already_in_use`, the
   Console offers **Continue for repository access**. Existing successful links
   keep their current flow. The continuation performs a separate GitHub App
   OAuth exchange with S256 PKCE and a single-use state bound to the signed-in
   AC user. It reads `/user`, attempts to revoke only that temporary token,
   and stores the numeric GitHub user ID and display login without retaining
   access or refresh tokens. Multiple AC users may prove the same GitHub ID.
   This connection grants no sign-in method: GitHub sign-in still selects the
   original Logto account. It also grants no repository permission by itself;
   installation coverage and the existing per-user permission checks still apply.

   The repository identity is consulted only after Logto successfully returns
   an existing user without a GitHub identity. Provider failures and deleted
   users never activate the fallback. The fallback resolves the current login
   through `GET /user/{account_id}` using the relevant installation token, so
   a renamed handle cannot permanently substitute another GitHub user. Its
   binding is read from PostgreSQL on every fallback; resolved handles have a
   bounded 60-second cache that also honors callers' shorter identity leases
   and explicit refreshes. Existing session-access leases and runtime
   installation-token lifetimes remain unchanged. The Profile returns this connection separately
   from `identities`, preserving the sign-in-method contract for older clients.

   Disconnect cancels pending authorizations as well as the repository binding.
   Callback completion and unlink share the existing per-subject mutation gate;
   consuming the state and saving the binding are one database transaction.
   Unlinking a real GitHub sign-in identity first retires any hidden repository
   binding. A generic Profile refresh never removes a repository connection.

   The continuation requires the GitHub App client ID and client secret plus
   the public Web origin. Setup Server supplies the saved `github.clientSecret`
   to the CP as `GITHUB_APP_CLIENT_SECRET`. The App's Callback URL list must
   include `https://console.example.test/auth/social/callback` with the actual
   configured Web origin. New Setup manifests include this callback; existing
   Apps may need it added in GitHub settings. Missing configuration preserves
   the current conflict result, and disconnect remains available if the OAuth
   credentials are later removed. The second OAuth trip may show GitHub's
   account picker or consent screen; it is never assumed to be silent.

   **Remaining limits:**

   - Authorization is checked when the workspace target or access level
     changes. A periodic re-attestation job is still needed to react when the
     authorization anchor later loses GitHub access.
   - Runtime pushes use the App identity for branch protection, CODEOWNERS, and
     audit attribution.
   - Sharing a restricted agent endorses its recipients at the AgentConnect
     layer; recipients are not individually re-attested against GitHub.
   - The daemon host remains the execution trust domain described under
     Security Boundary.

   **Configuration and enforcement:**

   - **Configuration gateway:** the persisted Logto Management connection must
     contain its application identity, write-only secret, and API Resource. Its
     service origin remains startup topology. Assemble the authorization
     service only when all three conditions hold:
     **GitHub App is enabled + Logto Management is configured + OIDC auth is
     enabled**. A devAuth principal has no real identity to attest. If the
     gateway is disabled, selection uses the organization-level installation
     authorization set. This authorization path in
     `github/logto-identity.ts` reads only identity metadata, specifically the
     GitHub login, and never accesses a social token. The same server-side
     Management API client also backs the Profile's explicit social
     Link/Unlink actions without exposing its M2M credential.
   - **Decision chain** (`github/user-authz.ts`):
     `app_user.oidcSubject` -> Logto Management M2M ->
     `identities.github.details.rawData` from `GET /api/users/{sub}`, accepting
     both supported login shapes (or the verified repository-only identity
     when the user has no GitHub sign-in identity) -> GitHub login ->
     installation metadata token ->
     `GET /repos/{o}/{r}/collaborators/{login}/permission`. For need=read,
     accept any effective permission **or a public repository**. For
     need=write, require write/admin. GitHub folds maintain into write and
     triage into read; a public repository alone does not confer write.
     Missing GitHub identity, such as Google sign-in, still permits public
     reads. Identity-dependent checks return `GITHUB_IDENTITY_REQUIRED` and
     never silently permit private access or writes.
   - **Enforcement points:** (1)
     `GET …/repositories/:owner/:repo/access` provides picker preflight and is
     registered only when the gateway is enabled. The web interprets 404 as
     "this instance has no per-user gate." (2) The branches route asserts
     read at repository selection time. (3) `POST /agents` asserts
     `gitAccess=read?read:write` and is the **security gate**; preflight is only
     UX. A denial returns 403 with machine code
     `GITHUB_IDENTITY_REQUIRED | USER_NO_ACCESS`.
   - **Failure semantics:** fail closed in every case. Upstream Logto/GitHub
     failure returns retryable 502/429 and never permits access. Caches are:
     M2M token until exp minus 60 seconds; sub->login for 10 minutes, with a
     60-second negative cache; and
     (installation, repo, login)->access for 5 minutes. All use the injected
     Clock.
   - **List filtering:** when the gateway is enabled, the repository
     list is **filtered per user**. Public repositories are retained directly.
     Each private repository is checked for effective permission and removed
     on `none`, so the **name** of an unauthorized repository never reaches the
     console. Cost model: probe only private repositories with eight bounded
     REST lookups at a time, and share the same
     (installation, repo, login)->permission 5-minute cache with the
     branches/create gates. Installation repository pages use the same TTL and
     are invalidated by installation/repository webhooks and manual Sync, so
     reopening another picker does not repeat the cold roster read.
     Do not replace the REST permission endpoint with GraphQL
     `Repository.collaborators(login:)`: installation tokens can return an
     empty collaborator connection for a user whose REST effective permission
     is non-`none`.
     An account without a GitHub identity receives the public subset with
     `privateReposHidden: true`. The console presents that as an informational
     state and links to Profile -> Sign-in methods; it does not render a failed
     or empty picker. Private names remain undisclosed.

     API-key principals are covered through
     key->userId->oidcSubject, with no browser session required. The
     resource visibility is unchanged and organization role is not a bypass.

   - **Web:** preflight `/access` as soon as a repository is selected. No read
     access shows a red inline error under the field and blocks submission.
     Read without write pins "Allow push" to read-only and submits
     `gitAccess: 'read'`. `GITHUB_IDENTITY_REQUIRED` points to the existing
     Profile GitHub-linking action.
   - Identity-provider application IDs and Logto Management credentials are
     loaded from the deployment configuration; secret values are never exposed
     to the Web client.
