# GitLab Self-Managed Support

> Status: **Proposed** — extends the implemented
> [GitLab.com integration](gitlab-com-integration.md), whose Section 22 M0–M8
> spine is merged.
>
> Platform assumptions last verified: **2026-08-23**
>
> Scope: **GitLab Self-Managed 18.11 or later**, Free and Premium, **one
> instance per deployment**. Instances below 18.11, GitLab Dedicated, more
> than one instance in a deployment, and Ultimate-only capabilities stay
> outside the support contract.

The GitLab.com integration deliberately pinned its host. OAuth, API, and Git
remotes all resolve to `gitlab.com`, and Section 18.3 of that design records
the decision as an explicit absence: "no `GITLAB_BASE_URL` or host override in
v1". This design removes that pin for a customer-operated instance while
leaving every other decision in that document standing.

This is an extension, not a second integration. The identity model, credential
purposes, webhook verification, event mapping, session keys, output ownership,
review publication, and run projection are unchanged; a self-managed instance
is the same product running against a different origin. Three questions are
genuinely new, and this document spends its prose on them.

1. **Who may create the service account.** On GitLab.com the installing user's
   OAuth grant is sufficient. On a self-managed instance the default is that
   only instance administrators may create a service account of either kind,
   and the one documented delegation switch covers group service accounts
   only. Section 7 adopts that delegation as the single supported path and
   records the rejected administrator-credential alternative.
2. **How the instance host travels.** The host becomes a configuration axis
   that must reach the Control Plane, the daemon's Git credential injection,
   the `glab` shim, and four daemon API clients — without letting a daemon
   that predates the change clone a private project from the wrong host.
   Section 6 designs that, and the rolling-compatibility rule is fail-closed
   by omission.
3. **What trusting the network means** when the code host sits inside the
   customer's perimeter: private certificate authorities, default-deny
   sandbox egress, and a webhook path that has to work in both directions.
   Section 8 designs that.

Everything else is mechanical. Appendix A is the complete inventory of the
places that spell `gitlab.com` today and what each one becomes.

## 1. Decision Summary

1. **Require GitLab 18.11 or later.** The integration's runtime identity is a
   service account, and service accounts became generally available on Free in
   18.11 — introduced disabled-by-default in 18.10, Premium-or-above before
   that. An older instance is refused with a specific message rather than
   degraded. Section 5 lists exactly what breaks below the floor.
2. **One instance per deployment.** The base URL is a single deployment-level
   value in the Setup Server's typed deployment document, beside the OAuth
   application it belongs to. There is no per-connection, per-organization, or
   per-binding host. Section 6.6 records why multi-instance is a non-goal and
   what it would cost.
3. **GitLab.com is the default value of the new axis, not a separate mode.**
   An unset base URL means `https://gitlab.com`, existing deployments change
   nothing, and no code path branches on "is this GitLab.com".
4. **Keep the per-agent group service account.** The shipped runtime
   identity is one group service account per (organization, agent, top-level
   group) — Section 7.2 of the base design — and the only documented way for
   a non-administrator to create a service account on a self-managed instance
   is the instance setting that delegates _group_ service-account creation to
   top-level group Owners. The shipped identity is therefore the only
   delegable one; project service accounts would be administrator-only on
   every self-managed instance. Section 7.5 records the reasoning.
5. **One creation path: the installing user's OAuth connection.** The
   instance must enable "Allow top-level group owners to create Service
   accounts" — or the connecting user must themselves be an instance
   administrator, which satisfies the same code path. There is no
   administrator credential: the deployment-wide instance-admin secret was
   designed and rejected (Section 7.3). A refused creation lands the account
   row in `service_account_creation_forbidden`, whose remedy names the
   instance setting and its Admin Area path.
6. **The host travels on the agent spec and the hook rule, and the credential
   grant echoes it.** The daemon needs the host _before_ any Git operation,
   because it selects the `credential.https://<host>` block written at spawn
   time, so the authoritative carriers are the `mode: 'gitlab'` workspace arm
   of the replicated agent spec and the compiled hook rule. The Git-credential
   grant gains an optional `host` member purely so the consumer can verify it,
   exactly as it already verifies provider and numeric project ID. No new
   member is added to `register/ok`.
7. **One new feature string, `gitlab-instance-v1`, and fail-closed by
   omission.** When the configured host is not `https://gitlab.com`, the
   Control Plane must never place a GitLab-backed agent on — or project a
   GitLab-shaped spec or hook rule to — a daemon or relay that has not
   advertised it. An older daemon therefore never sees a self-managed
   workspace at all, rather than seeing one and cloning from `gitlab.com`.
   When the configured host _is_ `https://gitlab.com`, nothing is gated and
   mixed fleets behave exactly as they do today.
8. **The operator origin policy stays authoritative.** A managed GitLab
   workspace clones only if the configured instance origin is in that daemon's
   `workspaceGitAllowedOrigins`. The managed feature allows exactly the
   configured origin and never widens an explicit operator list; the existing
   boot-time warning keyed on the `https://gitlab.com` literal is replaced by
   a spec-admission readiness refusal that names the origin actually required.
9. **TLS trust is process configuration, never a per-request escape hatch.** A
   private certificate authority is supplied to the Control Plane, daemon, and
   sandbox through the standard Node and Git trust variables this repository
   already forwards. Certificate-verification bypass is a non-goal at every
   layer, Git included.
10. **Reachability is a deployment obligation that the product states and
    probes.** The Setup Server verifies the base URL's scheme, shape, and
    reachability before the OAuth application is usable, and the Control Plane
    verifies the version at first credentialed contact. The instance
    administrator must allow the relay callback if it resolves to a private
    address, because GitLab blocks webhook requests to the local network by
    default.
11. **One base URL, used by every component.** There is no internal/external
    URL pair. Clone URLs, OAuth redirects, and the `web_url` values GitLab
    returns must all agree, and they only agree if there is one address.
12. **Tier detection stays observational.** Self-managed Free (or Community
    Edition) and Premium differ exactly as GitLab.com Free and Premium do, and
    Section 15.3 of the base design already reports observed outcomes instead
    of querying a tier. Section 10 restates the matrix with the self-managed
    quota and licensing differences called out.

## 2. Goals

1. Connect one customer-operated GitLab instance per deployment with the same
   single-redirect experience, project picker, and provisioning saga the
   GitLab.com integration already ships.
2. Preserve every semantic in the base design: credential purposes, webhook
   verification, collaborator gates, per-thread sessions, ordinary reply
   versus formal review exclusivity, the status-note projection, and the
   authorized re-request.
3. Keep GitLab.com deployments unchanged in behavior, wire shape, and
   configuration when the new axis is unset.
4. Make an unsupported instance fail with a specific, actionable message — too
   old, unreachable, untrusted certificate, wrong shape, administrator
   credential missing or unprivileged — instead of failing deep inside
   provisioning.
5. Support the shapes a self-managed base URL actually takes: a non-default
   port, a relative URL root such as `https://gitlab.example.test/gitlab`, and
   a certificate chaining to a private authority.
6. Keep a daemon that does not understand the host axis from ever performing a
   Git or API operation against the wrong origin.
7. Give an operator one place to state the instance, one stated
   service-account prerequisite, and a probe that tells them the truth before
   a user presses Connect.

## 3. Non-Goals

- **More than one GitLab instance per deployment.** Section 6.6.
- **GitLab instances below 18.11.** Section 5.2 lists what breaks; there is no
  compatibility branch, no capability-probing ladder, and no degraded mode.
- **GitLab Dedicated.** It is a hosted single-tenant offering with its own
  administration model. It may work; it is not certified here.
- **Certificate-verification bypass** at any layer — Control Plane, relay,
  daemon, sandbox, or Git. A private authority is supported; skipping
  verification is not, and no shipped code path reads such a flag.
- **Plain HTTP instances.** Webhook SSL verification, the credential helper's
  host scoping, and the OAuth callback all assume HTTPS.
- **A split internal/external base URL.** One address, reachable from every
  component. Section 8.2 explains why a pair breaks clone URLs and provider
  links.
- **An egress proxy** in the first slice. Section 8.4 records the shape the
  answer would take so a later implementation is not invented ad hoc.
- **Client-certificate (mTLS) authentication to the instance.**
- **SSH remotes.** Managed workspaces remain HTTPS-only, matching the base
  design; the default origin allowlist gains no `ssh://` entry for GitLab.
- **An instance-administrator credential.** Provisioning uses only the
  installing user's OAuth connection; Section 7.3 records why the
  deployment-wide administrator secret was rejected and what would reopen it.
- **Discovering the instance from a URL a console user types.** The host is
  operator-set deployment configuration.
- **Group- or instance-level webhooks, external status checks**, and every
  other Premium- or Ultimate-only surface the base design already excluded.
  Self-managed does not reopen them.
- **A second OAuth application.** One deployment, one instance, one
  application.

## 4. What Changes and What Does Not

| Area                                                       | Change                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| OAuth flow, PKCE, state binding, refresh single-writer     | Unchanged; only the authorize/token/revoke origin is composed from configuration                                                    |
| Service-account identity and the three credential purposes | Unchanged; only the instance-setting prerequisite for creation differs, plus one expiry-clamp rule (Sections 7 and 9.2)             |
| Webhook signature scheme, replay window, delivery key      | Unchanged                                                                                                                           |
| Relay                                                      | One pass-through field on the compiled rule; the relay never dials GitLab and needs nothing else                                    |
| Event mapping, collaborator gate, session keys             | Unchanged                                                                                                                           |
| Ordinary reply, formal review, status-note projection      | Unchanged; the four daemon API clients gain a resolved base URL                                                                     |
| Console links to merge requests, pipelines, jobs           | Already correct — the daemon broker and the relay read `web_url` from the provider instead of composing it                          |
| Workspace repository links                                 | Already correct — the console parses the stored clone URL rather than composing a host                                              |
| `CodeHostRepository`, claims, bindings, hook resources     | Shapes unchanged; the three synthesized `https://gitlab.com/<path>` clone URLs are deleted in favor of the persisted provider value |
| Git credential injection and the credential helper         | Host becomes a spec-supplied value instead of a two-literal classifier (Section 6.3)                                                |
| `glab` shim                                                | Must now _set_ `GITLAB_HOST` for the real CLI instead of only reading it as a signal to defer                                       |
| Deployment configuration                                   | One new value (Section 6.1)                                                                                                         |
| Feature negotiation                                        | One new string, `gitlab-instance-v1` (Section 6.5)                                                                                  |

The base design's central invariant is untouched: the Control Plane is still
not on the webhook hot path, still stores no message content, and still never
writes into a merge-request conversation.

## 5. The 18.11 Version Floor

### 5.1 Why 18.11

Every property the runtime identity depends on became true for every tier at
18.11:

| Property                                                  | Status at 18.11                                              |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| Service accounts on the Free tier                         | Generally available; introduced disabled-by-default in 18.10 |
| Project service accounts                                  | Generally available; introduced 18.10, endpoints added 18.9  |
| Subgroup service accounts                                 | Generally available; introduced 18.10                        |
| Service accounts consume no billable seat                 | True on every tier and offering                              |
| Group service-account PAT create / list / revoke / rotate | Available since 17.9–17.11                                   |
| Top-level group Owners may create group service accounts  | Instance setting, generally available since 17.6             |

Below 18.11 the picture fragments. On 18.10 the Free-tier and
project/subgroup behavior sits behind instance feature flags
(`allow_subgroups_to_create_service_accounts`,
`allow_projects_to_create_service_accounts`, and the Free-tier flag) that an
operator may not have enabled and that the API does not report cleanly. 18.11
is the first version where one code path is correct for Free, Premium, and
Ultimate without probing flags.

### 5.2 What Breaks Below the Floor

Stated plainly, so the refusal message can be specific.

- **A Free instance below 18.11 cannot create a service account at all.**
  There is no fallback. The base design refuses to substitute a regular user
  account, and Section 3 of that document already rejected project access
  tokens because they are not a common Free path. Without a service account
  there is no bot identity, therefore no Git credential, no reply, no review,
  and no status note — the integration does not exist.
- **On 18.10 the answer depends on instance flag state.** Whether provisioning
  works becomes a property we cannot read, and a negative result is
  indistinguishable from a permission failure. Supporting it would mean
  shipping a probe whose failure mode is a misleading error.
- **Premium and Ultimate instances between 17.6 and 18.10** would largely work
  for group service accounts. They are still excluded: certifying a version
  range we cannot exercise on the Free tier buys a support obligation without
  buying a correct Free story, and a self-managed instance's tier can change
  under a live deployment at license renewal.
- **Project and subgroup service accounts** are unavailable before 18.10 and
  not generally available before 18.11, so the option evaluated in Section 7.5
  does not exist below the floor either.

There is no partial support tier. An instance below the floor is refused
before any user sees a Connect button.

### 5.3 Enforcing the Floor

Enforcement happens in two stages, because GitLab's version endpoint requires
authentication and the Setup Server holds no token at the moment an operator
types a base URL.

1. **Unauthenticated shape and reachability, at configuration time.** The
   Setup Server issues `GET <base>/api/v4/version` with no credential. A
   healthy GitLab API root answers `401` with GitLab's JSON error body. That
   proves the four things that fail far more often than the version does: DNS
   resolves, TLS terminates against a chain the process trusts, the base URL
   names an API root rather than a proxy in front of something else, and any
   relative URL root was entered correctly. It proves nothing about the
   version.
2. **Authenticated version check, at first credentialed contact.** The first
   authenticated call the Control Plane makes — with the administrator
   credential where one is configured, otherwise immediately after the first
   successful OAuth callback — is `GET /api/v4/version`. The `version` string
   is parsed as `MAJOR.MINOR`, tolerating the `-ee` / `-pre` suffixes, and
   compared against the floor. The result is recorded on the deployment's
   instance record with its observation timestamp and whether the instance
   reports Enterprise Edition.

Below the floor the connection is refused, no provisioning begins, the GitLab
surface reports `instance_version_unsupported` with the observed version, and
the Console explains that the deployment requires 18.11 or later. An
unparseable version is treated as below the floor: fail closed. The recorded
version is refreshed on every reconciliation pass, so an instance downgraded
under a live deployment converges on the same refusal instead of quietly
losing provisioning.

The floor gates _provisioning_, not _runtime_. An instance that drops below
the floor after bindings exist keeps serving existing sessions on existing
credentials until they expire — the same bounded degradation as an unavailable
Control Plane in Section 19.1 of the base design. It simply cannot mint
anything new.

## 6. The Instance Host as a Configuration Axis

### 6.1 Where the Base URL Lives

The base URL is deployment configuration, stored exactly where the OAuth
application it belongs to is stored. The GitLab entry in the Setup Server's
typed deployment document gains one value:

| Key                              | Kind                | Meaning                                              |
| -------------------------------- | ------------------- | ---------------------------------------------------- |
| `values.gitlab.baseUrl`          | configuration value | Instance base URL; absent means `https://gitlab.com` |
| `values.gitlab.clientId`         | configuration value | Unchanged                                            |
| `secrets['gitlab.clientSecret']` | write-only secret   | Unchanged                                            |

The document schema is a strict object today, so adding a member is a
deliberate schema bump rather than a silently additive change — which is the
right shape for a field that changes which host receives credentials.

The projection into process configuration mirrors the existing pair exactly:
`GITLAB_BASE_URL` joins the managed environment keys, the document overlays
plain environment variables, and plain `GITLAB_BASE_URL` remains the
no-document fallback for deployments that never ran the Setup Server. The
existing all-or-nothing validation for the client pair extends to the new
value: a base URL without an application is a configuration error, not a
half-enabled feature.

Normalization happens once, where the application configuration is resolved,
and the normalized value is the only one anything downstream sees:

- the scheme must be `https`; `http` is refused;
- userinfo, query, and fragment are refused;
- the host is lower-cased and an explicit non-default port is preserved;
- a trailing slash is stripped;
- a path prefix is **preserved**, because a relative URL root is a first-class
  self-managed install shape.

### 6.2 Composing URLs From It

Three families of URL are composed from the base, and the path prefix is the
trap in all three:

```text
API      <base>/api/v4/<path>
OAuth    <base>/oauth/{authorize,token,revoke}
Clone    provider-supplied http_url_to_repo — never composed
```

Composition is string concatenation onto the normalized, slash-stripped base.
It must not use URL resolution against an absolute path, because
`new URL('/api/v4/projects', 'https://gitlab.example.test/gitlab')` discards
the prefix and silently produces a URL that answers nothing. This is the
single most likely implementation bug in the whole change and Section 16 puts
a test on it.

Clone URLs are never composed. The reconciler already persists
`http_url_to_repo` from the provider onto `CodeHostRepository.cloneUrl`, which
is correct on any host and already carries GitLab's `.git` suffix. The three
places that synthesize `https://gitlab.com/<path>` today are deleted rather
than parameterized; a synthesized clone URL is a second source of truth that a
configurable host turns from redundant into wrong.

The Control Plane's GitLab API module already accepts an optional per-request
base URL that no production caller passes. It becomes a client bound to the
resolved base at container build time, the module-level constant disappears,
and the two functions that bypass the shared request helper — the token
exchange and the paginated project list — are folded back onto it.

### 6.3 How the Host Reaches the Daemon

The daemon needs the host earlier than most people expect. It is not only an
API base: it selects the `credential.https://<host>` block written into the
agent's git configuration at spawn time, the clone-time `GIT_CONFIG_*` pairs,
and the repository-local helper configuration. All three are established
before the first fetch. A host learned at first API call would be too late.

The authoritative carriers are therefore the two frames that already describe
the work:

- **`AgentWorkspace`, `mode: 'gitlab'` arm** gains `host`. This covers every
  workspace materialization, credential injection, and `glab` invocation.
- **The compiled hook rule's `gitlab` member, and the trusted GitLab metadata
  the relay forwards on the hook delivery,** gain `host`. This is necessary
  and not redundant: a hook turn can run for an agent whose workspace is not a
  GitLab workspace, and the poster and status-note projector still need a base
  URL for that turn.

The relay copies the field through as opaque data. It composes no URL, dials
no GitLab endpoint, and delegates membership authorization to the Control
Plane, so this pass-through is its entire share of the change.

**`GitCredGrant` gains an optional `host`** — not as the carrier, but as the
echo. The consumer already verifies that a grant's provider and numeric
project ID match the request before returning a password; the host joins that
check. A grant whose host disagrees with the workspace spec is rejected, which
makes "the Control Plane handed out a credential for the wrong instance" a
detected condition rather than a silent one.

`register/ok` deliberately gains nothing. Handshake members have bitten this
fleet before: a strict decode on an older daemon turns a new optional field
into a reconnect loop that also kills that daemon's GitHub work. The host is
per-workspace data and belongs on per-workspace frames.

On the daemon the two-literal classifier is retired. `ManagedCredentialHost`
stops being the closed union `'github.com' | 'gitlab.com'` and stops being
inferred by sniffing the clone URL's hostname; it is resolved from the spec's
provider and host, and the clone URL is then _checked against_ it — which is
precisely what the existing trusted-origin check already does. Sniffing would
be the wrong direction anyway: it would let a tenant-set repository URL
nominate itself as a managed host.

Four consequences follow mechanically:

1. The `.git`-suffix canonicalization, added because GitLab redirects the
   suffix-less HTTPS probe and the daemon refuses redirects, becomes
   conditional on the provider rather than on the `gitlab.com` literal. GitLab
   behaves the same way on any instance. In practice it becomes a safety net,
   because the provider-supplied clone URL already carries the suffix.
2. The workspace materialization key and the repository-local helper
   configuration take the resolved host instead of a literal.
3. The hidden Git credential helper's gate — today "answer only for
   `github.com` or `gitlab.com`, and choose the project-path parser from that
   literal" — becomes "answer only for a host in the injected managed-host
   table, and choose the parser from that entry's provider". The helper is
   bundled for the sandbox and may import only Node builtins, so the table
   arrives the way the agent identity and socket path already do: as an
   `AC_GITCRED_*` environment value written at injection time. It is never
   read from the agent's own environment as a hint.
4. The four daemon GitLab API clients — poster, broker, note projector, review
   adapter — already accept an optional base URL that production never
   supplies, which is why they all fall back to the same literal. They now
   resolve it from the turn's workspace or hook metadata. Because a deployment
   has exactly one instance, that resolution always returns the same value;
   keeping it a per-turn lookup rather than a boot-time constant costs nothing
   and avoids a second place where "one instance" is assumed rather than
   derived.

The `glab` shim inverts its current relationship with `GITLAB_HOST`. Today the
target resolver treats any `GITLAB_HOST` in the environment as a signal to
defer to the real CLI, and the shim never sets it — correct when the only
managed host is `gitlab.com`, useless when there is another. Now the daemon
**exports `GITLAB_HOST` into the agent session** so the real `glab` targets the
right instance, and the resolver compares the resolved target against an
expected host passed to it explicitly, deferring only on a genuine mismatch.
The existing "a user-supplied `GITLAB_TOKEN` wins and the shim steps aside"
rule is unchanged, matching the `GH_TOKEN` pass-through precedent.

### 6.4 Origin Allowlist Interplay

The daemon's `workspaceGitAllowedOrigins` is the final boundary for every
tenant-selected network target, and it stays authoritative. Three rules:

1. **The default list is unchanged.** It keeps `https://gitlab.com`, because
   the default deployment is still GitLab.com. It does not gain a wildcard, a
   provider-shaped entry, or an implicit "whatever the Control Plane says"
   escape.
2. **The managed feature allows exactly the configured origin.** For a
   self-managed deployment the operator adds that one origin — scheme, host,
   and non-default port — to the daemon's list. Nothing widens it implicitly.
   This is the same sentence Section 13.2 of the base design writes about
   `gitlab.com`; only the value changes.
3. **The readiness check moves from boot to spec admission.** Today the daemon
   warns at boot if the list excludes the `https://gitlab.com` literal — a
   check it can no longer make, because at boot it does not know which
   instance the deployment uses. Instead, when a GitLab workspace spec arrives
   whose origin the policy excludes, the daemon refuses the workspace with an
   explicit reason and reports it, so the Console can say "this daemon's
   origin policy excludes `https://gitlab.example.test`" instead of surfacing
   a clone failure. The generic boot warning survives only in the degenerate
   form: no GitLab origin is permitted at all.

The failure is a refusal, not a widening. An operator who has deliberately
narrowed the list has made a policy statement, and a managed feature must not
overrule it.

### 6.5 Rolling Compatibility

One new feature string, `gitlab-instance-v1`, advertised by a daemon or relay
that implements its complete slice. It gates on the _configured value_, not on
the code path:

- **Configured host is `https://gitlab.com`.** Nothing is gated. Old and new
  daemons behave identically, and a mixed fleet is exactly today's fleet. This
  is what makes the change safe to deploy before anyone uses it.
- **Configured host is anything else.** The Control Plane must not place a
  GitLab-backed agent on a daemon that has not advertised the feature, must not
  include a GitLab-shaped workspace or placement in a snapshot sent to one, and
  must not assign a GitLab hook to a relay that has not advertised it.

The gate is fail-closed **by omission**, which is the important property. An
older daemon does not receive a self-managed workspace and reject it; it never
receives one. It therefore cannot clone from the wrong host, because it has no
repository to clone. This follows Section 17.3 of the base design exactly: the
daemon reads Control-Plane-authored frames tolerantly, so a new optional
member is rolling-safe, but tolerance is precisely why the Control Plane —
not the daemon — has to enforce the gate.

Three defenses sit behind it:

1. a `gitlab-instance-v1` daemon rejects a grant whose echoed host disagrees
   with the workspace spec (Section 6.3);
2. the trusted-origin check refuses a checkout whose actual `origin` is not
   the resolved managed host; and
3. the operator origin allowlist refuses the clone outright unless the exact
   origin is permitted (Section 6.4).

An absent `host` on a workspace or hook frame means `https://gitlab.com`, so
a new daemon reading an old Control Plane's frames is correct without a second
negotiation.

The existing `gitlab-com-v1` feature keeps its name. Feature strings are
opaque identifiers advertised by a live fleet; renaming one to remove a `.com`
that is now a misnomer would be a fleet-wide breaking change bought with
nothing. The name is documentation debt, not a defect, and this paragraph is
the repayment.

### 6.6 Why Not Multiple Instances

A single deployment-level instance is a deliberate ceiling, not an
implementation shortcut. Making the host per-connection would require, at
minimum:

- **an OAuth application per instance**, since an application is registered on
  the instance it authenticates against — so the Setup Server's single GitLab
  card becomes a list, and the configuration resolver stops being a
  both-or-none pair;
- **an instance dimension on the deployment-global repository claim.** Its
  uniqueness key is `(provider, externalId)`, and a numeric project ID is only
  unique within one instance. Two instances make that key wrong, and it is a
  shipped constraint protecting cross-tenant ownership — the migration is not
  cosmetic;
- **an instance selector in every project picker**, the hook wizard, the
  workspace picker, and the additional-repository picker;
- a creation-prerequisite check per instance,
  rotation, and health;
- **an origin allowlist entry per instance on every daemon**, plus a
  managed-host table in the credential helper that is genuinely multi-valued
  rather than incidentally so; and
- **a certificate-authority bundle that satisfies all of them at once**, since
  the trust store is process-wide.

The demand does not justify that. An organization running self-managed GitLab
runs one instance; the second is a migration, not a steady state. The revisit
trigger is concrete: a customer with two instances they intend to keep. At
that point the instance becomes a first-class resource, and the claim-key
migration is the first pull request, not the last.

Section 6.3's per-turn base-URL resolution is written so that this ceiling is
an assertion the Control Plane makes rather than an assumption the daemon
bakes in.

## 7. Service Accounts on a Self-Managed Instance

This is the only place where a self-managed instance is behaviorally different
rather than merely differently addressed.

### 7.1 The Creation Prerequisite

On GitLab.com, a top-level group Owner may create a group service account, so
the installing user's OAuth connection is sufficient and the base design needs
no other identity.

On a self-managed instance the default is stricter: **only instance
administrators may create a service account of either kind.** An administrator
can lift that for group service accounts with the instance setting "Allow
top-level group owners to create Service accounts" (Admin → Settings → General
→ Account and limit), generally available since 17.6. That setting is this
design's single supported path: with it enabled, the installing user's OAuth
connection provisions exactly as on GitLab.com. A connection whose user
happens to be an instance administrator satisfies the same code path without
the setting — creation authority is the instance's judgment, never this
product's.

The prerequisite is **not discoverable through the API**: the setting is not
among the documented application-settings attributes, and the only way to
observe it is to attempt a creation and interpret a `403`. Probing by attempt
is unacceptable — it converts a configuration question into half-provisioned
external state — so the deployment does not probe. The truth arrives at the
first inline account ensure, where a `403` from service-account creation is
classified as `service_account_creation_forbidden` on the account row: an
actionable, translated state whose remedy names the instance setting and its
Admin Area path. Nothing else degrades (Section 7.4), and nothing is adopted
or retried until an operator acts.

### 7.2 Delegated Creation, Per Agent

Nothing changes from the base design. The installing user connects with the
`api` scope and must be an Owner of the project's top-level group; the
per-agent account machinery of base Section 7.2 runs unmodified — one group
service account per (organization, agent, top-level group), created by the
inline pre-activation ensure under the account mutation lease, with the same
username scheme, the same persisted creation-attempt recovery window, the
same display-name and avatar convergence, the same coalesced project
convergence, and the same retirement sweep. A self-managed instance changes
only whether the create call is permitted.

That identity of paths is worth more than it sounds: the GitLab.com contract
suite covers the self-managed provisioning path too, and an operator
debugging either deployment reads one design.

### 7.3 Rejected: The Administrator Credential

An earlier draft designed a second posture for instances that do not
delegate: an instance administrator personal access token with the `api` and
`admin_mode` scopes, held as a write-only deployment secret and confined to a
structurally separate service-account lifecycle port. It was rejected:

- it is **deployment-scoped**, crossing the organization boundary every other
  GitLab credential in the product respects — a Control Plane compromise
  would expose an instance-administrator credential rather than the selected
  projects' credentials;
- it is a **single point of provisioning failure** with no self-healing: an
  expired or demoted token silently breaks account creation and rotation
  deployment-wide, surfacing as bots going quiet weeks later; and
- what it buys — supporting an instance whose administrator declines a
  one-line setting while demanding this product — does not justify an
  instance-wide secret.

Two adjacent shapes were rejected with it. An administrator OAuth connection
makes deployment-wide provisioning depend on a browser flow and refresh-token
rotation, and the connection resource is organization-scoped by design.
Operator-created accounts pasted into the deployment defeat create-or-recover,
rename and avatar convergence, rotation, and retirement, and turn project
selection into a ticket.

**Revisit trigger:** a real customer whose security policy forbids the
delegation setting and who accepts an instance-administrator secret in the
Control Plane. The required shape is then the enumerated lifecycle port this
document's history records — a method set the general API client cannot be
constructed with — not a general administrator client.

### 7.4 Absence of the Prerequisite

With the setting disabled — including re-disabled after adoption — and a
non-administrator connection:

| Capability                                        | Effect                                                                                                                                                      |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing sessions, replies, reviews, projections  | Unaffected                                                                                                                                                  |
| Existing accounts, webhooks, and membership gates | Unaffected                                                                                                                                                  |
| New agent-account creation                        | Refused; the account row lands `service_account_creation_forbidden` with the setting named                                                                  |
| PAT rotation on existing accounts                 | Verify during implementation: if the instance gates token minting like creation, rotation fails with the same specific reason as the 90-day horizon arrives |
| Retirement of an emptied account                  | The durable retirement obligation stays pending until authority returns                                                                                     |

If rotation is gated, that row is the one that eventually breaks runtime, and
the existing rotation-horizon warning must carry this specific reason rather
than the generic one: an operator learns the setting was disabled from a
warning, not from a bot going silent weeks later.

### 7.5 Group Service Account, Per Agent, Not Project Service Account

Project service accounts also reached general availability in 18.11, so the
option is genuinely on the table. **Recommendation: keep the shipped
per-agent group service account.** Three reasons, in order of weight.

1. **It is the only delegable scope on self-managed.** The one documented
   instance setting delegates _group_ service-account creation. Project
   service accounts have no such setting, so adopting them would make every
   self-managed deployment administrator-only — the credential Section 7.3
   rejects.
2. **It is the shipped identity.** Base Section 7.2's model — one account per
   (organization, agent, top-level group), membership following the agent's
   authorization across the root's projects — depends on the account being
   invitable within its hierarchy. A project service account cannot follow
   its agent to a second project at all.
3. **The quota changes but the shape does not.** On Free, GitLab.com allows
   100 service accounts per top-level group; a self-managed Free or Community
   Edition instance allows **100 for the entire instance**, counting every
   agent-and-root pair across all organizations, minus whatever the
   customer's own automation uses. The shipped `service_account_quota`
   refusal covers it; the operator documentation states the tighter ceiling.
   Paid tiers lift the limit.

### 7.6 What the Setup Server Says

There is no posture control and no credential field. The GitLab card states
the prerequisite as one line of copy with the exact path — enable Admin →
Settings → General → Account and limit → "Allow top-level group owners to
create Service accounts", or connect as an instance administrator — and is
honest that it cannot verify it: no non-mutating call reveals the setting, so
the first provisioning attempt is where the truth arrives, as
`service_account_creation_forbidden` on the account row rather than buried in
a log.

## 8. Trust and Network

### 8.1 TLS and Private Certificate Authorities

A self-managed instance frequently presents a certificate chaining to the
customer's own authority. The design supports that through process trust
configuration and nothing else, following the precedent this repository
already sets for self-hosted HTTPS: supply the root to Node with
`NODE_EXTRA_CA_CERTS`, and treat verification bypass as a short diagnostic
that never becomes configuration.

Where the bundle has to be configured:

| Component               | What it dials                                                              | How trust is configured                                                                               |
| ----------------------- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Control Plane           | OAuth token exchange, provisioning, membership authorization, re-run reads | `NODE_EXTRA_CA_CERTS`                                                                                 |
| Relay                   | **Nothing on the instance**                                                | Not applicable; it needs a certificate the _instance_ trusts on its own public endpoint (Section 8.3) |
| Daemon process          | The four GitLab API clients                                                | `NODE_EXTRA_CA_CERTS`                                                                                 |
| Daemon Git              | Clone, fetch, push                                                         | `GIT_SSL_CAINFO`, or `SSL_CERT_FILE` / `SSL_CERT_DIR`                                                 |
| Sandbox / agent runtime | Git and any agent-initiated call to the instance                           | The same variables, with the bundle present inside the sandbox                                        |

The daemon already forwards `SSL_CERT_FILE` and `SSL_CERT_DIR` into its skill
Git acquisition environment, and `NODE_EXTRA_CA_CERTS` and `SSL_CERT_FILE`
into runtime probe and install environments. The change is to extend the same
allowlists to the workspace clone environment and the agent session
environment — an addition to an existing, deliberately narrow list, not a new
mechanism.

One deployment-side consequence deserves naming because it is easy to miss:
these variables are _file paths_, so for a containerized sandbox the bundle
must exist inside the sandbox filesystem. Making the path available there is
an operator task; the design's obligation is to forward the variable and to
fail with a legible error when the file is absent.

Explicitly unsupported: any per-connection verification bypass, a
`GIT_SSL_NO_VERIFY` pass-through, or a documented instruction to disable Node's
TLS verification. If the chain does not verify, the probe reports
`instance_tls_untrusted` and provisioning fails.

### 8.2 Egress

Three components need outbound reachability to the instance, and a customer
may firewall them differently because they sit in different network positions:

- **Control Plane → instance**, for OAuth token exchange, the provisioning
  saga, membership authorization on every gated event, and re-run subject
  reads.
- **Daemon → instance**, for Git over HTTPS and the four API clients.
- **Sandbox → instance**, for the agent's own Git operations and read-only
  `glab` invocations.

The sandbox namespace is default-deny, so the instance host must be explicitly
permitted for sandboxed agents; this is a deployment-side requirement stated in
operator documentation, and no chart or overlay specifics belong in this
design. Two failure shapes are worth calling out in that documentation because
they are new with self-managed: an egress policy written to permit only public
destinations will block an instance on a private address, and a policy written
against `gitlab.com` by name will silently do nothing useful.

**There is exactly one base URL, and every component uses it.** A deployment
that wants an internal address for the Control Plane and a public one for
users cannot have both, because the base URL determines the clone URLs
recorded on repositories, the origin the credential helper answers for, the
OAuth redirect the browser follows, and the `web_url` values GitLab itself
returns in payloads and API responses. A pair would make those disagree, and
the disagreement would surface as a clone that works from the daemon and a
link that 404s for the user — or worse, a credential helper that declines to
answer for the host Git actually asked about. Deployments needing different
paths to the same address should solve it in DNS, not in configuration.

### 8.3 Webhook Reachability, Both Directions

**Instance → relay** is the only inbound path, and it has a self-managed-only
obstacle. GitLab blocks webhook and integration requests to the local network
by default — loopback, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, IPv6
site-local, and the instance's own address. A relay whose public origin
resolves to a private address will therefore never receive a delivery, and the
webhook will appear installed and silent.

The instance administrator must fix this, and the design states the preference:
add the relay host to Admin → Settings → Network → Outbound requests → "Local
IP addresses and domain names that hooks and integrations can access", rather
than enabling "Allow requests to the local network from webhooks and
integrations" instance-wide. The allowlist accepts hostnames, addresses,
ranges, and optional ports, up to 1000 entries of 255 characters, with no
wildcards. Narrowing to one host is strictly better than opening every
webhook on the instance to the internal network.

Webhook creation must classify the instance's rejection of a blocked URL as
its own reason rather than a generic provisioning failure, and the operator
documentation must list this as a prerequisite next to the relay's public
origin.

**Relay → instance does not exist.** The relay verifies a signature over the
raw body with a key delivered inline on its compiled rule, and delegates every
live authorization decision to the Control Plane. It issues no outbound
request to GitLab at all. This is worth stating positively: a self-managed
instance needs no inbound allowance for the relay, and the relay needs no
certificate-authority configuration for the instance.

### 8.4 Proxies

Node's global fetch does not honor `HTTP_PROXY` / `HTTPS_PROXY`, while Git has
its own proxy configuration. An environment that forces egress through a proxy
therefore needs a deliberate implementation, and this design scopes it out of
the first slice: the instance must be directly reachable from the Control
Plane, the daemon, and the sandbox.

The shape of the eventual answer is recorded so it is not invented ad hoc
under pressure: a proxy-aware dispatcher configured from `HTTPS_PROXY` and
`NO_PROXY` installed at the Control Plane and daemon HTTP seams, plus Git's
own proxy variables added to the workspace and session environment allowlists.
It is one coherent change across both seams, not a per-call option.

### 8.5 Latency Budgets

Two timeouts that are comfortable against GitLab.com become interesting
against an instance reached over a saturated internal link or a VPN: the
general API timeout of ten seconds, and the membership-authorization timeout
of four seconds, which exists because it has to fit inside the relay's
five-second request correlator.

The membership one matters more, because its failure mode is fail-closed: an
unavailable membership lookup denies the turn. On a slow instance that
presents to users as "the bot ignores me sometimes" and to operators as
nothing at all.

The decision for this slice is to keep both values and to make the failure
legible: count and surface authorization timeouts as their own outcome,
distinct from a genuine permission denial, so a slow instance is diagnosable
from the Console. Do not make them configurable yet. If they ever become
configurable they must be a single derived pair, because an operator who
raises the membership timeout above the relay correlator converts a
fail-closed denial into a dropped delivery — a strictly worse failure that
looks like a fix.

### 8.6 What Is Not Supported

Certificate-verification bypass at any layer; plain HTTP instances; a split
internal/external base URL; an egress proxy in the first slice;
client-certificate authentication to the instance; SSH remotes for managed
workspaces; and any configuration in which the relay's public origin is not
reachable from the instance.

## 9. API-Surface Parity Within the Floor

### 9.1 The Endpoints the Integration Uses

Every endpoint below exists and behaves identically on a self-managed instance
at 18.11. The only version-sensitive family is service accounts, which is
precisely why the floor is where it is.

| Family               | Endpoints                                                                                                                              | Self-managed note                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| OAuth                | `GET /oauth/authorize`, `POST /oauth/token`, `POST /oauth/revoke`                                                                      | On the instance root, so a relative URL root applies; the application is registered by hand |
| Identity             | `GET /api/v4/user`                                                                                                                     | Unchanged                                                                                   |
| Discovery            | `GET /projects?membership=true…` with `x-next-page`, `GET /projects/:id`, `GET /namespaces/:parentId`                                  | Unchanged; personal namespaces still refused                                                |
| Membership           | `GET /projects/:id/members/all/:userId`, `POST /projects/:id/members`, `PUT /projects/:id/members/:userId`                             | Unchanged; see the latency note in Section 8.5                                              |
| Service accounts     | `GET` and `POST /groups/:g/service_accounts`, `PATCH` and `DELETE /groups/:g/service_accounts/:u`                                      | **The floor's reason.** Creation requires the delegation prerequisite (Section 7)           |
| Service-account PATs | `GET` and `POST /groups/:g/service_accounts/:u/personal_access_tokens`, `DELETE …/:tokenId`                                            | Expiry may be clamped by an instance maximum (Section 9.2)                                  |
| Webhooks             | `GET` and `POST /projects/:id/hooks`, `PUT` and `DELETE /projects/:id/hooks/:hookId`, `POST /projects/:id/hooks/:hookId/test/:trigger` | Local-network blocking and per-project hook limits apply (Sections 8.3 and 9.2)             |
| Notes                | `POST` and `PUT /projects/:id/{issues,merge_requests}/:iid/notes`                                                                      | Unchanged; used by the poster and the status-note projection                                |
| Discussions          | `GET /…/discussions`, `GET /…/discussions/:id`, `POST /…/discussions/:id/notes`                                                        | Unchanged                                                                                   |
| Draft notes          | `GET` and `POST /…/draft_notes`, `PUT` and `DELETE /…/draft_notes/:id`, `POST /…/draft_notes/bulk_publish`                             | Unchanged; the inline-review transport on every tier                                        |
| Approvals            | `GET /…/approvals`, `POST /…/approve`                                                                                                  | Approval may be refused by reauthentication policy (Section 10)                             |
| Reviewers            | `PUT /…/reviewers` reads only; AgentConnect never mutates the reviewer list                                                            | Request-changes remains Premium-effective                                                   |
| Merge-request state  | `GET /projects/:id/merge_requests/:iid` including `detailed_merge_status`, `GET /…/versions`                                           | Unchanged                                                                                   |
| Issues               | `GET /projects/:id/issues/:iid`                                                                                                        | Unchanged                                                                                   |
| Pipelines and jobs   | `GET /…/pipelines`, `GET /…/pipelines/:id`, `GET /…/pipelines/:id/jobs`, `GET /…/jobs/:id`, `POST /…/{retry,cancel}`                   | Unchanged; a project may have CI disabled, which the broker already reports                 |
| Instance metadata    | `GET /api/v4/version`                                                                                                                  | New use: the version floor (Section 5.3). Requires authentication                           |

### 9.2 Instance Settings That Reshape the Integration

These are the self-managed-only knobs. Each one is a supported condition with a
specific reason code, not an unhandled failure.

| Setting                                                                                          | Effect                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Allow top-level group owners to create Service accounts"                                        | The creation prerequisite (Section 7.1). Not readable through the API                                                                                      |
| "Allow requests to the local network from webhooks and integrations", and the outbound allowlist | Determines whether the relay ever receives a delivery (Section 8.3)                                                                                        |
| "Maximum allowable lifetime for access tokens" (Ultimate)                                        | May clamp a minted token below the 90-day policy — see below                                                                                               |
| "Require expiration dates for new access tokens" (on by default)                                 | Harmless; AgentConnect always sends an explicit `expires_at`                                                                                               |
| `service_access_tokens_expiration_enforced` (Premium/Ultimate)                                   | Harmless for the same reason; the base design already refuses to rely on a provider default                                                                |
| Instance rate limits                                                                             | Typically stricter than GitLab.com's; the existing normalized rate-limit mapping and backoff apply and the Console shows it                                |
| Free instance-wide service-account quota of 100                                                  | A hard ceiling on per-agent accounts per instance (Section 7.5)                                                                                            |
| Per-project webhook count limit                                                                  | AgentConnect installs exactly one webhook per binding, so it only matters on a project already near the limit; the failure is reported as a webhook reason |
| Community Edition                                                                                | No Premium behavior at all; Section 10                                                                                                                     |

The token-lifetime clamp is the one that changes an existing rule. The base
design validates a returned token before sealing it and treats "a null, later,
or otherwise mismatched expiry" as out of policy, revoking the token and
failing closed. On a self-managed instance an **earlier** expiry is legitimate:
the instance maximum is the operator's policy and it wins over ours. So the
rule becomes:

- an expiry **earlier than requested** is accepted, and the rotation horizon is
  re-derived from the returned value rather than from the 90-day policy — a
  30-day instance cap must produce rotation warnings on a 30-day cycle, not a
  90-day one;
- an expiry that is **null or later than requested** stays out of policy, is
  revoked, and fails closed exactly as today;
- a creation **rejected** for exceeding the instance maximum produces a
  distinct reason naming the cap, so the operator sees a configuration
  mismatch instead of a mysterious provisioning error.

This is a small rule, but it is the only place where a correct GitLab.com
implementation is wrong on self-managed rather than merely differently
addressed, so it gets its own test in Section 16.

## 10. Tier Semantics on Self-Managed

Section 15.3 of the base design already reports observed outcomes rather than
querying a tier, which is exactly the property a self-managed deployment needs:
a license can change under a running deployment, and Community Edition has no
license to query at all. The matrix restated, with the self-managed
differences marked:

| Capability                             | Self-managed Free / CE       | Self-managed Premium / Ultimate                      | Difference from GitLab.com                             |
| -------------------------------------- | ---------------------------- | ---------------------------------------------------- | ------------------------------------------------------ |
| Group service accounts                 | Supported from 18.11         | Supported                                            | Creation requires the delegation setting (Section 7.1) |
| Service-account seats                  | Non-billable                 | Non-billable                                         | None                                                   |
| Service-account quantity               | **100 per instance**         | Unlimited                                            | GitLab.com Free is 100 per top-level group             |
| Project webhooks                       | Supported                    | Supported                                            | Local-network blocking applies (Section 8.3)           |
| Draft review notes and bulk publish    | Supported                    | Supported                                            | None                                                   |
| Approval API                           | Supported; approval optional | Approval rules may make it required                  | None                                                   |
| Request changes                        | Visible, non-blocking        | Can block merging once a human requests the reviewer | None                                                   |
| Approval reauthentication policy       | May disable bot approval     | May disable bot approval                             | None; report and never borrow a human credential       |
| Group webhooks, external status checks | Not used                     | Not used                                             | None; still out of scope                               |
| Project access tokens                  | Not used                     | Not used                                             | None                                                   |

Community Edition deserves one explicit sentence because it has no GitLab.com
analogue: it is a distinct build with the Premium and Ultimate code absent
entirely, not a licensed instance with features switched off. Everything in
the Free column applies; the instance metadata endpoint reports it, and the
Console shows it beside the version so a user asking why request-changes is
advisory has an answer on the same card.

AgentConnect still never edits reviewer lists, never changes approval rules,
and never claims a Free change request is blocking.

## 11. Setup Server and Console Surface

### 11.1 The GitLab Card

GitLab is the one provider the Setup Server cannot verify automatically today,
and it shows a badge saying so. Self-managed makes that badge partly obsolete:
the instance itself becomes verifiable even though the OAuth application does
not.

The card gains:

- **Instance URL**, defaulting to `https://gitlab.com`, with the normalization
  rules of Section 6.1 applied on save and the reasons for a rejection shown
  inline.
- **The service-account prerequisite**, one line of copy per Section 7.6 —
  nothing to configure and nothing the card can verify.
- **A probe result**, per Section 11.2.

Existing copy and links become host-aware. The "Open GitLab applications"
button targets the configured instance's user application settings, and for an
instance administrator registering an instance-wide application the card also
offers the administrator applications path, with one line explaining which to
use. The card's prose stops saying "GitLab.com" where it means "your GitLab".
The redirect URI and scope list are unchanged — they are derived from the
Control Plane's own public URL, which was never host-dependent.

### 11.2 The Probe

One button, staged results, each with its own message:

| Result                  | Meaning                                            | Blocks save |
| ----------------------- | -------------------------------------------------- | ----------- |
| `invalid_url`           | Not HTTPS, or carries userinfo, query, or fragment | Yes         |
| `unreachable`           | DNS or connection failure from the Setup Server    | No, warns   |
| `tls_untrusted`         | Certificate chain not trusted by this process      | No, warns   |
| `not_a_gitlab_api_root` | Responded, but not as a GitLab API root            | No, warns   |
| `ok`                    | Shape valid, reachable, TLS trusted                | —           |

Only shape and scheme block a save. Reachability does not, because the Setup
Server and the Control Plane are not guaranteed to sit at the same network
position, and refusing to record a correct URL because one process cannot reach
it would be a worse failure than a warning. The authoritative version check
belongs to the Control Plane at first credentialed contact (Section 5.3), and
its result appears on the Console rather than the Setup Server, because it can
change without anyone touching configuration.

### 11.3 Console

The Connections card shows the same facts it shows today, with the literal
`gitlab.com` badge replaced by the configured instance host and two new
deployment-level rows: the observed instance version with its floor status,
and the stated service-account prerequisite. The group chips on the bot rows
continue to link to each account's profile, now
on the configured host, which means the connection DTO carries a non-secret
`instanceUrl`.

Everything else in the Console is already correct on any host and needs no
change: workspace repository links are parsed from the stored clone URL, and
merge-request and issue links come from the provider's own `web_url` values
carried on the webhook payload. That is a pleasant consequence of the base
design's rule that provider-supplied identity beats composed identity, and it
is worth preserving deliberately rather than by luck.

No new REST routes. The connection DTO gains `instanceUrl` and
`instanceVersion`; the runtime-config snapshot continues to report only
whether GitLab is available.

## 12. Failure, Recovery, and Degradation

The base design's Section 19 applies unchanged. Three situations are
self-managed-specific:

- **Instance unreachable.** Identical bounded degradation to an unavailable
  Control Plane: existing relay-to-daemon routing continues, local sessions
  continue, cached grants work until their lease expires, and new remote
  operations fail closed. Nothing is lost; the outbox reconciles later.
- **Instance certificate rotated to an untrusted chain.** The sharpest
  self-managed failure, because it takes out the Control Plane's API calls and
  the daemon's Git at the same moment. The probe's `tls_untrusted` result and
  the operator documentation's certificate-authority step exist to make this a
  known step rather than an outage, and the failure must name TLS explicitly
  rather than surfacing as a generic connection error.
- **Instance downgraded below the floor.** Provisioning and rotation stop with
  `instance_version_unsupported`; runtime continues until credentials expire.

Rollback from self-managed support means returning the configured base URL to
`https://gitlab.com` or unsetting it. Existing self-managed bindings then stop
provisioning and rotating but are not deleted, because the base design's rule
holds: rollback must never orphan external credentials by deleting only local
metadata.

## 13. Security Analysis — Delta

Only the new threats and controls; the base design's table stands.

| Threat                                                       | Control                                                                                                                          |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Older daemon clones a private project from the wrong host    | Fail-closed by omission on `gitlab-instance-v1`, plus grant host echo, trusted-origin check, and the operator origin allowlist   |
| Managed feature silently widens an operator's origin policy  | The policy stays authoritative; an excluded origin is a refusal with a named reason, never an implicit allowance                 |
| Private certificate authority becomes verification bypass    | No shipped code path reads a skip-verify flag; documentation offers a bundle, never a bypass                                     |
| Instance-wide local-network allowance opened for one webhook | Documentation prefers the host allowlist over the global toggle and explains the difference                                      |
| Hostile or compromised host at the configured base URL       | HTTPS with a verified chain, and the base URL is operator configuration rather than user input — but see the residual risk below |
| Instance rate limits used as a denial channel                | Normalized rate-limit mapping with backoff; no retry storm; visible in the Console                                               |
| Slow instance turns fail-closed denials into silent ignores  | Authorization timeouts counted and surfaced distinctly from permission denials (Section 8.5)                                     |

Residual risks specific to this design:

- **The operator is the trust root for the base URL.** A deployment pointed at
  a hostile host would send it OAuth codes and receive tokens from it. There is
  no cryptographic remedy inside the product; the control is that the value is
  operator configuration under the deployment's existing change process.
- **The instance's own policies can silently narrow the product.** Token
  lifetime caps, disabled features, and rate limits are all legitimate operator
  choices that reduce what AgentConnect can do. The design's answer is that
  every one of them has a named reason on a binding rather than a generic
  failure.

## 14. Rollout

1. Ship the host axis with `https://gitlab.com` as its default and prove that
   GitLab.com deployments compose byte-identical URLs.
2. Ship the version floor and the Setup Server probe, still on GitLab.com,
   where the floor is trivially satisfied.
3. Ship the protocol host carriage and the daemon plumbing behind
   `gitlab-instance-v1`; advertise the feature only when the complete slice is
   live on that daemon.
4. Ship the `service_account_creation_forbidden` classification, the expiry
   clamp, and the Console and Setup Server surfaces with the operator
   documentation.
5. Pilot against a real self-managed instance in a controlled environment
   covering the delegation setting enabled and disabled, Free and Premium, a
   private certificate authority, a path-prefixed install, and a relay origin
   that the instance must be told to allow.
6. Enable self-managed configuration generally.

Steps 1 and 2 are safe to deploy before anyone intends to use self-managed,
which is the point of making the axis default to GitLab.com rather than
introducing a mode.

Rollback follows Section 12.

## 15. Implementation Plan

Milestones are merge order, not calendar. Each is one or a few small,
independently mergeable pull requests; GitLab.com behavior stays green at every
merge; the Control-Plane and daemon halves of the protocol change are separate
merges because compatibility demands it. The spine is N0 → N1 → N2 → N3 → N4.

### N0 — The host axis in the Control Plane

- `GITLAB_BASE_URL` in the environment schema and the managed-key set; the
  deployment document's GitLab entry gains `baseUrl` (a deliberate strict-schema
  bump); normalization and validation per Section 6.1, colocated with the
  existing all-or-nothing application-configuration check.
- The GitLab API module becomes a client bound to the resolved base; the
  module-level host constant is removed; the token exchange and the paginated
  project list stop composing their own URLs; the OAuth service composes
  authorize and revoke from the same value.
- The three synthesized clone URLs are deleted in favor of the persisted
  provider value.
- Exit: with the axis unset, every composed request URL is asserted identical
  to today's; with it set to a prefixed, non-default-port host, every composed
  URL keeps prefix and port; the integration fake is mounted under a prefix in
  at least one test.

### N1 — Version floor and probe

- Version parsing and the floor constant; `instance_version_unsupported`;
  the recorded instance version refreshed by the reconciler; the Setup Server
  instance-URL field and the staged probe of Section 11.2.
- Exit: below-floor refusal integration test; version-string parsing units
  including suffixes and garbage; a save with an unreachable host warns rather
  than fails.

### N2 — Protocol host carriage (protocol, Control Plane, relay)

- `host` on the GitLab workspace arm, on the compiled hook rule's GitLab
  member, and on the trusted hook metadata the relay forwards; optional `host`
  on the credential grant; the `gitlab-instance-v1` feature string.
- The Control Plane's projection and placement gate: when the configured host
  is not `https://gitlab.com`, never project a GitLab-shaped spec, never place
  a GitLab-backed agent, and never assign a GitLab hook to a target that has
  not advertised the feature.
- Exit: mixed-version integration tests proving an older daemon receives no
  GitLab-shaped spec, placement, or rule on a self-managed deployment, and
  receives everything unchanged on a GitLab.com deployment.

### N3 — Daemon host plumbing

- The managed-host type opens and is resolved from the spec and hook metadata
  rather than sniffed from the clone URL; the `.git` canonicalization becomes
  provider-conditional; the trusted-origin check and materialization key
  follow; the repository-local helper configuration takes the resolved host.
- The credential helper's two-literal gate becomes an injected host-to-provider
  table delivered through the existing credential environment convention.
- The boot origin warning is replaced by the spec-admission readiness refusal
  of Section 6.4, reported to the Control Plane.
- The four API clients resolve their base URL per turn; the `glab` shim exports
  `GITLAB_HOST` and the target resolver compares against an explicit expected
  host instead of deferring whenever the variable is set.
- Exit: a helper unit table covering GitHub, GitLab.com, a self-managed host, a
  near-miss host, and an unknown host; clone, push, and `glab` integration
  against a fake instance on a non-default port behind a path prefix; a
  grant-host mismatch rejection test. Daemons carrying N3 may advertise
  `gitlab-instance-v1`.

### N4 — Prerequisite handling, Console, documentation, availability

- The `service_account_creation_forbidden` classification with its remedy
  copy; the earlier-than-requested expiry acceptance with a re-derived
  rotation horizon; `instanceUrl` and `instanceVersion` on the connection
  DTO; the card badge, group-chip links, version row, prerequisite copy;
  operator documentation covering the certificate-authority bundle, egress
  for all three components, the webhook local-network allowlist, the
  delegation setting, and the Free instance quota.
- Exit: a fake instance in admin-only mode driving the forbidden
  classification; the expiry-clamp test; rotation-horizon derivation from a
  clamped expiry. Pilot and general enablement per Section 14.

Two disciplines carry over from the base plan. No milestone contains a
big-bang refactor, and no feature string is advertised before its complete
slice is live.

## 16. Validation

Unit tests for the pure boundaries:

- base-URL normalization: scheme rejection, userinfo/query/fragment rejection,
  trailing-slash stripping, case folding, port preservation, prefix
  preservation;
- URL composition for the API and OAuth families,
  including the prefixed case that absolute-path URL resolution would break;
- version parsing and floor comparison, including `-ee` and `-pre` suffixes,
  a below-floor version, and an unparseable value that must fail closed;
- the credential helper's host-to-provider table, including a host that is a
  prefix or suffix of the managed host and must not match;
- `glab` target resolution against an explicit expected host, including the
  deferral cases and a user-supplied token taking precedence;
- credential-grant host echo verification, including absent-means-GitLab.com;
- the expiry policy: earlier accepted with a re-derived horizon, null rejected,
  later rejected.

Integration tests, extending the existing fake GitLab API server rather than
inventing a second one. The fake gains four modes:

- mounted under a path prefix and on a non-default port;
- **admin-only**, returning `403` from group service-account creation, so
  the `service_account_creation_forbidden` classification is exercised;
- **expiry-clamping**, returning an earlier `expires_at` than requested;
- **below-floor**, returning an old version — plus a webhook-create response
  that rejects a URL as local-network-blocked.

On top of those:

- the Section 6.5 mixed-version gate in both directions;
- a self-managed clone, fetch, and push through the credential helper with the
  origin present in, and then absent from, the operator allowlist;
- rotation-horizon derivation from a clamped expiry;
- the readiness refusal reaching the Control Plane with its origin named.

A **real self-managed smoke environment is a rollout step, not a continuous
integration job**: a disposable instance, exercised by hand or by a scheduled
job against the pilot checklist —

1. the delegation setting enabled and then disabled, confirming the
   forbidden classification and its remedy copy;
2. Free (or Community Edition) and a Premium licence;
3. a certificate from a private authority, with the bundle configured for the
   Control Plane, the daemon, and the sandbox;
4. a path-prefixed install on a non-default port;
5. a relay origin the instance must be told to allow, verified by observing a
   delivery arrive only after the allowlist entry exists;
6. connect, project selection, provisioning, and webhook test;
7. clone, push, and a read-only `glab` invocation;
8. one issue turn and one merge-request turn;
9. all three formal-review outcomes, with the Premium and Free difference
   observed rather than assumed;
10. one status-note lifecycle including supersession and an authorized re-run;
11. purpose-token rotation, including under an instance lifetime cap; and
12. disconnect, verified by the absence of the webhook, the tokens, and the
    service account on the instance.

The base design's final validation rule applies here with more force, because
this feature is _about_ addresses: source, fixtures, generated examples, logs,
and pull-request prose must be scanned for real deployment addresses,
identifiers, application IDs, tokens, and signing secrets. Every example in
this document uses a reserved name.

## Appendix A. Host-Assumption Inventory

> Inventoried against the tree before the per-agent identity milestone
> merged; the N0 implementation re-sweeps the literal sites (the per-agent
> account service, avatar broker, and admission seam added several since).

Every place that assumes GitLab.com today, and what it becomes. Comment-only
and copy-only sites are listed because they are user-visible or
reviewer-visible, and a stale "GitLab.com" in a doc comment is how the next
person learns the wrong invariant.

### Control Plane

| File                                                                                                                                                                                     | Assumption                                                                                                        | Change                                                                             |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/control-plane/src/gitlab/config.ts`                                                                                                                                            | `GITLAB_HOST` is a module constant pinned to `https://gitlab.com`; the app config is `{ clientId, clientSecret }` | Resolved per deployment; config gains `baseUrl`; normalization lives here          |
| `packages/control-plane/src/gitlab/api.ts`                                                                                                                                               | `API_BASE` derives from the constant; the token call and the project list compose their own URLs                  | Client bound to the resolved base; both bypasses folded back onto it               |
| `packages/control-plane/src/gitlab/oauth.service.ts`                                                                                                                                     | Authorize and revoke URLs composed from the constant                                                              | Composed from the resolved base                                                    |
| `packages/control-plane/src/gitlab/provisioner.ts`                                                                                                                                       | Path-only; already host-neutral, and persists the provider's own clone URL                                        | No structural change; gains the forbidden classification and the expiry-clamp rule |
| `packages/control-plane/src/gitlab/gitcred.service.ts`                                                                                                                                   | Grant carries provider, project ID, and path — no host                                                            | Grant echoes `host`                                                                |
| `packages/control-plane/src/container.ts`                                                                                                                                                | `syncWorkspacePaths` synthesizes `https://gitlab.com/<path>`                                                      | Deleted; read the persisted clone URL                                              |
| `packages/control-plane/src/http/routes/agents.ts`                                                                                                                                       | Two agent routes synthesize `https://gitlab.com/<path>`                                                           | Deleted; read the persisted clone URL                                              |
| `packages/control-plane/src/config/env.ts`                                                                                                                                               | Only client id and secret exist                                                                                   | Adds `GITLAB_BASE_URL`                                                             |
| `packages/control-plane/src/config/deployment.ts`                                                                                                                                        | Managed keys and the document overlay cover only the client pair                                                  | Adds the base URL to the managed keys                                              |
| `packages/control-plane/src/persistence/deployment-config.ts`                                                                                                                            | The GitLab document entry is a strict object with `clientId` only                                                 | Strict-schema bump: `baseUrl`                                                      |
| `packages/control-plane/src/http/dto/index.ts`                                                                                                                                           | Connection DTO carries no host                                                                                    | Adds `instanceUrl`, `instanceVersion`                                              |
| `packages/control-plane/src/gitlab/membership-authz.service.ts`                                                                                                                          | Four-second timeout sized for GitLab.com                                                                          | Unchanged value; timeouts counted and surfaced distinctly                          |
| `packages/control-plane/src/http/deps.ts`, `http/routes/gitlab.ts`, `http/plugins/openapi.ts`, `persistence/ports.ts`, `persistence/repositories/gitlab.repo.ts`, `prisma/schema.prisma` | Prose and doc comments say "gitlab.com"                                                                           | Reworded to "the configured GitLab instance"                                       |

### Daemon

| File                                                                                                                 | Assumption                                                                                                                                                           | Change                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/daemon/src/workspace/git-injection.ts`                                                                     | `ManagedCredentialHost` is a closed two-literal union of `'github.com'` and `'gitlab.com'`; the classifier sniffs the clone URL; the `.git` rule keys on the literal | Type opens; host resolved from spec and hook metadata; `.git` rule keys on provider |
| `packages/daemon/src/workspace/workspace-manager.ts`                                                                 | Trusted-origin check and materialization key fall back to `'github.com'`                                                                                             | Both take the resolved host; fallback replaced by an explicit provider switch       |
| `packages/daemon/src/cp/workspace-git.ts`                                                                            | GitHub canonicalization guarded by a `!== 'gitlab.com'` comparison                                                                                                   | Guarded by provider                                                                 |
| `packages/daemon/src/gitcred/helper.ts`                                                                              | Answers only for two literal hosts and picks the path parser from them                                                                                               | Injected host-to-provider table via the credential environment                      |
| `packages/daemon/src/cp/glab-target.ts`                                                                              | A set `GITLAB_HOST` means "defer"; two more literal host comparisons                                                                                                 | Compares against an explicit expected host; defers only on mismatch                 |
| `packages/daemon/src/cp/glab-shim.ts`                                                                                | Never sets `GITLAB_HOST` for the real CLI                                                                                                                            | Exports the configured host                                                         |
| `packages/daemon/src/daemon.ts`                                                                                      | Boot warning keyed on the `https://gitlab.com` literal; session managed host chosen by a literal                                                                     | Readiness refusal at spec admission; host resolved from the spec                    |
| `packages/daemon/src/gitlab/poster.ts`                                                                               | Falls back to `https://gitlab.com/api/v4`                                                                                                                            | Resolves the base URL per turn                                                      |
| `packages/daemon/src/gitlab/broker.ts`                                                                               | Same fallback; reads `web_url` from responses                                                                                                                        | Same change; the link behavior already correct                                      |
| `packages/daemon/src/gitlab/note-projection.ts`                                                                      | Same fallback                                                                                                                                                        | Same change                                                                         |
| `packages/daemon/src/gitlab/review-adapter.ts`                                                                       | Same fallback                                                                                                                                                        | Same change                                                                         |
| `packages/daemon/src/workspace/git-origin-policy.ts`, `config/config-schema.ts`                                      | Default allowlist supplies the origins                                                                                                                               | Unchanged mechanism; the operator adds the instance origin                          |
| `packages/daemon/src/skills/skill-git-source.ts`, `runtimes/runtime-prober.ts`, `runtimes/runtime-install-repair.ts` | Forward `SSL_CERT_FILE` / `SSL_CERT_DIR` / `NODE_EXTRA_CA_CERTS` in some environments                                                                                | Same allowlist extended to the workspace and session environments                   |
| `packages/daemon/src/messages/hook-message.ts`                                                                       | Prompt text names `glab`                                                                                                                                             | Unchanged                                                                           |

### Protocol

| File                                                         | Assumption                                                         | Change                                                   |
| ------------------------------------------------------------ | ------------------------------------------------------------------ | -------------------------------------------------------- |
| `packages/protocol/src/git-url.ts`                           | `DEFAULT_WORKSPACE_GIT_ALLOWED_ORIGINS` lists `https://gitlab.com` | Unchanged default; the operator adds the instance origin |
| `packages/protocol/src/frames/agent.ts`                      | The GitLab workspace arm has no host; its comment names gitlab.com | Adds `host`; comment corrected                           |
| `packages/protocol/src/frames/gitcred.ts`                    | Grant echoes provider and project ID, not host                     | Adds optional `host`                                     |
| `packages/protocol/src/frames/hook.ts`, `frames/relay-cp.ts` | GitLab hook metadata and the compiled rule carry no host           | Both add `host`                                          |
| `packages/protocol/src/consts.ts`                            | `gitlab-com-v1` and friends encode `.com` in their names           | Names kept; `gitlab-instance-v1` added                   |

### Relay

| File                                         | Assumption                                               | Change                                         |
| -------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------- |
| `packages/relay/src/hooks/gitlab-ingress.ts` | None — no URL composition and no outbound call to GitLab | Passes the rule's `host` through to the daemon |

### Setup Server

| File                                             | Assumption                                                                                                            | Change                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/setup/src/server/html.ts`              | Hardcoded link to GitLab.com user application settings; copy says "GitLab.com"; badge says verification is impossible | Host-derived links; reworded copy; the probe result of Section 11.2 |
| `packages/setup/src/server/index.ts`             | The configure body is a strict object with the client pair only                                                       | Adds the base URL                                                   |
| `packages/setup/src/deployment-config-client.ts` | Writes `clientId` plus the sealed client secret                                                                       | Writes the base URL                                                 |
| `packages/setup/src/gitlab-app.ts`               | Publishes the callback URL and scopes; dials nothing                                                                  | Unchanged, plus the probe helper                                    |

### Web

| File                                                            | Assumption                                                                          | Change                                      |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| `packages/web/src/components/console/GitlabCard.tsx`            | Bot profile link composed from `https://gitlab.com`; a literal host badge           | Both read `instanceUrl` from the DTO        |
| `packages/web/src/components/console/views/AgentDetailView.tsx` | A literal host string in the hooks panel; a mock workspace fallback composes a host | Reworded; the mock fallback follows the DTO |
| `packages/web/src/lib/api.ts`                                   | `repoWebUrl` parses the stored clone URL                                            | Already correct on any host                 |
| `packages/web/src/components/console/WorkspaceCard.tsx`         | Doc comment names gitlab.com                                                        | Reworded                                    |

### Documentation

| File                                                                                   | Assumption                                                                           | Change                                                                                                                                            |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docs/designs/gitlab-com-integration.md`                                               | Section 1 decision 1 and Section 18.3 declare the pin; Section 13.2 names the origin | Superseded by this document for self-managed deployments; the GitLab.com contract stands                                                          |
| `docs/designs/daemon-detailed-design.md`, `docs/designs/github-app-git-credentials.md` | Reference the workspace origin policy                                                | Unchanged mechanism, new example origin                                                                                                           |
| Operator documentation                                                                 | No self-managed guidance exists                                                      | New: certificate authority, egress for three components, the webhook local-network allowlist, the delegation setting, and the Free instance quota |

No chart, overlay, or environment-specific configuration is named anywhere in
this design; the deployment-side requirements are stated as product
obligations for an operator to satisfy however their environment is assembled.

## Appendix B. References

- [GitLab service accounts](https://docs.gitlab.com/user/profile/service_accounts/)
- [GitLab service accounts API](https://docs.gitlab.com/api/service_accounts/)
- [GitLab account and limit settings](https://docs.gitlab.com/administration/settings/account_and_limit_settings/)
- [GitLab sign-in restrictions and Admin Mode](https://docs.gitlab.com/administration/settings/sign_in_restrictions/)
- [GitLab application settings API](https://docs.gitlab.com/api/settings/)
- [GitLab webhooks and local network restrictions](https://docs.gitlab.com/security/webhooks/)
- [GitLab version API](https://docs.gitlab.com/api/version/)
- [GitLab OAuth 2.0 identity provider API](https://docs.gitlab.com/api/oauth2/)
- [GitLab as an OAuth 2.0 identity provider](https://docs.gitlab.com/integration/oauth_provider/)
- [GitLab access token scopes](https://docs.gitlab.com/security/tokens/access_token_scopes/)
- [GitLab project webhooks API](https://docs.gitlab.com/api/project_webhooks/)
- [GitLab Draft Notes API](https://docs.gitlab.com/api/draft_notes/)
- [GitLab merge request approvals API](https://docs.gitlab.com/api/merge_request_approvals/)
