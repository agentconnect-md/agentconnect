# Logto Cloud tutorial

Use base `compose.yaml` with `--env-file compose.env`; never add the bundled Logto overlay. Follow the current [Logto authentication guide](https://docs.agentconnect.md/docs/logto-authentication.md) because Cloud plans and endpoint requirements can change.

## 1. Establish final topology

For a published or durable deployment, set final public origins before creating provider Apps:

```dotenv
AGENTCONNECT_PUBLIC_WEB_URL=https://app.agentconnect.example
AGENTCONNECT_PUBLIC_CP_URL=https://api.agentconnect.example
AGENTCONNECT_PUBLIC_RELAY_URL=https://relay.agentconnect.example
AGENTCONNECT_RELAY_DAEMON_URL=wss://relay.agentconnect.example
```

Ensure reverse proxies preserve WebSocket upgrades. Keep Setup and PostgreSQL loopback-only. For a strictly loopback evaluation, retain localhost service origins, but do not expose them and verify every selected provider accepts the displayed localhost callbacks.

## 2. Connect the Cloud tenant

Create or select a Logto Cloud tenant and record its canonical `https://<tenant-id>.logto.app` endpoint. Configure `compose.env`:

```dotenv
LOGTO_ENDPOINT=https://tenant-id.logto.app
LOGTO_ADMIN_ENDPOINT=https://cloud.logto.io
OIDC_ISSUER=https://tenant-id.logto.app/oidc
LOGTO_MGMT_ENDPOINT=https://tenant-id.logto.app
```

When sign-in uses a custom domain, use it for `LOGTO_ENDPOINT` and `OIDC_ISSUER`. Keep `LOGTO_MGMT_ENDPOINT` on the canonical `logto.app` tenant because Cloud Management API token requests do not use the custom domain.

Start the stack:

```bash
docker compose --env-file compose.env up -d
```

## 3. Create Management credentials

In Logto Console:

1. Create a **Machine-to-machine** application.
2. Assign **Logto Management API access**.
3. Enter its ID and secret directly into AgentConnect Setup → **Continue setup**.
4. Use the tenant-specific Management API resource:

```text
https://tenant-id.logto.app/api
```

Checkpoint: Setup verifies the client-credentials grant and advances to provider selection.

## 4. Configure a provider and claim ADMIN

Choose Google, GitHub, or Slack according to [integrations.md](integrations.md). Slack requires every relevant public origin to use HTTPS.

After Setup applies the connector:

1. Sign in with Logto.
2. Let Setup assign the first user the `ADMIN` role.
3. Sign in again to refresh the role claim.

## 5. Create the browser API Resource

For a production browser session, create a custom API Resource in Logto Console:

- Name: `AgentConnect Control Plane` (or equivalent)
- API identifier: an absolute URI such as `https://api.agentconnect.example`

The current documentation states that Logto Cloud Free does not include custom API Resources; verify current plan limits before purchase or deployment.

In Setup → **Logto → Edit**, enter the exact identifier as **Browser API resource**, save, and choose **Apply expected settings**. The value becomes both browser token resource and API audience; an exact mismatch causes immediate `401` responses.

## 6. Restart and verify

```bash
docker compose --env-file compose.env restart control-plane relay web
```

Run **Check match**, then test a fresh private-browser sign-in and confirm authenticated API calls continue. For network exposure, also confirm TLS, backups, replaced default secrets, secret encryption, and WebSocket upgrades.
