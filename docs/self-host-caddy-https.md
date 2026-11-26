# Self-host AgentConnect and Logto behind Caddy HTTPS

The default Compose stack is a loopback-only evaluation environment. Do not
publish it directly to a LAN: it does not include Logto sign-in, and its default
credentials are intentionally local-only.

The checked-in `compose.logto.https.yaml` overlay provides one supported LAN
topology: AgentConnect is authenticated by the bundled Logto deployment, and
Caddy is the only public gateway. There is deliberately no generic HTTPS
overlay for the no-auth base stack.

This guide uses the RFC 5737 documentation address `192.0.2.10`. Replace it
with the address or DNS name of the Docker host.

| Endpoint                          | Purpose                       |
| --------------------------------- | ----------------------------- |
| `https://192.0.2.10:1443/`        | Web console                   |
| `https://192.0.2.10:1443/cp/*`    | Control Plane                 |
| `https://192.0.2.10:1443/relay/*` | Relay HTTP and WebSocket      |
| `https://192.0.2.10:1444/*`       | Logto sign-in                 |
| `https://192.0.2.10:1445/*`       | Object store (S3 API)         |
| `http://localhost:8091`           | Setup, through an SSH tunnel  |
| `http://localhost:3002`           | Logto Admin, through a tunnel |

Setup and Logto Admin never bind to a LAN interface. PostgreSQL, Web, Control
Plane, Relay, Logto, and the object store do not publish host ports. Caddy
publishes the three HTTPS origins and owns the two loopback-only operator ports.

## Prerequisites

This overlay uses inline `configs.content` and the `!reset` merge tag. Install
Docker Compose 2.24.4 or newer:

```bash
docker compose version
```

Before the first database initialization, copy `.env.example` to `.env` and
set unique deployment credentials. The API-key pepper is effectively
immutable, and PostgreSQL applies its password when initializing the volume, so
do not initialize with the defaults and try to rotate them afterward.

```dotenv
AGENTCONNECT_HTTPS_HOST=192.0.2.10
AGENTCONNECT_HTTPS_PORT=1443
AGENTCONNECT_LOGTO_HTTPS_PORT=1444
AGENTCONNECT_OBJECT_STORE_HTTPS_PORT=1445
AGENTCONNECT_HTTPS_BIND_ADDRESS=0.0.0.0

AGENTCONNECT_SETUP_PORT=8091
AGENTCONNECT_LOGTO_ADMIN_PORT=3002

AGENTCONNECT_POSTGRES_PASSWORD=<random-password>
LOGTO_POSTGRES_PASSWORD=<random-url-safe-password>
AGENTCONNECT_API_KEY_PEPPER=<random-32+-character-value>
AGENTCONNECT_RELAY_TOKEN=<random-token>

AGENTCONNECT_OBJECT_STORE_ACCESS_KEY=agentconnect-store
AGENTCONNECT_OBJECT_STORE_SECRET_KEY=<random-password>
```

Generate a different value for every credential. For example,
`openssl rand -hex 32` produces values accepted by all of these settings.

The overlay derives the AgentConnect and Logto public URLs from these host and
port settings. No additional identity-provider URL is required in `.env`.

## Validate the merged stack

Always use all three Compose files, in this order:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.logto.https.yaml \
  config --quiet
```

The command fails before changing containers if any required credential is
missing. Do not satisfy the checks with the repository `local-only-*` values.

Validate the embedded Caddyfile independently:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.logto.https.yaml \
  run --rm --no-deps caddy \
  caddy validate --config /etc/caddy/Caddyfile
```

## Set up Logto

Start the stack with the loopback-only Setup route enabled:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.logto.https.yaml \
  --profile setup \
  up -d --force-recreate
```

On a remote Docker host, forward both operator ports rather than publishing
them:

```bash
ssh \
  -L 8091:127.0.0.1:8091 \
  -L 3002:127.0.0.1:3002 \
  user@agentconnect-host
```

If opening either page prints `open failed: administratively prohibited`, the
host SSH daemon is rejecting TCP forwarding. Set `AllowTcpForwarding yes` in
the host SSH server configuration, validate it, and fully restart SSH. Keep an
existing administrator session open while restarting the service.

For example, on Debian or Ubuntu:

```bash
sudo sshd -t
sudo systemctl restart ssh
```

Close the failed tunnel and create a new SSH connection because forwarding
permissions are fixed when each session is authenticated.

Trust the Caddy root CA as described below, then open:

- Setup: `http://localhost:8091`
- Logto Admin: `http://localhost:3002`

Complete the Logto Management API setup, save the Logto configuration, claim
the first AgentConnect administrator, sign out, and sign in again. Confirm the
Web console requires sign-in and the administrator can access it before
treating the deployment as ready.

After setup, omit `--profile setup` and recreate the stack. This removes the
Setup container; its loopback Caddy route returns `502` until the profile is
enabled again.

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.logto.https.yaml \
  up -d --force-recreate --remove-orphans
```

## Verify the deployment boundary

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.logto.https.yaml \
  ps

curl -k https://192.0.2.10:1443/cp/readyz
curl -k https://192.0.2.10:1443/relay/readyz
curl -k https://192.0.2.10:1444/oidc/.well-known/openid-configuration
curl -k https://192.0.2.10:1445/health
```

The endpoints should return HTTP 200. Only Caddy should show host port
mappings. Docker may display bare `8080/tcp`, `3001/tcp`, or `5432/tcp` image
metadata; those ports are not published unless a host mapping such as
`0.0.0.0:1443->443/tcp` appears.

Caddy uses `handle_path`, which removes `/cp` and `/relay` before proxying.
WebSocket upgrades are handled automatically. Daemons connect to:

```text
wss://192.0.2.10:1443/cp/daemon/ws
```

The Relay daemon dial URL is the Relay base URL; Relay appends `/rd/ws` when it
connects.

Setup preserves the `/cp` and `/relay` prefixes when it generates Slack and
GitHub provider manifests, so their callbacks and webhooks use the same public
service mounts shown above. No Control Plane or Relay routes are exposed at the
gateway root.

## Object store and file transfer

The overlay runs a [RustFS](https://rustfs.com) object store for console file transfers
([design](designs/source-cache-file-transfer.md)). Webchat attachments upload
straight from the browser into the store, and large workspace files download
from it, so neither passes through the Control Plane. Signed URLs must be
`https://`, so browsers and daemons reach the store only through Caddy on
`AGENTCONNECT_OBJECT_STORE_HTTPS_PORT`.

On every start, `object-store-setup` creates the `agentconnect` bucket, its
lifecycle rules, and a CORS rule that admits only the console origin. The store
starts with the access key pair from `.env`, and the Control Plane uses the same
pair. The Control Plane signs URLs for that public origin, but reads the bucket
itself through `https://object-store.internal:9443`, a Caddy site reachable only
on the Compose network. This keeps file transfer working when
`AGENTCONNECT_HTTPS_HOST` is `localhost`, which inside a container names the
container itself. To trust Caddy's certificate, it uses the root certificate that
`caddy-ca` copies out of Caddy's data volume. The private key is not copied.
For this reason Caddy starts before the AgentConnect services, and its routes
answer `502` until those services are healthy.

Clients that download a file follow a link to the store's origin. Browsers and
daemons must therefore trust the Caddy CA for that port as well as for the
console.

The same bucket holds uploaded agent and organization icons under `icon/`
([design](designs/icon-uploads.md)). The setup step grants anonymous reads on
that prefix alone, because the console and chat platforms load icons by plain
URL. Caddy sends `X-Content-Type-Options: nosniff` on the store's port. A chat
platform fetches an icon from its own servers, so it shows uploaded icons only
when the store's origin is publicly reachable with a certificate that platform
trusts; Caddy's internal CA is not one.

The Source Cache for Git bundles is a feature of the Kubernetes daemon pool.
Compose runs no pool members, so this overlay enables file transfer and icon
uploads only.

## Artifacts and the content domain

Artifacts, the pages and documents agents publish for people to open in the
console ([design](designs/artifacts.md)), use the object store above and a
**content domain**: a wildcard domain on a registrable domain of its own, such
as `example-usercontent.net`, where every revision renders at its own origin.
Without one, artifacts are off: agents get no artifact tools and the console
says artifacts are not enabled. What was already published is kept and comes
back once a content domain is configured.

Set it in `.env`; Compose passes it to the Control Plane:

```dotenv
ARTIFACTS_CONTENT_DOMAIN=example-usercontent.net
```

The Control Plane refuses to start when the value is an IP address, a
single-label name or `localhost`, or when it is same-site with any origin the
deployment knows: the console, the Control Plane, the Relay, Logto and the
object store. A subdomain of `AGENTCONNECT_HTTPS_HOST`'s domain is therefore
refused. Clients that reach the stack only by an IP address or a single-label
host name cannot resolve a content domain either, so artifacts stay off there
unless the LAN gives the content domain a DNS name.

Give the content domain a Caddy site block of its own that reverse-proxies only
to the Web service. Add it in your own override file rather than editing the
console's site block, which also routes `/cp` and `/relay`; those must never be
reachable on a host that serves artifact pages:

```caddyfile
https://*.example-usercontent.net {
    tls internal
    reverse_proxy web:8080
}
```

Revision origins carry no port, so browsers reach the content domain on port 443. Publish Caddy's port 443 on the host as well, for example
`'${AGENTCONNECT_HTTPS_BIND_ADDRESS:-0.0.0.0}:443:443'`, and point wildcard DNS
for `*.example-usercontent.net` at the Docker host.

The certificate depends on where the name resolves:

- **A public domain.** Caddy obtains a publicly trusted wildcard certificate
  only through the ACME DNS challenge. Build Caddy with your DNS provider's
  module (`xcaddy build --with github.com/caddy-dns/<provider>`), give it an
  API token for that provider, and replace `tls internal` with
  `tls { dns <provider> {env.<PROVIDER_TOKEN>} }`.
- **A LAN-only name.** `tls internal` issues the wildcard certificate from
  Caddy's internal CA, which clients already trust for the console, provided
  the LAN resolves every name under the content domain to the Docker host.

## Trust the Caddy internal CA

`tls internal` issues certificates from the private Caddy CA. Browsers and
Node.js daemons must trust that CA.

Export its root certificate:

```bash
docker compose \
  --env-file .env \
  -f compose.yaml \
  -f compose.logto.yaml \
  -f compose.logto.https.yaml \
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

If Node.js does not use the operating-system trust store, provide the CA
explicitly:

```bash
NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/agentconnect-caddy-root.crt \
  npx -y @agentconnect.md/cli run \
  --api-url wss://192.0.2.10:1443/cp/daemon/ws \
  --api-key '<daemon-key>'
```

`NODE_TLS_REJECT_UNAUTHORIZED=0` is suitable only for a short diagnostic. It
disables certificate verification for every HTTPS and WSS request made by that
Node.js process.

## Production considerations

- Prefer a real DNS name and a publicly trusted certificate when clients
  cannot install the Caddy CA.
- Keep `.env`, daemon API keys, and private keys out of source control.
- Membership in the host `docker` group grants root-equivalent control over
  the machine; restrict it to trusted operators.
- Do not add a plaintext `ws://` listener to avoid certificate setup. Daemon
  credentials and control traffic would cross the network without TLS.
