# Setup and Integration Diagnostics CLI

> **Status:** Accepted and implemented through Phase 1.3. The MVP has one
> published operator package with the CLI, narrow GitHub/Slack App bootstrap,
> DB-backed deployment settings, and an explicit temporary Tenant Admin
> (`agentconnect-setup serve`). It also ships the minimal Logto browser-app
> reconciliation needed by the OSS install flow; general provider plan/apply
> remains planned.
>
> **Related designs:**
>
> - [cli-daemon-split.md](cli-daemon-split.md) defines the end-user daemon CLI.
> - [integration-plugin-architecture.md](integration-plugin-architecture.md)
>   defines the runtime platform seams.
> - [slack-install-smoothing.md](slack-install-smoothing.md) defines per-agent
>   Slack app creation and OAuth.
> - [github-app-git-credentials.md](github-app-git-credentials.md) defines the
>   deployment GitHub App trust boundary.

`@agentconnect.md/setup` is the only operator npm package for bootstrapping and
auditing an AgentConnect deployment. Its normal CLI is the primary interface;
the same binary can temporarily serve the Tenant Admin API and thin browser UI.
The current MVP creates GitHub and Slack Apps, reconciles the Logto browser SPA,
GitHub login connector, sign-in targets, and shared `ADMIN` role, and audits the
result. Broader Logto policy and installed-integration audits are later phases.

The package should make a fresh OSS installation materially more
out-of-the-box without sharing credentials from AgentConnect Cloud. Every
deployment still owns its provider applications and secrets.

## 1. Decisions

1. **One operator package, two execution modes.** `@agentconnect.md/setup`
   exposes the `agentconnect-setup` binary and is normally run through
   `npx @agentconnect.md/setup`. The CLI remains primary. `serve` starts a
   temporary Tenant Admin from that same artifact; there is no second public
   admin package or always-on admin service. It is not a subcommand of
   `agentconnect`, which manages one daemon host rather than deployment-wide
   resources.
2. **One small current command vocabulary.** The MVP ships `init`,
   `config get|apply`, `create logto|github|slack`, `check`, and `serve`. Explicit
   provider creation avoids building a generic reconciliation framework before
   it is earned. Later `plan`/`apply` reconcilers live behind registered
   contributors rather than more top-level provider commands.
3. **Postgres is runtime desired state.** `agentconnect.setup.yaml` remains a
   non-secret CLI/bootstrap profile. The typed, versioned deployment singleton
   in Postgres is authoritative for public origins, OIDC/Logto, deployment
   GitHub/Slack Apps, and feature policy. The Control Plane reads one snapshot at
   process startup; updates report `restartRequired` instead of pretending to
   hot-reload.
4. **Actual grants are authoritative.** A manifest or desired permission is
   only the declaration. `check` separately reports effective token scopes,
   installation permissions, callbacks, connectivity, and runtime readiness.
5. **`check` is read-only.** Existing install-time validation may enable a
   provider setting as a convenience; diagnostics never reuse a mutating path.
   Delivery or email probes require an explicit `--probe`.
6. **Deployment secrets are sealed, write-only state.** Provider secrets are
   stored in dedicated rows through the same `SecretCipher` as other CP secrets.
   Admin reads expose only configured state, fingerprints, and timestamps. Raw
   values remain absent from YAML, plans, JSON responses, logs, and URLs.
7. **Logto is a first-class deployment dependency.** The typed deployment
   document covers its OIDC, browser-app, login-connector, and Management API
   settings. The MVP checks the M2M grant and idempotently reconciles the SPA,
   redirects/CORS, configured connector targets, sign-in methods, and exact
   non-default `ADMIN` User role. Account API, email, API-resource, and general
   tenant policy remain Phase 2.
8. **Deployment creation precedes tenant installation.** Setup creates the
   deployment GitHub/Slack Apps before startup; each organization installs
   those Apps only after its first user signs in. The two stages are never
   collapsed into one ambiguous "installed" state.
9. **The local quickstart stays zero-config.** Provider setup is for a
   configured deployment. A developer can still clone the repository, start
   Compose, and connect a daemon without Logto or any provider App.
10. **Installation has three deliberately small levels.** `local` keeps the
    existing no-auth loopback stack. `local-auth` adds localhost Logto without
    requiring DNS or TLS. `external` describes an operator-managed deployment
    whose existing HTTPS endpoints are checked but never provisioned by setup.
11. **TLS and ingress stay outside the CLI.** Setup accepts and verifies an
    endpoint. It does not model certificates, DNS records, Caddy, Nginx,
    load-balancer topology, or tunnels. A temporary `cloudflared` URL is useful
    during evaluation; a stable tunnel or company ingress is still
    operator-owned.
12. **Local Logto uses upstream components.** The optional Compose overlay runs
    a pinned official Logto image and reuses the existing Postgres instance and
    volume. It creates a separate `logto` database and role; database name,
    user, and password all default to `logto`.
13. **Tenant Admin is explicit and temporary.** Compose places it behind the
    opt-in `admin` profile and publishes it on `127.0.0.1:8091` only. Operators
    stop it after configuration and restart Control Plane, Relay, and Web. Setup
    does not mount a container runtime socket or grow a TLS/ingress manager.

## 2. Goals and non-goals

The CLI must:

- create or adopt the deployment GitHub App and Slack App;
- reconcile the minimum Logto browser/login resources and bootstrap the shared
  `ADMIN` role;
- offer an optional localhost Logto overlay without changing the default
  no-auth Compose command;
- persist typed deployment settings and sealed provider secrets without making
  the operator transcribe runtime environment variables;
- show a redacted plan before provider-side mutation;
- validate declared configuration and effective permissions;
- audit every installed integration without copying its credentials to the
  operator machine; and
- provide stable JSON and exit codes for AgentConnect's own staging and
  production checks.

The first version does not:

- create a Logto tenant, GitHub organization, or Slack workspace;
- provision DNS, TLS, ingress, external databases, Kubernetes, or a Relay;
- act as a general secret manager or deployment engine;
- silently delete or replace provider resources;
- prove settings in a provider console when the provider exposes no API for
  them; or
- move GitHub into the chat-platform plugin contract. GitHub remains on the
  code-host seam.

## 3. End-to-end OSS installation

The setup CLI is not a replacement for Docker Compose or a production
orchestrator. It owns the configuration before startup and proves the resulting
deployment afterward. The user journey has three intentionally scoped paths.

### 3.1 Local evaluation

The existing local path remains the shortest route to a working agent:

```text
clone repository
  -> docker compose up -d --pull always
  -> open the local Web console
  -> copy and run Add daemon
```

Compose creates the fixed no-auth local organization and built-in
`agentconnect` agent. GitHub, Slack, and Logto are optional. Running
`agentconnect-setup init` is not a prerequisite for this loopback-only path.

### 3.2 Local authentication

The middle path adds authentication without turning TLS or DNS into an
installation project:

```text
setup init local-auth
  -> start Postgres and the optional Logto Compose overlay
  -> create the initial Logto administrator
  -> create a bootstrap Logto Management API credential
  -> start temporary Tenant Admin and save the deployment document
  -> setup create logto
  -> setup check logto and claim ADMIN
  -> stop Tenant Admin and start the complete stack
  -> setup check deployment
```

The fixed issuer is `http://login.agentconnect.localhost:3001/oidc`.
`.localhost` resolves to loopback for the browser, while the same name is a
Compose network alias for the Control Plane, so both clients observe the exact
same OIDC issuer without a certificate. The initial UI provider list is
explicitly `github`; Google is not a local default. The overlay starts neither
in the normal `docker compose up` command nor in production guidance.

The official Logto image is pinned. It connects to the shared Postgres process
through a separate `logto` database and role. `LOGTO_POSTGRES_PASSWORD`
overrides the local `logto` password, and the idempotent database-init job also
updates an existing role so changing the value works on a retained volume.
Logto upgrades, database alterations across versions, external databases,
SMTP, backups, and high availability remain outside this MVP.

### 3.3 Configured self-hosting

A non-local deployment uses the following single path:

```text
clone and select an AgentConnect release
  -> setup init
  -> run that release's database migration job
  -> prepare the selected reachable endpoints and start or select Logto
  -> create a bootstrap Logto Management API M2M credential
  -> start agentconnect-setup serve (or the Compose admin profile)
  -> setup config apply
  -> setup create logto
  -> setup create github / setup create slack
  -> sign in locally, claim ADMIN, sign in again, and run final checks
  -> stop Tenant Admin
  -> restart Control Plane, Relay, and Web on the stored deployment revision
  -> setup check deployment
  -> first browser sign-in creates the personal organization
  -> connect a daemon
  -> install GitHub and Slack into the organization/workspace
  -> mint a personal API key
```

`init` records the non-secret profile used by the CLI. Postgres connectivity,
the API-key pepper, relay bootstrap credential, and the SecretCipher/Vault root
remain process-bootstrap environment because they must exist before the stored
document can be read. Tenant Admin writes the typed deployment document and
sealed provider values; neither path prints a secret.

Addressing, certificates, ingress, external database services, and any external
Logto process remain operator-owned. A user-owned public DNS name is not a
global prerequisite: private/VPN deployments may use internal DNS with trusted
HTTPS, and a provider-reachable tunnel URL can satisfy a public callback
requirement. Logto must be reachable and its one bootstrap Management API
credential must exist before Tenant Admin can check it and assign `ADMIN`. The
GitHub and Slack Apps can then be prepared before AgentConnect is exposed to
its users. The stored startup
snapshot enables OIDC on the first networked Control Plane start, avoiding a
temporary network-exposed no-auth window.

Public callback ingress is capability-derived. GitHub webhooks and the
deployment-wide Slack HTTP App require a stable provider-reachable HTTPS Relay
URL. Repository authorization without GitHub events and daemon-direct chat
transports do not. Setup requests and probes public callback ingress only when a
selected capability earns that requirement.

A provider operation that requires a live callback endpoint is represented as
deferred, not failed or silently skipped. In particular, setup can create the
deployment Slack App and seal its credentials before the runtime restart, then
verify its Events API and interactivity URLs after the Relay is reachable.

After startup, `check deployment` verifies the active DB revision/auth mode,
Web and Control Plane reachability, Relay readiness when configured, and OIDC
discovery/JWKS consistency. The first successful
OIDC sign-in JIT-provisions the user's personal AgentConnect organization and
built-in agent. Only then can that organization bind a GitHub installation,
install the deployment Slack App into a workspace, and connect its daemon.

Installed-integration diagnostics, `check integrations`, `check all`, and
active `--probe` delivery checks are Phase 3, not commands in the shipped MVP.

## 4. Command surface

The shipped MVP has one package and these command groups:

```bash
npx -y @agentconnect.md/setup init local
npx -y @agentconnect.md/setup init local-auth
npx -y @agentconnect.md/setup init external --control-plane-url <url>
npx -y @agentconnect.md/setup serve
npx -y @agentconnect.md/setup config get
npx -y @agentconnect.md/setup config apply --file <json|->
npx -y @agentconnect.md/setup create logto [--github-org <login>]
npx -y @agentconnect.md/setup create github [--github-org <login>]
npx -y @agentconnect.md/setup create slack
npx -y @agentconnect.md/setup check deployment
npx -y @agentconnect.md/setup check logto
```

The normal CLI remains the primary, automation-friendly interface. `serve`
temporarily opens the DB write authority and a thin browser UI. Compose runs the
same self-contained dist from the Control Plane image with
`docker compose --profile admin up -d tenant-admin`; it is not another npm
package. The default endpoint is loopback `http://127.0.0.1:8091`.

`config get` returns only the typed document and redacted secret status.
`config apply` replaces that document and applies a write-only secret patch;
changed results set `restartRequired: true`. The GitHub and Slack `create` commands
require an external profile with an HTTPS Relay URL and use that DB sink by
default. Passing `--env-file` explicitly selects the owner-only legacy file
sink. GitHub uses its browser-assisted App Manifest flow; Slack reads a
temporary `SLACK_CONFIG_TOKEN` and verifies the result through
`apps.manifest.export`. Neither command adopts, updates, or deletes an App.
Slack Public Distribution and organization/workspace installation remain
explicit provider-console actions.

After a DB write, the operator stops Tenant Admin, restarts Control Plane,
Relay, and Web, and runs `check deployment`. CI should pin an exact package
version instead of using an implicit latest version. Full `plan`/`apply`
provider reconciliation remains a later phase; the MVP does not register
placeholder commands.

### 4.1 Target v1 common options

| Option                 | Meaning                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `--config <path>`      | CLI bootstrap profile; defaults to `agentconnect.setup.yaml`           |
| `--admin-url <url>`    | Temporary Tenant Admin origin; defaults to loopback port 8091          |
| `--provider <id>`      | Repeatable open provider filter, such as `github`, `slack`, or `logto` |
| `--format table\|json` | Human table by default; stable versioned JSON for automation           |
| `--non-interactive`    | Never open a browser or prompt                                         |
| `--yes`                | Apply the already-rendered non-destructive plan without confirmation   |
| `--probe`              | Permit provider-contributed active delivery probes during `check`      |
| `--strict`             | Treat optional warnings as failures                                    |

The MVP implements `--config`, `--admin-url`, and `check --format`; the
remaining target flags arrive with the commands or provider behaviors that use
them.

Secret values are intentionally not accepted as command-line flags because
shell history and process listings expose them. Providers request named secret
references from the configured source.

### 4.2 `init`

`init` creates the non-secret CLI/bootstrap profile. The MVP accepts `local`,
`local-auth`, or `external`; the default is `local`. External mode requires only
the Control Plane URL used to locate `/api/v1/runtime-config`. Web, Relay, OIDC,
feature, and provider values live in the DB-backed document. The older YAML
fields remain only for env-fallback and explicit `--env-file` compatibility.

It refuses to overwrite an existing file; the operator must move it or choose
another `--config` path. It performs no provider mutation.

### 4.3 `serve`

`serve` opens the deployment-config store with only the startup roots it cannot
load from that store: `DATABASE_URL` and the `SecretCipher`/Vault settings. It
serves the ADMIN-protected configuration API and a thin browser UI. Its default
bind is loopback; the Compose `admin` profile binds container port 8091 to
`127.0.0.1:8091` and has `restart: no`.

After OIDC is enabled, CLI calls send the Logto ID token from
`TENANT_ADMIN_ID_TOKEN`. Tenant Admin requires `ADMIN` in its `roles` claim and
validates `aud` against the browser application's app id. It does not accept a
Control Plane API access token for this surface.

It is a temporary maintenance surface. It neither starts nor controls the
Control Plane, Relay, Web, Logto, TLS, or ingress, and it never receives a
container-runtime socket.

### 4.4 `config get|apply`

`config get` reads the typed deployment singleton through Tenant Admin. Secret
fields are represented only by configured state, fingerprint, and timestamp.

`config apply --file <json|->` performs an atomic full replacement of typed
non-secret values plus a partial secret patch. Omission preserves a secret,
string replaces it, and `null` clears it. An equivalent input is a no-op;
otherwise the revision advances and the result requires a runtime restart.

### 4.5 Future `plan`

`plan` resolves provider dependencies, inspects current resources, and emits a
redacted ordered operation list. Each operation has a stable id, provider,
action, resource identity, risk, and whether browser interaction is required.
Its readiness is `ready`, `manual`, or `deferred`; a deferred operation names
the observable prerequisite, such as a reachable Relay callback.

V1 plans may create, adopt, or update explicitly managed fields. They never
contain delete operations. Unknown provider-owned fields are preserved.

### 4.6 Future `apply`

`apply` recomputes the plan, displays it, and executes it only after approval
or `--yes`. It is idempotent and stops before dependent operations when a
prerequisite fails.

It records no opaque resume token. A later invocation re-inspects provider
state, recomputes the plan, and resumes only operations whose prerequisites are
now ready.

Browser-assisted provider flows open a URL when possible and also print it for
remote terminals. A short-lived loopback callback may receive one-time setup
codes; long-lived credentials go directly to the DB-backed sealed store through
Tenant Admin.

`--non-interactive` can update adopted resources with existing credentials but
cannot complete a provider flow that requires a human owner to authorize it.

### 4.7 `check`

The shipped MVP has two scopes:

| Scope        | Checks                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------- |
| `deployment` | Core service reachability, configured auth, OIDC discovery/signing keys, and callback availability      |
| `logto`      | Stored Management API config, client credentials, role-read permission, and the exact global ADMIN role |

Phase 3 adds `integrations` for effective permissions and runtime readiness of
organization-owned installations, plus `all` to combine those provider checks.

The future `check integrations` scope requires a Control Plane URL and an organization-scoped
personal API key minted by a current organization owner. The key comes from a
secret reference, normally `env:AGENTCONNECT_API_KEY`, and is never sent to a
provider. Its existing one-key-to-one-organization binding selects the
organization; there is deliberately no separate `--org` argument. The Control
Plane opens its encrypted integration credentials in-process and returns only
normalized findings.

Examples:

```bash
npx -y @agentconnect.md/setup config get
npx -y @agentconnect.md/setup config apply --file deployment.json
npx -y @agentconnect.md/setup create github
npx -y @agentconnect.md/setup check deployment
npx -y @agentconnect.md/setup check logto
```

## 5. Desired state and secret boundary

The checked-in bootstrap profile remains deliberately narrow and contains no
secret values:

```yaml
apiVersion: setup.agentconnect.md/v1alpha1
kind: AgentConnectSetup
mode: local-auth
services:
  web: http://localhost:3000
  controlPlane: http://localhost:8080
  relay: http://localhost:8090
auth:
  issuer: http://login.agentconnect.localhost:3001/oidc
```

The runtime source of truth is a singleton `deployment_config` row with a schema
version, monotonically increasing revision, and typed JSON document. Version 1
contains:

- public Control Plane, Relay, Web, and MCP origins;
- `none` or OIDC auth, including browser Logto configuration and social
  providers;
- deployment GitHub, Slack, and Logto non-secret App identity;
- preset-agent and waitlist feature policy.

Secrets live in one row per declared key under `deployment_secret`; arbitrary
environment names are rejected. The current keys cover GitHub private/webhook/
client secrets, Slack client/signing secrets, and the Logto Management API
secret. Every value is sealed and opened through the configured `SecretCipher`.
Admin reads never select or return opened values.

The Control Plane loads and validates this document once, after connecting to
Postgres and constructing the cipher but before assembling its runtime graph. A
persisted document owns its managed keys, including absence, so a stale
container variable cannot silently re-enable a disabled provider. No row means
the previous env-only startup remains compatible. A saved revision takes effect
only after Control Plane, Relay, and Web restart; Tenant Admin returns this fact
as `restartRequired`.

The bootstrap environment remains intentionally small: database access,
process bind/topology, the API-key pepper and relay authentication, and the
SecretCipher/Vault root of trust. The encryption root cannot be stored beside
the ciphertext it unlocks. DNS, TLS, image selection, database provisioning,
and orchestrator settings also remain operator-owned.

Passing `--env-file` explicitly to a provider-create command retains the legacy
owner-only file sink for compatibility and recovery. It is not the documented
primary flow. The writer remains atomic, refuses tracked/unignored Git paths,
uses mode `0600`, and never echoes a value.

## 6. Setup provider contract

The CLI core discovers built-in providers through one static registry. It does
not branch on provider ids.

```ts
interface SetupProvider<TDesired> {
  readonly id: string
  readonly dependsOn?: readonly string[]
  readonly desiredSchema: ZodType<TDesired>

  inspect(ctx: InspectContext, desired: TDesired): Promise<ObservedState>
  plan(ctx: PlanContext, desired: TDesired, observed: ObservedState): Promise<PlanOperation[]>
  apply(ctx: ApplyContext, operations: readonly PlanOperation[]): Promise<ApplyResult>
  check(ctx: CheckContext, desired: TDesired, observed: ObservedState): Promise<DiagnosticFinding[]>
}
```

Contexts expose narrow capabilities instead of raw globals: HTTP, browser
handoff, clock, prompt, redacting logger, secret reader, and secret writer.
Providers declare dependencies; core topologically orders them and rejects a
cycle. Unsupported actions are capabilities on the provider, not provider-name
special cases in core.

The first registry contains:

- `github`: deployment code-host App;
- `slack`: deployment-wide Add to Slack App; and
- `logto`: deployment identity configuration.

This registry is intentionally separate from the runtime platform registry.
The two solve different lifecycles, and sharing a registry would incorrectly
force GitHub and Logto into the chat message contract.

## 7. Provider behavior

### 7.1 GitHub

`apply` uses GitHub's App Manifest flow to create an App with server-owned
permissions, events, setup URL, and webhook URL. The one-time conversion result
contains the App identity, private key, webhook secret, and OAuth credentials;
secret fields go directly to the sealed deployment store. The Control Plane
projects them into its existing GitHub runtime contract after restart.

The setup callback needs to be reachable by the installer's browser. A
provider-reachable HTTPS Relay is required only when selected GitHub event
capabilities subscribe the App to webhooks.

An existing App can be adopted by slug and id. Setup changes only fields the
operator explicitly selected. When GitHub does not expose an update through the
available authorization, `apply` emits a manual operation with an App settings
deep link instead of claiming success.

Permissions are derived from enabled AgentConnect capabilities, not a single
maximal preset. `check` validates:

- App identity and private-key authentication;
- declared repository and organization permissions;
- subscribed events and webhook URL;
- webhook delivery configuration without exposing its secret;
- effective permissions on each installation; and
- whether an installation must accept newly requested permissions.

Installation ownership remains tenant-safe. A roster scan may report an
unknown installation but may never claim it for an organization; only the
signed setup callback establishes ownership.

### 7.2 Slack

`apply` uses Slack's App Manifest API with an App Configuration token to create
or update the deployment-wide Add to Slack App. It derives OAuth redirect,
Events API, and interactivity URLs from the deployment origins and stores the
App identity plus sealed credentials in the deployment document.

The deployment App uses HTTP ingress and therefore requires a stable
provider-reachable HTTPS Relay. That URL may come from owned ingress or a
trusted tunnel; owned DNS is not required. Slack settings that the manifest API
cannot complete, including any required distribution approval, are explicit
manual operations. App Configuration tokens remain input credentials and are
not persisted unless the operator's secret source does so.

A private-only deployment omits this deployment-wide HTTP App and keeps the
existing per-agent Slack Socket Mode path, which needs no inbound callback.

This is distinct from the existing per-agent quick-install flow. Setup creates
the reusable deployment App; an organization later installs it into a
workspace through AgentConnect. `check` validates:

- manifest scopes, events, redirects, request URLs, and interactivity;
- App identity and signing configuration;
- whether distribution is ready for the intended deployment mode;
- installed bot token identity and **effective** OAuth scopes;
- app-token identity and `connections:write` for Socket Mode bots created by
  the per-agent flow; and
- Relay availability and current integration routing for HTTP bots.

A scope present in the current manifest but absent from an already-installed
bot token is a failure with a reinstall remediation, not a pass.

### 7.3 Logto (minimal shipped reconciliation and future Phase 2 scope)

The shipped `create logto` command reads the explicit Management API
endpoint/resource, verifies the M2M `all` grant, and idempotently creates or
adopts the AgentConnect SPA. It reconciles Web and Tenant Admin redirects, the
Web post-logout redirect, CORS origins, selected social connector targets, the
sign-in experience, and the exact non-default `ADMIN` User role. It writes the
created SPA id back into the deployment document's OIDC projection.

The operator must supply one existing Logto Management API M2M credential with
the permissions required to manage the selected tenant. This is the unavoidable
bootstrap step: a tenant cannot call its Management API before an authorized
client exists. Under the current Logto Management API contract, the bootstrap
credential needs the Management API's `all` permission; `check` verifies the
effective grant instead of trusting the role name.

For a fresh GitHub-only login tenant, `create logto` may also launch the
official GitHub App Manifest flow for a separate login-only App. That App asks
only for read access to email addresses, has no webhook or repository
permissions, and registers the normal and Account API Logto callbacks. Its
client secret is sealed as write-only deployment state. If a GitHub connector
already exists, setup adopts it and does not create another App.

The broader Phase 2 reconciler will additionally manage:

- the API resource whose indicator becomes both `LOGTO_API_RESOURCE` and
  `OIDC_AUDIENCE`;
- the runtime Management API M2M application and its role assignment;
- Account API enablement and Social identities `Edit` permission when profile
  linking is enabled;
- provider-specific connector configuration beyond the shipped GitHub path;
- optional email connector and required templates for profile-linking flows.

It writes the browser, Control Plane, and Management API settings to the typed
deployment document. Control Plane and Web consume the startup projection after
restart. It preserves unknown tenant resources and fields. V1 never deletes a
connector or application.

The sign-in `endpoint`, Management API `endpoint`, and Management API `resource`
are separate desired fields even when all three share one origin. `init` may
suggest `<management-endpoint>/api` as the resource, but `apply` never derives it
from a custom sign-in domain. This keeps Logto Cloud custom domains and
self-hosted canonical API audiences correct.

Connector client secrets come from named secret references. Provider-console
callback registration is a separate provider responsibility: when it cannot be
read through an API, `plan` emits a manual operation and `check` reports
`unknown`, not a false pass. The Logto connector callback and AgentConnect's
own `/auth/social/callback` are checked as distinct URLs.

The operational GitHub and Slack Apps are not implicitly reused as Logto
social-connector applications. An operator may explicitly reference the same
client credentials, but setup does not silently merge those trust boundaries.

The shipped `check logto` validates:

- SPA type, redirect URIs, and post-logout URIs;
- Management API token acquisition and effective role permissions;
- `SOCIAL_PROVIDERS`, connector targets, and sign-in experience parity;
- connector existence; and
- the exact non-default global User role `ADMIN`.

Phase 2 extends those checks with:

- OIDC discovery and exact issuer match;
- exact API resource indicator / token audience parity;
- Account API social-identity policy;
- connector status and required non-secret configuration;
- email connector and template readiness when required; and
- regional Lark/Feishu permission-app and third-party-token prerequisites when
  those profile/session-access capabilities are selected.

Sending an email or completing an end-to-end social OAuth round trip is an
active probe and runs only with `--probe`.

#### Self-hosted Logto

The provider is endpoint-driven and uses the same OIDC discovery and Management
API contracts for Logto Cloud and self-hosted Logto. There is no `selfHosted`
mode branch. A custom or self-hosted deployment sets its canonical Management
API endpoint and resource independently from the public sign-in endpoint.

The current self-hosted flow is therefore:

1. start Logto and its database using the operator's chosen deployment method;
2. create a bootstrap Management API M2M credential in Logto;
3. start temporary Tenant Admin and save the Logto browser/Management desired
   state;
4. run `create logto`;
5. sign in locally, claim `ADMIN`, and run `check logto`;
6. stop Tenant Admin and restart Control Plane, Relay, and Web; and
7. run `check deployment` before admitting users.

The MVP owns only the browser/login resources listed above. It does not own the
Logto process lifecycle, database migration, SMTP service, TLS, backups,
upgrades, or unrelated tenant policy.

## 8. Installed-integration diagnostics

Deployment setup and installed integration health are related but have
different secret boundaries. Installed Bot tokens are sealed in the Control
Plane, so the CLI must not download them for inspection.

The Control Plane adds the personal-key-scoped read-only endpoint
`GET /api/v1/diagnostics/integrations`. It requires a personal API key and
derives the organization from `req.apiKeyOrgId`; a caller cannot select or
override it in the URL. The route opens credentials only inside the owning
process, runs registered contributors, and returns a `DiagnosticReport` with
`Cache-Control: no-store`. It receives OpenAPI tags, summary, description, and
a stable operation id. Contributor calls use bounded concurrency and deadlines;
upstream responses and message content are not persisted.

The key's stored organization is a selector, not proof of current access. Both
diagnostic routes use a dedicated `requirePersonalKeyOrgOwner` pre-handler that:

1. rejects OIDC sessions, dev auth, daemon/relay keys, and OAuth access tokens;
2. carries an explicit credential kind from API-key authentication rather than
   inferring a personal key from an empty scope list;
3. loads the key-bound organization membership on every request and requires
   the current `owner` role; and
4. attaches the resulting `orgCtx` before listing a subject or opening an
   integration secret.

A revoked/expired key, removed member, or demoted owner therefore cannot audit
or probe the old organization even though the key row still names it. Owner role
does not widen resource visibility: chat contributors apply the existing
`visibilityWhere(orgCtx)` / `canView` policy while listing subjects and exclude a
restricted agent or integration not shared with that owner before credential
access. Organization-wide code-host installations use the existing organization
manage policy. Supporting non-owners later requires an explicit authorization
design; it is not an implicit broadening of this route.

Active probes use a separate
`POST /api/v1/diagnostics/integration-probes` endpoint with the same key-derived
organization. It is never called without `--probe` and the same explicit
confirmation rules as `apply`.

Chat providers contribute diagnostics through an optional read-only facet on
`CpPlatformProvider`. GitHub contributes through the code-host registry. The
composition root combines those contributors; the route iterates them without a
provider-name switch. Logto remains a deployment check owned by its local setup
provider rather than pretending to be an organization integration.

The existing `validateConfig(credentials, transport)` contract is not reused:
it accepts raw install credentials and some implementations intentionally make
best-effort provider changes. Diagnostics instead receive a resolved subject
and a read-only secret handle.

```ts
interface DiagnosticContributor<TSubject> {
  readonly id: string
  listSubjects(ctx: DiagnosticContext): Promise<readonly TSubject[]>
  check(ctx: DiagnosticContext, subject: TSubject): Promise<DiagnosticFinding[]>
  probe?(ctx: ProbeContext, subject: TSubject): Promise<DiagnosticFinding[]>
}
```

The initial effective checks retain current provider-specific knowledge inside
each contributor:

| Provider    | Effective checks                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------- |
| Slack       | Bot/app identity, granted scopes, events, token pairing, Relay/Socket readiness, reinstall needed |
| Telegram    | Bot identity and Group Privacy Mode                                                               |
| Discord     | Bot identity and Message Content Intent, read-only                                                |
| Lark/Feishu | Region, bot capability, granted scopes/events, callbacks, permission-app readiness                |
| GitHub      | Installation identity, effective permissions, selected repositories, webhook delivery readiness   |

Provider outages or rate limits produce `unknown`; they do not get translated
into invalid credentials.

## 9. Diagnostic report

Every check returns the same schema:

```ts
interface DiagnosticFinding {
  checkId: string
  provider: string
  subject: {
    kind: 'deployment' | 'application' | 'installation' | 'integration'
    id?: string
    name?: string
  }
  layer: 'configuration' | 'declaration' | 'grant' | 'callback' | 'connectivity' | 'runtime'
  status: 'pass' | 'warn' | 'fail' | 'unknown' | 'not_applicable'
  required: boolean
  capability?: string
  message: string
  remediation?: {
    summary: string
    url?: string
    action?: string
  }
  checkedAt: string
}

interface DiagnosticReport {
  schemaVersion: '1'
  deployment?: string
  organization?: string
  findings: DiagnosticFinding[]
  summary: Record<DiagnosticFinding['status'], number>
}
```

The zod schema lives in `@agentconnect.md/protocol` so the Control Plane and
setup CLI consume one wire contract.

The table renderer groups by provider, subject, and layer. JSON field names and
`checkId` values are compatibility contracts. `message` is for humans and may
change.

Contributors may run concurrently, but core sorts the merged findings by
`provider`, `subject.kind`, `subject.id ?? subject.name`, the declared `layer`
order, and finally `checkId`. Summary aggregation happens after that sort. The
same observed state therefore produces stable table and JSON ordering regardless
of provider response timing.

Exit codes are:

- `0`: no required finding failed or is unknown; optional findings do not
  affect the default exit code;
- `1`: at least one required finding failed; under `--strict`, any `fail` or
  `warn` finding produces exit 1; and
- `2`: a required finding is `unknown`, the audit is incomplete, or invocation
  is invalid; under `--strict`, any `unknown` finding produces exit 2.

`not_applicable` never affects the exit code. When several rules match, exit 2
takes precedence over exit 1, which takes precedence over exit 0; the report
still preserves every known failure.

The report is still written on exit 1 or 2 so CI can archive it.

## 10. Security invariants

- No provider token, private key, client secret, signing secret, webhook
  secret, API key, or email address appears in plans, reports, logs, state,
  remediation URLs, or errors.
- One-time authorization codes are accepted only by the bound callback and are
  never logged, persisted, echoed, or propagated to another URL.
- Provider callback `state` is random, short-lived, single-use, and bound to the
  exact setup operation.
- A secret returned only once by a provider must reach a confirmed sink before
  the operation is recorded as successful.
- The CLI asks only for permissions implied by selected capabilities.
- Read-only diagnostics do not call provider mutation endpoints.
- Active probes are visibly labeled, opt-in, and report the resource they may
  create or message they may send before execution.
- The key-scoped diagnostics endpoints never return raw credentials and cannot
  inspect another organization; owner membership and resource visibility are
  revalidated on every request before any integration credential is opened.
- Redaction happens when structured values enter the logger, not only at final
  string rendering.

## 11. Delivery plan

### Phase 1: CLI shell and report contract

- add the publishable `packages/setup` package with `init` and
  `check deployment`;
- model only `local`, `local-auth`, and `external` setup profiles;
- add deterministic table/JSON checks for Web, database-backed Control Plane
  readiness, Relay readiness, API auth mode, OIDC discovery, and signing keys;
- add the opt-in official Logto Compose overlay with a separate logical
  database on the shared Postgres instance; and
- keep TLS, DNS, tunnels, and external orchestration out of the implementation.

### Phase 1.1: one-time deployment App bootstrap

- add explicit `create github` and `create slack` commands without introducing
  the target provider/reconciliation framework;
- require external HTTPS Control Plane, Web, and Relay endpoints already
  described by the existing alpha schema;
- retain the atomic mode-`0600` env-file writer only as an explicit legacy
  fallback, refusing Git-tracked or unignored sinks and never logging secrets;
  and
- verify Slack's managed permissions and callback manifest after creation while
  keeping Public Distribution manual.

### Phase 1.2: DB deployment source and temporary Tenant Admin

- add the typed, versioned deployment singleton and per-key sealed secret rows;
- load one startup snapshot in Control Plane, distribute Relay-owned ingress
  configuration over its authenticated control connection, and serve Web's
  public runtime settings from Control Plane;
- add `config get|apply` and make provider-create commands use the DB sink by
  default;
- add `serve` to the same `@agentconnect.md/setup` artifact, with a thin UI and
  ADMIN-only API after bootstrap; the first local operator can claim the shared
  global `ADMIN` role, then that self-claim closes for the configured OIDC app;
- add `check logto` through Tenant Admin without returning the stored Management
  API credential to the CLI;
- carry the self-contained setup dist in the Control Plane image and expose it
  only through Compose's loopback `admin` profile; and
- report restart-required state explicitly instead of implementing hot reload.

### Phase 1.3: minimal Logto reconciliation

- add idempotent `create logto` through Tenant Admin so write-only Management
  and connector credentials never return to the CLI;
- create or adopt the SPA and reconcile redirects, CORS, social connector
  targets, sign-in methods, and `ADMIN` without deleting unrelated resources;
- create a separate login-only GitHub App through the browser manifest flow
  only when a fresh GitHub connector needs credentials; and
- extend `check logto` to report drift across the same shipped resource set.

### Phase 2: deployment providers

- add `plan` and `apply`, secret sources/sinks, redaction, and provider
  dependency ordering with the first real provider implementation;
- extend GitHub App handling with adopt/update/check;
- extend Slack App handling with adopt/update/check; and
- extend Logto reconciliation to API resources, Account API policy, arbitrary
  connectors, email/templates, and redacted plan output.

### Phase 3: effective integration audit

- add the normalized protocol report;
- add the personal-key-scoped Control Plane diagnostics endpoint;
- add the explicit personal-key credential kind and current-owner pre-handler;
- add read-only facets for current chat providers;
- register GitHub installation diagnostics on the code-host seam; and
- make `check integrations` call the endpoint with an org-scoped API key.

### Phase 4: OSS and internal adoption

- preserve the zero-config local quickstart and add a separate networked
  self-hosting walkthrough starting with `npx @agentconnect.md/setup init`;
- document pre-start resource creation, deferred callback activation, and
  migration from existing env-only setup;
- run pinned `check all --format json` against AgentConnect environments; and
- surface the same normalized findings in the Console later without duplicating
  provider logic.

## 12. Acceptance criteria

Items 1-9 cover the shipped MVP. Items 10-17 are acceptance criteria for the
future phases named in section 11.

1. The loopback-only local quickstart still requires only Compose and Add
   daemon; setup adds no mandatory provider step.
2. The optional local-auth overlay starts the pinned official Logto image on
   `*.agentconnect.localhost`, retains data in the shared Postgres volume under
   a distinct `logto` database/role, and requires no DNS or TLS configuration.
3. Changing `LOGTO_POSTGRES_PASSWORD` updates an existing role and Logto
   reconnects without recreating the volume.
4. `check deployment` fails when the database-backed Control Plane readiness,
   Relay readiness, configured auth mode, OIDC issuer, or JWKS is wrong, and it
   never mutates the deployment.
5. An OSS operator can create deployment GitHub and Slack Apps, verify an
   existing Logto Management API credential, reconcile the Logto SPA/login
   resources, and bootstrap `ADMIN` without printing generated secrets. The
   same Logto path works against Logto Cloud and a reachable self-hosted Logto
   endpoint; the localhost profile can create its login-only GitHub App without
   public DNS or TLS.
6. The only published setup artifact provides both the CLI and `serve`; Compose
   runs that same self-contained dist from the Control Plane image, behind an
   explicit profile bound to `127.0.0.1:8091`.
7. A persisted deployment document overrides its managed legacy environment
   keys, secret reads expose only metadata, and the encryption root remains
   outside the database.
8. A changed revision reports `restartRequired`; stopping Tenant Admin and
   restarting Control Plane, Relay, and Web activates the same revision across
   all three processes.
9. Every unavoidable provider-console action is shown as an unfinished manual
   operation with a direct remediation; the CLI never reports it as applied.
10. When Phase 2 lands, re-running `plan` immediately after `apply` yields no
    automatic operations.
11. Removing an effective Slack scope, GitHub installation permission, or Logto
    role produces a known failing `grant` finding even when desired manifests are
    correct.
12. A provider outage produces `unknown` and exit 2, not an invalid-token claim.
13. `check integrations` never returns or logs a stored integration credential.
14. Removing or demoting the personal key's user prevents both diagnostics and
    probes before any subject credential is opened.
15. Restricted integrations not shared with that owner are excluded before
    credential access; owner role does not widen resource visibility.
16. GitHub remains on the code-host seam and all core provider execution is
    registry-driven.
17. Golden redaction tests prove that every secret-shaped fixture is absent from
    table output, JSON output, errors, and logs. Contract tests cover exit-code
    aggregation and one representative provider; provider API clients use only
    focused behavior tests.

## 13. Provider API references

- [GitHub App Manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Slack app manifests](https://docs.slack.dev/app-manifests/configuring-apps-with-app-manifests/)
- [Logto Management API](https://docs.logto.io/integrate-logto/interact-with-management-api)
- [Logto API resources](https://docs.logto.io/authorization/global-api-resources)
- [Logto OSS](https://docs.logto.io/logto-oss)
- [Logto deployment and database setup](https://docs.logto.io/logto-oss/deployment-and-configuration)
- [GitHub OAuth loopback redirect URLs](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps#loopback-redirect-urls)
