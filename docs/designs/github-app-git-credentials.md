# GitHub App Repository Selection + Credential-Free Git Operations on Daemons

> **Status:** Implemented. The authoritative wire schema is
> `packages/protocol/src/frames/gitcred.ts`. It includes repository,
> capability, hook-purpose, and forced-refresh fields. Explicit additional
> repositories and the on-demand `gh` wrapper are described in
> [agent-multi-repo-authorization.md](agent-multi-repo-authorization.md).
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
> planned; the rest of this document states the current security contract.
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

GitLab already shares this credential plane through the provider-qualified
gitcred v2 schema. A planned third arm, Bitbucket Cloud, is designed in
[bitbucket-cloud-integration.md](bitbucket-cloud-integration.md) §13.2 and is
**not implemented**: it would widen `ManagedCredentialProvider`, add
`bitbucket.org` to the default allowed origins, add its own
`GitCredRequest.purpose` values, and reuse GitHub's two-segment `owner/repo`
path parsing rather than GitLab's nested one. It has no first-party CLI, so it
adds no shim.

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
- **Per-organization self-managed GitHub Apps** (manifest flow / manual
  registration): the App is instance-level configuration. Separate Apps per
  tenant are deferred; see "Current Behavior and Remaining Questions."
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
   filesystem. The socket is reached through the shim's `gitcred` tunnel, the helper
   is the runtime image's own root-owned executable, and every pointer the daemon
   writes — the `credential.helper` line, `GIT_CONFIG_GLOBAL`, the socket path in
   `AC_GITCRED_SOCKET` — is in the POD's coordinates, resolved from the same
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
   gated by organization + `canView`; webchat token minting returns 404; and
   unauthorized SSE items are discarded. Organization role never widens
   restricted-resource visibility. The repository picker filters unauthorized private
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
  in `gitcred.sock` are both acceptable; do not introduce fixed-length limits.
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

1. **Unix socket:** `~/.agentconnect/run/gitcred.sock`, mode 0600, in a 0700
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
   `--help`. It reads the local capability from `AC_GITCRED_CAPABILITY` and
   implements the git credential-helper protocol: `get` reads
   `protocol/host/path` from stdin and verifies `host==github.com`.
   **Agent identity resolution:** the agentId positional argument is a value
   baked into the config file. It can become a dead ID when an agent is deleted
   and recreated under the same name while the checkout survives; the daemon
   then rejects it because its capability does not match. Prefer the
   `AC_GITCRED_AGENT` environment variable from `gitCredentialEnv`, injected as
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
  resolution rule: `AC_GITCRED_AGENT` takes precedence over this baked-in ID;
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
     automatically uses its own App bot. Git always reads global config;
     children inherit the path, and no indexed-count conflict exists. Reserve
     indexed `GIT_CONFIG_*` variables for **short-lived subprocesses directly
     controlled by the daemon, such as clone**, and for non-credential ambient
     policy. In particular, configured Git workspaces inject
     `core.hooksPath=/dev/null` (or `NUL`) and `core.fsmonitor=false` at command
     scope for the Agent process. If a nested tool deliberately replaces that
     indexed channel it can opt out of the ambient hook policy, but it cannot
     remove or replace the global-file credential reset.
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
managed runtime environment and connects to `gitcred.sock` -> after daemon
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

1. **GitHub API capabilities:** a hidden `agentconnect gh-token` helper uses the
   same socket and runtime-only per-agent capability to pull a fresh token on
   demand. The runtime never injects a process-lifetime `GH_TOKEN`.
   `GitCredRequest.capabilities` scopes each request, and the `gh` wrapper
   routes per-repository requests as described in
   [agent-multi-repo-authorization.md](agent-multi-repo-authorization.md).
2. **Multi-tenancy / per-organization self-managed Apps.** The current App is
   one instance-level App shared with sign-in. If separate organizations can
   connect their own GitHub Apps in the future, introduce an
   organization-level App table and keep each App's key and installation set in
   its own trust boundary.
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

   **Identity attestation uses an App permission self-check with no user OAuth
   token.** The CP obtains the user's GitHub login from identity metadata via
   the Logto Management API. It then uses an installation metadata token to
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
     both supported login shapes -> GitHub login ->
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
