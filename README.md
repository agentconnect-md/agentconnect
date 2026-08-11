<p align="center">
  <img src="packages/web/src/app/icon.svg" width="88" alt="AgentConnect logo" />
</p>

<h1 align="center">AgentConnect</h1>

<p align="center">
  <strong>Tag any agent, wherever work happens.</strong>
</p>

<p align="center">
  <sub><strong>FROM</strong>&nbsp;&nbsp;
  <a href="https://slack.com"><img src="https://api.iconify.design/logos/slack-icon.svg" width="16" height="16" alt="Slack" title="Slack" /></a>&nbsp;&nbsp;
  <a href="https://telegram.org"><img src="https://cdn.simpleicons.org/telegram" width="16" height="16" alt="Telegram" title="Telegram" /></a>&nbsp;&nbsp;
  <a href="https://discord.com"><img src="https://cdn.simpleicons.org/discord" width="16" height="16" alt="Discord" title="Discord" /></a>&nbsp;&nbsp;
  <a href="https://www.larksuite.com"><img src="https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/svg/lark.svg" width="16" height="16" alt="Lark and Feishu" title="Lark / Feishu" /></a>&nbsp;&nbsp;
  <a href="https://github.com"><img src="https://cdn.simpleicons.org/github/181717/e6edf3" width="16" height="16" alt="GitHub" title="GitHub" /></a>&nbsp;&nbsp;
  <a href="https://en.wikipedia.org/wiki/Webhook"><img src="https://api.iconify.design/logos/webhooks.svg" width="16" height="16" alt="Webhook" title="Webhook" /></a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <strong>WITH</strong>&nbsp;&nbsp;
  <a href="https://claude.com"><img src="https://cdn.simpleicons.org/claude" width="16" height="16" alt="Claude" title="Claude" /></a>&nbsp;&nbsp;
  <a href="https://openai.com"><img src="https://api.iconify.design/tabler/brand-openai.svg?color=%23808896" width="16" height="16" alt="OpenAI" title="OpenAI" /></a>&nbsp;&nbsp;
  <a href="https://gemini.google.com"><img src="https://cdn.simpleicons.org/googlegemini" width="16" height="16" alt="Gemini" title="Gemini" /></a>&nbsp;&nbsp;
  <a href="https://www.deepseek.com"><img src="https://cdn.simpleicons.org/deepseek" width="16" height="16" alt="DeepSeek" title="DeepSeek" /></a>&nbsp;&nbsp;
  <a href="https://opencode.ai"><img src="https://cdn.simpleicons.org/opencode/000000/e6edf3" width="16" height="16" alt="OpenCode" title="OpenCode" /></a>&nbsp;&nbsp;
  <a href="https://pi.dev"><img src="https://cdn.simpleicons.org/pi/000000/e6edf3" width="16" height="16" alt="Pi" title="Pi" /></a>&nbsp;&nbsp;
  <strong>ANY ACP AGENT</strong></sub>
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
  <a href="https://www.youtube.com/@agentconnect-md"><img src="https://img.shields.io/badge/YouTube-FF0000?logo=youtube&logoColor=fff" alt="Watch AgentConnect on YouTube" /></a>
</p>

<p align="center">
  <a href="https://github.com/agentconnect-md/agentconnect/actions/workflows/test.yaml"><img src="https://github.com/agentconnect-md/agentconnect/actions/workflows/test.yaml/badge.svg" alt="Test status" /></a>
  <a href="https://www.npmjs.com/package/@agentconnect.md/daemon/v/latest"><img src="https://img.shields.io/npm/v/%40agentconnect.md%2Fdaemon/latest?label=daemon%20latest" alt="Latest daemon version" /></a>
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
tools, skills, permissions, and sandbox policy it needs. Agents can call one
another while your team follows the work in shared channels and from one console.

A small daemon runs the agents in the environment you operate. One console lets
your team configure the fleet, connect channels and triggers, control access,
and follow the work they are allowed to see.

<p align="center">
  <img src="docs/assets/console-agents.gif" alt="AgentConnect console: touring the Agents, Sessions, Schedules, Tools & Skills, Knowledge, and Daemons views" width="880" />
</p>

## Why AgentConnect?

AI agents are taking on work across the team, but most still live in individual
terminals. AgentConnect brings them into the team's shared workflows:

- **Work as one team.** Create agents with different roles and let them call on
  one another, while people follow along in the conversations where the work
  happens.
- **Keep work where it happens.** Link agents to bots in Slack, Telegram, and
  Discord, or to repositories and workflows on GitHub.
- **Choose the right agent for every job.** Configure each agent's runtime,
  model, workspace, tools, and machine independently.
- **Carry context forward.** Give each agent its own memory and skills, and let
  the team publish reviewed organization knowledge that every agent can find on
  demand.
- **Set clear boundaries.** Decide who can see each agent and session, which
  repositories and tools it may use, and which other agents it may call.
- **Stay in control.** Self-host the Apache-2.0 stack, run agents in your
  environment, and change runtimes without locking the team to one vendor.

## Get started

Pick the path that matches what you want to do.

### Self-host locally

Start the Web console, Control Plane, Relay, and PostgreSQL with Docker Compose:

```bash
git clone https://github.com/agentconnect-md/agentconnect.git
cd agentconnect
docker compose up -d --pull always
```

To build the images from the checkout instead of pulling the published ones,
run `docker compose up -d --build`. Every service in `compose.yaml` carries a
build definition, and the built images take the tags the stack already
references.

Open `http://localhost:3000`. The default stack listens only on `127.0.0.1`,
uses local no-auth mode, and is intended for local evaluation.

The Compose stack does not run agent daemons. Add a daemon from the Web console,
then run its generated command on each machine that should host agents,
workspaces, and runtime credentials.

Past the local stack — sign-in, public URLs, and provider apps — a guided path
helps. Open Claude Code in the checkout and ask it to set up AgentConnect:
[`.claude/skills/agentconnect-setup`](.claude/skills/agentconnect-setup/SKILL.md)
runs those steps as an interactive tutorial and verifies each checkpoint before
moving on. The rest of this section covers the same ground by hand.

To evaluate local sign-in without configuring DNS or TLS, use the optional
official Logto overlay and its browser-based Setup Server:

```bash
docker compose -f compose.yaml -f compose.logto.yaml up -d
```

Continue with the browser-based local-auth bootstrap in the
[`@agentconnect.md/setup` walkthrough](packages/setup/README.md). The
default no-auth Compose command above is unchanged.

To reach the console from **other devices on your LAN** (for example a stack on
a NAS opened by IP), use the HTTPS overlay. Browsers grant `crypto.randomUUID`,
`crypto.subtle`, and clipboard access only to secure contexts — HTTPS or
localhost — so a console served over plain HTTP from a non-localhost address
degrades. The overlay fronts the stack with Caddy and an internal CA:

```bash
AGENTCONNECT_HTTPS_HOST='your LAN IP or hostname' docker compose -f compose.yaml -f compose.https.yaml up -d
```

Open `https://<host>:3443` and trust the generated root certificate once per
device (export it with `docker compose -f compose.yaml -f compose.https.yaml cp
caddy:/data/caddy/pki/authorities/local/root.crt agentconnect-root-ca.crt`), or
visit each of the three HTTPS origins (`:3443`, `:8443`, `:9443`) once and
accept the warning. Daemons keep dialing the plain HTTP/WS ports and are
unaffected. Do not expose a no-auth stack beyond your trusted network.

For image pinning, production networking, sign-in, secrets, GitHub App setup,
and optional Mem0 configuration, see the
[AgentConnect OSS guide](https://docs.agentconnect.md/docs/oss-get-started).

### AgentConnect Cloud

AgentConnect Cloud provides a hosted management console while agents continue
running in your environment.
[Join the Cloud waitlist](https://app.agentconnect.md/waitlist).

## Build your stack

| Layer                    | Options                                                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| **Agent runtimes**       | Claude Code, Codex, Gemini CLI, and other ACP-compatible runtimes                                                |
| **Channels**             | Slack, Telegram, Discord, Lark / Feishu, and webchat                                                             |
| **Triggers**             | GitHub events, generic webhooks, and schedules                                                                   |
| **Memory**               | AgentConnect-managed memory, supported runtime-native memory, external providers, or Off                         |
| **Tools and apps**       | Custom MCP providers and OpenConnector-backed services                                                           |
| **Knowledge and skills** | Reviewed organization knowledge, immutable managed skills, and Git-based skill sources with per-agent enablement |
| **Team controls**        | Organization roles, resource and session visibility, repository access, and directional agent call policies      |
| **Agent infrastructure** | Independent runtime, model, workspace, credentials, and daemon placement per agent                               |

## Architecture

![AgentConnect daemon-centric message paths](docs/designs/daemon-centric-architecture.svg)

| Component                  | Responsibility                                                                                                                                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Daemon**                 | Runs placed agents over local ACP, owns workspaces and session state, maintains direct platform connections and schedules, and sends model-provider traffic directly                                               |
| **Relay** (optional)       | Accepts callback-based ingress and webchat, proxies centrally managed MCP and OpenConnector access, and forwards message ingress directly to the owning daemon without durable storage                             |
| **Control Plane + Web UI** | Manages authentication, configuration, placement, permissions, metadata, and observability; stores explicitly approved organization knowledge/skill revisions and otherwise proxies bounded daemon reads on demand |

Live platform messages and ACP update streams stay on the daemon/relay data
plane. Apart from explicitly approved organization knowledge and bounded skill
bundles, the Control Plane stores coordination metadata—not message bodies,
attachment bytes, pending Dream proposals, or ACP session streams. If it is
temporarily unavailable, established sessions and daemon-local schedules
continue; new assignments and configuration changes resume after reconnection.

See the
[daemon-centric architecture](docs/designs/daemon-centric-architecture.md) for
the complete message paths, trust boundaries, and failure model.

## Development

Development requires Node >= 24.12.0 and pnpm 11. Docker is required for the Control
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
| `@agentconnect.md/setup`              | [`packages/setup`](packages/setup)                           | Browser-based self-hosting and provider App administration        |
| `@agentconnect.md/web`                | [`packages/web`](packages/web)                               | Next.js configuration and monitoring console                      |

## Explore

- [Public documentation](https://docs.agentconnect.md)
- [Self-host AgentConnect OSS](https://docs.agentconnect.md/docs/oss-get-started)
- [Architecture and detailed designs](docs/designs/)
- [CLI and daemon lifecycle](docs/designs/cli-daemon-split.md)
- [Setup Server](packages/setup/README.md)
- [Daemon configuration](docs/designs/daemon-detailed-design.md)
- [Config-file secrets](docs/config-file-secrets.md)
- [Product conventions](docs/product-conventions.md)
- [Add-on evaluation harness](evals/README.md)

## License

AgentConnect is available under the [Apache License 2.0](LICENSE).
