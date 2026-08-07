# Deployment modes

Source baseline: AgentConnect OSS documentation and Compose files verified 2026-08-07. Before changing a live deployment, compare with the checkout and the current [Get started](https://docs.agentconnect.md/docs/oss-get-started.md) and [Deployment and configuration](https://docs.agentconnect.md/docs/deployment-and-configuration.md) pages.

## Shared prerequisites and architecture

- Require Docker Desktop, OrbStack, or Docker Engine; Docker Compose v2; and Git.
- Published images currently target `linux/amd64`; Apple Silicon normally uses Docker Desktop or OrbStack emulation.
- Compose starts PostgreSQL, migration jobs, Web, the coordination API, Relay, and Setup. The daemon intentionally runs on the host or another machine so it can reach repositories and existing Claude/Codex authentication.
- Default long-running services are `postgres`, `control-plane`, `relay`, `setup-server`, and `web`. `migration-files` and `migrate` are successful when they show `Exited (0)`.

Run the read-only check first:

```bash
skills/agentconnect-setup/scripts/check-local.sh MODE /path/to/agentconnect
```

## Mode 1: local without authentication

Use only for loopback evaluation.

```bash
docker compose up -d --pull always
docker compose ps --all
```

Default URLs when no custom topology was supplied:

- AgentConnect: `http://localhost:3000`
- Setup: `http://localhost:8091`
- API readiness: `http://localhost:8080/readyz`
- Relay readiness: `http://localhost:8090/readyz`

The first run initializes the local no-auth organization and enables the built-in `agentconnect` agent by default. Setup → **Options** can disable preset Agents for future provisioning; it does not delete existing agents.

Reject any attempt to publish this mode, including through a tunnel. `AGENTCONNECT_BIND_ADDRESS` defaults to `127.0.0.1`; do not make an unauthenticated deployment externally reachable.

## Mode 2: local with bundled Logto

Use the overlay for local authentication evaluation. Its defaults need no DNS or TLS, but a stable tunnel may supply custom public origins; collect them through [network-topology.md](network-topology.md) before Logto bootstrap:

```bash
docker compose -f compose.yaml -f compose.logto.yaml up -d
```

Reuse both `-f` arguments for every later Compose command. Expected additional URLs:

- Logto sign-in: `http://localhost:3001`
- Logto Console: `http://localhost:3002`

Continue with [local-logto.md](local-logto.md). Google is the shortest bootstrap. Slack sign-in is unavailable with the default HTTP origins; it becomes eligible only when stable HTTPS Logto, Web, API, and Relay origins are configured.

## Mode 3: local or single-host Compose with Logto Cloud

Use base `compose.yaml`; do not add `compose.logto.yaml`. Cloud hosts identity while AgentConnect services still run in the selected Compose host.

1. Create a gitignored `compose.env` from the deployment template shipped with the selected release, or copy the required names from the checkout's environment example. Template names may differ between the source checkout and published deployment bundle.
2. Configure the Logto Cloud service locations in `compose.env`.
3. For a network-accessible or durable deployment, set final HTTPS Web/API/Relay public origins and a `wss://` daemon Relay URL before provider Apps are created.
4. Start with:

```bash
docker compose --env-file compose.env up -d
```

Reuse `--env-file compose.env` on all later commands. Continue with [cloud-logto.md](cloud-logto.md).

Do not conflate “the stack runs on my local machine” with “loopback-only evaluation.” Logto Cloud can be the identity service for a locally hosted Compose stack, but publishing AgentConnect still requires final HTTPS origins, changed bootstrap secrets, encrypted secret storage, backups, and WebSocket-capable reverse proxying.

## Common verification

```bash
docker compose ps --all
curl -fsS http://localhost:8080/readyz
curl -fsS http://localhost:8090/readyz
```

Adjust the command prefix and URLs for the chosen overlay, environment file, ports, or public origins. Then open the Web console and connect a daemon through **Daemons → Add daemon** using the exact one-time command shown there.
