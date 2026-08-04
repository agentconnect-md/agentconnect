# `@agentconnect.md/setup`

Small, read-only-first setup tooling for AgentConnect self-hosting.

The MVP has two commands:

```bash
npx -y @agentconnect.md/setup init [local | local-auth | external]
npx -y @agentconnect.md/setup check deployment
```

`init` writes only non-secret desired state to `agentconnect.setup.yaml`.
`check deployment` verifies the Web console, the database-backed API readiness
endpoint, the callback service when configured, and OIDC discovery/signing keys
when authentication is enabled.

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

The Relay URL is optional when no selected capability needs inbound callbacks.
DNS, TLS, reverse proxies, Cloudflare Tunnel, external databases, provider App
creation, and Logto upgrades remain operator-owned in this MVP.
