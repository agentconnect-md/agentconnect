<p align="center">
  <img src="packages/web/src/app/icon.svg" width="88" alt="AgentConnect logo" />
</p>

<h1 align="center">AgentConnect</h1>

<p align="center">
  <strong>Tag any agent, wherever work happens.</strong>
</p>

<p align="center">
  <sub><strong>FROM</strong></sub>&nbsp;&nbsp;
  <img src="https://api.iconify.design/logos/slack-icon.svg" width="26" height="26" alt="Slack" title="Slack" />&nbsp;&nbsp;
  <img src="https://api.iconify.design/logos/telegram.svg" width="26" height="26" alt="Telegram" title="Telegram" />&nbsp;&nbsp;
  <img src="https://api.iconify.design/logos/discord-icon.svg" width="30" height="26" alt="Discord" title="Discord" />&nbsp;&nbsp;
  <img src="https://api.iconify.design/icon-park/new-lark.svg?color=%233370FF" width="26" height="26" alt="Lark and Feishu" title="Lark / Feishu" />
  &nbsp;&nbsp;&nbsp;&nbsp;
  <sub><strong>WITH</strong></sub>&nbsp;&nbsp;
  <img src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/claude-color.svg" width="28" height="28" alt="Claude Code" title="Claude Code" />&nbsp;&nbsp;
  <img src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/codex-color.svg" width="28" height="28" alt="Codex" title="Codex" />&nbsp;&nbsp;
  <img src="https://cdn.jsdelivr.net/npm/@lobehub/icons-static-svg@latest/icons/gemini-color.svg" width="28" height="28" alt="Gemini CLI" title="Gemini CLI" />&nbsp;&nbsp;
  <sub><strong>ANY ACP AGENT</strong></sub>
</p>

<p align="center">
  <strong><a href="https://docs.agentconnect.md">Documentation</a></strong> ·
  <strong><a href="https://agentconnect.md">Website</a></strong> ·
  <strong><a href="https://agentconnect.md/blog">Blog</a></strong> ·
  <strong><a href="https://app.agentconnect.md/waitlist">Join Cloud waitlist</a></strong>
</p>

<p align="center">
  <a href="https://slack.agentconnect.md"><img src="https://custom-icon-badges.demolab.com/badge/Slack-4A154B?logo=slack&logoColor=fff" alt="Join AgentConnect on Slack" /></a>
  <a href="https://x.com/getAgentConnect"><img src="https://img.shields.io/twitter/follow/getAgentConnect?style=social" height="28" alt="Follow @getAgentConnect on X" /></a>
</p>

<p align="center">
  <a href="https://github.com/agentconnect-md/agentconnect/actions/workflows/test.yaml"><img src="https://github.com/agentconnect-md/agentconnect/actions/workflows/test.yaml/badge.svg" alt="Test status" /></a>
  <a href="https://www.npmjs.com/package/@agentconnect.md/daemon/v/latest"><img src="https://img.shields.io/npm/v/%40agentconnect.md%2Fdaemon/latest?label=daemon%20latest" alt="Latest daemon version" /></a>
  <a href="https://www.npmjs.com/package/@agentconnect.md/daemon/v/rc"><img src="https://img.shields.io/npm/v/%40agentconnect.md%2Fdaemon/rc?label=daemon%20rc" alt="RC daemon version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache 2.0 license" /></a>
</p>

<p align="center">
  <a href="#why-agentconnect">Why AgentConnect?</a> ·
  <a href="#get-started">Get started</a> ·
  <a href="#build-your-stack">Build your stack</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#development">Development</a> ·
  <a href="#explore">Explore</a>
</p>

AgentConnect is an open-source platform where teams and AI agents work together
across the tools they already use, including Slack, Telegram, Discord, and
GitHub. Connect Claude Code, Codex, Gemini CLI, or any ACP-compatible runtime,
then start work from a conversation, pull request, issue, webhook, or schedule.

Give each agent a role, then choose the runtime, model, workspace, memory,
tools, skills, permissions, and machine it needs. Agents can call one another
while your team follows the work in shared channels and from one console.

A small daemon runs the agents in the environment you operate. One console lets
your team configure the fleet, connect channels and triggers, control access,
and follow the work they are allowed to see.

## Why AgentConnect?

AI agents are increasingly doing work for entire teams, but most still live as personal
tools in individual terminals. AgentConnect provides the shared layer around
them:

- **Work as a team.** Give every agent a stable identity and role. Agents can
  call one another and return results to the channels where work started.
- **Choose the right agent for every job.** Run different runtimes, models,
  workspaces, and machines side by side, then change each independently.
- **Keep work where it happens.** Bring agents into team channels and trigger
  them from GitHub, webhooks, schedules, and the Web console.
- **Carry context forward.** Select managed, runtime-native, external, or
  disabled persistent memory per agent, and share reusable skills across the
  roster.
- **Control access.** Manage organization roles, resource and session
  visibility, repository access, tools, skills, and agent-to-agent call
  policies.
- **Own the stack.** Self-host an Apache-2.0 platform built on open ACP and MCP
  boundaries, without tying the team to one agent vendor.

## Get started

Pick the path that matches what you want to do.

### Self-host locally

Start the Web console, Control Plane, Relay, and PostgreSQL with Docker Compose:

```bash
git clone https://github.com/agentconnect-md/agentconnect.git
cd agentconnect
docker compose up -d --pull always
```

Open `http://localhost:3000`. The default stack listens only on `127.0.0.1`,
uses local no-auth mode, and is intended for local evaluation.

The Compose stack does not run agent daemons. Add a daemon from the Web console,
then run its generated command on each machine that should host agents,
workspaces, and runtime credentials.

For image pinning, production networking, sign-in, secrets, GitHub App setup,
and optional Mem0 configuration, see the
[AgentConnect OSS guide](https://docs.agentconnect.md/docs/get-started).

### AgentConnect Cloud

AgentConnect Cloud provides a hosted management console while agents continue
running in your environment.
[Join the Cloud waitlist](https://app.agentconnect.md/waitlist).

## Build your stack

| Layer                    | Options                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| **Agent runtimes**       | Claude Code, Codex, Gemini CLI, and other ACP-compatible runtimes                                           |
| **Channels**             | Slack, Telegram, Discord, Lark / Feishu, and webchat                                                        |
| **Triggers**             | GitHub events, generic webhooks, and schedules                                                              |
| **Memory**               | AgentConnect-managed memory, supported runtime-native memory, external providers, or Off                    |
| **Tools and apps**       | Custom MCP providers and OpenConnector-backed services                                                      |
| **Skills**               | Shared Git-based skill sources with per-agent enablement                                                    |
| **Team controls**        | Organization roles, resource and session visibility, repository access, and directional agent call policies |
| **Agent infrastructure** | Independent runtime, model, workspace, credentials, and daemon placement per agent                          |

## Architecture

![AgentConnect daemon-centric message paths](docs/designs/daemon-centric-architecture.svg)

| Component                  | Responsibility                                                                                                                                                                         |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Daemon**                 | Runs placed agents over local ACP, owns workspaces and session state, maintains direct platform connections and schedules, and sends model-provider traffic directly                   |
| **Relay** (optional)       | Accepts callback-based ingress and webchat, proxies centrally managed MCP and OpenConnector access, and forwards message ingress directly to the owning daemon without durable storage |
| **Control Plane + Web UI** | Manages authentication, configuration, placement, permissions, metadata, and observability; proxies bounded, authorized daemon reads on demand without persisting their content        |

Live platform messages and ACP update streams stay on the daemon/relay data
plane. The Control Plane stores coordination metadata, not message bodies,
attachment bytes, or ACP session streams. If it is temporarily unavailable,
established sessions and daemon-local schedules continue; new assignments and
configuration changes resume after reconnection.

See the
[daemon-centric architecture](docs/designs/daemon-centric-architecture.md) for
the complete message paths, trust boundaries, and failure model.

## Development

Development requires Node >= 24 and pnpm 11. Docker is required for the Control
Plane integration tests.

```bash
pnpm install
pnpm dev          # run all packages in parallel
pnpm build        # build all packages
pnpm typecheck    # type-check all packages
pnpm lint         # lint the workspace
pnpm format:check # check formatting
pnpm test         # test all packages

# single package
pnpm --filter @agentconnect.md/daemon dev
pnpm --filter @agentconnect.md/control-plane dev
pnpm --filter @agentconnect.md/web dev
```

For a complete local Control Plane and PostgreSQL development setup, follow the
[Control Plane quickstart](packages/control-plane/README.md#local-dev-quickstart).

## Monorepo layout

This repository is a pnpm workspace. Product packages live under `packages/`:

| Package                               | Path                                                         | Role                                                              |
| ------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `@agentconnect.md/cli`                | [`packages/cli`](packages/cli)                               | Stable `agentconnect` entry point, daemon lifecycle, and upgrades |
| `@agentconnect.md/connection`         | [`packages/connection`](packages/connection)                 | Shared WebSocket transport, correlation, backoff, and keepalive   |
| `@agentconnect.md/control-plane`      | [`packages/control-plane`](packages/control-plane)           | Orchestration, registry, authentication, and Web UI BFF           |
| `@agentconnect.md/daemon`             | [`packages/daemon`](packages/daemon)                         | Edge message processing and agent execution unit                  |
| `@agentconnect.md/memory-plugin-mem0` | [`packages/memory-plugin-mem0`](packages/memory-plugin-mem0) | Mem0 Cloud and OSS memory-plugin profiles                         |
| `@agentconnect.md/message`            | [`packages/message`](packages/message)                       | Pure platform message normalization                               |
| `@agentconnect.md/protocol`           | [`packages/protocol`](packages/protocol)                     | Shared daemon, relay, and Control Plane wire contracts            |
| `@agentconnect.md/relay`              | [`packages/relay`](packages/relay)                           | Callback ingress, webchat, and centralized MCP proxy              |
| `@agentconnect.md/web`                | [`packages/web`](packages/web)                               | Next.js configuration and monitoring console                      |

## Explore

- [Public documentation](https://docs.agentconnect.md)
- [Self-host AgentConnect OSS](https://docs.agentconnect.md/docs/get-started)
- [Architecture and detailed designs](docs/designs/)
- [CLI and daemon lifecycle](docs/designs/cli-daemon-split.md)
- [Daemon configuration](docs/designs/daemon-detailed-design.md)
- [Config-file secrets](docs/config-file-secrets.md)
- [Product conventions](docs/product-conventions.md)
- [Add-on evaluation harness](evals/README.md)

## License

AgentConnect is available under the [Apache License 2.0](LICENSE).
