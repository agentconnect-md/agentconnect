# Azure DevOps Integration

> Status: **In progress** — A1 (protocol) has landed; A2 to A4 follow (§13).
> Scope: **Azure DevOps Services** (`dev.azure.com`),
> Git repositories in Azure Repos. The first version covers workspaces and
> additional repositories only; pull-request hooks, reviews, pull-request
> tools, and code-channel pull-request views are the second step (§11).
> Platform facts were read from Microsoft's documentation on 2026-11-06; each
> item marked **probe** in §12 must be confirmed against a live organization
> before the step that relies on it.

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
   and a push or an API write requires a `write` grant on the repository it
   names.
4. **A surrogate numeric identity.** Repository GUIDs map to a deployment-global
   numeric id, which is what every existing catalog, claim, grant, workspace,
   and wire field carries (§4).
5. **No webhooks in the first version.** A binding is a catalog row and an
   identity; it needs no administration rights on the Azure DevOps side and
   no provisioning saga.
6. **The Azure CLI works unmodified.** `az repos` and the other `azure-devops`
   extension commands reach the proxy with a placeholder. They read, and with a
   `write` grant they also open, update, and complete pull requests.

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
| Provider CLI          | none                                  | the Azure CLI `azure-devops` extension through the proxy, writes by tier    |
| API reads naming none | the workspace's credential            | `connectionData` and resource-area lookups only; everything else refused    |
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

The delegated Azure DevOps scope does not require administrator consent. A
member may consent for themselves when the tenant's user-consent policy permits
it, and the page describes the scope as full access to the Azure DevOps REST
APIs. A tenant can turn user consent off, or limit it to selected low-impact
permissions, even for a verified publisher. The connect flow therefore keeps an
Entra administrator-consent fallback: a refusal for missing consent tells the
person to ask an Entra administrator to grant it, since Azure DevOps rights
such as Project Collection Administrator do not override that policy. A guest
of the tenant cannot consent for itself at all, so an Azure DevOps
administrator who is a guest always needs that grant. An
application without a verified publisher is marked "unverified" there, and a
tenant may forbid consent to such applications. A multi-tenant deployment
application therefore needs Microsoft publisher verification before customers
connect through it.

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
   (`POST /orgs/:orgId/azure-devops/connect/callback`), or the error Microsoft
   returned instead. The Control Plane redeems the code with the deployment
   secret, asking for the Azure DevOps scope alone, since one token serves one
   resource, and takes the customer tenant from the ID token's `tid`. Missing
   consent (`consent_required`, `access_denied`, `AADSTS65001`, `AADSTS90094`)
   is refused with the message of §3.1, and with the tenant's admin-consent
   URL when the tenant is known. The administrator's delegated token lives
   only in an encrypted flow ticket, as in the Teams connect: AES-GCM under a
   key derived from the deployment's pepper, bound to the organization, the
   caller, and a flow id, and expiring thirty minutes after the sign-in or
   before the token does. The Console holds the ticket and sends it back as a
   request header on each later step, never in a path; the Control Plane
   stores no copy. Two Control Plane replicas therefore serve one flow alike.
3. **Organization.** The Control Plane lists the Azure DevOps organizations the
   administrator belongs to in that tenant (the profile and accounts APIs), and
   the administrator picks one. A guest signs in at their home tenant, so the
   Control Plane first reads the organization's own Entra tenant: an
   unauthenticated `GET dev.azure.com/{organization}/_apis/connectionData`
   answers a redirect with the tenant in `x-vss-resourcetenant`. When it
   differs from the signed-in tenant, the step is refused (`tenant_mismatch`)
   with a new authorize URL at that tenant's authority, so the person signs in
   again there as its member or guest; the connection then records that
   tenant. Without the header, the signed-in tenant stands. The Control Plane
   reads the organization's `instanceId` with the delegated token, refuses an
   organization another AgentConnect organization holds before writing
   anything there, and answers its projects.
4. **Entitlement.** The Control Plane takes a client credentials token at the
   customer tenant and reads the service principal's object id from its `oid`
   claim, which works before the service principal is in the organization.
   With that token it reads `connectionData`: a 200 means the service principal
   is already a member, so it is not added again, which also makes the step
   safe to repeat; `TF401444` or `TF400813` means it is not. A member found
   below Basic (Stakeholder or none) is raised to Basic with the entitlement
   `PATCH`, which answers like the add; Basic and every level above it are left
   alone. Otherwise, with the
   administrator's delegated token, the Control Plane
   adds the application's service principal to the organization with the Basic
   access level (`POST vsaex…/_apis/serviceprincipalentitlements`). It then
   adds the service principal to the project groups the administrator picks,
   one Graph membership each
   (`PUT vssps…/_apis/graph/memberships/{principal}/{group}`): Readers where
   agents only read, Contributors where any agent writes, never both. A group
   is found in the project's scope by its principal name (`[Project]\Readers`,
   `[Project]\Contributors`), not by its display name, which is localized. A
   membership that already exists counts as made. The entitlement
   call's own `projectEntitlements` is not used: for a service principal it
   reports success and grants nothing. The entitlement call answers 200 even
   when it refuses, so the Control Plane reads `isSuccess` and the result's
   access level, not the status code.

   Only a Project Collection Administrator can add the service principal with
   Basic. A Project Administrator asking for Basic is refused (`5032`, "Add
   Users"). Without an access level the same call succeeds at Stakeholder,
   which reaches no repository, so the Control Plane always asks for Basic and
   never omits it. A Project Administrator can still make the project-group
   memberships, and a Project Collection Administrator can raise the access
   level later (`PATCH …/serviceprincipalentitlements/{id}`). An administrator
   below Project Collection Administrator therefore gets a refusal that names
   the role, and a checklist for doing it by hand. The checklist names the
   application by its client ID as well as its name: a customer tenant keeps
   the display name the application had when it was first consented to, so a
   later rename does not reach the Azure DevOps member picker there.

   The memberships are still attempted after that refusal. With no subject
   descriptor yet, the first one adds the service principal to the
   organization through its group
   (`POST vssps…/_apis/graph/serviceprincipals?groupDescriptors=…`), which
   leaves it at the organization's default access level; the refusal reports
   which memberships were made and keeps the ticket. Once the checklist is
   done, `POST /orgs/:orgId/azure-devops/connect/:flow/verify` resumes: it
   re-reads `connectionData` as the application, raises a member below Basic
   when the caller may, makes the memberships the caller may, and runs steps 5
   and 6. A raise refused with `5032` answers with the same checklist. A
   membership the caller may not make does not stop it there, since a Project
   Collection Administrator may have made it by hand; the repository list of
   step 5 decides.

   A new connection must also prove that the caller administers the service
   principal in that organization, or any plain member could connect a
   service principal another deployment organization left behind and take
   its rights. The caller proves it by adding the service principal, or by
   making or confirming at least one of the chosen project memberships with
   their own delegated token (an existing membership answered as such
   counts). When the service principal is already a member and every
   membership is refused, the step answers `insufficient_rights`, names
   Project Administrator and Project Collection Administrator, and creates
   nothing. Manage project access acts on a connection the organization
   already holds and needs no such proof.

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
   `instanceId`, the identity id and display name, the credential source
   (`deployment` or `own`), the own application's client ID, and a credential
   epoch. An own application's secret is sealed in a side table. A
   `deployment` connection keeps no copy of the deployment secret, only its
   fingerprint: an HMAC under a key derived from the deployment's pepper for
   this purpose alone, which is how a rotation is recognized (§3.5). A
   connection is `connected`, or `degraded` with the reason of §3.5.

The Console offers one Azure DevOps connection per AgentConnect organization in
the first version. The model does not assume one: bindings, grants, and the
workspace credential name their connection, so several connections, each chosen
per agent, can follow without a migration (§10).

**Managing project access.** Which projects the identity reaches is set in
step 4 and can change later. The Control Plane keeps no administrator token, so
it cannot change the organization's groups by itself. The card therefore offers
**Manage project access**, which runs steps 1 to 4 again for the connection's
organization. The administrator signs in at the connection's tenant authority,
so a guest of that tenant signs in there too, picks projects and their groups,
and the Control Plane applies the change with the new delegated token and
discards it; a service principal found below Basic is raised to Basic, so a
Project Collection Administrator fixes a Stakeholder identity in one pass. It
then re-verifies the connection with the same identity and
organization required, and a degraded connection recovers. The flow adds
memberships; it removes none, so taking a project away or lowering
Contributors to Readers is done in Azure DevOps. A change made directly in
Azure DevOps works as well; the picker and the
permission evaluation of §5 read the identity's rights as they are.

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
it when less than twenty minutes of the `expires_in` it was issued with
remain; it never assumes a fixed lifetime, and a token issued for less than
forty minutes is kept for half of its life. Twenty minutes is the lease margin
below (five) plus the daemon's handout floor (it hands a cached grant out only
while more than ten minutes remain) plus five of slack, so every lease the
daemon receives can be handed out. Concurrent callers share one request
per connection, and a new credential epoch or a rejected answer drops the
cached token. A gitcred lease for an Azure DevOps repository carries that
token with a TTL of its remaining life less five minutes, at most an hour, so
a lease never outlives the token inside it. The lease names the identity id,
a GUID, as the Basic user; the display name is chosen in the customer's
tenant and may hold a colon. A request with `forceRefresh`, as the proxy sends
after a `401`, drops the connection's cached token first, at most once every
thirty seconds per connection. The daemon never sees a client secret.

### 3.5 Rotation and Failure

The deployment secret is rotated in Setup. The new value reaches every
connection whose source is `deployment` at once, as it reaches Teams' customer
rows: at boot, the Control Plane compares the configured secret's fingerprint
with the one each such connection recorded, and where they differ it records
the new one and increments the credential epoch, so daemon caches purge the
old tokens.
An own application's secret is replaced on its card; the replacement runs
§3.2's steps 5 and 6 and requires the same tenant, client ID, and identity id.

Entra does not tell an application when its own secret expires, so the product
learns of expiry from the refusal. An `invalid_client` answer moves every
binding of the affected connections to `runtime_degraded` with reason
`secret_rejected`. A service principal that is not in the organization moves
them to `runtime_degraded` with reason `access_revoked`, and the card offers to
connect again. Azure DevOps reports this two ways: `TF401444` for an identity
the organization has never seen, and `TF400813` for one that was removed. An
application with no service principal left in the tenant (Entra `700016`) is
read the same way. Any later success recovers them: a token proves the secret
again, and an Azure DevOps answer proves access again, so a lease for a
degraded connection first reads `connectionData`. A failed read is trusted for
a minute: leases on that connection are refused as retryable without any call
to Entra or Azure DevOps, and the next read follows the minute. A
connection-level verdict and its recovery leave a binding that is
`repository_unavailable` as it is; only the picker's read clears that. Any
other `401` is treated as a stale token and retried once with a fresh one.

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
Azure DevOps root, the organization name and the project and repository GUIDs
beside the numeric id, because the Azure CLI and REST paths address a
repository by GUID as often as by name (§6.2).

`repoFullName` is `{organization}/{project}/{repository}`. It is display and
matching text, and nothing is keyed on it. When the picker or a bind sees a
new path or clone URL for a bound GUID (a rename), the binding is refreshed and,
as on Gitea, the workspaces' clone URLs and the grants' `repoFullName` follow,
and the affected agents are projected again.
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
(`secret_rejected` or `access_revoked` from §3.5, or `repository_unavailable`
when the repository left the identity's list: deleted, disabled, in
maintenance, or no longer granted). The picker's read moves a binding to
`repository_unavailable` and back; a lease is refused while it lasts. Removing
a binding that a workspace or grant still references is refused with 409
naming the reference; otherwise removal is immediate, since there is no
webhook to clean up.

A binding belongs to one connection, and the workspace and grant rows name
that connection beside the numeric id; a composite foreign key from those rows
to the binding makes a referenced binding impossible to delete. The
deployment-global claim of §4 is held while any binding of the organization
names the repository, and released with the last one, an organization
deletion included.

Workspace derivation (git-workspace-model.md §6) gains two rows: an address in
the connected organization that the identity can see yields
`{ provider: 'azure-devops', repoId, connectionId }`; one it cannot see is
refused with "grant the application access to this repository". Project and
repository names match case-insensitively, and a project GUID stands for the
project name. A `write` request on a repository where the identity lacks
Contribute is refused the same way, read through one permission evaluation
(§12, item 7); a request that names no tier takes `write` where the identity
holds Contribute and `read` otherwise. Every other Azure DevOps address stays
anonymous, as any unmanaged host does, and a `write` request for one is
refused.

Clone addresses are normalized to `https://dev.azure.com/{organization}/{project}/_git/{repository}`.
The normalizer accepts:

- a user-info part equal to the organization name, which Azure DevOps puts in
  its clone URLs and which is not a credential;
- `https://dev.azure.com/{organization}/_git/{repository}`, the form Azure
  DevOps documents for a repository that has its project's name. The probe
  (§12) saw the four-segment form even then, so this form is accepted, never
  produced; and
- `https://{organization}.visualstudio.com/[DefaultCollection/]{project}/_git/{repository}`,
  and its three-segment form likewise.

An optional `.git` suffix or trailing slash is dropped. Segments are compared
after percent-decoding and re-encoded one way, so a space is always `%20`. The
label of every accepted form is `{organization}/{project}/{repository}`,
decoded, which is the binding's `repoFullName`. An address that matches none
of these forms is handled as on any other host.

SSH addresses are not managed: a service principal cannot register SSH keys.

## 6. Access Through the Credential Proxy

### 6.1 Proxy Only

The token carries the identity's full rights in the organization. Handed to an
environment, it would reach every repository the identity can see at the
identity's highest permission; no helper, wrapper, or label could take that
back. So the Control Plane serves an Azure DevOps grant only to the credential
proxy and to the daemon's own Git operations, and refuses the agent-facing
helper channel for it. This is a capability of the provider's credential module
(`proxyOnly`), which the Control Plane's mint path reads, not a provider-name
branch, as Gitea §13 requires of every provider difference. The gitcred request
says who will present the credential, `consumer: 'proxy' | 'daemon' | 'helper'`;
for a `proxyOnly` provider the Control Plane answers `proxy` and `daemon` only,
and refuses `helper` and an absent field with `SCOPE_DENIED`, so a daemon that
predates the field is refused rather than served. No purpose-gated lease
exists for Azure DevOps in the first version.

A daemon therefore advertises `azure-devops-v1` only while its credential proxy
is enabled, and placement requires it. A session on a strategy the proxy does
not reach yet is refused with `azure_devops_requires_proxy` rather than started
without credentials.

Two consequences follow from where the proxy stands today:

- The proxy reaches `srt` and host sessions. Sessions in a VM, in a pool pod,
  or placed on a remote executor are not covered yet. Until the pool-pod
  tunnel lands, the Cloud pool cannot place an agent with an Azure DevOps
  workspace or additional repository.
- The proxy always runs (github-app-git-credentials.md, Phase 2), so no switch
  gates Azure DevOps beyond the sessions the proxy reaches.

### 6.2 Instance and Routes

An Azure DevOps connection contributes one proxy instance with two hosts:
`dev.azure.com` with the path prefix `{organization}`, and
`{organization}.visualstudio.com` at the root. Requests are routed by method and
path:

- **git**: `[{project}/]_git/{repository}[.git]/` followed by `info/refs`,
  `git-upload-pack`, or `git-receive-pack`. The repository is resolved by name
  among the agent's authorized Azure DevOps repositories.
- **REST naming a repository**: `[{project}/]_apis/git/repositories/{id-or-name}/…`.
  The repository is resolved by GUID, with or without a project, or by project
  and name; Azure DevOps itself refuses a name without a project. The project
  segment may be a name or a GUID, since the links Azure DevOps returns name
  the project by GUID.
- **REST naming no repository**: only `_apis/connectionData` and the
  resource-area lookups the Azure CLI makes. Each is forwarded as a read.
- **One pull request by id**: `GET [{project}/]_apis/git/pullrequests/{id}`
  names no repository, but the Azure CLI resolves `--id` through it before
  every repository-scoped call, including `az repos pr update` and
  `az repos pr show`. The proxy makes this request itself with the
  connection's token and reads the answer's `repository.id`:
  - when that repository is one the agent holds, it returns the answer;
  - otherwise it returns the same 404 Azure DevOps gives for an id that does
    not exist.

  Walking ids therefore finds only the agent's own pull requests. Only `GET`
  is answered this way; a write by id with no repository is refused.

- **Everything else is refused.** That includes:
  - the project and repository lists, at organization and at project scope;
  - pull-request lists that name no repository, such as
    `{project}/_apis/git/pullrequests`, which `az repos pr list` calls when it
    names no repository. Every pull request names its repository, so a list
    would name other repositories;
  - other cross-repository queries, such as commit search; and
  - other Azure DevOps services and hosts, such as code search, which the
    proxy does not terminate. A placeholder sent there is refused by Azure
    DevOps.

  An agent learns its own repositories from its standing context, and commands
  that name a repository still work; listing commands such as `az repos list`
  fail instead. If agents turn out to need a list, the proxy can filter it
  down to the agent's repositories rather than forward it whole.

A repository outside the agent's authorizations is refused before the request
leaves the proxy. The answer is the same whether or not such a repository
exists, so the proxy is not an oracle for other repositories. What remains is
what an authorized repository's own answers mention, such as a fork's parent.

The provider contributes these rules to the proxy as its route descriptor, as
GitLab and Gitea contribute theirs; the shared router has no Azure DevOps
branch. The descriptor differs from the others in one place. The other
providers map a read that names no repository to the workspace's credential,
because their tokens are scoped by the provider. An Azure DevOps token is not,
so its descriptor maps such a read to `deny` unless it is on the allowlist
above, rather than borrowing the workspace's authority. The per-repository
lease from the Control Plane and the push gate of §6.3 are already shared by
every provider, so this descriptor is the only proxy code Azure DevOps adds.

### 6.3 The Tier

| Access    | git            | API                                 |
| --------- | -------------- | ----------------------------------- |
| `read`    | fetch          | reads of that repository            |
| `comment` | fetch          | reads of that repository            |
| `write`   | fetch and push | reads and writes of that repository |

A push is `git-receive-pack`, or `info/refs?service=git-receive-pack`. The proxy
refuses either unless the grant it obtained for that repository has access
`write`, naming the agent's actual access in the refusal. The check reads the
grant's access, not the provider, so it lives in the proxy's shared git route.

An API write follows the same rule as a push, as GitHub's REST writes do
([github-app-git-credentials.md](github-app-git-credentials.md#phase-2-the-daemon-credential-proxy)).
A write that names an authorized repository is forwarded under a `write`
grant and refused below it. A write that names no repository is refused. So
an agent with `write` opens, updates, and completes pull requests through the
Azure CLI or REST, and the first version adds no Azure DevOps tool:

- `az repos pr create` posts to its repository;
- `az repos pr update --id … --status completed` resolves the id through the
  lookup of §6.2, then writes to the repository it found. Such a pull
  request carries no AgentConnect footer. Completing a pull request is bounded
  by the organization's branch policies, such as required reviewers on the
  default branch, as merging is by branch protection on GitHub. Tools for pull
  requests and reviews come with the second step (§11).

### 6.4 Client Configuration

git uses the session credential helper and the proxy like every other provider;
the proxy presents the token as the Basic password with the identity id as the
user (§3.4). The Azure CLI receives:

- `AZURE_DEVOPS_EXT_PAT`, set to the placeholder; the CLI sends it as a Basic
  password, which the proxy already reads;
- `AZURE_CONFIG_DIR`, set to an empty per-session directory, because the CLI
  prefers a cached sign-in over `AZURE_DEVOPS_EXT_PAT`;
- `AZURE_EXTENSION_DIR`, set to the host's installed extension directory and
  readable from the sandbox. Without it, an empty configuration directory hides
  the installed `azure-devops` extension, and the CLI installs it again from
  Microsoft's download hosts on every session's first command;
- `AZURE_CORE_COLLECT_TELEMETRY=false`; and
- the proxy and trust variables of the credential proxy design, including
  `REQUESTS_CA_BUNDLE`.

With these, the commands that name a repository reach only `dev.azure.com`,
and the CLI writes no credential into the session directory.
The CLI only accepts `dev.azure.com` and `*.visualstudio.com` as organization
hosts, which the proxy preserves, since it terminates TLS for those names
rather than rewriting them. Its organization and project detection reads the
four-segment canonical remote of §5. AgentConnect does not install the CLI or
its extension.

### 6.5 Rate Limits

Azure DevOps limits each identity, not each token, so every agent of the
organization and the Control Plane share one budget. The proxy forwards `429`
and `Retry-After` untouched, so the client's own backoff applies. The Control
Plane's picker and refresh honor `Retry-After` and `X-RateLimit-Remaining`.

## 7. Protocol and Compatibility

- `CODE_HOST_PROVIDERS` gains `azure-devops`. Every provider-keyed hook table
  gets an entry that refuses, as Gitea's G1 did before its hooks existed; the
  second step replaces them. The database's hook-kind enum gains no value: no
  hook body admits the kind, and a query for it matches nothing.
- Feature string `azure-devops-v1` on the daemon gates placement and spec
  projection, with fail-closed-by-omission semantics (§6.1).
- `AgentWorkspaceCredential` gains
  `{ provider: 'azure-devops', repoId, connectionId }`: the numeric identity of
  §4, and the connection whose identity serves it (§3.2). The routing of §4
  rides beside them as `azureDevOps: { organization, projectId, repositoryId }`,
  required on the credential and optional on an additional-repository entry, so
  an older peer still decodes the list. There is no host field, since the host
  is fixed.
- gitcred grants echo the provider, numeric id, path, access, and credential
  epoch, which the daemon verifies as it does for the other providers.
- The protocol's clone-URL normalizer and label learn the forms of §5.

## 8. Console and REST

The Integrations page gains an Azure DevOps card. The card offers:

- **Connect with Microsoft**, and **Use your own application instead**;
- **Manage project access** (§3.2), for a connection made with Microsoft;
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
  `POST /azure-devops/connect/:flow/projects`, for steps 3 and 4, and
  `POST /azure-devops/connect/:flow/verify` to resume after the manual
  checklist. Each carries the flow ticket in the
  `x-azure-devops-flow-ticket` header. A `connectionId` on
  `POST /azure-devops/connect` starts **Manage project access** for that
  connection, whose organization is fixed;
- `POST /azure-devops/connections` for an own application (one per
  organization, `connection_exists` otherwise),
  `GET /azure-devops/connections`, and `DELETE /azure-devops/connections/:id`,
  which removes the connection and its bindings at once and answers 409 while
  a workspace or grant still uses one of them;
- `POST /azure-devops/connections/:id/secret`, for an own application only;
- `GET /azure-devops/connections/:id/repositories` for the picker, each row
  keyed by GUID and carrying its binding when bound;
- `GET /azure-devops/repositories`, the bound repositories and their states;
  and
- `DELETE /azure-devops/repositories/:id`, which answers 409 when a workspace or
  grant still references the repository.

The workspace and additional-repository routes bind on first use, as for Gitea.
An additional-repository grant names the repository by GUID and the connection
that sees it, `{ provider: 'azure-devops', connectionId, repositoryId }`; a
`write` grant, and raising one to `write`, require Contribute. The connect,
connection-write, and secret routes manage a credential and are
`interactiveOnly`; the reads are not.

## 9. Security

- Client secrets are sealed at rest and never leave the Control Plane. An own
  application's secret is sealed under its organization; the deployment
  secret is not copied under any organization, and a `deployment` connection
  keeps only its keyed fingerprint (§3.2 step 6).
- A new connection to a service principal already in an Azure DevOps
  organization needs the caller to prove they administer it there (§3.2
  step 4), so a plain member cannot take over the rights it holds.
- Tokens exist in the Control Plane's cache, in leases over the authenticated
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
  is deny-by-default, and a push or an API write needs `write` on the
  repository it names. A client that bypasses the proxy holds only a
  placeholder.
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
- Azure DevOps tools for pull requests and reviews, which come with the second
  step (§11).
- Several connections per AgentConnect organization, each agent choosing one.
  This is how an agent gets an identity of its own: the customer registers an
  application whose service principal reaches only that agent's repositories,
  so Azure DevOps itself bounds it. The model already keys everything by
  connection (§3.2). Only the Console's choice is missing.
- Finer control in the proxy than §6.2 describes, such as filtering a list down
  to the agent's repositories instead of refusing it.
- A second, read-only identity per organization beneath the proxy.
  - It would keep a read grant from pushing even if the proxy misrouted one.
  - It costs a second application registration, a second consent, a second
    entitlement, and a second licence.
  - It does not narrow reads, and it does not help once the daemon host is
    compromised, since both tokens are there.
  - With the token never in the environment and one push gate in the proxy,
    the first version relies on the proxy. A customer whose review requires
    a provider-side bound can have it added as an option.

## 11. Second Step: Hooks, Reviews, and Tools

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
- **Pull-request tools.** An Azure DevOps pull-request tool beside the GitHub,
  GitLab, and Gitea ones. It adds the footer, and in a hook turn the guidance
  points the agent to it rather than to the CLI.
- **Code channels.** Pull-request links and views key on the surrogate
  identity plus the pull-request id.

## 12. Open Questions and Probes

Results of 2026-11-07 are against two test organizations: one in the
application's home tenant, and one in a second tenant where the application is
known only through consent.

1. **Verified in both tenants:** an application's service principal added to
   an Azure DevOps organization is accepted with a client credentials token at
   that organization's tenant. Before the entitlement, `connectionData` answers
   401 `TF401444` naming the service principal of that tenant; after it, 200,
   and the repository list returns only projects the identity was granted. In
   the consenting tenant, the whole of §3.2 ran as written:
   - the sign-in at that tenant;
   - project creation, the entitlement, and the Contributors membership with
     the delegated token;
   - then, as the application, the permission check, a clone, and a push.

   The service principal there carried the display name from its first
   consent, not the application's current one (§3.2, step 4).

2. **Verified, through §3.2's sign-in:** the deployment application's
   authorization-code flow with PKCE at the `organizations` authority returns a
   delegated token with `scp=user_impersonation`, and the ID token carries the
   tenant. With that token, the profile and accounts APIs list the
   administrator's organizations. The Service Principal Entitlements API adds
   and removes the service principal with Basic (200, 204). A Graph membership
   adds it to a project group (201), and its rights follow at once. The
   entitlement call's `projectEntitlements` reported success but added no
   membership. A tenant's security defaults refuse a device-code sign-in.

   The same calls were repeated as a guest of the tenant holding only Project
   Administrator on one project, with the organization's default policy that
   lets project administrators invite users. The guest's sign-in was refused
   until an Entra administrator granted tenant-wide consent. Then:
   - adding the service principal with Basic answered 200 with `isSuccess`
     false, error `5032`;
   - adding it without an access level succeeded at Stakeholder, and the
     application then listed no repository and could not clone;
   - the Graph membership succeeded (201);
   - after the owner raised the access level to Basic through the entitlement
     `PATCH`, the application listed and cloned the repository at once.

3. **Verified:** git over HTTPS takes the Entra token as the Basic password. A
   Reader identity clones; its push is refused at the `git-receive-pack`
   advertisement with 403 `TF401027` (GenericContribute). A Contributor
   pushes. Still to run through the proxy in A3.
4. **Verified without the proxy:** Azure CLI 2.92 with `azure-devops` 1.0.10
   took an Entra token in `AZURE_DEVOPS_EXT_PAT` under an empty
   `AZURE_CONFIG_DIR`. The repository list, pull-request list, and project
   list commands, and organization and project detection from the
   four-segment remote, all succeeded. These reached only `dev.azure.com`,
   and no session file held the token. An empty configuration directory
   without `AZURE_EXTENSION_DIR` reinstalled the extension from `aka.ms`, Azure
   blob storage, and `github.com` (§6.4). Still to run with the placeholder
   through the proxy in A3.
5. **Decided:** project and repository lists, at either scope, and
   pull-request lists that name no repository are refused. A single pull
   request by id is answered only when it belongs to one of the agent's
   repositories (§6.2). A filtered list is the follow-up if agents need one.
6. **Decided:** no Azure DevOps tool in the first version. An agent with
   `write` opens and completes pull requests through the CLI or REST (§6.3);
   the tools come with the second step (§11).
7. **Verified:** derivation can read the identity's own rights in one call.
   `POST _apis/security/permissionevaluationbatch` as the identity, Git
   Repositories namespace, token `repoV2/{project GUID}/{repository GUID}`,
   answers GenericRead (bit 2) and GenericContribute (bit 4) and follows a
   group change at once. So a `write` workspace on a repository the identity
   cannot push to can be refused at save time.
8. **Verified:** `remoteUrl` percent-encodes a space (`%20`) in both the project
   and the repository segment, carries the organization as user-info, and
   keeps the four-segment form when the repository has its project's name.
9. **Decided:** no second, read-only identity in the first version (§10).

## 13. Implementation Plan

Each step is one pull request, merged in order. The probes of §12 run against a
live organization before A2.

- **A0 — Push gate.** The proxy refuses `git-receive-pack` under a grant below
  `write` (§6.3). This is #3767; it is not scheduled again here.
- **A1 — Protocol.** _Landed (#3781)._ The provider value with refusing hook entries,
  `azure-devops-v1`, the credential arm, the clone-URL forms, and the reserved
  secondary-root directory.
- **A2 — Control Plane.** The connect flow on the deployment application and
  the own-application path, and Manage project access; the token cache; the
  identity table and claims, with bindings and grants keyed by connection; the
  picker; derivation and grant arms; gitcred leases served only to the proxy
  plane; and the REST routes.
- **A3 — Daemon.** The credential module with its `proxyOnly` capability, the
  proxy instance and route descriptor of §6.2, the client configuration of
  §6.4, the feature advertisement tied to the proxy, the gitcred `consumer`
  field of §6.1 on every request, and the strategy refusal. Tests pin each refusal of §6.2: the lists, the pull-request lists that name
  no repository, and a repository outside the agent's authorizations. They
  also pin the pull-request lookup by id: it answers for the agent's own
  repository, and answers another repository's pull request exactly as it
  answers a missing id.
  They also pin §6.3: a write below `write` is refused, and a pull-request
  write at `write` is forwarded.
- **A4 — Console, Setup, and documentation.** The card, the pickers, the
  Microsoft section's redirect URI and wording, and the setup page on the
  documentation site.
