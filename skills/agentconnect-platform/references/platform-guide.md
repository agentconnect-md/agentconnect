# AgentConnect Platform Guide

Condensed from the official documentation at <https://docs.agentconnect.md/docs>.
Each section links its source page; prefer the live docs when detail matters or the
information here seems stale.

## What AgentConnect is

AgentConnect lets teams "tag any agent, wherever work happens": it connects AI coding
runtimes (Claude Code, Codex, Gemini CLI, or any ACP-compatible tool) to Slack,
Telegram, Discord, Lark/Feishu, GitHub, webhooks, and a browser Playground. Agents run
via lightweight daemons in the team's own environment; a central console handles
configuration, access control, and monitoring. The stack is Apache 2.0 open source and
fully self-hostable; AgentConnect Cloud offers a hosted console with daemons still
running on the team's machines.

## How it works ([docs/how-it-works](https://docs.agentconnect.md/docs/how-it-works))

Design rule: **the Control Plane is not on the live message path.**

| Component            | Role                                                                                                                                                                                            |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Daemon**           | Local process (laptop, VM, workstation). Outbound-only connections to the CP, optional relay, and chat platforms. Launches runtimes over ACP, owns working directories, git repos, transcripts. |
| **Relay** (optional) | Public ingress for Slack/GitHub/webhook callbacks and webchat. Routes to the owning daemon; persists nothing.                                                                                   |
| **Control Plane**    | Auth, permissions, org structure, integrations, bot tokens, approved Knowledge, control metadata. Daemon link is one WebSocket (register, heartbeat, config, telemetry).                        |
| **Console**          | Config + monitoring UI. Transcript/workspace views are bounded live reads proxied from the owning daemon, never persisted centrally.                                                            |

Data residency: transcripts, workspaces, and runtime credentials stay on the daemon.
Graceful degradation: if the CP goes offline, established sessions and local schedules
keep running.

## Quickstart ([docs/quickstart](https://docs.agentconnect.md/docs/quickstart))

Prerequisites: macOS/Linux with Node.js 24+, and an installed, authenticated agent CLI
(Claude Code, Codex, …) — AgentConnect uses the tools you already have, it does not
supply model API credentials.

1. **Sign in** — console at `app.agentconnect.md` (Cloud) or the org's own deployment
   URL. Social login (GitHub / Google / Slack); first sign-in auto-creates a personal
   organization.
2. **Connect a daemon** — console → Daemons → Add daemon, then run the copied command
   on the target machine:
   `npx -y @agentconnect.md/cli run --api-url <cp-ws-url> --api-key <one-time-key>`.
   The one-time key is shown once. The daemon connects outbound within seconds and
   reports its installed runtimes. It runs in the foreground for testing; install it
   as a system service for permanent operation. No inbound ports are needed.
3. **Create an agent** — Agents → Add agent: name, daemon, runtime, workspace
   (fresh directory or GitHub clone).
4. **Test in the Playground** — open the agent → Playground for a live browser chat.
5. **Integrate** — connect Slack / Telegram / Discord / Lark / GitHub / webhooks.

New orgs are born with the **`agentconnect` preset agent** already present (unplaced);
it is auto-placed onto the first daemon that connects, and it is the default bind
target for the platform's "Add to Slack" app and the GitHub flow. It cannot be renamed
or deleted.

## Agents ([docs/create-an-agent](https://docs.agentconnect.md/docs/create-an-agent), [docs/configure-an-agent](https://docs.agentconnect.md/docs/configure-an-agent))

An agent is a configured instance of a runtime: "Claude Code, on my build box, in this
repo, allowed to edit files."

- **Identity**: immutable `name` slug (lowercase/digits/hyphens), optional display
  name, and a description/persona that is injected into every session's context.
- **Placement & runtime**: pick a daemon, then a runtime from what that daemon
  actually reported; model options are exactly what the daemon advertised. An agent
  can also be left **unplaced** (no daemon yet).
- **Behavior** (runtime-dependent): effort/reasoning level, fast mode, output mode,
  **permission mode** (how autonomously it may act), sandbox execution, memory
  backend, MCP servers/tools.
- **Workspace**: fresh scratch directory or a cloned GitHub repository with a chosen
  access level. Workspace contents live on the daemon.
- **Access**: team visibility (Everyone / Selected members) and, independently,
  agent-to-agent visibility (which agents may discover and call this one — inbound
  and outbound, All or Selected).
- Agents can be **paused** (stop accepting new triggers) and resumed.

## Sessions ([docs/sessions](https://docs.agentconnect.md/docs/sessions))

A session is the flight recorder for one agent run, whatever started it: a Slack
thread, GitHub event, webhook, cron firing, or the Playground.

- Records source, agent, participants, daemon, runtime and model, duration, token
  usage, and estimated cost. The header snapshots what the run _actually used_, even
  if the agent has since been reconfigured.
- **Metadata lives on the CP** (title, status, timestamps, tokens); **transcript
  content lives on the daemon** that ran it. Metadata stays visible while a daemon is
  offline, but the transcript can't load until it's back.
- Transcripts show messages, reasoning, plans, tool calls with input/output, and file
  edits with diffs.
- Cross-platform hand-offs create a linked session on the destination platform;
  replies stay platform-local unless the agent explicitly reports back.
- Live sessions stream updates; Playground sessions can be resumed from the browser.
- Session visibility is configurable per session: Everyone, Private, Slack members,
  GitHub access.

## Integrations ([docs/integrations-overview](https://docs.agentconnect.md/docs/integrations-overview))

Supported entry points:

| Platform          | Behavior                                                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Slack**         | Channels, threads, DMs — via the platform "Add to Slack" app or a custom app. A **shared bot** can front several agents through one identity, routing per channel. |
| **Telegram**      | DMs and groups via a bot token.                                                                                                                                    |
| **Discord**       | Channels, threads, DMs via a generated invite link.                                                                                                                |
| **Lark / Feishu** | Group mentions and 1:1 chats.                                                                                                                                      |
| **GitHub**        | Issues, PRs, and comments on connected repositories.                                                                                                               |
| **Webhooks**      | Any JSON POST — no platform credential needed.                                                                                                                     |

Model: a **bot** is a durable platform identity managed in Settings; an
**integration** binds _that bot_ to _one agent_. Removing an integration keeps the bot
for reuse; the channel wiring is what's lost.

**Channel triggers** — once a bot is in a channel, each conversation has a trigger
mode: `mention` (@-mention only, the default), `any` (every message), or `off`
(muted, membership and history preserved). Restricted agents start with channels
`off` until an allowed editor enables them.

**In-conversation commands** (handled by the daemon, so they work even during a CP
outage): `/stop` interrupts the current run, `/queue` defers messages, `/status`
shows token usage, `/model` switches model/reasoning.

## Permissions ([docs/permissions-overview](https://docs.agentconnect.md/docs/permissions-overview))

Layered — broader grants never override narrower restrictions. Evaluation order:
org membership → role → resource visibility → session visibility → agent-to-agent
policy.

- **Roles**: Owner, Collaborator, Viewer — what a person may do across the org.
- **Resource visibility**: agents, daemons, schedules, tools set to Everyone or
  Selected.
- **Session visibility**: per-transcript (Everyone / Private / Slack members /
  GitHub access).
- **Agent visibility**: which agents may discover and call one another (inbound and
  outbound, All or Selected).

Distinct, composable controls that are easy to confuse: an agent's **permission
mode** governs its runtime autonomy; **sandboxing** is OS-level isolation;
**repository access** is GitHub read/comment/write; **platform app scopes** are
provider-side; **tool and secret configuration** bounds the agent process.
Visibility never grants repository write; agent-calling rights never unlock hidden
resources.

## Tools & Skills ([docs/tools-and-skills](https://docs.agentconnect.md/docs/tools-and-skills))

Capabilities are registered **once at the org level**, then enabled **per agent** —
adding to the library gives nothing to any agent automatically.

- **MCP servers / connectors**: browse OpenConnector providers or register a custom
  HTTP MCP endpoint by URL; set visibility; optional upstream headers are write-only
  after save. Agents receive a **managed proxy grant**, never the upstream URL or
  credential. A provider only appears for an agent when its daemon+runtime support
  the transport; each tool is toggled on individually.
- **Skills**: reusable capabilities (folders containing a `SKILL.md`) in a central
  library with two source types — **Git skill sources** (installed from the public
  [skills.sh](https://skills.sh) registry or a public GitHub `owner/repo`, optionally
  pinned to branch/tag/commit or filtered to a subdirectory; re-installed when the
  source updates) and **managed skills** (immutable owner-approved revisions,
  archivable/restorable). Skills are disabled by default; enable per agent under
  Tools & Skills → Skills. Disable everywhere before deleting a source.

## Knowledge & Memory ([docs/knowledge](https://docs.agentconnect.md/docs/knowledge))

- **Organization Knowledge**: published, versioned Markdown all members can read;
  only Owners publish. Edits create new immutable revisions (full history); entries
  can be archived and restored. Agents query it on demand through a read-only
  `findKnowledge` tool (search by text and tags) — the library is never bulk-copied
  into prompts.
- **Memory** comes in three shapes: **Managed** (drives Dreaming — pattern detection
  that proposes improvements, auto-adopted or Owner-reviewed), **Native** (each
  agent's own runtime memory backend and policy), and **External** (org-approved
  services such as Mem0 OSS that agents opt into with their own recall/capture
  policies; approving a connection changes no agent by itself).
- **Dreaming proposals** land in a Suggestions queue for Owner review; accepted
  knowledge becomes an immutable library revision, accepted skills land in the
  Skills library (still needing per-agent enablement).

## Guides

- [Fast and deep PR reviews](https://docs.agentconnect.md/docs/fast-and-deep-pr-reviews)
- [One Slack app across channels](https://docs.agentconnect.md/docs/one-slack-app-across-channels)
- [Hand-off conversations across messaging platforms](https://docs.agentconnect.md/docs/hand-off-conversations-across-messaging-platforms)
- [Install the daemon](https://docs.agentconnect.md/docs/install-the-daemon) ·
  [OSS get started](https://docs.agentconnect.md/docs/oss-get-started)

## The open-source codebase

AgentConnect is developed in a pnpm monorepo (`packages/*`), Node ≥ 24:

| Package                          | Role                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| `@agentconnect.md/protocol`      | Shared zod wire contract — frames, normalized message schemas, fencing fields.                 |
| `@agentconnect.md/message`       | Pure Slack/Lark/Telegram/Discord message normalization (no SDKs, no I/O).                      |
| `@agentconnect.md/daemon`        | The edge unit; ships the `agentconnect` CLI (`run`, `chat`).                                   |
| `@agentconnect.md/control-plane` | Fastify + Prisma (Postgres); one process hosts the REST BFF and the daemon WebSocket endpoint. |
| `@agentconnect.md/web`           | Next.js console.                                                                               |

Authoritative design documents live in the repo's `docs/designs/` (start with
`daemon-centric-architecture.md`).
