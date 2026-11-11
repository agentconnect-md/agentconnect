# Azure DevOps Integration

> Status: **In progress** — A1 (protocol), A2 (Control Plane), A3 (daemon), A4's Console and Setup, and A5 (pull-request tools) have landed; the second step, hooks and reviews (§11), is designed and follows as B1–B5 (§13), and the documentation-site setup page comes last.
> Scope: **Azure DevOps Services** (`dev.azure.com`),
> Git repositories in Azure Repos. The first version covers workspaces and
> additional repositories, and the pull-request tools of §6.6 followed it;
> pull-request and push hooks, reviews, the run projection, and code-channel
> pull-request views are the second step (§11).
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
   credential proxy and the daemon's own Git. It never reaches an agent
   environment, the agent-facing helper channel, or a CLI wrapper. The `host`
   strategy still does not stop a process of the same user (§6.1).
3. **The tier is enforced in the proxy.** Requests are routed deny-by-default,
   and a push or an API write requires a `write` grant on the repository it
   names.
4. **A surrogate numeric identity.** Repository GUIDs map to a deployment-global
   numeric id, which is what every existing catalog, claim, grant, workspace,
   and wire field carries (§4).
5. **No webhooks in the first version.** A binding is a catalog row and an
   identity; it needs no administration rights on the Azure DevOps side and
   no provisioning saga. The second step adds service hook subscriptions,
   which need one extra grant per project (§11.1).
6. **The Azure CLI works unmodified.** `az repos` and the other `azure-devops`
   extension commands reach the proxy with a placeholder. They read, and with a
   `write` grant they also open, update, and complete pull requests.

## 2. What Differs From Gitea

| Capability            | Gitea                                 | Azure DevOps                                                                  |
| --------------------- | ------------------------------------- | ----------------------------------------------------------------------------- |
| Instance axis         | one instance per deployment, base URL | fixed host; one Azure DevOps organization per connection                      |
| Identity              | a bot user's personal access token    | the deployment application's service principal in the customer tenant         |
| Connecting            | paste the token                       | an administrator's Microsoft sign-in                                          |
| Token lifetime        | no expiry; manual replacement         | about an hour; the Control Plane refreshes it                                 |
| Secret replacement    | replace token                         | Setup rotates the deployment secret; an own application replaces its own      |
| Repository identity   | numeric id, `owner/repo`              | GUID inside a project GUID; `organization/project/repository`; surrogate id   |
| Rights on the repo    | `admin` on every bound repository     | read on every bound repository; Contribute where any agent writes             |
| Where a tier is held  | a label on one token                  | the proxy; the token is organization-wide                                     |
| Agent token delivery  | helper or proxy                       | proxy only                                                                    |
| Provider CLI          | none                                  | the Azure CLI `azure-devops` extension through the proxy, writes by tier      |
| API reads naming none | the workspace's credential            | the Azure CLI's discovery reads only; everything else refused                 |
| Webhooks              | managed per repository, HMAC-signed   | second step: subscriptions per repository and kind, Basic-authenticated (§11) |
| Rate limiting         | instance-defined                      | per identity, shared by every agent of the organization (§6.5)                |

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
organization required, and a degraded connection recovers.

The project list opens on what the identity already holds, read with the
administrator's token: its direct groups from
`GET vssps…/_apis/graph/memberships/{subject}?direction=up`, each group's
project from its `domain`, and Allow triggers from one
`GET _apis/accesscontrollists/{ServiceHooks}?token=PublisherSecurity&recurse=true&descriptors={identity}`
(**verified**). A newly checked project starts at Contributors with Allow
triggers. Apply makes Azure DevOps match the page: a project left unchecked
loses its group (`DELETE …/graph/memberships/{subject}/{group}`), a lowered
group loses the higher one once the new one is made, and Allow triggers turned
off deletes the entry (`DELETE _apis/accesscontrolentries/{namespace}?token=…&descriptors=…`).
A removal the caller may not make is listed in the checklist. The flow ticket
keeps the access the page showed, and Apply removes only from that: access
granted since, or a state that could not be read when the page opened, is
never taken away. The Console labels
the groups **Read** and **Write**. A change made directly in Azure DevOps
works as well; the picker and the permission evaluation of §5 read the
identity's rights as they are.

**All projects.** Project groups exist per project, so a project created
later is not reached until someone picks it. A row above the projects grants
every project, present and future, at the namespace roots every project
inherits from, with three entries for the identity (**verified** on a project
created after the grant, in which it holds no group):

| Entry            | Namespace and token               | Allow                                   |
| ---------------- | --------------------------------- | --------------------------------------- |
| See the projects | Project `52d39943-…`, `$PROJECT`  | GENERIC_READ (1)                        |
| Read or Write    | Git Repositories, `repoV2`        | read (2), or Contributors' bits (16502) |
| Allow triggers   | ServiceHooks, `PublisherSecurity` | View and Edit subscriptions (3)         |

The first is required: without it a project and its repositories stay
invisible to the identity even though the Git permission evaluates as granted.
The Git entry is written with `merge: false`, so lowering Write to Read drops
the write bits. Only a Project Collection Administrator may write these; a
refusal joins the checklist, and a granted row is proof of administration for
a new connection as a membership is. The row opens on the entries the
identity holds, read the same way, and is removed by the same `shown…` rule as
a project: unchecking it deletes the Git and Project entries, and turning off
its Allow triggers deletes the ServiceHooks entry. The deletes follow the
ticket rather than a fresh read and run with the Project entry last, since it
is what makes the others readable: a removal cut short is finished by a retry.
While it is on, the per-project rows are hidden and their access left as it is.

**Use your own application instead** stays one click away, and is the only
path when the deployment has no Microsoft application. The administrator enters
the organization, the tenant ID, the client ID, and a client secret of an
application registered in the customer's tenant. That application's service
principal is added to the organization and its project groups by hand; steps 5
and 6 run unchanged; and the secret is sealed behind the connection's
secret-store port. Entering the deployment application's own client ID here is
refused.

### 3.3 People

Agents act as the application. A person selecting a managed repository needs
both the agent's edit rights and the corresponding access in Azure DevOps.
The check uses the Microsoft account already linked in Profile and the
connection's application token. A direct identity match needs no additional
authorization, including when the Azure organization is connected later.

This is a prerequisite even for a self-hosted deployment: console sign-in must
be configured through Logto with Microsoft account linking (`azuread`) enabled.
The loopback no-auth stack, a deployment without that connector, and a person
without its linked identity cannot select or grant a managed Azure repository.
Agent edit rights alone never replace this check. Connecting or maintaining the
organization's application remains available under the existing management
rules; its credentials do not prove the administrator's personal repository access.

The linked Entra object ID must match one active human identity in the
connection's tenant. Email locates candidates but never establishes identity.
A guest can have different home-tenant and resource-tenant object IDs. When the
linked object does not match directly, the picker offers **Verify Microsoft
access**. This is a separate authorization-code flow against the connection's
fixed Entra tenant, using the deployment Microsoft application and its existing
`/azure-devops/connect` redirect URI. It requests only `openid profile
offline_access User.Read`, not delegated Azure DevOps repository permissions.
The person proves control of the tenant account; its identity supplements the
current Microsoft link without modifying any Logto sign-in method.

The state is single-use, expires after ten minutes, and binds the caller,
organization, connection, tenant, client and current linked object ID. PKCE and
an ID-token nonce bind the code exchange. The CP validates the token signature,
issuer, audience, lifetime and tenant, and requires Graph `/me` to agree with its
object ID. Email locates Azure candidates but never proves their identity.
Only the verified object ID is used for entitlement and effective ACL checks.

`azure_devops_user_identity` stores the caller, linked object ID, target tenant,
verified object ID, application ID and refresh token. The refresh token and
pending PKCE verifier pass through `SecretCipher` under deployment scope because
the verification belongs to a person across organizations. Tokens never reach
the browser, daemon, logs or Logto. On each fallback authorization the CP checks
the current Microsoft link, refreshes the tenant token, checks the same tenant
and object again, then reads current Azure permissions with the application.
This works while the person is offline and after a CP restart. Refresh-token
replacement uses a conditional write; a late refresh cannot recreate a deleted
verification. Social unlinking serializes with verification, clears both stored
verifications and pending callbacks, and prevents them from restoring the link.

Official Logto's existing identity API is sufficient. Setup keeps the native
Microsoft connector and does not require token storage or a custom Management
API. Existing directly matched users need no migration; guests verify once in
the picker after the upgrade. Consent withdrawal, expired refresh tokens and
conditional access prompt verification again and block new repository authority.
Provider failures remain retryable errors, not persisted access-loss verdicts.
A deployment without the Microsoft application can still use directly matched
identities; supplementary tenant verification requires that application.

The application reads the person's repository and project ACLs with their
descriptor and `includeExtendedInfo=true`. Azure's `effectiveAllow` and
`effectiveDeny` resolve group membership and inheritance; the service does not
reconstruct permission inheritance or require access to organization-root ACLs.
The target repository needs Read and the target project needs View project-level
information for these queries. Basic user-entitlement search, without extended
selection, supplies account status and license information; full user-detail
administration rights are unnecessary.

Repository access requires project visibility, effective Git Read, and an
eligible access level. Write additionally requires effective Contribute.
Basic and recognized subscription tiers are accepted; Stakeholder reaches
repositories only in a project Azure reports as public. Disabled, removed and
expired entitlements grant nothing. An assigned `msdn/eligible` category alone
does not prove a recognized subscription. Pending invitations still require an
active identity, a supported license, and effective permissions.

The repository picker applies this check. Workspace creation/replacement and
additional-grant creation/increases fetch fresh evidence before granting
authority; a picker result is never reused to authorize a save. An unreadable
or ambiguous identity grants nothing, and a provider outage remains retryable.
Every workspace or additional-repository lease repeats the check against the
stored authorizer and full authorized tier before applying a requested read
clamp. Workspace saves record `workspaceAttestedByUserId`; additional grants
record `attestedByUserId`, replaced by the caller on a tier increase. After the
external check, the lease verifies that the workspace or grant still names the
same authorizer, repository, connection and tier. A replacement grant's row ID
cannot reuse the old check.

Confirmed access loss or identity unlinking returns `LEASE_DENIED`, evicting the
daemon's cached lease while allowing later retries. Provider failures prevent
new leases but are retryable and do not mark access lost. A previously issued
lease can remain usable until its expiry, at most one hour; copied data cannot
be recalled. The enabled hook's daemon-only reply authority remains separate.

Additional grants use the shared repository re-attestation loop, independently
of GitHub configuration, with the existing `REPO_GRANT_REATTEST_*` cadence and
batch limits. A stale grant leaves the spec, which clears cached credentials;
a later successful sweep restores it. Increasing its tier records the caller
and restores a stale grant, or a member can revoke and authorize it again.
Lease checks are read-only and do not race the sweep's persisted verdicts.

Legacy workspaces have no reliable authorizer: the agent creator or last editor
cannot establish who authorized the current repository. Their nullable field
is left empty, and new leases are refused until a permitted member saves the
workspace through its existing editor. Saving the same repository and tier can
record a new authorizer without replacing the checkout. This adds no personal
OAuth flow or access-sync prerequisite.

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
  Contribute and Create branch where any agent writes;
- it needs no administrator role; and
- for hooks, it holds View and Edit subscriptions on each project where an
  agent has one (§11.1).

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
across the whole organization, drops disabled repositories and those in
maintenance, filters to repositories the caller can read (§3.3), and keys rows
by GUID. Its merge only enriches authorized rows with binding metadata; a bound
row cannot restore a repository the human access check excluded. The management
catalog remains a database-only list of existing bindings and their health, so
administrators can diagnose degraded connections without personal repository
access or a working Azure API. That metadata never authorizes a new grant.

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
naming the reference; otherwise removal is immediate, and in the second step
it also deletes the binding's subscriptions (§11.2).

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
(§12, item 7). The acting person must independently have the requested access
(§3.3); a request that names no tier takes `write` only where both the person
and application hold Contribute, and `read` otherwise. Every other Azure DevOps
address stays anonymous, as any unmanaged host does, and a `write` request for
one is refused.

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

The Azure-first delivery of [Unified managed Git network operations](github-app-git-credentials.md#unified-managed-git-network-operations)
uses one managed-operation preparation path in local SRT and VMs, Cloud pods,
and remote executor host/SRT/VM environments, including mixed-provider agents.

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

The daemon's credential module carries the same `proxyOnly` capability. Its
agent channel refuses such a credential to every capability but the daemon's
own, by the provider the agent's spec resolves the ask to, before the runtime
capability's general mint refusal. Git on the owning daemon's own machine names
`consumer: 'daemon'` and the proxy names `proxy`. The daemon's credential cache
refuses an Azure DevOps ask that names neither, without asking the Control Plane, since a grant it
already holds would otherwise answer it. A request for any other provider names
no consumer, as before. The trusted-host `daemon` consumer remains a supported
contract: host-side canonical clones and local host-strategy preparation retain
their existing helper path.

The real token is therefore presented only by the proxy and by the daemon's own
Git on the daemon's machine, outside every sandbox. Where the daemon runs Git
inside a sandbox, that Git must not hold the token either:

- The agent channel serves a proxy-only credential to no connection a shim's
  tunnel carries, whatever capability it presents, so daemon Git inside a
  confined `srt` session, a VM, a pool pod or an executor's environment is
  never handed the token.
- In each execution environment, daemon-authored Azure workspace Git uses
  the existing credential proxy and `codehost` tunnel. SRT uses its intercepted
  domains; the other environments use their shim's authenticated loopback
  listener. The helper returns only the placeholder, and TLS verifies against
  the current environment's trust bundle.
- Selection follows the operation's trusted target URL and provider capability,
  not the agent's primary repository. A migrated invocation removes all real
  credential helpers and the daemon minting capability. Every managed target
  of that invocation must be covered by the route before Git starts.
- Non-Azure daemon Git retains its existing helper path in this delivery.
  Scoped source acquisition and the in-pod auto-merge watcher also retain
  their existing credential contracts. Their remaining capabilities mean a
  mixed environment is not entirely free of token-minting authority.

The proxy already carries agent runtime Git. Workspace preparation now binds
the execution environment and waits for its route before the first clone or
fetch, independently of whether an ACP runtime has started. Each Git request
reads the current binding's listener and trust; a missing or stale route fails
without a real-token fallback. Cancellation releases the preparation hold,
unused environments retain their idle cleanup policy, and retirement or a new
binding fences the previous one. Ambiguous mutations are not replayed.

Azure's start is refused with `azure_devops_requires_proxy: …`, naming the
reason, when:

- the daemon's credential proxy did not start;
- the agent holds no managed code-host credential, or the proxy serves none of
  its Azure DevOps repositories.

The selected execution environment must additionally provide its usable route
before a managed Git operation or a credentialed runtime launches. Its actual
listener, trust bundle and SRT domain coverage decide readiness; Cloud, VM and
remote placement are not blanket refusals.

The refusal fails the turn as any other start failure does, and the agent is
never started without credentials. A dream or a research host, which carries
no code-host credential, is not refused.

The `host` strategy keeps the token out of the agent's environment but confines
nothing: a process of the same user can still recover the daemon's capability
and ask for the token, as the
[trust model](github-app-git-credentials.md#trust-model) says of every code
host. Because this token is organization-wide, that costs more here than on a
repository-scoped host.

A daemon, including a pool member, advertises `azure-devops-v1` and
`azure-devops-hooks-v1` while its credential proxy runs. Placement requires
the advertised capability; preparation still checks the particular environment.

### 6.2 Instance and Routes

Each Azure DevOps organization the agent's repositories name in their spec
routing contributes two proxy instances: `dev.azure.com` with the path prefix
`{organization}`, and `{organization}.visualstudio.com` at the root, optionally
under `DefaultCollection`. Both are SaaS names, so neither may resolve into
private space. The placeholder is sealed for both and `srt` routes both to the
proxy. The session helper is pinned for `dev.azure.com`, and for each
organization's own host, whenever the workspace or an additional repository is
on Azure DevOps, as a GitLab or Gitea repository pins its instance. A request's
organization is the first path segment on `dev.azure.com`, or the host's own
name; it must be the organization of one of the agent's repositories, compared
case-insensitively, and any other is refused.

Requests are routed by method and path. The lease the proxy obtains must be for
the repository Azure DevOps then acts on, so it resolves names by Azure DevOps's
own rules (§12, probe 3) and never more loosely:

- every segment, `DefaultCollection`, `_git` and `_apis` included, is read
  after percent-decoding;
- names match case-insensitively only where both lower-casing and
  upper-casing agree, so an all-uppercase spelling matches while a character
  such as the Kelvin sign never matches the ASCII letter it lower-cases to;
- a `.git` suffix is part of the name, since Azure DevOps answers
  `_git/{repository}.git` with `TF401019` rather than stripping it; and
- a GUID-shaped project or repository segment is an id and never a name.

A path with a segment that does not decode to one plain name, such as an
encoded separator, a dot segment, or an empty segment, is refused. A request
carrying `X-HTTP-Method-Override`, `X-HTTP-Method` or `X-Method-Override`, with
any value, is refused with 400, because Azure DevOps would run that method
rather than the one the request was routed by.

- **git**: `[{project}/]_git/{repository}/` followed by `info/refs`,
  `git-upload-pack`, or `git-receive-pack`, spelled as git sends them, so no
  other spelling of a push reads as a fetch. The repository is resolved among
  the agent's authorized Azure DevOps repositories by name, or by GUID below a
  project; without a project it is the repository in the project of the same
  name, and a GUID without a project is refused, as Azure DevOps refuses it
  (`TF200016`). A `GET` or `HEAD` of `{repository}/vsts/info`, which the Azure
  CLI reads to resolve a Git remote into its organization, project and
  repository, is forwarded as a REST read under that repository's read lease;
  any other path below the repository is refused.
- **REST naming a repository**: `[{project}/]_apis/git/repositories/{id-or-name}/…`.
  The repository is resolved by GUID, with or without a project, or by project
  and name; Azure DevOps itself refuses a name without a project. The project
  segment may be a name or a GUID, since the links Azure DevOps returns name
  the project by GUID. Below the repository, a read is forwarded as it is, a
  write only as §6.3 allows, and a query whose repository criterion
  (`searchCriteria.repositoryId`, `searchCriteria.sourceRepositoryId`, or any
  other parameter ending in `repositoryId`, however cased or bracketed) names
  another repository is refused.
- **One pull request below a held repository**:
  `[{project}/]_apis/git/repositories/{repository}/pullrequests/{id}[/…]`, any
  method. Before forwarding, the proxy looks the pull request up by id as below
  and forwards only when its `repository.id` is the repository the path names,
  so a held repository's path never reaches another repository's pull request.
  Any other pull request, including one of another held repository, gets the
  `TF401180` answer for a missing id.
- **REST naming no repository**: only what the Azure CLI reads before any
  command, at the organization's root: `_apis/connectionData`,
  `_apis/ResourceAreas[/{area}]`, one level deep, and an `OPTIONS` of `_apis`
  itself, which lists the API's resource locations. Each is forwarded as a read
  under a read lease of one of the agent's repositories in that organization:
  the token is the same for all of them, and no answer is about a repository.
- **One pull request by id**: `GET [{project}/]_apis/git/pullrequests/{id}`
  names no repository, but the Azure CLI resolves `--id` through it before
  every repository-scoped call, including `az repos pr update` and
  `az repos pr show`. The proxy makes this request itself, with a read lease
  of one of the agent's repositories and over the route its forwarded requests
  take, and reads the answer's `repository.id`:
  - when that repository is one the agent holds, the request itself is
    forwarded under that repository's read lease, so it reaches Azure DevOps
    twice;
  - otherwise, and for an id that does not exist, the proxy answers the
    `TF401180` 404 below itself, so the two answers are the same.

  Walking ids therefore finds only the agent's own pull requests. Only `GET`
  is answered this way; a write by id with no repository is refused. The
  lookup sends its own path with `api-version=7.1` alone and
  `accept: application/json`, never the client's query or `Accept`, so nothing
  the client sends shapes its answer. A `401` to it drops its lease and retries
  once, and a `429` is refused naming Azure DevOps's `Retry-After`. Every other
  4xx, an answer that does not parse, and one over the proxy's 1 MiB limit are
  answered like a missing id; any other answer is refused with 502. A lease the
  lookup cannot obtain is refused with a reason that names no repository.

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

That answer is Azure DevOps's own for a repository it does not show: 404 and
`TF401019: The Git repository with name or identifier {identifier} does not
exist or you do not have permissions for the operation you are attempting.`,
as plain text for git and in Azure DevOps's JSON error shape for REST, naming
the identifier the client sent. Another repository's pull request gets Azure
DevOps's `TF401180` answer for a missing id. The proxy writes these through its
refusal path, so they carry its plain-text content type and marker header: a
client can tell the proxy answered, but nothing in the answer depends on
whether the repository or the pull request exists. Refusals that are not about
existence (lists, writes below the tier, another organization) are the proxy's
ordinary 403 with a short reason.

Each of GitLab, Gitea and Azure DevOps registers a route descriptor with the
proxy: the hosts it serves a managed host on, whether its credential always
goes as Basic, the headers whose presence refuses a request (Azure DevOps's
method overrides), and the route of one request. The router dispatches by
provider and has no provider branch; GitHub keeps its own route, which reads
GraphQL bodies. The Azure DevOps descriptor differs from the others in two
places. It reads the agent's authorized repositories from its spec, the
workspace's and the additional ones with their GUIDs, and resolves every request
among them.
And where GitHub and GitLab map a read that names no repository to the
workspace's credential, because their tokens are scoped by the provider, the
Azure DevOps descriptor maps such a read to `deny` unless it is on the
allowlist above, rather than borrowing the workspace's authority. Gitea's
descriptor does the same for its bot token
([Gitea §9](gitea-integration.md#9-git-access)). Beside it
the proxy gained three provider-neutral members that Azure DevOps is the first
to use: a write gate beside the push gate (§6.3), a lookup route the proxy
answers by asking the upstream itself, on the target the descriptor names and
with the access the forwarded request needs, and a lease of its own for a
proxy-only provider.

### 6.3 The Tier

| Access    | git            | API                                                                                      |
| --------- | -------------- | ---------------------------------------------------------------------------------------- |
| `read`    | fetch          | reads of that repository                                                                 |
| `comment` | fetch          | reads of that repository                                                                 |
| `write`   | fetch and push | reads, and writes to its pull requests, pushes, refs, commit statuses and annotated tags |

A push is `git-receive-pack`, or `info/refs?service=git-receive-pack`. The proxy
refuses either unless the grant it obtained for that repository has access
`write`, naming the agent's actual access in the refusal. The check reads the
grant's access, not the provider, so it lives in the proxy's shared git route.

An API write follows the same rule as a push, as GitHub's REST writes do
([github-app-git-credentials.md](github-app-git-credentials.md#phase-2-the-daemon-credential-proxy)).
A write that names an authorized repository is forwarded under a `write`
grant and refused below it, naming the agent's access as the push gate does
(`this agent has read access to {repository}; writing needs write access`). A
write that names no repository is refused.

`write` changes what a repository holds, never the repository itself. A write
to `_apis/git/repositories/{repository}` with nothing below it, which would
rename it, delete it or change its default branch, is refused. Below it a write
reaches only `pullrequests` and everything under it (threads, reviewers,
labels, statuses, iterations), `pushes`, `refs`, `commits/{commit}/statuses`
and `annotatedtags`; any other write, such as a fork or an import, is refused
with a short reason. A pull request is written only after the lookup of §6.2
shows it is that repository's.

The proxy asks the Control Plane for a `read` lease for a fetch or a read, and
for the agent's tier for a push or a write. It keeps each lease per repository
and per access asked, so a read lease never answers a push. A lease names the
repository's surrogate id and `consumer: 'proxy'`, and its token is presented
as the Basic password with the identity id as the user, whatever scheme
carried the placeholder. A `401` from Azure DevOps drops that lease, and the
next request asks the Control Plane with `forceRefresh` once (§3.4).

So an agent with `write` opens, updates, and completes pull requests through
the tools of §6.6, or through the Azure CLI or REST:

- `az repos pr create` posts to its repository;
- `az repos pr update --id … --status completed` resolves the id through the
  lookup of §6.2, then writes to the repository it found. Such a pull
  request carries no AgentConnect footer; one the tools open does. Completing
  a pull request is bounded by the organization's branch policies, such as
  required reviewers on the default branch, as merging is by branch
  protection on GitHub. Review tools come with the second step (§11).

### 6.4 Client Configuration

git uses the session credential helper and the proxy like every other provider;
the helper is pinned for `dev.azure.com`, where every canonical remote points,
and for each `{organization}.visualstudio.com` the proxy serves, and the proxy
presents the token as the Basic password with the identity id as the user
(§3.4). The proxy routes `{organization}.visualstudio.com` for the CLI and REST
as well. Git LFS is refused: its endpoints under `info/lfs` are none of git's
own services of §6.2, so the proxy answers them with its 403, and a checkout
keeps LFS pointer files.

The Azure CLI receives these variables from the credential module's `cli`
member, where a module declares its CLI, rather than from a provider branch in
the daemon:

- `AZURE_DEVOPS_EXT_PAT`, set to the placeholder; the CLI sends it as a Basic
  password, which the proxy already reads;
- `AZURE_CONFIG_DIR`, set to an empty directory of the host's own, emptied again
  at each start, because the CLI prefers a cached sign-in over
  `AZURE_DEVOPS_EXT_PAT`. For local host/SRT launches it lies under the private
  HOME: a confined session's goes with the session's directory, and another host's is under the
  agent directory, where the daemon reclaims it at boot. A pod, VM or remote
  executor uses a host-keyed directory under its own shim runtime root,
  cleared through the existing launch materialization channel. No state
  directory is created on the owning daemon for a remote launch;
- `AZURE_EXTENSION_DIR`, set to the host's installed extension directory, when
  that directory exists, and readable from local `srt`. For a local launch it is
  the daemon configuration's `azureDevOps.cliExtensionDir`, else
  `~/.azure/cliextensions` of the daemon's user. A pod, VM or remote executor
  preserves an explicitly configured target-side `AZURE_EXTENSION_DIR`;
  otherwise it points at `cliextensions` beneath the fresh state directory,
  replacing any inherited extension path from the owning daemon. The bundled
  runtime images install `azure-devops` in the CLI's system extension directory,
  which stays visible alongside an empty per-session extension directory.
  A host installation that puts the extension only under a user's HOME needs
  the explicit installed extension path to avoid downloading it again;
- `AZURE_CORE_COLLECT_TELEMETRY=false`; and
- the proxy and trust variables of the credential proxy design, including
  `REQUESTS_CA_BUNDLE`, which names the merged trust bundle on every strategy
  that starts an Azure DevOps agent.

A variable the agent's own environment sets is left to it, as an agent's own
token always has been. The `az` command itself is readable from `srt` where it
is installed.

With these, the commands that name a repository reach only `dev.azure.com`,
and the CLI writes no credential into the session directory.
The CLI only accepts `dev.azure.com` and `*.visualstudio.com` as organization
hosts, which the proxy preserves, since it terminates TLS for those names
rather than rewriting them. Its organization and project detection reads the
four-segment canonical remote of §5. Both `runtime-sandbox` (Cloud) and
`runtime-sandbox-full` (VM) include pinned Azure CLI and `azure-devops` packages,
with a shared installation layer and a non-root check using empty session state.
Host and SRT executors use the CLI installed on their execution machine; Git
support does not require that executable.

### 6.5 Rate Limits

Azure DevOps limits each identity, not each token, so every agent of the
organization and the Control Plane share one budget. The proxy forwards `429`
and `Retry-After` untouched, so the client's own backoff applies. The Control
Plane's picker and refresh honor `Retry-After` and `X-RateLimit-Remaining`.

### 6.6 Pull-Request Tools

An agent holding an Azure DevOps repository is offered three tools beside the
GitHub, GitLab, and Gitea ones, on the same code-host effect seam:

- `azureDevOpsPullRequest` opens, edits, completes, abandons (`close`), and
  reactivates (`reopen`) a pull request, and adds or removes its labels;
- `azureDevOpsComment` opens a comment thread on a pull request, rewrites the
  first comment of a thread this session opened, and replies in a thread;
- `readAzureDevOpsPullRequest` reads a pull request with its newest threads,
  or one thread, at `read`.

The daemon's broker for Azure DevOps runs each call under the repository's
proxy lease at the agent's tier (§6.3), presented as a bearer token, never in
the agent's environment. The token is the organization's, so the broker's
allowlist is what scopes it: every call renders a template below
`{organization}/{project GUID}/_apis/git/repositories/{repository GUID}/`,
with the GUIDs from the agent's spec, and each template costs `read`,
`comment`, or `write` as on the other hosts. A repository the model names
resolves only among the agent's own.

What the tools leave out, they leave out of their schemas, and the validator
refuses such a field by name:

- **Issues.** Azure Boards work items belong to a project, not a repository,
  so there is no issue tool and comments go on pull requests only.
- **Assignees and reviewers.** A pull request has no assignees, and a
  reviewer is an identity id that only an organization-wide identity search
  resolves from a name, which the broker does not make. `az repos pr
reviewer add` remains available through the proxy where its lookup is.

A pull request's description carries the agent's footer below a hidden marker,
as on the other hosts; Azure DevOps hides the marker. A comment thread's id is
the handle `update` and `reply` take. Completion is asynchronous: Azure DevOps
answers the `PATCH` with the pull request still `active` and its merge
`queued`. It also accepts a completion at a source commit the pull request no
longer ends at and then never runs it, so the broker reads the pull request
first, refuses one that is not `active`, refuses when `sha` is given and the
source has moved, and completes at the commit it read. The merge methods map
to `noFastForward`, `squash`, and `rebase`.

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
- disconnect;
- the connection's state, and a degraded connection's reason with who fixes
  it (the card for an own application's secret, Setup for the deployment's);
- the repositories in use; and
- one line on the identity's reach (§3.6, §9), linking the setup page on the
  documentation site for the detail.

Its copy is about Azure DevOps throughout. The administrator it asks for is a
Project Collection Administrator, not a Teams administrator, and the manual
checklist of §3.2 step 4 lists what §3.6 asks of the organization. The
Console's `/azure-devops/connect` page runs steps 2 to 4: it posts what
Microsoft returned, offers the organizations (skipped for Manage project
access), then the projects with Readers or Contributors for each, and answers
every refusal with its fix: the admin-consent URL, a sign-in at the
organization's tenant, or the checklist with **Check again**, which calls
`verify` with the ticket the refusal carries. The page holds the flow ticket
in memory for the flow alone, never in storage or a URL. The workspace picker
gains an Azure DevOps tile, and the additional-repository picker lists what
the identity can see, marking an unbound row "added on save" and offering the
`read` and `write` tiers. Trigger pickers read a hooks capability of the
Console's code-host projection, so Azure DevOps stays out of them until §11.

Setup's **Microsoft** section stays one section for the one application. It
describes what that application serves (sign-in, Teams, Azure DevOps),
recommends an Entra display name that names no single Microsoft product
(§3.1), and lists the connect page's redirect URI once the Console's address
is HTTPS.

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
  daemon WebSocket, and in the daemon's memory, and only the proxy and the
  daemon's own Git outside every sandbox present them (§6.1). They never appear
  in an environment, argv, a remote URL, `.git/config`, or a diagnostic.
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
  is deny-by-default, a push or an API write needs `write` on the repository
  it names, and `write` reaches only the parts of a repository §6.3 lists,
  never the repository itself. A client that bypasses the proxy holds only a
  placeholder.
- On the `host` strategy that does not hold against a process of the same user,
  which can still recover the daemon's capability and ask for the token, as the
  [trust model](github-app-git-credentials.md#trust-model) says of every code
  host. Because this token is organization-wide, that costs more than on a
  repository-scoped host (§6.1).
- The proxy resolves a repository's name by Azure DevOps's own rules and never
  more loosely (§6.2): after percent-decoding, a `.git` suffix literally, a GUID
  as an id alone, and case folded only where lower- and upper-casing agree, so
  its lease is for the repository Azure DevOps then acts on. A method override
  header is refused, so a request cannot run another method than the one it was
  routed by.
- The proxy's own lookups send a fixed target and `Accept` and answer every
  refusal but `401` and `429`, an unreadable answer and an oversized one like
  a missing id, so neither the client's request nor Azure DevOps's answer
  about another repository's pull request shows through them.
- A compromised daemon host yields the current token: the identity's full
  rights in the organization for up to an hour. That is wider than a GitHub
  installation token. The Console states this on the connect card, and §3.6's
  advice to grant only the projects agents need is the mitigation. Whoever can
  enroll a daemon and place an agent on it can obtain this identity's token too
  ([placement trust](github-app-git-credentials.md#trust-model)), so what the
  organization grants the identity (§3.6) is the real bound.

## 10. Non-Goals

- Azure DevOps Server (on-premises), TFVC repositories, SSH remotes, and Git
  LFS, which the proxy refuses (§6.4).
- Personal access tokens. They belong to a user, expire, and are increasingly
  restricted by organization policy, and the token would still be
  organization-wide.
- Workload identity federation in place of a client secret. It needs an issuer
  Entra can reach, and it can follow without changing anything downstream of
  §3.4.
- More than one Azure DevOps organization per AgentConnect organization.
- Pipelines, Boards, Wiki, and Artifacts, and publishing a Marketplace
  extension.
- Work-item triggers and tools. Azure Boards items belong to a project, not a
  repository (§6.6, §11.4).
- Several connections per AgentConnect organization, each agent choosing one.
  This is how an agent gets an identity of its own: the customer registers an
  application whose service principal reaches only that agent's repositories,
  so Azure DevOps itself bounds it, and it is also how an agent gets a review
  vote of its own (§11.6). The model already keys everything by connection
  (§3.2). Only the Console's choice is missing.
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

## 11. Second Step: Hooks and Reviews

Pull-request triggers, the push trigger, formal reviews, the run projection,
and code-channel pull-request views. The pull-request tools landed ahead of
them (§6.6). Everything here follows the Gitea design's §7, §8 and §10 unless
it says otherwise, and every platform fact marked **verified** was observed
against a test organization on 2026-11-07 (§12, item 10).

### 11.1 What the Organization Grants for Hooks

A service hook subscription is managed under the ServiceHooks security
namespace (`cb594ebe-87dd-4fc9-ac2c-6a10a4c92046`, `ViewSubscriptions` = 1,
`EditSubscriptions` = 2), on the token `PublisherSecurity/{project GUID}`.
Contributors and Readers hold neither; a service principal in Contributors is
refused with `AccessCheckException` naming `Edit Subscription` (**verified**).
`EditSubscriptions` also deletes.

The identity therefore gets both bits, on each project where an agent has a
hook, from the administrator's delegated token during §3.2's step 4: one
`POST _apis/accesscontrolentries/{namespace}` with `merge: true` and the
service principal's identity descriptor, allow 3 (**verified**: the entry
took effect, and deleting it refused the next create). Manage project access
shows **Allow triggers** per project beside its group; it is on for a project
picked with Contributors and can be turned on for one picked with Readers.
Turning it off there deletes the entry (§3.2). A hook
on a repository whose project lacks the grant is refused at save with "allow
triggers on this project in Manage project access", and a grant that later
disappears degrades the hook's binding (§11.2).

The bits reach every subscription in the project, including the customer's
own. The Control Plane touches only the subscriptions whose ids it recorded,
and the proxy refuses `_apis/hooks/…` to agents as it refuses everything
outside §6.2, so an agent never holds this authority.

### 11.2 Subscriptions

A subscription carries one event type, so a hooked repository gets one
subscription per delivery kind its enabled hooks need, never one per hook:

| Delivery kind | `eventType`                                 | Publisher filters                                      | Resource details |
| ------------- | ------------------------------------------- | ------------------------------------------------------ | ---------------- |
| opened        | `git.pullrequest.created`                   | `projectId`, `repository`                              | all              |
| revision      | `git.pullrequest.updated`                   | … plus `notificationType: PushNotification`            | `minimal`        |
| reviewers     | `git.pullrequest.updated`                   | … plus `notificationType: ReviewersUpdateNotification` | all              |
| state         | `git.pullrequest.updated`                   | … plus `notificationType: StatusUpdateNotification`    | all              |
| comment       | `ms.vss-code.git-pullrequest-comment-event` | `projectId`, `repository`                              | all              |
| push          | `git.push`                                  | `projectId`, `repository`                              | `minimal`        |

Each subscription is `publisherId: tfs`, `consumerId: webHooks`,
`consumerActionId: httpRequest`, with `resourceVersion: 1.0` pinned so the
body does not change under it. Its consumer inputs are the relay's
`/webhooks/azure-devops` URL, `basicAuthUsername: agentconnect`, the
binding's signing secret as `basicAuthPassword`, and `messagesToSend` and
`detailedMessagesToSend` both `none`, which keeps message text with names in it
out of the body. "All" resource details is the input left out; an empty string
is refused (**verified**).

The kind of an update is not in its body, and a body's resource is the pull
request as it stood when the notification was sent, not when the event
happened: a vote and a push that preceded a completion both arrived showing
`completed` (**verified**). One subscription per update kind is therefore how
the relay knows what happened. A revision, a merge and a push need only an
identifier (`minimal` sends the pull request's `url` and `pullRequestId`,
**verified**). Opened and comment deliveries carry the whole resource, because
the relay matches mentions and vetoes the identity's own traffic on what they
say. Reviewers and state carry it too, because the relay gates them on the pull
request's author, which a minimal resource does not name (§11.4). A
subscription still sending a minimal resource for those two kinds is drift, and
the convergence rewrites it.

A hook that watches pull requests also gets the state kind, even when it
subscribes to no state event: it carries the cleanup that retires a pull
request's checkout (§11.4). `git.pullrequest.merged` is "merge attempted" and
fires on every merge check, opening a pull request included (**verified**), so
it is never subscribed: completion arrives as a state update. A delivery of that
kind from an older subscription is cleanup only when the daemon's read finds
the pull request `completed`.

The binding records each subscription id with its kind. The Control Plane's
`convergeManagedRepository` makes the set match the union of the enabled
hooks' families: it creates what is missing, deletes what no hook needs, and
reads each recorded subscription back. A subscription removed in Azure DevOps
is recreated. One whose `eventType`, publisher inputs, or consumer inputs
other than the masked password no longer match its recorded kind, which the
grant of §11.1 lets anyone with it edit, is rewritten whole with `PUT`, the
current secret included, before its status is touched. A repository whose
last hook goes away loses all of its subscriptions; the binding stays for its
workspaces and grants.

**Secrets.** The signing secret is 32 random bytes per binding, hex, sealed
like the other code hosts' webhook secrets. A subscription read answers it as
`********` (**verified**), and the notification history masks the
`Authorization` header and the password but shows `httpHeaders` in clear
(**verified**), so the secret travels only as the Basic password, never as a
custom header. A rotation replaces each subscription's consumer inputs with
`PUT _apis/hooks/subscriptions/{id}` carrying the new secret in full; the
masked value a read returns is never sent back, since what Azure DevOps does
with it is not established.

One key serves several subscriptions, so a rotation is a fan-out with a
barrier, unlike Gitea §7's single successor webhook:

1. seal the next key and compile it into the rule as `nextSigningKey`, so the
   relay accepts both;
2. `PUT` each recorded subscription with the next key, recording per
   subscription, durably, that its update was acknowledged; a rotation cut
   short resumes from those records and never re-keys a subscription twice
   under different secrets;
3. once every recorded subscription is recorded as switched — the barrier —
   the next delivery verified under the next key promotes it. A delivery
   verified under the next key before the barrier promotes nothing; and
4. the old key stays accepted as `previousSigningKey` for 36 hours after
   promotion, the length of Azure DevOps's retry schedule, so a notification
   queued before its subscription switched is not refused and does not put
   that subscription on probation. Every rotation keeps this window.

A subscription created during a rotation gets the next key and counts as
switched.

**Subscription state.** Azure DevOps puts a subscription on probation after a
failure that is not transient, drops new events while it lasts, and disables
it (`disabledBySystem`) after about 36 hours of failed retries. It also
disables a subscription whose owner lost the permission
(`disabledByInactiveIdentity`), and one with no successful delivery in six
months. The convergence reads `status` on each pass: a disabled subscription,
or one on probation, is re-enabled with the same `PUT`, and the binding shows
`webhook_unverified` until a delivery verifies. Probation is not left to
Azure DevOps's own retries, whose backoff kept a repaired subscription dropping
new events for over an hour (**verified**). A disable by `disabledByInactiveIdentity` is
reported as the missing grant of §11.1 and is not re-enabled until the grant
returns.

### 11.3 Verification and Routing at the Relay

A delivery is a JSON envelope: `subscriptionId`, `notificationId`, `id` (the
event id), `eventType`, `publisherId`, `resource`, `resourceVersion`,
`resourceContainers` (`collection`, `account` and `project` ids), and
`createdDate` (**verified**). Azure DevOps signs nothing and sends no
timestamp. The relay:

1. enforces HTTPS and the 1 MiB raw-body limit, and parses only enough to read
   `subscriptionId`;
2. looks the subscription id up in the compiled rules, whose `azureDevOps`
   member is keyed by subscription id and carries the repository's surrogate
   id, its organization `instanceId`, project and repository GUIDs, the
   delivery kind, the connection's identity id as the veto set, and the
   signing keys;
3. compares the `Authorization: Basic` credentials, timing-safe, against every
   key the rule carries (current, next, and previous during its 36 hours),
   user name included; and only then
4. decodes the body, and refuses one whose `eventType`, collection id or
   project id disagrees with the rule, or whose resource names another
   repository or pull request than the rule's repository.

A subscription id no rule knows, or a delivery that fails verification, gets
the uniform `404`. Azure DevOps puts such a subscription on probation and then
disables it, which retires an orphan on its own. A verified delivery is always
answered `2xx`, whether or not a daemon takes it, so a working subscription is
never put on probation by the product's own routing.

Basic credentials over TLS authenticate the sender as an HMAC does, but there
is no replay window. The event id is the delivery key: the `(hookId,
deliveryKey)` uniqueness and the session inbox absorb repeats, and an Azure
DevOps retry is the same notification of the same event.

The relay reports a verified delivery to the Control Plane as
`rc/codehost-delivery` with the frame's existing fields: the surrogate id the
rule holds as `repoExternalId`, and which key verified it. Keys and promotion
belong to the binding, so the frame needs no subscription id.

### 11.4 Event Mapping and Routing

| Product family                   | Azure DevOps source                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------- |
| `merge_request:opened`           | opened: `git.pullrequest.created`                                                     |
| `merge_request:synchronize`      | revision: a new iteration                                                             |
| `merge_request:review_requested` | reviewers: the connection identity among the reviewers, with no vote and not declined |
| `merge_request:reopened`         | state: `active` again after `abandoned`                                               |
| maintenance cleanup family       | state: `abandoned` or `completed`                                                     |
| pull-request comment             | comment: a `text` comment on a thread, conversation or diff                           |
| `push:*`                         | push                                                                                  |

Azure Boards work items are not repository issues, and Azure Repos has no
releases, so the `issues:*`, issue-comment and `release:*` families do not
exist for Azure DevOps and the Console does not offer them. No event reports a
label change, so the label filter is not offered either. A pull request opened
as a draft is admitted as Gitea §8 admits one; toggling draft fires none of
the update kinds subscribed here and is inert.

For the three update kinds, the relay forwards the pull-request id
and no classification. The daemon reads the pull request and its iterations at
turn start under the hook-reply lease of §11.5, and classifies on that read,
not on the body. A reviewer change is a review request only while the pull
request is `active` and the lease's identity is among its reviewers with no
vote and not declined. A status change is a reopening when the pull request is
`active` and the rule admits reopened, and cleanup when it is `abandoned` or
`completed`. Any other reviewer or status change completes without a turn. An
update kind whose read fails is refused, since it cannot be classified; any
other delivery keeps its turn and its prompt says the read failed. The head
fence is the newest iteration's `sourceRefCommit`, which is the pull request's
`lastMergeSourceCommit`. The daemon reads nothing for a merge or a push.

A comment delivery's resource is the comment alone: `id`, `parentCommentId`,
`author`, `content`, `commentType`, and `_links` (**verified**). The pull
request id and the thread id are read from `_links.threads.href`, which must
have the form `…/_apis/git/repositories/{repository GUID}/pullRequests/{n}/threads/{t}`
with the rule's repository GUID; any other shape is refused. A `system`
comment is never a trigger. Whether the thread is on a diff is read by the
daemon from the thread's `threadContext` when the turn starts.

**Summon forms.** A mention-gated rule is summoned by `@<agent-name>` as plain
text, or by mentioning the connection identity as the repository-wide
broadcast, which Azure DevOps stores in a comment's content as
`@<{identity id}>` (**probe**, §12 item 11).

**Loop prevention.** A delivery whose actor is the connection's identity id is
rejected: `createdBy.id` for opened, `author.id` for a comment, `pushedBy.id`
for a push. The bot's own same-repository pull-request revisions still enter
review, as in GitLab §12.1, which Gitea inherits.

**Collaborator gate.** Opened, comment, review-requested and reopened
deliveries are authorized live through `rc/codehost-membership-authz`. Azure
DevOps answers a permission question only for the caller
(`permissionevaluationbatch`), and the webhook helper's raw access-control list
query for another identity answers only that identity's explicit entries,
without what its groups grant (**verified**). The Azure DevOps arm therefore evaluates it:

1. read the actor's identity with `queryMembership=ExpandedUp`, which lists
   every group it belongs to, directly or not (**verified**);
2. read the Git repositories namespace's access-control lists on
   `repoV2/{project GUID}/{repository GUID}`, `repoV2/{project GUID}` and
   `repoV2`, in that order, stopping after the first list whose
   `inheritPermissions` is false: a repository or project that does not
   inherit takes nothing from above it, so an ancestor's allow beyond that
   boundary counts for nothing. A list whose `inheritPermissions` the answer
   leaves out is taken as a boundary too. A connection whose identity is a
   project member, not an organization administrator, is refused the
   `repoV2` list with 403 (**verified**); that level is then not read and adds
   nothing. Any other refusal fails closed;
3. admit the actor when an entry for the actor or one of its groups allows
   GenericContribute (bit 4) on the lists read, and no entry for any of them
   denies it.

The rule is stricter than Azure DevOps's own, which lets a more specific
allow override an inherited deny, so it can refuse a person Azure DevOps would
let push. It never admits one Azure DevOps would not, except through a deny set
for all repositories at organization level that the connection cannot read.
Branch-level entries are not read. The repository's lists are cached for a minute per binding.

The update kinds name no actor, so a review request and a reopening are gated
on the pull request's author, `createdBy.id` of the whole resource: anyone
holding the pull-request contribute permission, which Readers have, can add a
reviewer, and the review then reads code the author wrote. The relay gates
without classifying. A refused reviewer change goes nowhere. A refused state
change still reaches the daemon for its cleanup, but cannot reopen into a turn.
The identity's own pull request from the same repository is not gated, as its
opened delivery is not. A revision and a push need no gate, since pushing to
the repository already takes Contribute. An external pull request from a fork
starts only through the explicit paths of GitLab §12.2.

**Session keys.**

```text
pull request: azure-devops:<surrogate id>:pull:<pull request id>
push:         azure-devops:<surrogate id>:push:<ref>
```

`transportScope = azure-devops:<surrogate id>`. Turn admission is the
provider-neutral hook-admission seam with an Azure DevOps implementation of its
members.

### 11.5 Output

**Final reply.** A comment trigger is answered in its own thread, as a reply
to the triggering comment; any other trigger opens a thread on the pull
request. Comments coalesce per thread, so a batch is answered in the thread
its first comment fired in. It is written by the daemon's
final poster under a lease of purpose `azure_devops_hook_reply`, which the
Control Plane serves to `consumer: 'daemon'` only and at `comment` for a
repository with an enabled hook, whatever the agent's own tier. The standing
context block is `# Azure DevOps`.

**Acknowledgement.** A comment trigger gets a like on the triggering comment
(`POST …/threads/{t}/comments/{c}/likes`, **verified**). A new comment is
one whose `lastContentUpdatedDate` equals its `publishedDate`; the relay drops
any other comment delivery, so neither an edit nor a like starts a turn. Other
triggers get none, since a pull request has no reaction of its own. A failed
like never fails the turn.

**Controlled effects.** The tools of §6.6. In a hook turn the guidance names
them before the Azure CLI, and the hook's lease raises a repository held at
`read` to `comment` for them, as in Gitea §10.2. A write still needs the
agent's own `write`.

### 11.6 Formal Reviews

`submitCodeReview` keeps its schema and is routed to an Azure DevOps adapter
on the code-host review router. A review is a vote plus threads, and none of
it is staged: there is no pending review to absorb another attempt's comments,
so the publication lease guards ordering and ambiguity only. Under the seam's
publication lease and operation, the adapter:

1. re-reads the pull request and refuses a moved head (the newest iteration's
   source commit);
2. creates one thread per inline comment with `threadContext` (`filePath`, and
   `rightFileStart`/`rightFileEnd` for `RIGHT`, `leftFileStart`/`leftFileEnd`
   for `LEFT`, so a range is a range) and `pullRequestThreadContext` naming the
   iteration and the file's `changeTrackingId` from that iteration's changes
   (**verified** for a single line);
3. creates the summary thread; and
4. casts the vote, `PUT …/reviewers/{identity id}`: `APPROVE` → 10,
   `REQUEST_CHANGES` → −5 (waiting for the author), `COMMENT` leaves the vote
   alone, so it never clears an earlier verdict.

Every comment the attempt writes carries the hidden signed attempt-and-ordinal
marker. After a timeout or an ambiguous answer the adapter lists the threads,
counts the marked comments that exist, writes only the missing ones, and then
the vote, which is idempotent. Nothing an attempt writes is ever deleted. The
identity may vote on a pull request it opened (**verified**); whether that
vote counts is the branch policy's "allow requestors to approve their own
changes", which the adapter does not read or work around. A policy that resets
votes on a new push is the customer's, and a re-review follows the re-request
paths of GitLab §16.1, which Gitea §10.4 inherits.

A vote is one state per reviewer identity, and the identity is the
connection's, shared by every agent. Two agents reviewing one pull request
therefore overwrite each other's vote, last writer wins, and a `COMMENT`
review leaves another agent's verdict standing. Each agent's verdict stays
durable in its own summary thread and its own status context (§11.7), unlike
Gitea, where two agents leave two reviews. An agent that needs a vote of its
own needs an identity of its own: the several-connections path of §10.

**As implemented (B4).** The adapter publishes under the `azure_devops_hook_reply`
lease, whose user name is the identity's id: votes and threads need only the
pull-request contribute permission that lease's `comment` tier stands for.
The publication lease keys its publisher by a number, so both ends derive one
from the identity's GUID (its first 60 bits), and the Control Plane resolves
it from the repository's hooked binding. On the operation ledger an inline
thread is a `draft_create` record carrying its ordinal, the summary thread the
`bulk_publish` record, and the vote the `approval` record. The pieces:

- An unknown answer is read back before the record settles. A thread is
  sought by its marker for a bounded window; one that never appears is
  absence, settled with its code, and written once more under a new record, so
  a request that lands after the window leaves a duplicate thread, never a
  deleted one. A vote is read back from the reviewer entry. Only when the
  threads cannot be listed at all does the record stay ambiguous, and the pull
  request locks. The lock's one exit is the locked attempt's summary thread,
  which a later attempt finds from the lock's coordinates.
- A recovered attempt settles each started record the same way, by marker or
  read-back, and then writes what is missing.
- A range is anchored as a range. A refused range is retried on its end line,
  naming its first line; a refused line is listed under the summary instead.
- A thread refused outright ends the attempt: `not_submitted` when nothing
  was written, `review_state_not_recorded` otherwise. A refused vote is
  `approval_not_recorded` for APPROVE, `review_state_not_recorded` for
  REQUEST_CHANGES.
- The prompt names `submitCodeReview` exactly when a delivery opens a review
  generation, as Gitea's does: opened, a new revision, and a review request
  of the identity, on the head the turn-start read fenced.

### 11.7 Run Projection

The Control Plane writes a pull-request status with the connection's token:
`POST …/pullRequests/{id}/statuses` with `context` `{ genre: 'agentconnect',
name: <agent-slug> }`, the head's `iterationId`, `targetUrl` the Console
session, and a bounded `description`. States map `queued|running → pending`,
`completed → succeeded`, `failed|interrupted → error`, and
`skipped|superseded → succeeded` with the reason in the description;
`notApplicable` is never written, because under a required status policy it
removes the requirement. Each write adds an entry, and Azure DevOps shows the
newest per context (**verified**: two writes, two entries), so the writer posts
one per state change rather than updating, under the GitHub Check writer's
generation and ordering rules. It carries no conversation content, so the
writer stays in the Control Plane, as Gitea's commit status does.

An administrator who adds a status check policy for `agentconnect/<agent-slug>`,
optionally limited to the connection's identity, makes it a gate; the product
does not.

**As implemented (B4).** A hook reports with `reportingMode: status`; `check`
is refused, since the run note has no Azure DevOps meaning. The context name
is the agent's name. The writer reads the pull request's iterations before
each write and names the newest one whose source commit is the projected
head, or none. An update kind's accepted delivery names no head, so its
status opens at `running`, on the head the daemon's read recorded through
`hook/start`; the Control Plane advertises `azure-devops-hooks-v1` as the
daemon's sign that it routes that arm. A success whose run never crossed the
start barrier settles only a status its own delivery opened, so an ignored
reviewer or status change or a cleanup writes none: the vote a review casts is
itself a reviewer change, and its completion would otherwise restate the
head's status as completed, over a failed run's (**verified**). A turn that ran
past a failed barrier still settles the status its delivery queued. A write whose answer was lost is
reconciled against the listed statuses: a newer entry by the identity with
the same context, state and description proves it, and absence past the
grace window lets it be written again.

### 11.8 Code Channels

A pull-request link and view key on the surrogate id and the pull-request id,
labelled `{organization}/{project}/{repository}!{id}` with the web address
`https://dev.azure.com/{organization}/{project}/_git/{repository}/pullrequest/{id}`,
as the tools' opened-object record already does (§6.6).

### 11.9 Protocol

- The hook kind `azure-devops` joins the database enum, the hook body, and the
  Console's hook tables, replacing the refusing entries of §7.
- Feature string `azure-devops-hooks-v1` on the relay and the daemon gates the
  compiled rule's `azureDevOps` member, the relay's dispatch target, and the
  review adapter, fail-closed by omission. The daemon advertises it with
  `azure-devops-v1`, to the Control Plane and in every relay hello, exactly
  while its credential proxy runs.
- Hook and relay frames gain an `azureDevOps` optional member beside `github`,
  `gitlab` and `gitea`, with its arm in the decode-time view of Gitea §13.
- The gitcred purpose enum gains `azure_devops_hook_reply`; the
  membership-authorization request carries the actor's identity id.
- The binding gains its signing key, next key, and previous key with its
  expiry, and recorded subscriptions with their kinds, last observed status,
  and the key each was last switched to.

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
   pushes. Through the proxy with a placeholder, on both `dev.azure.com` and
   `{organization}.visualstudio.com`, a held repository fetches and clones, a
   push under a `read` grant is refused by the proxy naming that access, and
   the same push under `write` lands. Azure DevOps names a git repository as
   follows (§6.2):
   - `{project}/_git/{repository GUID}` works, the project named or given by
     GUID, while `_git/{repository GUID}` without a project fails with
     `TF200016`;
   - a `.git` suffix is read literally: `_git/{repository}.git` answers 404
     `TF401019`; and
   - project and repository names match regardless of ASCII case, an
     all-uppercase spelling included.
4. **Verified without the proxy:** Azure CLI 2.92 with `azure-devops` 1.0.10
   took an Entra token in `AZURE_DEVOPS_EXT_PAT` under an empty
   `AZURE_CONFIG_DIR`. The repository list, pull-request list, and project
   list commands, and organization and project detection from the
   four-segment remote, all succeeded. These reached only `dev.azure.com`,
   and no session file held the token. An empty configuration directory
   without `AZURE_EXTENSION_DIR` reinstalled the extension from `aka.ms`, Azure
   blob storage, and `github.com` (§6.4). Through the proxy with the
   placeholder in `AZURE_DEVOPS_EXT_PAT`:
   - `az repos show` and a pull-request list naming the repository answer;
   - `az repos list` and a pull-request list naming no repository are refused;
   - under `write`, `az repos pr create`, `az repos pr show --id` and
     `az repos pr update --id … --status abandoned` work, the last two through
     the lookup by id.

   With the repository not held, a pull request of it and a missing id, a
   repository GUID that exists and one that does not, and a Git
   `info/refs` for an existing and a missing name each answered
   byte-identically (Date aside).

5. **Decided:** project and repository lists, at either scope, and
   pull-request lists that name no repository are refused. A single pull
   request by id is answered only when it belongs to one of the agent's
   repositories (§6.2). A filtered list is the follow-up if agents need one.
6. **Decided:** no Azure DevOps tool in the first version. An agent with
   `write` opens and completes pull requests through the CLI or REST (§6.3).
   The pull-request tools followed it (§6.6); verified 2026-11-07 against the
   test repository: create with labels and draft, edit, a thread, its rewrite
   and a reply, abandon, reactivate, and squash completion, with the footer
   marker hidden.
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
10. **Verified 2026-11-07, for §11**, as the application's service principal
    in Contributors of one project:
    - a subscription create is refused (`AccessCheckException`, `Edit
Subscription` on `PublisherSecurity/{project GUID}`); after an
      administrator's access-control entry allowing bits 1 and 2 it succeeds,
      and after the entry is deleted it is refused again;
    - a read answers the password as `********`; the notification history
      masks the `Authorization` header and the password, and shows custom
      headers in clear;
    - an empty `resourceDetailsToSend` is refused; leaving it out sends the
      whole resource, `minimal` sends a pull request's `url` and
      `pullRequestId`, and `none` sends `resource: null`;
    - the envelope carries `subscriptionId`, `notificationId`, the event `id`,
      and the resource containers; an update's resource is the pull request
      when the notification is sent, and its kind is not in the body;
    - a comment delivery's resource is the comment, with the pull request and
      thread only in `_links`;
    - the identity votes on its own pull request, posts pull-request statuses
      (each write a new entry), opens a single-line inline thread anchored to
      an iteration, likes a comment, and resolves a thread;
    - multi-line inline threads as §11.6 writes them: a right-side range on
      added lines and a left-side range on removed lines, each with the file's
      `changeTrackingId` from the iteration's changes and the current
      iteration as both comparing iterations, are accepted and read back
      unchanged, on the first iteration and after a second push; the
      left-side range shows on the removed base lines;
    - an access-control list query for a member answers no effective
      permission from that member's groups, while `queryMembership=ExpandedUp`
      lists the groups and the repository's list chain names which of them
      may contribute.
11. **Probe, before the step that relies on it:**
    - whether a Project Administrator below Project Collection Administrator
      may write §11.1's access-control entry (B2);
    - the content form of a mention of the identity (B1);
    - whether a subscription `PUT` without the real password keeps the stored
      one (B2 never relies on it).

## 13. Implementation Plan

Each step is one pull request, merged in order. The probes of §12 run against a
live organization before A2.

- **A0 — Push gate.** The proxy refuses `git-receive-pack` under a grant below
  `write` (§6.3). This is #3767; it is not scheduled again here.
- **A1 — Protocol.** _Landed (#3781)._ The provider value with refusing hook entries,
  `azure-devops-v1`, the credential arm, the clone-URL forms, and the reserved
  secondary-root directory.
- **A2 — Control Plane.** _Landed._ The connect flow on the deployment application and
  the own-application path, and Manage project access; the token cache; the
  identity table and claims, with bindings and grants keyed by connection; the
  picker; derivation and grant arms; gitcred leases served only to the proxy
  plane; and the REST routes.
- **A3 — Daemon.** _Landed._ The credential module with its `proxyOnly`
  capability, the proxy instances and route descriptor of §6.2 in the
  descriptor registry GitLab and Gitea moved into, the proxy's leases and gates
  of §6.3, the client configuration of §6.4, the feature advertisement tied to
  the proxy, the gitcred `consumer` field of §6.1 on every Azure DevOps
  request, the tunnel refusal and the placeholder for daemon Git inside a
  boundary, and the strategy refusal. Tests pin each refusal of §6.2: the
  lists, the pull-request lists that name no repository, and a repository
  outside the agent's authorizations, answered alike whether or not it exists.
  They also pin the pull-request lookup by id: it answers for the agent's own
  repository, and answers another repository's pull request exactly as it
  answers a missing id. They also pin §6.3: a write below `write` is refused,
  and a pull-request write at `write` is forwarded. A real daemon with its
  proxy runs `git ls-remote` against a fake Azure DevOps through the proxy,
  is refused a push at `read`, an unauthorized repository and the runtime's
  own ask, and advertises `azure-devops-v1` only while the proxy runs. The
  Azure-first shared managed-Git path extends daemon workspace preparation to
  local VMs, pool pods and remote executors, with per-operation route checks
  replacing the environment bans (§6.1). Validation records distinguish real
  Git transport fixtures from live execution-environment tests.
- **A4 — Console, Setup, and documentation.** _Landed, except the setup page
  on the documentation site._ The card and the connect page, the pickers, and
  the Microsoft section's redirect URI and wording.
- **A5 — Pull-request tools.** _Landed (#3812)._ The broker and the three tools
  of §6.6. Tests pin the allowlist below one repository, the tier of each
  call, the refusals of issues, assignees, reviewers and pipelines, the
  completion checks, and the single re-mint after a rejected lease.

The second step (§11):

- **B1 — Protocol and relay ingress.** The hook kind, `azure-devops-hooks-v1`,
  the frames' `azureDevOps` member and its decode-time arm, the compiled rule
  keyed by subscription id, and `/webhooks/azure-devops` with §11.3's
  verification and §11.4's mapping, summons, and loop veto. Tests pin the
  uniform `404`, both keys during a rotation, a body that disagrees with its
  rule, and the link shapes a comment must have.
- **B2 — Control Plane.** §11.1's access-control entry in the connect flow and
  Manage project access, with **Allow triggers**; the hook write and its
  refusal without the grant; the binding's secrets and subscriptions;
  `convergeManagedRepository` with create, delete, read-back with drift
  rewrite, re-enable, and the rotation barrier; the membership-authorization
  arm with its inheritance boundaries; and the `azure_devops_hook_reply`
  purpose. Tests pin that no delivery promotes a key before every
  subscription switched, and that a project without inheritance takes no
  ancestor allow.
- **B3 — Daemon hook turns.** Normalization and the hook-admission members, the
  turn-start read of the pull request, its iterations and threads, the final
  poster and the like, the standing context, and the tool guidance.
- **B4 — Reviews and run projection.** _Implemented; see "As implemented"
  in §11.6 and §11.7._ The review adapter of §11.6 and the
  status writer of §11.7. Tests pin the shared vote: a second agent's verdict
  replaces the first, and a `COMMENT` review leaves the vote alone.
- **B5 — Console.** The hook kind's families, Allow triggers, the binding's
  subscription state, and code-channel views (§11.8).
