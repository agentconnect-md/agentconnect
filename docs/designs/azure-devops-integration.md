# Azure DevOps Integration

> Status: **Proposed**. Scope: **Azure DevOps Services** (`dev.azure.com`),
> Git repositories in Azure Repos. The first version covers workspaces and
> additional repositories only; pull-request hooks, reviews, and code-channel
> pull-request views are the second step (§11). Platform facts were read from
> Microsoft's documentation on 2026-11-06; each item marked **probe** in §12
> must be confirmed against a live organization before the step that relies
> on it.

Azure DevOps is the fourth code host, after GitHub, GitLab, and Gitea. It is
one more implementer of the code-host seam
([gitea-integration.md](gitea-integration.md) §13) and one more `credential`
variant of the host-neutral workspace
([git-workspace-model.md](git-workspace-model.md) §2), never a new workspace
mode. Everything this document does not mention is inherited from the Gitea
design, and through it from [gitlab-com-integration.md](gitlab-com-integration.md).

Two facts shape the design:

1. **Azure DevOps cannot narrow a token.** An Entra token issued to a service
   principal carries everything that identity may do in the organization, and
   a personal access token's scopes apply organization-wide. There is no
   request that mints a credential limited to one repository or to read
   access. AgentConnect's per-agent, per-repository tier therefore cannot live
   in the token.
2. **The daemon credential proxy already exists**
   ([github-app-git-credentials.md](github-app-git-credentials.md#phase-2-the-daemon-credential-proxy)).
   The environment holds a sealed placeholder; the proxy picks the repository
   from each request and presents the real token. For Azure DevOps the proxy
   is not only where the token lives but the only boundary that enforces the
   repository set and the tier, so Azure DevOps is served through the proxy
   and nothing else (§6.1).

## 1. Decision Summary

1. **The deployment's Microsoft application.** Azure DevOps reuses the Entra
   application that already signs people in with Microsoft and serves Teams.
   An administrator connects with one Microsoft sign-in. The application's
   service principal in the customer's tenant becomes the connection's
   identity, and the Control Plane exchanges the deployment secret for
   short-lived Azure DevOps tokens. An organization may use its own
   application instead. Personal access tokens are not accepted (§10).
2. **Proxy only.** An Azure DevOps grant is presented only by the daemon
   credential proxy. It never reaches an agent environment, the agent-facing
   helper channel, or a CLI wrapper.
3. **The tier is enforced in the proxy.** Requests are routed deny-by-default,
   a push requires a `write` grant, and API writes are refused.
4. **A surrogate numeric identity.** Repository GUIDs map to a deployment-global
   numeric id, which is what every existing catalog, claim, grant, workspace,
   and wire field carries (§4).
5. **No webhooks in the first version.** A binding is a catalog row and an
   identity; it needs no administration rights on the Azure DevOps side and
   no provisioning saga.
6. **The Azure CLI works unmodified.** `az repos` and the other `azure-devops`
   extension commands reach the proxy with a placeholder and get reads; writes
   are refused with a message naming the alternative.

## 2. What Differs From Gitea

| Capability            | Gitea                                 | Azure DevOps                                                                |
| --------------------- | ------------------------------------- | --------------------------------------------------------------------------- |
| Instance axis         | one instance per deployment, base URL | fixed host; one Azure DevOps organization per connection                    |
| Identity              | a bot user's personal access token    | the deployment application's service principal in the customer tenant       |
| Connecting            | paste the token                       | an administrator's Microsoft sign-in                                        |
| Token lifetime        | no expiry; manual replacement         | about an hour; the Control Plane refreshes it                               |
| Secret replacement    | replace token                         | Setup rotates the deployment secret; an own application replaces its own    |
| Repository identity   | numeric id, `owner/repo`              | GUID inside a project GUID; `organization/project/repository`; surrogate id |
| Rights on the repo    | `admin` on every bound repository     | read on every bound repository; Contribute where any agent writes           |
| Where a tier is held  | a label on one token                  | the proxy; the token is organization-wide                                   |
| Agent token delivery  | helper or proxy                       | proxy only                                                                  |
| Provider CLI          | none                                  | the Azure CLI `azure-devops` extension, read-only through the proxy         |
| API reads naming none | the workspace's credential            | an allowlist of metadata reads; everything else refused                     |
| Webhooks              | managed per repository                | none in the first version (§11)                                             |
| Rate limiting         | instance-defined                      | per identity, shared by every agent of the organization (§6.5)              |

## 3. Identity

### 3.1 The Microsoft Application

**Setup → Microsoft** already holds one Entra application with a write-only
client secret. It signs people in with Microsoft and, with its home tenant ID,
is also the deployment's Teams app
([teams-integration.md](teams-integration.md) §8.2). Azure DevOps reuses it.
There is no second registration and no Azure DevOps field in Setup beyond one
more redirect URI, the Console's `/azure-devops/connect` page, which Setup lists
beside the others.

An application becomes an identity in a customer's tenant through consent: the
first sign-in that consents to it creates its service principal there. Azure
DevOps authorizes that service principal like a user, by its membership in an
organization and its groups, never by Entra application permissions. A
connection is therefore the deployment application's service principal in one
customer tenant, added to one Azure DevOps organization. The Control Plane
requests its tokens with the client credentials grant at the customer tenant's
authority, scope `499b84ac-1321-427f-aa17-267ca6975798/.default` (the Azure
DevOps resource), and the deployment secret.

The deployment application is multi-tenant wherever Teams already serves more
than one tenant. On a deployment whose application is single-tenant, only its
home tenant can connect, which suits an organization hosting the product for
itself.

Microsoft's consent page shows the application's Entra display name. Setup
therefore recommends a name that does not name one Microsoft product, since
the same application now serves sign-in, Teams, and Azure DevOps.

### 3.2 Connecting

The Console's Azure DevOps card leads with **Connect with Microsoft**:

1. **Sign-in.** The Console asks for an authorization URL
   (`POST /orgs/:orgId/azure-devops/connect`). The Control Plane signs a state
   of the organization, the caller, and a ten-minute expiry, and returns
   Microsoft's `organizations` authorize URL for the deployment application
   with `openid`, `User.Read`, and the delegated Azure DevOps scope
   `499b84ac-1321-427f-aa17-267ca6975798/user_impersonation`, a PKCE challenge
   only the Control Plane can complete, and the Console's
   `/azure-devops/connect` page as the redirect URI. A personal Microsoft
   account is refused.
2. **Exchange.** The page posts the code and state back
   (`POST /orgs/:orgId/azure-devops/connect/callback`). The Control Plane
   redeems the code with the deployment secret and takes the customer tenant
   from the ID token's `tid`. It keeps the administrator's delegated token only
   for the rest of this flow, encrypted, as the Teams connect does, and never
   stores it.
3. **Organization.** The Control Plane lists the Azure DevOps organizations the
   administrator belongs to in that tenant, and the administrator picks one.
4. **Entitlement.** With the administrator's delegated token, the Control Plane
   adds the application's service principal to the organization with the Basic
   access level, then to the project groups the administrator picks: Readers
   where agents only read, Contributors where any agent writes. An
   administrator without that right (a Project Collection Administrator has it)
   gets a refusal that names the role and a checklist for doing it by hand. The
   flow resumes at step 5 once the service principal is in the organization.
5. **Verification.** As the application, the Control Plane takes a client
   credentials token at the customer tenant and reads
   `GET https://dev.azure.com/{organization}/_apis/connectionData`, recording
   the service principal's identity id and the organization's `instanceId`. It
   then lists the repositories (§5), which proves an access level that
   includes Azure Repos; Stakeholder does not.
6. **The row.** An organization another AgentConnect organization on this
   deployment has connected is refused (`AZURE_DEVOPS_ORGANIZATION_TAKEN`,
   naming no organization), because two catalogs would claim one repository.
   Otherwise the connection records the tenant, the organization name and
   `instanceId`, the identity id, the credential source (`deployment` or
   `own`), and a credential epoch.

One AgentConnect organization holds at most one Azure DevOps connection in the
first version.

**Use your own application instead** stays one click away, and is the only
path when the deployment has no Microsoft application. The administrator enters
the organization, the tenant ID, the client ID, and a client secret of an
application registered in the customer's tenant. That application's service
principal is added to the organization and its project groups by hand; steps 5
and 6 run unchanged; and the secret is sealed behind the connection's
secret-store port. Entering the deployment application's own client ID here is
refused.

### 3.3 People

Nobody signs in again to use Azure DevOps. Agents act as the application, and
the console sign-in stays whatever the deployment offers. Who may make a
repository an agent's workspace or additional repository follows the agent's
edit rights, as on Gitea: a person's own Azure DevOps permissions are not
consulted in the first version (§10).

### 3.4 Tokens

The Control Plane caches one Azure DevOps token per connection and refreshes
it when less than ten minutes of the `expires_in` it was issued with remain;
it never assumes a fixed lifetime. A gitcred lease for an Azure DevOps
repository carries that token with a TTL no longer than the token's remaining
life less a margin, so a lease never outlives the token inside it. The daemon
never sees a client secret.

### 3.5 Rotation and Failure

The deployment secret is rotated in Setup. The new value reaches every
connection whose source is `deployment` at once, as it reaches Teams' customer
rows, and each such connection's credential epoch increments so daemon caches
purge the old tokens. An own application's secret is replaced on its card; the
replacement runs §3.2's steps 5 and 6 and requires the same tenant, client ID,
and identity id.

Entra does not tell an application when its own secret expires, so the product
learns of expiry from the refusal. An `invalid_client` answer moves every
binding of the affected connections to `runtime_degraded` with reason
`secret_rejected`. A service principal removed from the tenant or from the
organization (`TF401444`) moves them to `runtime_degraded` with reason
`access_revoked`, and the card offers to connect again.

### 3.6 What the Organization Grants

Whether the Control Plane adds the entitlement or an administrator does, the
customer decides what the identity can reach:

- the service principal holds the Basic access level, which consumes a paid
  licence in that organization;
- its project groups give it read on every repository an agent will use, and
  Contribute and Create branch where any agent writes; and
- it needs no administrator role in the first version.

Everything the identity can read is reachable by the token, so the Console
recommends granting it only the projects agents need. The proxy (§6) is what
keeps each agent inside its own repositories and tier; the grants above only
bound the worst case.

## 4. Repository Identity

Azure DevOps identifies a repository by a GUID within a project GUID within an
organization; renames keep the GUID. AgentConnect's catalog, claims, grants,
workspace column, gitcred frames, and hook tables carry a decimal
`externalId` stored as `BigInt`.

Instead of widening each of those, the Control Plane keeps a deployment-global
identity table, `AzureDevOpsRepositoryIdentity`: a numeric id it allocates once
per repository GUID and never reuses, beside the repository GUID, the project
GUID, and the organization `instanceId`. The numeric id is the repository's
`externalId` everywhere the existing code reads one. Because the table is
deployment-global, the deployment-global claim keeps its meaning: one
AgentConnect organization per repository.

The GUID still travels where routing needs it. The agent spec carries, for each
Azure DevOps root, the repository GUID beside the numeric id, because the Azure
CLI and REST paths address a repository by GUID as often as by name (§6.2).

`repoFullName` is `{organization}/{project}/{repository}`. It is display and
matching text, refreshed when the binding converges; nothing is keyed on it.
A secondary root lives at `repos/_azure-devops/<numeric id>/`, and
`_azure-devops` joins the reserved secondary-root directories. Project and
repository names may contain spaces; paths are compared after percent-decoding.

## 5. Repositories

The picker reads `GET https://dev.azure.com/{organization}/_apis/git/repositories`
across the whole organization, which returns what the identity can see, drops
disabled repositories and those in maintenance, and keys rows by GUID.

Binding is implicit on first use, as in Gitea §6, minus the webhook steps: the
write that names a repository (a workspace, or an additional-repository grant)
allocates the identity, takes the claim, and creates the binding and catalog
row in one transaction. A binding records the path, the canonical clone URL,
and the default branch. Its states are `ready` and `runtime_degraded`
(`secret_rejected`, or `repository_unavailable` when the repository was deleted
or disabled). Removing a binding that a workspace or grant still references is
refused with 409 naming the reference; otherwise removal is immediate, since
there is no webhook to clean up.

Workspace derivation (git-workspace-model.md §6) gains two rows: an address in
the connected organization that the identity can see yields
`{ provider: 'azure-devops', repoId }`; one it cannot see is refused with "grant
the application access to this repository". Every other Azure DevOps address
stays anonymous, as any unmanaged host does.

Clone addresses are normalized to `https://dev.azure.com/{organization}/{project}/_git/{repository}`.
The normalizer accepts:

- a user-info part equal to the organization name, which Azure DevOps puts in
  its clone URLs and which is not a credential;
- `https://dev.azure.com/{organization}/_git/{repository}`, the form Azure
  DevOps emits when a repository has its project's name; and
- `https://{organization}.visualstudio.com/[DefaultCollection/]{project}/_git/{repository}`.

SSH addresses are not managed: a service principal cannot register SSH keys.

## 6. Access Through the Credential Proxy

### 6.1 Proxy Only

The token carries the identity's full rights in the organization. Handed to an
environment, it would reach every repository the identity can see at the
identity's highest permission; no helper, wrapper, or label could take that
back. So the Control Plane serves an Azure DevOps grant only to the credential
proxy and to the daemon's own Git operations, and refuses the agent-facing
helper channel for it.

A daemon therefore advertises `azure-devops-v1` only while its credential proxy
is enabled, and placement requires it. A session on a strategy the proxy does
not reach yet is refused with `azure_devops_requires_proxy` rather than started
without credentials.

### 6.2 Instance and Routes

An Azure DevOps connection contributes one proxy instance with two hosts:
`dev.azure.com` with the path prefix `{organization}`, and
`{organization}.visualstudio.com` at the root. Requests are routed by method and
path:

- **git**: `[{project}/]_git/{repository}[.git]/` followed by `info/refs`,
  `git-upload-pack`, or `git-receive-pack`. The repository is resolved by name
  among the agent's authorized Azure DevOps repositories.
- **REST naming a repository**: `[{project}/]_apis/git/repositories/{id-or-name}/…`.
  The repository is resolved by GUID or by project and name.
- **REST naming no repository**: only `_apis/connectionData`, `_apis/projects`,
  `_apis/git/repositories` (the list), and the resource-area lookups the Azure
  CLI makes. Each is forwarded as a read.
- **Everything else is refused**, including other Azure DevOps services and
  organization-wide content such as code search.

The other providers forward a read that names no repository with the
workspace's credential, because their tokens are scoped by the provider. An
Azure DevOps token is not, so a read the proxy cannot attribute to an
authorized repository is refused instead of borrowing the workspace's
authority.

### 6.3 The Tier

| Access    | git            | API                      |
| --------- | -------------- | ------------------------ |
| `read`    | fetch          | reads of that repository |
| `comment` | fetch          | reads of that repository |
| `write`   | fetch and push | reads of that repository |

A push is `git-receive-pack`, or `info/refs?service=git-receive-pack`. The proxy
refuses either unless the grant it obtained for that repository has access
`write`, naming the agent's actual access in the refusal. The check reads the
grant's access, not the provider, so it lives in the proxy's shared git route.

API writes are refused for every tier in the first version. The refusal says
that writes need a tool. Pushing a branch works and the pull request can be
opened in Azure DevOps (§12, question 6).

### 6.4 Client Configuration

git uses the session credential helper and the proxy like every other provider;
the proxy presents the token as the Basic password with the identity's name as
the user. The Azure CLI receives:

- `AZURE_DEVOPS_EXT_PAT`, set to the placeholder; the CLI sends it as a Basic
  password, which the proxy already reads;
- `AZURE_CONFIG_DIR`, set to an empty per-session directory, because the CLI
  prefers a cached sign-in over `AZURE_DEVOPS_EXT_PAT`; and
- the proxy and trust variables of the credential proxy design, including
  `REQUESTS_CA_BUNDLE`.

The CLI only accepts `dev.azure.com` and `*.visualstudio.com` as organization
hosts, which the proxy preserves, since it terminates TLS for those names
rather than rewriting them. Its organization and project detection reads the
four-segment canonical remote of §5. AgentConnect does not install the CLI.

### 6.5 Rate Limits

Azure DevOps limits each identity, not each token, so every agent of the
organization and the Control Plane share one budget. The proxy forwards `429`
and `Retry-After` untouched, so the client's own backoff applies. The Control
Plane's picker and refresh honor `Retry-After` and `X-RateLimit-Remaining`.

## 7. Protocol and Compatibility

- `CODE_HOST_PROVIDERS` gains `azure-devops`. Every provider-keyed hook table
  gets an entry that refuses, as Gitea's G1 did before its hooks existed; the
  second step replaces them.
- Feature string `azure-devops-v1` on the daemon gates placement and spec
  projection, with fail-closed-by-omission semantics (§6.1).
- `AgentWorkspaceCredential` gains `{ provider: 'azure-devops', repoId }`, the
  numeric identity of §4. The spec carries the organization name and each Azure
  DevOps root's repository GUID. There is no host field, since the host is
  fixed.
- gitcred grants echo the provider, numeric id, path, access, and credential
  epoch, which the daemon verifies as it does for the other providers.
- The protocol's clone-URL normalizer and label learn the forms of §5.

## 8. Console and REST

The Integrations page gains an Azure DevOps card. The card offers:

- **Connect with Microsoft**, and **Use your own application instead**;
- replace secret, for an own application only;
- disconnect; and
- the repositories in use.

Its copy is about Azure DevOps throughout. The administrator it asks for is a
Project Collection Administrator, not a Teams administrator, and the manual
checklist of §3.2 step 4 lists what §3.6 asks of the organization. The
workspace picker gains an Azure DevOps tile, and the additional-repository
picker lists what the identity can see, marking an unbound row "added on save".

Setup's **Microsoft** section stays one section for the one application. It
describes what that application serves (sign-in, Teams, Azure DevOps) and lists
the connect page's redirect URI.

REST at the organization scope:

- `POST /azure-devops/connect` and `POST /azure-devops/connect/callback`, the
  sign-in of §3.2;
- `GET /azure-devops/connect/:flow/organizations`, then
  `POST /azure-devops/connect/:flow/organization` and
  `POST /azure-devops/connect/:flow/projects`, for steps 3 and 4;
- `POST /azure-devops/connections` for an own application,
  `GET /azure-devops/connections`, and `DELETE /azure-devops/connections/:id`;
- `POST /azure-devops/connections/:id/secret`, for an own application only;
- `GET /azure-devops/connections/:id/repositories` for the picker; and
- `DELETE /azure-devops/repositories/:id`, which answers 409 when a workspace or
  grant still references the repository.

The workspace and additional-repository routes bind on first use, as for Gitea.
The connect, connection, and secret routes manage a credential and are
`interactiveOnly`.

## 9. Security

- Client secrets are sealed at rest and never leave the Control Plane.
  Tokens exist in the Control Plane's cache, in leases over the authenticated
  daemon WebSocket, and in the daemon's memory. They never appear in an
  environment, argv, a remote URL, `.git/config`, or a diagnostic.
- An administrator's delegated token lives only for the connect flow,
  encrypted, and is never stored.
- On a multi-tenant deployment, the deployment secret mints Azure DevOps tokens
  for every organization connected through it. Teams already shares that
  secret for bot traffic, but here it reaches code. Setup therefore recommends
  a certificate credential over a client secret for this application, and a
  rotation reaches every connection at once (§3.5). A customer revokes the
  deployment's access on its own side by removing the service principal from
  its organization.
- The proxy is the boundary for both the repository set and the tier: routing
  is deny-by-default, a push needs `write`, and API writes are refused. A
  client that bypasses the proxy holds only a placeholder.
- A compromised daemon host yields the current token: the identity's full
  rights in the organization for up to an hour. That is wider than a GitHub
  installation token. The Console states this on the connect card, and §3.6's
  advice to grant only the projects agents need is the mitigation.

## 10. Non-Goals

- Azure DevOps Server (on-premises), TFVC repositories, and SSH remotes.
- Personal access tokens. They belong to a user, expire, and are increasingly
  restricted by organization policy, and the token would still be
  organization-wide.
- Workload identity federation in place of a client secret. It needs an issuer
  Entra can reach, and it can follow without changing anything downstream of
  §3.4.
- Checking a person's own Azure DevOps permissions before they bind a
  repository. That needs a delegated Azure DevOps token per person and a
  linked Microsoft identity, and it can follow the first version.
- More than one Azure DevOps organization per AgentConnect organization.
- Pipelines, Boards, Wiki, and Artifacts, and publishing a Marketplace
  extension.
- API writes, and per-agent identities.

## 11. Second Step: Hooks and Reviews

This step is out of scope here. Its constraints are recorded so the first
version does not preclude them:

- **Ingress.** Service-hook subscriptions do not sign their payload. The relay
  would verify a per-subscription secret carried as Basic credentials, ask for
  minimal resource details, and fetch the resource back under the binding's
  lease. Managing subscriptions needs the ServiceHooks edit permission on the
  project, which widens §3.6.
- **Reviews.** A reviewer votes (10 approved, 5 approved with suggestions, −5
  waiting for author, −10 rejected) and comments in threads. A pull-request
  status on the iteration can carry the run state, written by the Control
  Plane as Gitea's commit status is.
- **Code channels.** Pull-request links and views key on the surrogate
  identity plus the pull-request id.

## 12. Open Questions and Probes

1. **Probe:** a multi-tenant application's service principal, created in a
   customer tenant by consent, can be added to that tenant's Azure DevOps
   organization, and its client credentials token at the customer tenant's
   authority is accepted there.
2. **Probe:** with the administrator's delegated token, the Service Principal
   Entitlements API adds that service principal with Basic, the group
   membership calls add it to project groups, and the organizations the
   administrator belongs to can be listed. Which role each call needs.
3. **Probe:** git clone and push with the Entra token as the Basic password,
   through the proxy.
4. **Probe:** `az repos` and `az repos pr` reads with the placeholder in
   `AZURE_DEVOPS_EXT_PAT` and an empty `AZURE_CONFIG_DIR`. Also: which hosts
   the CLI contacts besides `dev.azure.com`.
5. Whether the repository list (names only) belongs in §6.2's allowlist, or
   only repositories the agent holds.
6. Whether the first version needs a pull-request tool. Without one, an agent
   pushes a branch and a person opens the pull request.
7. **Probe:** whether the identity's Contribute permission on a repository can
   be read cheaply at derivation, so that a `write` workspace on a repository
   the identity cannot push to is refused at save time instead of at the first
   push.
8. **Probe:** how `remoteUrl` encodes a space in a project or repository name.
9. Whether to offer a second, read-only identity per organization as defense
   in depth beneath the proxy, at the cost of a second licence.

## 13. Implementation Plan

Each step is one pull request, merged in order. The probes of §12 run against a
live organization before A2.

- **A0 — Push gate.** The proxy refuses `git-receive-pack` under a grant below
  `write` (§6.3).
- **A1 — Protocol.** The provider value with refusing hook entries,
  `azure-devops-v1`, the credential arm, the clone-URL forms, and the reserved
  secondary-root directory.
- **A2 — Control Plane.** The connect flow on the deployment application and
  the own-application path; the token cache; the identity table, bindings, and
  claims; the picker; derivation and grant arms; gitcred leases served only to
  the proxy plane; and the REST routes.
- **A3 — Daemon.** The credential module, the proxy instance and routes of
  §6.2, the client configuration of §6.4, the feature advertisement tied to the
  proxy, and the strategy refusal.
- **A4 — Console, Setup, and documentation.** The card, the pickers, the
  Microsoft section's redirect URI and wording, and the setup page on the
  documentation site.
