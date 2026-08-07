# Operations and troubleshooting

## Preserve the invocation pattern

Use exactly one prefix throughout a deployment session:

```bash
# No auth
docker compose

# Bundled Logto
docker compose -f compose.yaml -f compose.logto.yaml

# Cloud Logto / environment overrides
docker compose --env-file compose.env
```

Append `up`, `pull`, `logs`, `restart`, or `down` only after the prefix. Combining Cloud with other intentional Compose overlays is valid, but preserve every selected `-f` flag.

## Inspect health

```bash
docker compose ps --all
docker compose logs --tail=200 <service>
curl -fsS http://localhost:8080/readyz
curl -fsS http://localhost:8090/readyz
```

Use the selected prefix and configured URL/port. Successful one-shot migration jobs show `Exited (0)`; do not try to keep them running.

## Apply settings

Setup saves deployment configuration, but services load it at startup:

```bash
docker compose restart control-plane relay web
```

If topology environment variables or Compose definitions changed, prefer `up -d --force-recreate` for affected services with the same prefix.

## Common failures

- Immediate browser API `401`: Browser API resource and API audience likely differ. Compare Setup's **Browser API resource** with the exact Logto API identifier, apply expected settings, and restart API/Web.
- Provider button reaches a Logto error: connector is missing or not included in the sign-in experience. Run Logto **Check match** and inspect its diff.
- Setup rejects Logto M2M: confirm the application is Machine-to-machine, has **Logto Management API access**, and uses the correct resource (`https://default.logto.app/api` for Logto OSS; tenant-specific `/api` for Cloud).
- Slack option disabled: at least one required Logto/Web/API/Relay origin is not HTTPS. This is expected on default localhost.
- GitHub events do not arrive locally: default HTTP Relay intentionally leaves webhook delivery inactive. Provide reachable HTTPS Relay ingress and reconcile the App.
- Remote daemon cannot connect: public API/Relay URLs are not host-reachable, `AGENTCONNECT_RELAY_DAEMON_URL` is wrong, or the reverse proxy does not upgrade WebSockets.
- Tunnel works in a browser but providers fail: an access gateway is challenging machine callbacks, the tunnel hostname is ephemeral, or the proxy rewrites callback paths. Test the exact generated callback URL without an interactive session.
- Tunnel works for HTTP but the daemon stays offline: verify the `wss://` daemon Relay URL from the daemon's network and confirm the tunnel permits long-lived WebSocket upgrades.
- Setup changes appear ignored: restart `control-plane`, `relay`, and `web` using the same overlay/env-file prefix.

## Updates

```bash
docker compose pull
docker compose up -d
```

Use the selected prefix. Pin `AGENTCONNECT_VERSION` to a release tag for reproducibility.

## Stop and reset

Preserve data:

```bash
docker compose down
```

Only after explicit confirmation, permanently delete the Compose database:

```bash
docker compose down --volumes
```

This deletes AgentConnect and Setup database data. Daemon-local workspaces and transcripts are outside that volume.

## Network hardening

Before any network exposure:

- enable OIDC and a browser API Resource;
- replace PostgreSQL password, API-key pepper, and Relay token with distinct stable values;
- use HTTPS/WSS and preserve WebSocket upgrades;
- keep Setup and PostgreSQL private;
- back up PostgreSQL and test restore;
- enable encrypted secret storage (the default `SECRET_CIPHER=none` stores write-only secrets as plaintext in PostgreSQL);
- pin release images.

Generate distinct bootstrap secrets with `openssl rand -hex 32`. Rotating the API-key pepper invalidates existing daemon and personal API keys.
