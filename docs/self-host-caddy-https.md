# Self-host AgentConnect behind Caddy HTTPS

The default Compose stack binds its services to loopback and is intended for
local evaluation. When users or daemons connect over a LAN, terminate HTTPS and
WSS at a gateway instead of publishing the Web, Control Plane, Relay, and
PostgreSQL ports directly.

This example uses the RFC 5737 documentation address `192.0.2.10`. Replace it
with the LAN address of the AgentConnect host. The deployment uses one IP
address and path prefixes:

| Public endpoint                   | Internal service       |
| --------------------------------- | ---------------------- |
| `https://192.0.2.10:1443/`        | `web:8080`             |
| `https://192.0.2.10:1443/cp/*`    | `control-plane:8080/*` |
| `https://192.0.2.10:1443/relay/*` | `relay:8080/*`         |

Caddy supports WebSocket proxying without manually adding `Connection` or
`Upgrade` headers. `handle_path` is important here because it strips `/cp` and
`/relay` before forwarding the request.

## Complete authenticated setup first

Do not expose the default evaluation stack to a LAN. When `OIDC_ISSUER` is
unset, the Control Plane uses a fixed-owner development authentication stub;
the base Compose defaults also include known local-only database, API-key, and
Relay credentials.

Before the first database initialization, copy `.env.example` to `.env` and set
unique values for all three deployment credentials:

```dotenv
AGENTCONNECT_POSTGRES_PASSWORD=<random-password>
AGENTCONNECT_API_KEY_PEPPER=<random-32+-character-value>
AGENTCONNECT_RELAY_TOKEN=<random-token>
```

For example, `openssl rand -hex 32` generates a suitable value. Generate a
different value for each variable. The API-key pepper is effectively immutable,
and the PostgreSQL password is applied when the database volume is initialized,
so do not bootstrap with the defaults and rotate them afterward.

Configure an HTTPS OIDC/Logto issuer that every client can reach, and set its
issuer in `.env`:

```dotenv
OIDC_ISSUER=https://login.example.test/oidc
```

Complete the browser-based [`@agentconnect.md/setup`](../packages/setup/README.md)
flow while Setup Server remains loopback-only. On a remote Docker host, reach it
through an SSH port forward rather than publishing its port:

```bash
ssh -L 8091:127.0.0.1:8091 user@agentconnect-host
```

During this bootstrap, use the final HTTPS Web origin for
`AGENTCONNECT_PUBLIC_WEB_URL`, but use the gateway origin without `/cp` or
`/relay` for the temporary Control Plane and Relay values. Setup intentionally
accepts origins only:

```dotenv
AGENTCONNECT_PUBLIC_WEB_URL=https://192.0.2.10:1443
AGENTCONNECT_PUBLIC_CP_URL=https://192.0.2.10:1443
AGENTCONNECT_PUBLIC_RELAY_URL=https://192.0.2.10:1443
```

Start Setup without the HTTPS override, open `http://localhost:8091` through the
tunnel, save the OIDC deployment configuration, claim the administrator role,
sign in again, and confirm authenticated sign-in succeeds:

```bash
docker compose --env-file .env -f compose.yaml up -d setup-server
```

Stop Setup after authentication is verified. The HTTPS override keeps it behind
the opt-in `setup` profile because Setup cannot model the final path-prefixed
Control Plane and Relay URLs:

```bash
docker compose --env-file .env -f compose.yaml stop setup-server
```

Do not configure callback-based provider Apps during this temporary-origin
bootstrap. Their callback URLs must match the final routed topology, which this
path-prefixed example does not expose through Setup.

### Use the bundled Logto overlay

To run the repository's bundled Logto instead of an external OIDC provider,
combine all three checked-in overlays:

```text
compose.yaml + compose.logto.yaml + compose.https.yaml + compose.logto.https.yaml
```

Logto needs its own origin. With one IP address, the companion overlay serves
AgentConnect on port `1443` and Logto on a different HTTPS port such as `1444`.
It does not place Logto under a path prefix because OIDC issuer and browser
callback URLs need a stable origin.

Add the Logto ports and a unique database password to `.env`. The two HTTPS
ports must differ:

```dotenv
AGENTCONNECT_LOGTO_HTTPS_PORT=1444
AGENTCONNECT_LOGTO_ADMIN_PORT=3002
AGENTCONNECT_SETUP_PORT=8091
LOGTO_POSTGRES_PASSWORD=<random-url-safe-password>
OIDC_ISSUER=https://192.0.2.10:1444/oidc
```

The companion overlay derives Logto's public endpoint from the host and port.
`OIDC_ISSUER` must match that endpoint plus `/oidc`; Compose requires it while
loading the base HTTPS overlay, before merging the Logto-specific value.

The public Logto port maps to Caddy's fixed internal TLS port `8443`; Caddy then
proxies to `logto:3001`. The overlay enables Logto's trusted-proxy mode and
forwards the HTTPS scheme so OIDC discovery and browser redirects advertise the
public HTTPS endpoint rather than the internal HTTP hop.

Start the stack with the local-only Setup and Logto Admin routes enabled through
Caddy:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.https.yaml \
  -f compose.logto.https.yaml \
  --profile setup \
  up -d --force-recreate
```

Caddy is the only service that publishes ports. AgentConnect and Logto are
available over HTTPS on the LAN; Setup (`8091`) and Logto Admin (`3002`) are
published by Caddy on host loopback only. For a remote host, forward both local
operator ports:

```bash
ssh \
  -L 8091:127.0.0.1:8091 \
  -L 3002:127.0.0.1:3002 \
  user@agentconnect-host
```

Trust Caddy's root CA before opening Logto, then visit
`http://localhost:8091` for Setup and `http://localhost:3002` for Logto Admin.
Complete Logto Management API setup, save OIDC authentication, claim the first
administrator, sign in again, and verify authenticated access to AgentConnect.

After setup, omit `--profile setup` and recreate the stack. The Setup container
stops, while its loopback Caddy route returns `502` until the profile is enabled
again:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.https.yaml \
  -f compose.logto.https.yaml \
  up -d --force-recreate --remove-orphans
```

## Configure the public URLs

Replace the temporary Control Plane and Relay origins in `.env` with their final
path-prefixed URLs, and add the gateway settings:

```dotenv
AGENTCONNECT_HTTPS_HOST=192.0.2.10
AGENTCONNECT_HTTPS_PORT=1443
AGENTCONNECT_HTTPS_BIND_ADDRESS=0.0.0.0

AGENTCONNECT_PUBLIC_WEB_URL=https://192.0.2.10:1443
AGENTCONNECT_PUBLIC_CP_URL=https://192.0.2.10:1443/cp
AGENTCONNECT_PUBLIC_RELAY_URL=https://192.0.2.10:1443/relay
AGENTCONNECT_RELAY_DAEMON_URL=wss://192.0.2.10:1443/relay
```

`AGENTCONNECT_RELAY_DAEMON_URL` is a base URL. Daemons append `/rd/ws` when
they connect to the Relay.

## Use the Compose override

The repository includes `compose.https.yaml` beside `compose.yaml`. Pass both
files to Docker Compose as shown below; no copy-and-paste configuration is
required.

The upstream port is `8080` even when the base Compose file publishes a
different host port. Caddy reaches the other containers through the Compose
network and therefore uses each container's listening port, not its host port.

`!reset []` removes inherited port publications. A plain `ports: []` is not
sufficient because Compose normally merges port sequences. Docker may still
show `8080/tcp` or `5432/tcp` as image metadata; a port is published only when
the output contains a mapping such as `0.0.0.0:1443->443/tcp`.

This override uses both inline `configs.content` and the `!reset` merge tag. It
requires Docker Compose 2.24.4 or newer.

## Validate and start

Render the merged model before changing running containers:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.https.yaml \
  config --quiet
```

This command fails before changing containers if `OIDC_ISSUER` or any required
deployment credential is missing. Do not bypass those checks by setting them to
the repository's `local-only-*` defaults.

Validate the inline Caddyfile independently:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.https.yaml \
  run --rm --no-deps caddy \
  caddy validate --config /etc/caddy/Caddyfile
```

Recreate the whole stack so the cleared ports and public URLs apply to every
container:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.https.yaml \
  up -d --force-recreate
```

Check the result:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.https.yaml \
  ps

curl -k https://192.0.2.10:1443/cp/readyz
curl -k https://192.0.2.10:1443/relay/readyz
```

Both health endpoints should return HTTP 200. Only Caddy should have a host
port mapping. The example exposes HTTP/1.1 and HTTP/2 over TCP. When the public
port is not 443, omit the optional HTTP/3 UDP mapping unless Caddy is also
configured to advertise that public port.

## Trust Caddy's internal CA

`tls internal` issues certificates from Caddy's private CA. Browsers and Node.js
daemons must trust that CA; disabling TLS verification is suitable only for a
short diagnostic.

Export the root certificate:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.https.yaml \
  cp caddy:/data/caddy/pki/authorities/local/root.crt \
  ./agentconnect-caddy-root.crt
```

On Debian or Ubuntu clients:

```bash
sudo install -m 0644 \
  ./agentconnect-caddy-root.crt \
  /usr/local/share/ca-certificates/agentconnect-caddy-root.crt
sudo update-ca-certificates
```

For a Node.js daemon, explicitly provide the additional CA if the process does
not pick up the operating-system trust store:

```bash
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/agentconnect-caddy-root.crt \
  npx -y @agentconnect.md/cli run \
  --api-url wss://192.0.2.10:1443/cp/daemon/ws \
  --api-key '<daemon-key>'
```

For a systemd user service, add the same variable with
`systemctl --user edit agentconnect`, then restart the service.

For a short diagnostic only, you can disable Node.js TLS certificate
verification for one CLI invocation:

```bash
NODE_TLS_REJECT_UNAUTHORIZED=0 \
  npx -y @agentconnect.md/cli run \
  --api-url wss://192.0.2.10:1443/cp/daemon/ws \
  --api-key '<daemon-key>'
```

Do not use this as a permanent deployment setting. It disables certificate
verification for every HTTPS and WSS request made by that Node.js process,
allowing an attacker who can intercept the connection to impersonate the
server. Trusting Caddy's root CA with `NODE_EXTRA_CA_CERTS` is the secure
solution.

## Production considerations

- Prefer a real DNS name and a publicly trusted certificate when clients cannot
  install the Caddy CA.
- Keep `.env`, daemon API keys, and private keys out of source control.
- Membership in the host's `docker` group grants root-equivalent control over
  the machine; restrict it to trusted operators.
- Do not add a plaintext `ws://` listener solely to avoid certificate setup.
  Daemon keys and control traffic would cross the network without TLS.
