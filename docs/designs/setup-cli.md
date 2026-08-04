# Setup and Integration Diagnostics CLI

> **Status:** Accepted; the Phase 1 MVP implements `init` and
> `check deployment`. Provider reconciliation remains planned.
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

`@agentconnect.md/setup` is a separate operator CLI for bootstrapping and
auditing an AgentConnect deployment. Its first-party providers are GitHub,
Slack, and Logto. It also asks the Control Plane to audit the effective
permissions of installed chat and code-host integrations.

The package should make a fresh OSS installation materially more
out-of-the-box without sharing credentials from AgentConnect Cloud. Every
deployment still owns its provider applications and secrets.

## 1. Decisions

1. **A separate package and binary.** `@agentconnect.md/setup` exposes the
   `agentconnect-setup` binary and is normally run through
   `npx @agentconnect.md/setup`. It is not a subcommand of `agentconnect`: the
   existing CLI manages one daemon host, while setup manages deployment-wide
   external resources.
2. **One small command vocabulary.** The public workflow is `init`, `plan`,
   `apply`, and `check`. Provider-specific behavior lives behind registered
   contributors rather than top-level provider commands or core switches.
3. **Desired state, not a one-shot wizard.** A versioned, non-secret
   `agentconnect.setup.yaml` records intended capabilities and resource
   identity. Re-running `plan` or `apply` is safe.
4. **Actual grants are authoritative.** A manifest or desired permission is
   only the declaration. `check` separately reports effective token scopes,
   installation permissions, callbacks, connectivity, and runtime readiness.
5. **`check` is read-only.** Existing install-time validation may enable a
   provider setting as a convenience; diagnostics never reuse a mutating path.
   Delivery or email probes require an explicit `--probe`.
6. **Secrets never become setup state.** Secret values come from a secret
   source and go directly to an explicit secret sink. They are absent from the
   YAML, plans, JSON reports, logs, URLs, and Control Plane responses.
7. **Logto is a first-class deployment dependency.** Setup covers its SPA,
   API resource, OIDC contract, Management API access, Account API policy,
   connectors, and sign-in experience. It is not reduced to three environment
   variables.
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

## 2. Goals and non-goals

The CLI must:

- create or adopt the deployment GitHub App and Slack App;
- reconcile the AgentConnect-owned portion of a Logto tenant;
- offer an optional localhost Logto overlay without changing the default
  no-auth Compose command;
- generate non-default core deployment secrets and render the exact runtime
  environment values needed by Compose;
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
  -> create the AgentConnect SPA and one localhost-capable social connector
  -> start the complete stack with the Logto runtime values
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
  -> prepare the selected reachable endpoints and start or select Logto
  -> create the first Logto Management API M2M credential
  -> setup plan
  -> setup apply (create resources and write runtime env)
  -> start AgentConnect with the generated runtime env
  -> setup apply (resume any live-callback operations)
  -> setup check deployment
  -> first browser sign-in creates the personal organization
  -> connect a daemon
  -> install GitHub and Slack into the organization/workspace
  -> mint a personal API key
  -> setup check all
```

`init` selects `networked` access, pins the target release, records the external
origins, and writes fresh Postgres password, API-key pepper, and Relay token
values directly to the secret sink. It also records the chosen Logto and
integration capabilities. It never puts those generated values in desired
state or terminal output.

Addressing, certificates, ingress, external database services, and any external
Logto process remain operator-owned. A user-owned public DNS name is not a
global prerequisite: private/VPN deployments may use internal DNS with trusted
HTTPS, and a provider-reachable tunnel URL can satisfy a public callback
requirement. Logto must be reachable and its one bootstrap Management API
credential must exist before `apply`; the
GitHub and Slack Apps and all other AgentConnect-owned Logto resources can then
be prepared before AgentConnect is exposed to its users. The generated runtime
env enables OIDC on the first networked start, avoiding a temporary
network-exposed no-auth window.

Public callback ingress is capability-derived. GitHub webhooks and the
deployment-wide Slack HTTP App require a stable provider-reachable HTTPS Relay
URL. Repository authorization without GitHub events and daemon-direct chat
transports do not. Setup requests and probes public callback ingress only when a
selected capability earns that requirement.

A provider operation that requires a live callback endpoint is represented as
deferred, not failed or silently skipped. In particular, setup can create the
deployment Slack App and capture its credentials before startup, then enable
and verify its Events API and interactivity URLs only after the Relay is
reachable. The post-start `apply` resumes only those deferred idempotent
operations; when none exist, the CLI omits that step from its next-command
output.

After startup, `check deployment` verifies service readiness, required callback
reachability, OIDC, non-default core secrets, the configured secret-storage
policy, Relay availability, and deployment provider state. The first successful
OIDC sign-in JIT-provisions the user's personal AgentConnect organization and
built-in agent. Only then can that organization bind a GitHub installation,
install the deployment Slack App into a workspace, and connect its daemon.

The user mints a personal API key in the Console for the final
`check integrations` pass. `check all` combines both scopes, and `--probe` can
perform an explicit end-to-end delivery smoke test. Every command prints one
exact next command plus any remaining manual provider action; the user should
not need to reconstruct the sequence from documentation.

## 4. Command surface

The complete target v1 surface is:

```text
agentconnect-setup init
agentconnect-setup plan
agentconnect-setup apply
agentconnect-setup check [all|deployment|integrations]
```

The package-name form is the recommended OSS entry point:

```bash
npx -y @agentconnect.md/setup init
npx -y @agentconnect.md/setup plan
npx -y @agentconnect.md/setup apply
npx -y @agentconnect.md/setup check all
```

CI should pin an exact package version instead of using an implicit latest
version.

The shipped Phase 1 MVP intentionally registers only `init` and
`check deployment`. It does not expose `plan` or `apply` as placeholders:
those commands arrive with the first real provider reconciler in Phase 2.

Its current package-name form is:

```bash
npx -y @agentconnect.md/setup init local
npx -y @agentconnect.md/setup init local-auth
npx -y @agentconnect.md/setup init external --web-url <url> --control-plane-url <url> --issuer <url>
npx -y @agentconnect.md/setup check deployment
```

### 4.1 Target v1 common options

| Option                 | Meaning                                                                |
| ---------------------- | ---------------------------------------------------------------------- |
| `--config <path>`      | Desired-state file; defaults to `agentconnect.setup.yaml`              |
| `--provider <id>`      | Repeatable open provider filter, such as `github`, `slack`, or `logto` |
| `--format table\|json` | Human table by default; stable versioned JSON for automation           |
| `--non-interactive`    | Never open a browser or prompt                                         |
| `--yes`                | Apply the already-rendered non-destructive plan without confirmation   |
| `--probe`              | Permit provider-contributed active delivery probes during `check`      |
| `--strict`             | Treat optional warnings as failures                                    |

The MVP implements `--config` and `check --format`; the remaining flags arrive
with the commands or provider behaviors that use them.

Secret values are intentionally not accepted as command-line flags because
shell history and process listings expose them. Providers request named secret
references from the configured source.

### 4.2 `init`

`init` creates the non-secret desired-state file. The MVP accepts `local`,
`local-auth`, or `external`; the default is `local`. External mode requires the
Web, Control Plane, and OIDC issuer URLs and accepts a Relay URL only when the
deployment needs callback ingress. Later provider phases add release, feature,
provider, and secret-sink selection without putting secret values in YAML.

It refuses to overwrite an existing file; the operator must move it or choose
another `--config` path. It performs no provider mutation.

### 4.3 `plan`

`plan` resolves provider dependencies, inspects current resources, and emits a
redacted ordered operation list. Each operation has a stable id, provider,
action, resource identity, risk, and whether browser interaction is required.
Its readiness is `ready`, `manual`, or `deferred`; a deferred operation names
the observable prerequisite, such as a reachable Relay callback.

V1 plans may create, adopt, or update explicitly managed fields. They never
contain delete operations. Unknown provider-owned fields are preserved.

### 4.4 `apply`

`apply` recomputes the plan, displays it, and executes it only after approval
or `--yes`. It is idempotent and stops before dependent operations when a
prerequisite fails.

It records no opaque resume token. A later invocation re-inspects provider
state, recomputes the plan, and resumes only operations whose prerequisites are
now ready.

Browser-assisted provider flows open a URL when possible and also print it for
remote terminals. A short-lived loopback callback may receive one-time setup
codes; long-lived credentials are written directly to the secret sink.

`--non-interactive` can update adopted resources with existing credentials but
cannot complete a provider flow that requires a human owner to authorize it.

### 4.5 `check`

`check` has three scopes:

| Scope          | Checks                                                                                                     |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| `deployment`   | Core config/readiness, runtime env, GitHub/Slack/Logto resources, callbacks, and provider access           |
| `integrations` | Effective permissions and runtime readiness for org-owned installed integrations through the Control Plane |
| `all`          | Both; this is the default                                                                                  |

`check integrations` requires a Control Plane URL and an organization-scoped
personal API key minted by a current organization owner. The key comes from a
secret reference, normally `env:AGENTCONNECT_API_KEY`, and is never sent to a
provider. Its existing one-key-to-one-organization binding selects the
organization; there is deliberately no separate `--org` argument. The Control
Plane opens its encrypted integration credentials in-process and returns only
normalized findings.

Examples:

```bash
npx -y @agentconnect.md/setup plan --provider logto
npx -y @agentconnect.md/setup apply --provider github --provider slack
npx -y @agentconnect.md/setup check deployment --provider logto
npx -y @agentconnect.md/setup check integrations --format json --strict
```

## 5. Desired state and secret boundary

The checked-in file contains intent and secret references only:

The Phase 1 schema is deliberately narrow:

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

Provider reconciliation will use a new alpha schema revision rather than
silently reinterpreting an existing MVP file. Its target shape includes the
following sections:

```yaml
apiVersion: setup.agentconnect.md/v1alpha2
kind: AgentConnectSetup

deployment:
  access: networked
  callbackIngress: public
  release: vX.Y.Z
  externalControlPlaneUrl: https://cp.example.com
  controlPlaneApiUrl: https://cp.example.com/api/v1
  externalRelayUrl: https://relay.example.com
  daemonRelayUrl: wss://relay.example.com
  externalWebUrl: https://app.example.com

diagnostics:
  apiKey: env:AGENTCONNECT_API_KEY

secrets:
  sources:
    - type: environment
  sink:
    type: envFile
    path: .agentconnect/runtime.env

providers:
  github:
    resource:
      mode: createOrAdopt
      name: AgentConnect
    features: [repositories, pullRequests, checks, actions]
  slack:
    resource:
      mode: createOrAdopt
      name: AgentConnect
    transport: http
  logto:
    endpoint: https://login.example.com
    management:
      endpoint: https://tenant.example.com
      resource: https://tenant.example.com/api
      bootstrap:
        appId: env:LOGTO_BOOTSTRAP_APP_ID
        appSecret: env:LOGTO_BOOTSTRAP_APP_SECRET
    application:
      name: AgentConnect Console
    apiResource: https://api.example.com
    socialProviders: [github, google]
    accountApi:
      socialIdentities: edit
```

`externalControlPlaneUrl` is the unversioned, client-reachable origin projected
to the existing `PUBLIC_CP_URL` env key; it does not imply public-internet
reachability. `controlPlaneApiUrl` is the versioned, potentially rewritten REST
base used by the CLI and projected to the Web console as `CP_URL`. Setup never
constructs provider callbacks from the REST base. `externalRelayUrl` is optional
when `callbackIngress` is `none`; `daemonRelayUrl` remains independently
reachable by every daemon.

Provider resource ids learned during adoption may be recorded in the YAML as
non-secret identity. Generated secrets and tokens may not. The env-file sink:

- is opt-in and intended for the Compose path;
- is created atomically with owner-only permissions;
- changes only keys owned by the selected setup providers;
- refuses a path that is tracked or not ignored when it is inside a Git
  checkout; and
- is never echoed after a write.

For a networked Compose deployment, core owns the generated
`AGENTCONNECT_POSTGRES_PASSWORD`, `AGENTCONNECT_API_KEY_PEPPER`, and
`AGENTCONNECT_RELAY_TOKEN` keys in that sink. Provider contributors own only
their declared runtime keys. Neither side may overwrite a user-owned key
without showing an update operation in `plan`.

Other deployment systems consume `plan --format json` and implement a secret
sink outside this package. Kubernetes or cloud-secret mutation is not part of
v1.

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
secret fields go directly to the sink and produce the existing
`GITHUB_APP_*` runtime projection.

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
Events API, and interactivity URLs from the deployment origins and writes the
existing `SLACK_PLATFORM_*` runtime projection.

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

### 7.3 Logto

The operator must first supply one existing Logto Management API M2M credential
with the permissions required to manage the selected tenant. This is the one
unavoidable bootstrap step: a tenant cannot use its own Management API to mint
the first administrator credential from nothing. Under the current Logto
Management API contract, both the bootstrap credential and the generated
runtime M2M role need the Management API's `all` permission; `check` verifies
the effective grant instead of trusting the role name.

After bootstrap, `apply` uses the Logto Management API to create or adopt and
reconcile:

- the AgentConnect single-page application;
- sign-in and sign-out redirect URIs;
- the API resource whose indicator becomes both `LOGTO_API_RESOURCE` and
  `OIDC_AUDIENCE`;
- the runtime Management API M2M application and its role assignment;
- Account API enablement and Social identities `Edit` permission when profile
  linking is enabled;
- selected social connector existence and non-secret configuration;
- the sign-in experience so it exposes exactly the selected connectors; and
- optional email connector and required templates for profile-linking flows.

It writes the existing web, Control Plane, and Management API environment
projection (`LOGTO_*`, `OIDC_*`, and `SOCIAL_PROVIDERS`). It preserves unknown
tenant resources and fields. V1 never deletes a connector or application.

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

`check` validates at least:

- OIDC discovery and exact issuer match;
- SPA type, redirect URIs, and post-logout URIs;
- exact API resource indicator / token audience parity;
- Management API token acquisition and effective role permissions;
- Account API social-identity policy;
- `SOCIAL_PROVIDERS`, connector targets, and sign-in experience parity;
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

The self-hosted flow is therefore:

1. start Logto and its database using the operator's chosen deployment method;
2. create the first Management API M2M credential in Logto;
3. run `apply --provider logto` to reconcile all AgentConnect-owned resources
   and write the runtime env projection; and
4. run `check deployment --provider logto` before enabling OIDC in the Control
   Plane.

The CLI removes the tenant-configuration work after Logto is reachable. It does
not own the Logto process, database, SMTP service, TLS, backups, or upgrades.

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
- keep TLS, DNS, tunnels, provider mutation, and external orchestration out of
  the implementation.

### Phase 2: deployment providers

- add `plan` and `apply`, secret sources/sinks, redaction, and provider
  dependency ordering with the first real provider implementation;
- implement GitHub App Manifest create/adopt/check;
- implement Slack App Manifest create/adopt/check; and
- implement Logto plan/apply/check, including runtime env projection and the
  explicit Management API bootstrap handoff.

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
5. A networked OSS operator can create deployment GitHub and Slack Apps and reconcile
   an existing Logto tenant without manually transcribing generated secrets.
   The same path works against Logto Cloud and a reachable self-hosted Logto
   endpoint.
6. Networked `init` pins a release, creates the three non-default core secrets,
   derives callback-ingress requirements from selected capabilities, and
   enables OIDC before the first networked start without printing a secret.
7. Every unavoidable provider-console action is shown as an unfinished manual
   operation with a direct remediation; the CLI never reports it as applied.
8. Re-running `plan` immediately after `apply` yields no automatic operations.
9. Removing an effective Slack scope, GitHub installation permission, or Logto
   role produces a known failing `grant` finding even when desired manifests are
   correct.
10. A provider outage produces `unknown` and exit 2, not an invalid-token claim.
11. `check integrations` never returns or logs a stored integration credential.
12. Removing or demoting the personal key's user prevents both diagnostics and
    probes before any subject credential is opened.
13. Restricted integrations not shared with that owner are excluded before
    credential access; owner role does not widen resource visibility.
14. GitHub remains on the code-host seam and all core provider execution is
    registry-driven.
15. Golden redaction tests prove that every secret-shaped fixture is absent from
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
