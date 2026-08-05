# `@agentconnect.md/setup`

Small setup and readiness tooling for AgentConnect self-hosting. This is the
only published operator package: the normal CLI and the temporary Tenant Admin
server are two modes of the same `agentconnect-setup` binary.

The MVP has five command groups:

```bash
npx -y @agentconnect.md/setup init [local | local-auth | external]
npx -y @agentconnect.md/setup config [get | apply]
npx -y @agentconnect.md/setup check [deployment | logto]
npx -y @agentconnect.md/setup create github
npx -y @agentconnect.md/setup create slack
npx -y @agentconnect.md/setup serve
```

`init` writes a non-secret bootstrap locator to `agentconnect.setup.yaml`.
`check deployment` verifies the Web console, the database-backed API readiness
endpoint, the callback service when configured, and OIDC discovery/signing keys
when authentication is enabled.

`create github` and `create slack` are one-time bootstraps for a deployment-owned
provider App. `config`, provider credentials, and the Tenant Admin operate on a
typed deployment document in AgentConnect's Postgres database. Secret fields are
write-only on the admin surface and pass through the configured `SecretCipher`.
They are never added to the setup YAML.

## Installation modes

| Mode         | Intended use                                                                 |
| ------------ | ---------------------------------------------------------------------------- |
| `local`      | Existing loopback-only Compose stack with no authentication                  |
| `local-auth` | Loopback-only Compose stack plus the optional official Logto image           |
| `external`   | An operator-managed HTTPS deployment; setup checks it but does not manage it |

The shortest local path does not require this CLI:

```bash
docker compose up -d --pull always
```

For local authentication:

```bash
npx -y @agentconnect.md/setup init local-auth
docker compose -f compose.yaml -f compose.logto.yaml up -d postgres logto
```

Open `http://admin.agentconnect.localhost:3002`, create the initial Logto admin,
then create:

1. a GitHub social connector; and
2. one single-page application with both redirect URIs
   `http://localhost:3000/auth/callback` and
   `http://localhost:8091/auth/callback`, post-sign-out redirect URI
   `http://localhost:3000/login`, and both CORS origins
   `http://localhost:3000` and `http://localhost:8091`; and
3. a bootstrap Management API M2M application with the `all` permission for
   resource `https://default.logto.app/api`. Tenant Admin uses it only to check
   Management API access and create/assign the non-default `ADMIN` User role.

Start the temporary Tenant Admin and save those values in the DB-backed
deployment document. Its bootstrap flow lets the first local operator claim the
shared Logto `ADMIN` role. That self-claim closes for the configured issuer and
browser app; grant later operators the same role in Logto. Subsequent Tenant
Admin writes require it.

```bash
docker compose -f compose.yaml -f compose.logto.yaml --profile admin up -d tenant-admin
```

The safest manual path is to paste the `values` object below into Tenant Admin's
Desired configuration editor and enter the M2M secret in its write-only
`logto.managementAppSecret` field. For CLI automation, the complete document
below can be saved as `deployment-config.json`, but it contains a plaintext
secret: create it with mode `0600`, keep it out of Git, and delete it immediately
after apply. The SPA app id is intentionally both the browser app id and token
audience in this minimal profile.

```json
{
  "values": {
    "publicUrls": {
      "controlPlane": "http://localhost:8080",
      "relay": "http://localhost:8090",
      "web": "http://localhost:3000",
      "mcp": null
    },
    "auth": {
      "mode": "oidc",
      "issuer": "http://login.agentconnect.localhost:3001/oidc",
      "audience": "<LOGTO_SPA_APP_ID>",
      "browserClient": {
        "endpoint": "http://login.agentconnect.localhost:3001",
        "appId": "<LOGTO_SPA_APP_ID>",
        "apiResource": null
      },
      "socialProviders": ["github"]
    },
    "github": null,
    "slack": null,
    "logto": {
      "managementEndpoint": "http://login.agentconnect.localhost:3001",
      "managementAppId": "<LOGTO_M2M_APP_ID>",
      "managementResource": "https://default.logto.app/api"
    },
    "features": {
      "presetAgentsEnabled": true,
      "waitlistMode": false
    }
  },
  "secrets": {
    "logto.managementAppSecret": "<LOGTO_M2M_APP_SECRET>"
  }
}
```

Apply it:

```bash
npx -y @agentconnect.md/setup config apply --file deployment-config.json
```

Then open `http://localhost:8091`, sign in, claim `ADMIN`, and sign in once more
so the new role appears in the ID token. Finally run the read-only Logto check;
loopback diagnostics do not require copying the browser token:

```bash
npx -y @agentconnect.md/setup check logto
```

Later non-loopback CLI maintenance sets a fresh ID token in
`TENANT_ADMIN_ID_TOKEN`.

Then stop Tenant Admin, start the complete stack, and check it:

```bash
docker compose -f compose.yaml -f compose.logto.yaml --profile admin stop tenant-admin
docker compose -f compose.yaml -f compose.logto.yaml up -d
npx -y @agentconnect.md/setup check deployment
```

The overlay uses one Postgres instance and volume but keeps Logto in its own
`logto` database and role. Database name, user, and password default to `logto`.
Set `LOGTO_POSTGRES_PASSWORD` to a URL-safe value to change the password; the
initialization job updates an existing role as well as creating a new one.

For an operator-managed deployment:

```bash
npx -y @agentconnect.md/setup init external \
  --control-plane-url https://api.example.test
```

Run the selected AgentConnect release's database migration job before starting
`agentconnect-setup serve`; the npm package opens the migrated schema but does
not own database migrations. Put public Web/Relay URLs and OIDC settings in the
DB-backed deployment document, not in this bootstrap YAML. The old flags remain
available only for env-fallback and explicit `--env-file` compatibility.

For a direct npm run against an already migrated database, the minimal process
bootstrap is:

```bash
DATABASE_URL='postgresql://agentconnect:password@db.example.test:5432/agentconnect' \
  SECRET_CIPHER=none \
  npx -y @agentconnect.md/setup serve
```

Vault-backed deployments instead pass the same `SECRET_CIPHER=vault-transit`
and `VAULT_*` root settings used by the Control Plane.

## Temporary Tenant Admin

The CLI remains the primary setup and automation interface. `serve` starts a
small, temporary Tenant Admin surface from the same npm package when an operator
wants a browser-assisted view of the redacted deployment document or needs the
write authority used by `config apply` and provider App creation. It is not a
second package and is not intended to remain online.

The Compose profile runs the exact self-contained setup bundle carried inside
the Control Plane image:

```bash
docker compose --profile admin up -d tenant-admin
```

Open `http://localhost:8091`. The port is published on `127.0.0.1` only. For a
remote host, use an SSH port forward; do not expose this temporary HTTP service
through public ingress. This does not add a TLS, DNS, reverse-proxy, or tunnel
setup feature to AgentConnect.

Postgres is the source of truth for the typed deployment settings: public
service URLs, OIDC and Logto settings, deployment GitHub/Slack Apps, and feature
policy. Database connectivity and the `SecretCipher`/Vault root of trust remain
startup environment because they must exist before the stored document can be
opened. When no deployment row exists, the existing env-only startup remains a
compatibility path.

Configuration is a startup snapshot, not a hot-reload mechanism. After a
successful change, stop the temporary server and restart the affected services:

```bash
docker compose --profile admin stop tenant-admin
docker compose restart control-plane relay web
npx -y @agentconnect.md/setup check deployment
```

The Tenant Admin reports only secret presence and fingerprints after a write;
it never returns stored secret values.

## CLI and AI automation

The same redacted API is available through deterministic JSON commands. The
Tenant Admin origin defaults to `http://127.0.0.1:8091`; use `--admin-url` to
override it. Plain HTTP overrides are accepted only for loopback addresses.

```bash
npx -y @agentconnect.md/setup config get --format json

npx -y @agentconnect.md/setup check logto --format table
npx -y @agentconnect.md/setup check logto --format json

npx -y @agentconnect.md/setup config apply \
  --file deployment-config.json \
  --format json

generate-config | npx -y @agentconnect.md/setup config apply \
  --file - \
  --format json
```

An apply file is the CLI apply document: `{ "values": { ... },
"secrets": { ... } }`. `values` is a full typed replacement. Secret keys form a
partial write-only patch: omission preserves the current value, a string
replaces it, and `null` clears it. Changing or re-enabling a provider identity
requires its bound secrets in the same write, preventing an old write-only
credential from being paired with a new endpoint or app id. Output reports `changed`, the previous and
current revisions, and `restartRequired`, but never echoes the submitted secret
values. A validated no-op exits `0` without sending PUT; invalid input, auth,
network, revision conflict, and server failures exit `1`. The CLI reads the
current revision and attaches it to PUT; retry after a conflict instead of
overwriting another operator's change.

`check logto` asks Tenant Admin to verify its stored Logto Management API
configuration, client-credentials grant, role-read permission, and the exact
global `ADMIN` role. The CLI does not read or decrypt Logto credentials itself.
It exits `1` for a definite failure, `2` when the only non-pass result is
`unknown`, and `0` when all findings pass.

No bearer is needed for loopback writes before the first successful `ADMIN`
claim, and loopback-only Logto diagnostics remain read-only without one. After
claim, configuration writes require a Logto ID token whose `roles` claim
includes `ADMIN` and whose `aud` is the browser application's app id. Sign in
again, use Tenant Admin's deliberate **Copy CLI ID token** button, and export the
short-lived value as `TENANT_ADMIN_ID_TOKEN`. This is not a Control Plane API
access token and has no command-line flag.

## Create provider Apps

Both commands refuse a partial existing configuration and never silently
replace an existing provider App. By default they read the redacted deployment
document through the temporary Tenant Admin and atomically write the new App
identity and sealed credentials back to Postgres. When OIDC is enabled, export
the short-lived Tenant Admin ID token as `TENANT_ADMIN_ID_TOKEN` while using
these CLI commands. Secret values are never accepted as command flags, written
to setup YAML, returned by Tenant Admin, or printed.

The default DB-backed provider-create flow requires saved HTTPS Web, Control
Plane, and Relay URLs because both generated Apps include callback ingress. It
derives those URLs from Postgres, never from setup YAML.

Passing `--env-file <path>` explicitly selects the legacy file sink instead;
that path requires a complete `external` YAML profile with HTTPS Web and Relay
URLs.
That path is a compatibility/recovery option, not the primary installation
flow; it is written with mode `0600` and must be ignored and untracked inside a
Git checkout.

Create a GitHub App under your account, or name an organization owner:

```bash
npx -y @agentconnect.md/setup create github --name AgentConnect
npx -y @agentconnect.md/setup create github --github-org example-org
npx -y @agentconnect.md/setup create github --format json
```

The CLI prints a loopback URL. Open it in a browser, review the GitHub App, and
confirm its creation. The CLI then exchanges the one-time manifest code and
stores the App id, slug, private key, client id/secret, and webhook secret. The
client secret is retained because the manifest flow returns it only once; the
AgentConnect runtime does not consume it directly, but it can be used later for
the Logto GitHub social connector.

The browser must be able to reach loopback on the machine running the CLI. For
an SSH session, forward the printed port to that host (for example,
`ssh -N -L <port>:127.0.0.1:<port> <host>`) before opening the URL locally, or
run the CLI on the browser machine with access to the intended secret sink.

The result includes the new deployment revision and `restartRequired: true`.
After stopping Tenant Admin and restarting the Control Plane, Relay, and Web,
connect GitHub from the AgentConnect console. Repository installation remains a
separate GitHub approval step.

For Slack, first generate a temporary App Configuration access token in Slack.
Load it into `SLACK_CONFIG_TOKEN` with your shell or secret manager, then run:

```bash
SLACK_CONFIG_TOKEN="$SLACK_CONFIG_TOKEN" \
  npx -y @agentconnect.md/setup create slack --name AgentConnect

SLACK_CONFIG_TOKEN="$SLACK_CONFIG_TOKEN" \
  npx -y @agentconnect.md/setup create slack --format json
```

The token is used for `apps.manifest.create` and a manifest export check; it is
not saved. The CLI stores the Slack App identity and sealed credentials in the
deployment document and verifies the requested scopes, events, redirect URL,
and Relay callback URLs. Slack still requires an App manager to activate Public
Distribution before other workspaces can install the App.

If a provider creates an App but the process stops before Postgres is updated,
delete that orphaned App in the provider console before retrying. Provider
create APIs do not offer an idempotency key.

The Relay URL is optional when no selected capability needs inbound callbacks.
DNS, TLS, reverse proxies, Cloudflare Tunnel, external databases, provider App
distribution, Logto connector setup, and Logto upgrades remain operator-owned in
this MVP.
