# AgentConnect

[![daemon rc](https://img.shields.io/npm/v/%40agentconnect.md%2Fdaemon/rc?label=daemon%20rc)](https://www.npmjs.com/package/@agentconnect.md/daemon/v/rc)
[![daemon latest](https://img.shields.io/npm/v/%40agentconnect.md%2Fdaemon/latest?label=daemon%20latest)](https://www.npmjs.com/package/@agentconnect.md/daemon/v/latest)

Daemon-centric multi-agent platform that bridges IM platforms (Slack / Telegram / Discord)
to AI coding agents (Claude, Codex) over ACP. See [`docs/designs/`](docs/designs/) for the
architecture and detailed design.

## Monorepo layout

pnpm workspace with three packages:

| Package                          | Path                                               | Stack                      | Role                                                     |
| -------------------------------- | -------------------------------------------------- | -------------------------- | -------------------------------------------------------- |
| `@agentconnect.md/web`           | [`packages/web`](packages/web)                     | Next.js + React + Tailwind | Config / monitoring Web UI                               |
| `@agentconnect.md/control-plane` | [`packages/control-plane`](packages/control-plane) | Fastify                    | Orchestration / registry / BFF (no message hot path)     |
| `@agentconnect.md/daemon`        | [`packages/daemon`](packages/daemon)               | Node CLI (commander)       | Edge message + agent execution unit (`agentconnect` CLI) |

## Develop

```bash
pnpm install
pnpm dev       # run all packages in parallel
pnpm build     # build all packages
pnpm typecheck # type-check all packages

# single package
pnpm --filter @agentconnect.md/daemon dev
pnpm --filter @agentconnect.md/control-plane dev
pnpm --filter @agentconnect.md/web dev
```

Requires Node >= 24 and pnpm 11.

## Evaluate AgentConnect add-ons

Credential-free contracts and the configured Promptfoo memory/collaboration treatment matrix live in [`evals/`](evals/README.md). The suite measures paired add-on effects and raw-ACP harness neutrality; it does not combine underlying harness capability into an AgentConnect score.

## Native ACP runtimes outside the registry

The daemon includes a reviewed fallback catalog for ACP harnesses that ship a
native ACP command but may be absent from the public registry:

| Runtime          | Command           | Initialized-state signal                                       | Memory modes      |
| ---------------- | ----------------- | -------------------------------------------------------------- | ----------------- |
| Hermes Agent     | `hermes acp`      | `$HERMES_HOME` or `~/.hermes`                                  | `managed`, `none` |
| Open Interpreter | `interpreter acp` | `$INTERPRETER_HOME` or `~/.openinterpreter`                    | `managed`, `none` |
| Kiro CLI         | `kiro-cli acp`    | `$KIRO_HOME` or `~/.kiro`                                      | `managed`, `none` |
| Maki             | `maki acp`        | XDG `maki` config/data/state directories or `~/.maki`          | `managed` only    |
| ZeroClaw         | `zeroclaw acp`    | `$ZEROCLAW_CONFIG_DIR`, `$ZEROCLAW_DATA_DIR`, or `~/.zeroclaw` | `managed`, `none` |
| Oh My Pi         | `omp acp`         | `$PI_CODING_AGENT_DIR` or `~/.omp/agent`                       | `managed`, `none` |

Runtime definitions resolve in `curated < usable registry/cache < explicit user`
order. A curated winner is not advertised or launched merely because its binary
exists: the daemon also requires initialized local state and runs a disposable
`initialize + session/new` ACP probe with a private HOME, no MCP servers, and
permission/elicitation requests denied. Registry-backed and explicit user
definitions retain their existing behavior.

The probe copies only reviewed credential/config files into its disposable
home; sessions, history, memory, logs, caches, extensions, and MCP configuration
stay behind. Probe failures are local and sanitized. Maki is intentionally
`managed`-only because its bundled persistent-memory plugin has no reliable,
non-overridable per-process off switch; selecting `none`, `native`, or an
external sole-store provider fails closed.

## Docker & Kubernetes credentials

Agents can receive whole tool config files through write-only `*_DATA`
secrets: `DOCKER_CONFIG_DATA` (a Docker `config.json`) and `KUBECONFIG_DATA`
(a kubeconfig). At agent start the daemon materializes each value as a private
mode-0600 file and points the tool's standard env var (`DOCKER_CONFIG`,
`KUBECONFIG`) at it, so `docker`, `kubectl`, `helm`, `helmfile` and anything
else that honors those variables works unchanged — the raw value never enters
the agent's environment. See
[`docs/config-file-secrets.md`](docs/config-file-secrets.md) for setup and
security details.

## In-conversation commands

While talking to an agent in a thread you can control its run with short commands.
They are handled by the daemon and never sent to the agent itself.

| Command            | Alias on Slack | Effect                                                               |
| ------------------ | -------------- | -------------------------------------------------------------------- |
| `/stop`, `/cancel` | `!stop`        | Interrupt the agent's current turn.                                  |
| `/queue <message>` | `!queue …`     | Hold `<message>` and send it automatically once the agent goes idle. |

On Slack use the `!` alias — Slack reserves `/…` for its own slash commands, so the
bot never receives `/stop`. Commands respect the same routing and `allowedUserIds`
rules as normal messages, and work even when the Control Plane is offline. See
[`docs/designs/daemon-detailed-design.md`](docs/designs/daemon-detailed-design.md) §8.8.
