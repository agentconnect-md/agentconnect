# `@agentconnect.md/setup`

Browser-based Tenant Admin for AgentConnect self-hosting. It configures Logto,
GitHub, Slack, Google, Feishu, and Lark through one authenticated local admin
surface. Provider identities and write-only credentials are stored in the
deployment database; the UI never returns stored secret values.

This package has no command-line setup interface. Provider creation, match
checks, edits, secret replacement, and clearing a provider configuration all
happen in Tenant Admin.

## Run with Docker Compose

The local authentication stack includes Tenant Admin:

```bash
docker compose -f compose.yaml -f compose.logto.yaml up -d
```

Open:

- Tenant Admin: `http://localhost:8091`
- Logto Console: `http://admin.agentconnect.localhost:3002`
- AgentConnect: `http://app.agentconnect.localhost:3000`

Tenant Admin first guides the operator through Logto Management API setup. It
does not display deployment configuration until an administrator has signed
in. The first signed-in user is assigned the shared `ADMIN` role; sign in once
more so the refreshed token contains that role.

## Run from source

Start the database and optional Logto services, then run the server directly:

```bash
pnpm --filter @agentconnect.md/setup dev
```

The process reads the repository `.env` and listens on `127.0.0.1:8091` by
default. `HOST` and `PORT` control the binding. `DATABASE_URL` and the
`SECRET_CIPHER`/`VAULT_*` root settings remain startup environment because they
are needed before the deployment database can be opened.

The public service origins are also startup environment:

```dotenv
AGENTCONNECT_PUBLIC_WEB_URL=http://app.agentconnect.localhost:3000
AGENTCONNECT_PUBLIC_CP_URL=http://api.agentconnect.localhost:8080
AGENTCONNECT_PUBLIC_RELAY_URL=http://relay.agentconnect.localhost:8090
```

Tenant Admin shows these values at the top because GitHub and Slack manifests
derive their callbacks from them. Change the environment and restart Tenant
Admin before applying updated provider settings.

## Configuration ownership

Each provider has one card containing its current IDs, masked secret state,
match status, and edit/create/clear controls. Clearing a provider removes its
stored identity and secrets so its creation flow becomes available again.

Saved deployment changes are startup configuration rather than hot reload.
Restart the consuming services after editing:

```bash
docker compose restart control-plane relay web
```

Tenant Admin is bound to loopback in the supplied Compose stack. For a remote
host, forward the port over SSH instead of exposing this HTTP service publicly.
