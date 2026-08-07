# Network topology and tunnels

Collect this information before configuring authentication or provider Apps. The stack may run locally while browsers, providers, and remote daemons reach it through Cloudflare Tunnel, another tunnel, or a reverse proxy. “Local deployment” does not imply `localhost` public URLs.

## Intake checklist

Ask for the following without requesting credentials:

1. Where does Compose run, and where will each daemon run?
2. Is the deployment loopback-only, LAN-only, or externally reachable?
3. Which stable public origins will be used for:
   - Web: `AGENTCONNECT_PUBLIC_WEB_URL`;
   - API: `AGENTCONNECT_PUBLIC_CP_URL`;
   - Relay HTTP callbacks: `AGENTCONNECT_PUBLIC_RELAY_URL`;
   - daemon Relay WebSocket: `AGENTCONNECT_RELAY_DAEMON_URL`.
4. Which Logto endpoints apply: browser sign-in, admin console, OIDC issuer, and server-reachable Management API?
5. Which tunnel/proxy owns TLS, DNS, WebSocket upgrades, and any access-control policy?
6. Are the hostnames permanent named routes or temporary/ephemeral tunnel URLs?

Record the answers as a small table before changing `compose.env`. Do not assume the four AgentConnect addresses share a hostname. Prefer separate origin-level hostnames because the configured values are origins without trailing slashes; use path-based routing only after verifying the current release and proxy preserve every callback and WebSocket path.

## Typical tunnel mapping

A tunnel agent on the Compose host can connect to loopback-bound ports, so external access usually does not require changing `AGENTCONNECT_BIND_ADDRESS`:

| Public route                | Local origin            | Purpose                    |
| --------------------------- | ----------------------- | -------------------------- |
| `https://app.example.com`   | `http://127.0.0.1:3000` | Web console                |
| `https://api.example.com`   | `http://127.0.0.1:8080` | API and daemon control WS  |
| `https://relay.example.com` | `http://127.0.0.1:8090` | callbacks and Relay WS     |
| `https://login.example.com` | `http://127.0.0.1:3001` | bundled Logto, when chosen |

Use `wss://relay.example.com` for `AGENTCONNECT_RELAY_DAEMON_URL` when the same Relay hostname serves daemon WebSockets. Keep Setup (`127.0.0.1:8091`), PostgreSQL, and normally the Logto admin console private; reach Setup through local access or SSH forwarding.

Cloudflare Tunnel should use a named tunnel with stable DNS routes, not a Quick Tunnel URL. Other providers need the same stability guarantee.

## Public configuration example

```dotenv
AGENTCONNECT_PUBLIC_WEB_URL=https://app.example.com
AGENTCONNECT_PUBLIC_CP_URL=https://api.example.com
AGENTCONNECT_PUBLIC_RELAY_URL=https://relay.example.com
AGENTCONNECT_RELAY_DAEMON_URL=wss://relay.example.com
```

Do not add trailing slashes. These public values describe what browsers, callbacks, links, and daemons use; Docker service-to-service addresses remain internal and must not be replaced with public tunnel URLs unless the current Compose configuration explicitly requires it.

For bundled Logto behind a stable tunnel, also align at least:

```dotenv
LOGTO_ENDPOINT=https://login.example.com
OIDC_ISSUER=https://login.example.com/oidc
```

Keep `LOGTO_MGMT_ENDPOINT` server-reachable, normally the Docker-internal Logto address supplied by the overlay, and keep `LOGTO_ADMIN_ENDPOINT` private unless there is a deliberate protected admin route. Treat the bundled overlay as evaluation topology; prefer a separately operated Logto OSS deployment or Logto Cloud for production use.

## Access gateways and callbacks

- Preserve WebSocket upgrades and long-lived connections for both API control signaling and Relay daemon connections.
- Do not put provider callbacks, OAuth redirects, GitHub webhooks, or Slack Events/interactivity endpoints behind an interactive login challenge. Providers cannot complete a human access-gateway prompt.
- If Cloudflare Access or an equivalent gateway is enabled, define explicit policies/bypasses for required machine callbacks and WebSocket clients, then verify authorization still happens at the intended AgentConnect or provider layer.
- Avoid proxy path stripping or prefix insertion. Provider manifests are generated from the saved origins and expect their documented paths unchanged.
- Confirm the proxy forwards the original scheme and host correctly and permits the Web origin through API CORS.

## Ordering and verification

1. Establish persistent DNS and tunnel/proxy routes.
2. Verify each public HTTPS origin reaches the intended local service.
3. Verify `wss://` connectivity from the actual daemon network.
4. Save the final public values and recreate Setup if topology environment values changed.
5. Only then bootstrap Logto and create GitHub or Slack Apps.
6. Restart/recreate consuming services and run Setup's provider checks.

Changing a public origin later requires regenerating or updating Logto redirects, provider callbacks, CORS configuration, links, and daemon enrollment details. Do not paper over drift with temporary redirects.
