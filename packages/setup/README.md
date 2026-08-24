# `@agentconnect.md/setup`

Browser-based Setup Server for AgentConnect self-hosting. It configures Logto,
GitHub, GitLab, Slack, Google, Feishu, and Lark through one authenticated local
operator surface. Provider identities and write-only credentials are stored in
the deployment database; the UI never returns stored secret values.

This package has no command-line setup interface. Provider creation, match
checks, edits, secret replacement, and clearing a provider configuration all
happen in Setup.

## Run with Docker Compose

The local authentication stack includes Setup Server:

```bash
docker compose -f compose.yaml -f compose.logto.yaml up -d
```

Open:

- Setup: `http://localhost:8091`
- Logto Console: `http://localhost:3002`
- AgentConnect: `http://localhost:3000`

Setup first guides the operator through Logto Management API setup. It
does not display deployment configuration until an administrator has signed
in. The first signed-in user is assigned the shared `ADMIN` role; sign in once
more so the refreshed token contains that role.

Google is the shortest local sign-in path because its Web OAuth client accepts
the bundled bare `localhost` origins. Slack remains disabled until every
required public service URL uses HTTPS.

## Run from source

Start the database and optional Logto services, then run the server directly:

```bash
pnpm --filter @agentconnect.md/setup dev
```

The process reads the repository `.env` and listens on `127.0.0.1:8091` by
default. `HOST` and `PORT` control the binding. `DATABASE_URL` and the
`SECRET_CIPHER`/`VAULT_*` root settings remain startup environment because they
are needed before the deployment database can be opened.

The public service base URLs are also startup environment. Control Plane and
Relay URLs may include an ingress path prefix:

```dotenv
AGENTCONNECT_PUBLIC_WEB_URL=https://gateway.example.test
AGENTCONNECT_PUBLIC_CP_URL=https://gateway.example.test/cp
AGENTCONNECT_PUBLIC_RELAY_URL=https://gateway.example.test/relay
```

Setup shows these values at the top because GitHub and Slack manifests, and the
GitLab redirect URI, derive their callbacks from them. Change the environment and restart Setup
Server before applying updated provider settings.

## Configuration ownership

Each provider has one card containing its current IDs, masked secret state,
match status, and edit/create/clear controls. Clearing a provider removes its
stored identity and secrets so its creation flow becomes available again.

Saved deployment changes are startup configuration rather than hot reload.
Restart the consuming services after editing:

```bash
docker compose restart control-plane relay web
```

Setup Server is bound to loopback in the supplied Compose stack. For a remote
host, forward the port over SSH instead of exposing this HTTP service publicly.
