# `@agentconnect.md/setup`

Small setup and readiness tooling for AgentConnect self-hosting.

The MVP has four entry points:

```bash
npx -y @agentconnect.md/setup init [local | local-auth | external]
npx -y @agentconnect.md/setup check deployment
npx -y @agentconnect.md/setup create github
npx -y @agentconnect.md/setup create slack
```

`init` writes only non-secret desired state to `agentconnect.setup.yaml`.
`check deployment` verifies the Web console, the database-backed API readiness
endpoint, the callback service when configured, and OIDC discovery/signing keys
when authentication is enabled.

`create github` and `create slack` are one-time bootstraps for a deployment-owned
provider App. They require an `external` setup config with an HTTPS Relay URL.
They do not add provider state to the setup YAML.

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
2. a single-page application with redirect URI
   `http://localhost:3000/auth/callback` and post-sign-out redirect URI
   `http://localhost:3000/login`.

Put the resulting non-secret application ID in the repository's untracked
`.env` file:

```dotenv
LOGTO_ENDPOINT=http://login.agentconnect.localhost:3001
LOGTO_APP_ID=<spa-application-id>
OIDC_ISSUER=http://login.agentconnect.localhost:3001/oidc
OIDC_AUDIENCE=<spa-application-id>
SOCIAL_PROVIDERS=github
```

Then start the complete stack and check it:

```bash
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
  --web-url https://console.example.test \
  --control-plane-url https://api.example.test \
  --issuer https://login.example.test/oidc \
  --relay-url https://relay.example.test
```

## Create provider Apps

Both commands refuse a partial existing configuration and never overwrite
provider keys. They append credentials to `.env` (or `--env-file`) with file
mode `0600`. Inside a Git worktree, the target must be ignored and untracked.
Secret values are never accepted as command flags, written to the setup YAML,
or printed.

Create a GitHub App under your account, or name an organization owner:

```bash
npx -y @agentconnect.md/setup create github --name AgentConnect
npx -y @agentconnect.md/setup create github --github-org example-org
```

The CLI prints a loopback URL. Open it in a browser, review the GitHub App, and
confirm its creation. The CLI then exchanges the one-time manifest code and
writes the App id, slug, private key, client id/secret, and webhook secret. The
client secret is retained because the manifest flow returns it only once; the
AgentConnect runtime does not consume it directly, but it can be used later for
the Logto GitHub social connector.

The browser must be able to reach loopback on the machine running the CLI. For
an SSH session, forward the printed port to that host (for example,
`ssh -N -L <port>:127.0.0.1:<port> <host>`) before opening the URL locally, or
run the CLI on the browser machine with access to the intended secret sink.

After restarting the Control Plane and Relay, connect GitHub from the
AgentConnect console. Repository installation remains a separate GitHub
approval step.

For Slack, first generate a temporary App Configuration access token in Slack.
Load it into `SLACK_CONFIG_TOKEN` with your shell or secret manager, then run:

```bash
SLACK_CONFIG_TOKEN="$SLACK_CONFIG_TOKEN" \
  npx -y @agentconnect.md/setup create slack --name AgentConnect
```

The token is used for `apps.manifest.create` and a manifest export check; it is
not saved. The CLI writes the four `SLACK_PLATFORM_*` runtime values and verifies
the requested scopes, events, redirect URL, and Relay callback URLs. Slack still
requires an App manager to activate Public Distribution before other workspaces
can install the App.

If a provider creates an App but the process stops before `.env` is updated,
delete that orphaned App in the provider console before retrying. Provider create
APIs do not offer an idempotency key.

The Relay URL is optional when no selected capability needs inbound callbacks.
DNS, TLS, reverse proxies, Cloudflare Tunnel, external databases, provider App
distribution, Logto connector setup, and Logto upgrades remain operator-owned in
this MVP.
