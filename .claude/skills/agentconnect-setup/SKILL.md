---
name: agentconnect-setup
description: Guide users through installing, configuring, and verifying the complete self-hosted AgentConnect OSS stack as an interactive tutorial. Use for Docker Compose setup, local no-auth evaluation, the bundled local Logto overlay, Logto Cloud authentication, Cloudflare Tunnel or reverse-proxy exposure, custom production domains, initial administrator bootstrap, daemon connection, deployment Google/Slack/GitHub Apps, public URLs, startup options, upgrades, or setup troubleshooting.
---

# Set Up AgentConnect

Guide the user one checkpoint at a time. Select one deployment mode, load only its relevant references, verify each checkpoint from evidence, and keep a short progress checklist throughout the tutorial.

## Establish the session

1. Determine the AgentConnect checkout or deployment directory. Prefer the current directory when it contains `compose.yaml`; otherwise ask for or locate the checkout.
2. Ask whether access is loopback-only, LAN-only, or through stable public domains using Cloudflare Tunnel or another reverse proxy. Never assume `localhost`. If anything is externally reachable, read [references/network-topology.md](references/network-topology.md) and collect the final topology before continuing.
3. Determine the target mode:
   - `no-auth`: loopback-only local evaluation;
   - `local-logto`: local evaluation with the bundled Logto OSS overlay;
   - `cloud-logto`: a locally or single-hosted Compose stack using Logto Cloud.
4. Determine whether the user wants only the core stack or also Google, GitHub, Slack, a daemon, and production hardening.
5. Read [references/deployment-modes.md](references/deployment-modes.md) plus [references/local-logto.md](references/local-logto.md) or [references/cloud-logto.md](references/cloud-logto.md) only when that mode is selected. Read [references/integrations.md](references/integrations.md) only for requested providers. Read [references/operations.md](references/operations.md) for upgrades, reset, remote-daemon networking, or troubleshooting.
6. Inspect the checkout's `compose.yaml`, optional `compose.logto.yaml`, and available environment template before issuing commands. If the checkout differs from the bundled references, follow the checkout and current official documentation, and explain the difference.

For an external topology, obtain these values before starting authentication or provider setup:

- the final public Web, API, Relay HTTP, and daemon Relay WebSocket origins;
- the Logto sign-in, admin, issuer, and Management API locations;
- the tunnel/proxy provider, whether its hostname is stable, and its local origin mappings;
- whether daemons run on the Compose host, LAN, or Internet;
- whether an access gateway, WAF, or path rewrite sits in front of any callback or WebSocket endpoint.

## Teach interactively

At each checkpoint:

1. State the immediate goal in one sentence.
2. Explain what the next action changes.
3. Give or run the smallest command/action needed.
4. State the expected result and verify it when local access is available.
5. Stop after browser-only or provider-console work and ask the user to report success or the exact error. Continue only after the checkpoint passes.

Do not dump the entire tutorial at once. Keep a compact checklist such as `Prerequisites ✓ · Stack ✓ · Auth → · Providers · Daemon · Final check` and update it as work progresses.

Use `scripts/check-local.sh <mode> [checkout]` for a read-only prerequisite and Compose validation pass. Treat its warnings as guidance; inspect failures rather than blindly retrying.

## Safety and secret handling

- Never ask the user to paste secrets, private keys, configuration tokens, or OAuth client secrets into chat. Direct them to the password field in Setup or the provider console.
- Never print, source, commit, or echo `compose.env`. Check only whether required variable names exist. Keep it gitignored.
- Obtain confirmation before starting/stopping containers when the user asked only for guidance. Starting the requested stack is in scope when the user asked Codex to perform the setup.
- Never run `docker compose down --volumes` unless the user explicitly requests a full reset and confirms permanent database deletion.
- Keep no-auth mode bound to loopback. Do not help expose it to a LAN or public network; switch to authenticated setup first.
- Preserve the exact Compose file set and `--env-file` choice across `up`, `pull`, `logs`, `restart`, and `down` commands.
- Set final public URLs before configuring Logto or creating GitHub/Slack Apps. URL changes alter redirects and callbacks and require reconciliation.
- Reject ephemeral tunnel URLs for OAuth, provider Apps, or daemon enrollment. Require stable DNS names that will survive restarts.
- Use Setup at `http://localhost:8091`; keep it loopback-only. For a remote host, use SSH port forwarding rather than exposing Setup publicly.

## Completion gates

Do not call setup complete until the selected gates pass:

- Docker Compose reports the expected long-running services healthy/running and migration jobs `Exited (0)`.
- `http://localhost:8080/readyz` and `http://localhost:8090/readyz` succeed, adjusted for configured ports or origins.
- The Web console opens at the configured public Web URL.
- Public Web/API/Relay endpoints resolve through the selected tunnel or proxy, and daemon WebSocket connectivity succeeds from the daemon's actual network.
- For Logto modes, the first administrator bootstrap is complete, the user has signed in again after the `ADMIN` claim, and Logto **Check match** passes or any known manual checks are recorded.
- Requested provider cards are saved, applied, and checked; consuming services have been restarted.
- At least one daemon is connected when the user wants a usable agent stack.
- The final summary names the deployment mode, URLs (never secrets), enabled providers, verification results, remaining warnings, and the exact Compose invocation pattern to reuse.

## Resolve failures

Diagnose the current checkpoint before changing configuration. Prefer `docker compose ps --all`, focused service logs, readiness probes, and Setup's **Check match** output. Explain the cause and make one correction at a time. Use [references/operations.md](references/operations.md) for common failure signatures.
