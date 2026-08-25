# Detailed Design: Components, Technology Choices, and Interfaces

> **Status:** Architecture design reference.
>
> This document defines the C1-C7 and D1-D12 component model, technology
> choices, and interfaces for
> [`architecture.md`](architecture.md). For exact
> current behavior, use [`daemon-cp-ws-protocol.md`](daemon-cp-ws-protocol.md)
> and `packages/protocol/src/frame.ts` for the control wire,
> [`daemon-detailed-design.md`](daemon-detailed-design.md) for the daemon, and
> [`control-plane-implementation.md`](control-plane-implementation.md) for the
> Control Plane. Package manifests are authoritative for library and runtime
> versions.

---

## 1. Design Constraints (Hard Requirements That Determine the Choices)

Every choice in this document is bounded by the following **settled product constraints**. Their rationale is not repeated here; only their design impact is noted.

| Constraint                                                                                                                                     | Design impact                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Platform integrations live at the daemon edge; the Control Plane is outside the message hot path**                                           | Live messaging remains on the daemon/relay data plane; the Control Plane carries orchestration and bounded, on-demand BFF reads without persisting their content.                                |
| **ACP is daemon-owned and never crosses the Control Plane** (local IPC self-hosted; one in-cluster dial to the sandbox pod in the daemon pool) | The ACP host and ACP adapter exchange stdio JSON-RPC; the pool carries that same stream over the shim connection.                                                                                |
| **`agent : channel(integration) : machine = 1 : N : 1`**                                                                                       | An agent runs on only one machine; one machine runs many agents; one agent has many IM integrations. **Machine isolation is a hard security requirement.**                                       |
| **Reuse the ACP ecosystem; product code must not be written for each agent type**                                                              | ACP adapters such as `claude-agent-acp` and `codex` are started as **subprocesses** (stdio JSON-RPC), independent of the daemon's implementation language. Product code only needs to speak ACP. |
| **Agent-to-agent and proactive messaging need a custom layer: inject tools into agents**                                                       | Use **MCP** to register product tools with the agent. Platform and service credentials remain outside the model's context.                                                                       |
| **Workspace paths are daemon-owned**                                                                                                           | Repository and scratch workspaces use daemon-generated paths; multiple agents may use different subdirectories of one repository.                                                                |
| **cron/loop is required and must be reliable**                                                                                                 | Schedules fire locally on the daemon, including during a Control Plane outage.                                                                                                                   |
| **Credential custody is centralized and delivery is least-privilege**                                                                          | The Control Plane persists integration secrets through the configured cipher and sends only assigned credentials to the owning daemon over the authenticated control connection.                 |

---

## 2. System Layers

```
┌───────────────────────────────────────────────────────────────────┐
│ Control Plane (control + bounded BFF reads / outside message path) │
│   Web UI ── API/BFF ── Orchestrator ── Registry&Auth ── Secrets Svc │
│                          │                                          │
│                     Persistence (Postgres)  Observability Backend  │
└──────────────────────────┬────────────────────────────────────────┘
                           │  Control WebSocket (orchestration/control/
                           │  telemetry + bounded BFF read-back; no live
                           │  platform or ACP update stream)
            ┌──────────────┴───────────────┐
            ▼                              ▼
┌────────────────────────────┐   ┌────────────────────────────┐
│ Daemon (Computer A, edge)   │   │ Daemon (Computer B, same)  │
│  ┌─ Supervisor (process/lifecycle)                              │
│  ├─ CP-Client (WebSocket client)                                │
│  ├─ Platform Adapters: slack-adapter / telegram-adapter        │
│  ├─ Message Normalizer & Local Router (session↔agent routing)  │
│  ├─ Local Scheduler (cron/loop, triggered locally)             │
│  ├─ ACP Host (local ACP client) ──stdio JSON-RPC──┐            │
│  ├─ MCP Tool Server (sendMessage, injected into agent) │      │
│  ├─ Workspace Manager (git repo / memory.md)          │      │
│  ├─ Secrets Agent / Local Store (SQLite)              ▼      │
│  └─ ACP Adapters (third party): claude-agent-acp / codex      │
│                                                → model process │
└────────────────────────────┘   └────────────────────────────┘
        │ Slack/Telegram bot API (data plane, direct from edge)
        ▼
   IM platforms
```

**Keep the two process boundaries distinct:**

- **Network boundaries**: daemon ↔ Control Plane (WebSocket, control signals), and daemon ↔ IM platform (platform API, data plane).
- **Local boundaries**: most modules inside a daemon run **in the same process**. The ACP Host ↔ ACP adapter ↔ model process chain consists of **local subprocesses** connected through stdio.

---

## 3. Module Summary

| #   | Module                                | Layer         | Form                          | Responsibility in one sentence                                                    |
| --- | ------------------------------------- | ------------- | ----------------------------- | --------------------------------------------------------------------------------- |
| C1  | **Web UI**                            | Control Plane | Standalone frontend           | Configuration and monitoring for agents, channels, workspaces, and sessions       |
| C2  | **API / BFF**                         | Control Plane | Service                       | Web UI backend: REST, SSE, and authentication entry point                         |
| C3  | **Orchestrator**                      | Control Plane | In-process service module     | Session ownership, agent placement, scaling, and orchestration commands           |
| C4  | **Registry & Auth**                   | Control Plane | Service                       | Daemon registration/health, routing table, and daemon authentication and rotation |
| C5  | **Secrets Service**                   | Control Plane | In-process service module     | Cipher-mediated platform credential custody and assigned-daemon delivery          |
| C6  | **Persistence**                       | Control Plane | Database                      | Configuration, routing, session metadata, audit data, and telemetry metadata      |
| C7  | **Observability Backend**             | Control Plane | External component            | Aggregation and presentation of metrics, logs, and traces                         |
| D1  | **Daemon Supervisor**                 | Daemon        | In-process core               | Process bootstrap, module lifecycle, and degraded-mode control                    |
| D2  | **CP-Client**                         | Daemon        | In-process                    | The daemon's single WebSocket connection to the Control Plane                     |
| D3  | **Platform Adapters**                 | Daemon        | In-process modules            | Platform I/O, normalization, and outbound rendering                               |
| D4  | **Message Normalizer & Local Router** | Daemon        | In-process                    | Route normalized messages to agents using the session routing table               |
| D5  | **Local Scheduler**                   | Daemon        | In-process                    | Trigger cron/loop locally, including during a control-plane outage                |
| D6  | **ACP Host**                          | Daemon        | In-process (local ACP client) | Drive ACP adapters over ACP and manage sessions                                   |
| D7  | **ACP Adapters**                      | Daemon        | **Third-party subprocesses**  | Implement ACP and start models: `claude-agent-acp` / `codex`                      |
| D8  | **MCP Tool Server**                   | Daemon        | In-process (local MCP server) | Inject tools such as `sendMessage` into agents                                    |
| D9  | **Workspace Manager**                 | Daemon        | In-process                    | Manage both git-repo and `memory.md` working directories and install skills       |
| D10 | **Secrets Agent**                     | Daemon        | In-process                    | Apply assigned credentials and refresh platform connections                       |
| D11 | **Local Store**                       | Daemon        | Embedded database             | Session state, transcripts, and degraded-mode cache                               |
| D12 | **Telemetry Reporter**                | Daemon        | In-process                    | Export OpenTelemetry and report metadata-only session/usage events                |

---

## 4. Module Details (Responsibilities, Language, Dependencies, and Key Interfaces)

The daemon and Control Plane use TypeScript on Node.js 24.12+. This keeps the
daemon-owned platform adapters, routing, and session orchestration in one
process and lets both sides share the zod-based `protocol` package. ACP and MCP
remain language-neutral subprocess boundaries that communicate through JSON-RPC
over stdio; they do not create source-level coupling to TypeScript.

### C1. Web UI

- **Responsibilities**: agent (name, skills, runtime), channel integration (connect Slack/Telegram, credential and binding rules), workspace (directory/git tree), sessions (metadata plus daemon-served transcript details), cron/loop, and dashboard (status, usage, alerts).
- **Language/framework**: TypeScript + **React 19 + Next.js** (App Router).
- **Dependencies**: package manifests are authoritative; the UI uses Next.js, React, Tailwind, SWR, and the shared HTTP client layer.
- **External interface**: communicates only with **C2 API/BFF**, never directly with a daemon.

### C2. API / BFF

- **Responsibilities**: backend aggregation layer for the Web UI; authentication entry point (OIDC/JWT); CRUD for agent/channel/workspace/cron configuration; expose daemon-reported session metadata and daemon-served transcript details.
- **Language/framework**: TypeScript + **Fastify**.
- **Dependencies**: `fastify`, `@fastify/websocket`, `zod` + `fastify-type-provider-zod`, `jose` (JWT), `@prisma/client` (database access), and `pino` (logging).
- **Key interfaces**: see §6.5 (REST + subscriptions).

### C3. Orchestrator

- **Responsibilities**: **orchestrate without touching messages** — determine which daemon owns a workspace/session; instruct daemons to start or stop agents; place and scale agents from reported load/health; maintain the **global routing table** (session→daemon) and distribute it to each daemon's local router (D4).
- **Language/framework**: TypeScript **in the same process as C2** (one Fastify instance hosting the WebSocket server), separated as a logical module.
- **Dependencies**: `ws` (daemon WebSocket server), `zod` (the `protocol` package), and plain TypeScript for the placement/scaling state machine; no heavyweight framework is needed.
- **Key interface**: the control-plane WebSocket protocol in §6.1.

### C4. Registry & Auth

- **Responsibilities**: daemon registration and health table; daemon capabilities (supported platforms/agent runtimes); daemon authentication using a long-lived, revocable **API key** (opaque token, stored as a hash and used as the lookup key; see [daemon-api-key-auth.md](daemon-api-key-auth.md)); persisted routing policies.
- **Language/dependencies**: same process as C2/C3; `@prisma/client`; `node:crypto` for HMAC and `timingSafeEqual` API-key verification.
- **Key interfaces**: the daemon's initial handshake (§6.1 `register` + `auth`); the Web UI reads the registry through C2.

### C5. Secrets Service

- **Responsibilities**: custody of platform credentials such as bot tokens and signing secrets; deliver only credentials assigned to a daemon; support rotation and revocation.
- **Storage**: `bot_secret` rows pass through the Control Plane's unified
  `SecretCipher`. The persisted representation depends on the configured
  provider selected through runtime configuration. See
  [`secret-store-seams.md`](secret-store-seams.md).
- **Delivery**: `integration/upsert` carries the assigned credential inside the authenticated WebSocket/TLS channel. Secret values are excluded from read DTOs and logs.
- **Key interface**: integration configuration frames consumed by D10 on the daemon.

### C6. Persistence

- **Responsibilities**: store configuration (agent/channel/workspace/cron definitions), routing tables, session metadata (**metadata and summaries only, never individual message bodies**, which remain local to daemons), audit logs, and telemetry indexes.
- **Choice**: **PostgreSQL**, with **Prisma** as the ORM for type safety and friendly migrations. Time-series telemetry belongs in the Observability Backend rather than Postgres.
- **Key interface**: accessed only within the Control Plane.

### C7. Observability Backend

- **Responsibilities**: aggregate and display metrics, logs, and traces reported by daemons.
- **Choice**: daemons emit OpenTelemetry data to the configured OTLP endpoint. Control-plane session milestones and usage summaries use the control connection. See §9.

---

### D1. Daemon Supervisor

- **Responsibilities**: process bootstrap; start and stop modules (adapters, ACP Host, agent runtime) according to orchestration commands; health self-checks; act as the **degraded-mode controller**, switching to "local autonomy" when CP-Client disconnects so existing sessions remain active and new assignments are paused.
- **Language/dependencies**: TypeScript / Node.js 24.12+; `node:child_process` for subprocesses; plain TypeScript for lifecycle state; `pino` for logging.
- **Key interface**: coordinates daemon modules in process; it does not expose an external protocol itself.

### D2. CP-Client

- **Responsibilities**: maintain the **single** WebSocket connection to the
  Control Plane; reconnect with exponential backoff; heartbeat; carry
  registration, orchestration, and telemetry; and serve scoped, bounded BFF
  reads of daemon-local content. Live platform messages and ACP update streams
  stay on the data plane.
- **Language/dependencies**: TypeScript; `ws` (client), `zod` (`protocol` validation), and custom reconnection and heartbeat logic.
- **Key interface**: the control-plane protocol in §6.1.

### D3. Platform Adapters

- **Responsibilities**: platform connection and authentication, message sending and receiving, rich-text and attachment normalization, and inbound/outbound mapping; **hold platform credentials** obtained from D10; **register MCP tools** through D8 to expose proactive channel messaging to the agent.
- **Implementation strategy**: **own the platform adapters inside the AgentConnect daemon**. For Slack, `SlackConnection` manages direct-mode Socket Mode connections and daemon-owned Web API clients; in shared mode, the relay owns inbound delivery while the daemon retains its send-only path. `normalizeSlackEvent` maps inbound events to `NormalizedMessage`. Thread/session state, trigger evaluation, routing, and ACP dispatch remain daemon responsibilities rather than adapter behavior. Other platforms follow the same normalized-message boundary.
- **Language/dependencies**:
  - slack-adapter: `@slack/bolt` in **Socket Mode** (no public callback) + `@slack/web-api` (`chat.postMessage`, etc.).
  - telegram-adapter: **`grammY`**, a TypeScript-friendly Telegram bot framework.
- **Key interfaces**:
  - Downstream (platform→daemon): submit a **normalized message** (§6.6 `NormalizedMessage`) to D4.
  - Upstream (daemon→platform): provide `reply(threadRef, content)` and `sendMessage(target, content)`. The latter implements the tool injected into the agent, while the adapter retains the token.
- **Platform coverage**: daemon adapters support Slack, Telegram, Discord, and Lark / Feishu. Webchat and hook are session-level sources. Shared-bot, webchat, and webhook ingress is accepted by the relay and delivered to the owning daemon; see [`shared-bot-relay.md`](shared-bot-relay.md).

### D4. Message Normalizer & Local Router

- **Responsibilities**: normalize raw platform events into `NormalizedMessage`; bind each "session (thread) → agent" using the **local routing table** (distributed by C3 and cached locally); match trigger rules (@mention, DM, specific text, or automatic handling in an alert channel); deliver messages to the corresponding ACP Host session.
- **Language/dependencies**: TypeScript; pure logic; `zod` for message validation; reads the D11 SQLite routing table for degraded-mode caching.
- **Key interfaces**:
  - Input: `route(msg: NormalizedMessage)`.
  - Output: `acpHost.prompt(sessionId, content)` (§6.3).
  - Configuration: receive C3's `route/assign` and `route/update` (§6.1).

### D5. Local Scheduler

- **Responsibilities**: trigger cron/loop **locally**. A cron schedule uses its trigger text to invoke a **specific agent**. The Web UI configures the definition, C3 delivers it to the owning daemon selected by `agentId`, and the daemon keeps the CP-owned definition in memory alongside any hand-authored local crons. At the scheduled time, if `target.channel` exists, the local scheduler first posts the trigger as a real channel message and attaches the agent session to the resulting thread for replies. Without a target, it runs headlessly. An already-running daemon retains this state during a CP outage; after daemon restart the CP roster must re-converge it.
- **Language/dependencies**: TypeScript; **`croner`** (pure JavaScript, dependency-free, supports time zones, and preferable to the aging `node-cron`); persist `last-run` in D11 for deduplication and catch-up.
- **Key interfaces**: input: C3 sends `cron/upsert` and `cron/remove` (§6.1), which update the memory-only CP cron registry; output: construct a `NormalizedMessage{ source: "cron" }` and dispatch it directly to the agent; reporting: execution results through D12.

### D6. ACP Host (Local ACP Client)

- **Responsibilities**: act as the ACP **client** (the role normally played by an IDE/editor); start the corresponding ACP adapter subprocess locally under the 1 agent : 1 machine rule; manage the ACP session lifecycle (new/prompt/load/cancel); handle reverse agent→client calls (file reads/writes, permission requests, and incremental `session/update` streams); **condense** agent output before returning it to D3, addressing the requirement that a channel show only start/plan/problem/end plus a link.
- **Preset webchat admin MCP**: an entitled private webchat conversation on the
  built-in preset receives a session-scoped remote HTTPS MCP descriptor. The runtime
  calls the CP-hosted catalog directly with a short-lived opaque conversation grant;
  no dedicated ACP host or OS sandbox is required by this feature. Support is
  advertised through `webchat_remote_mcp_v1`; see
  [`webchat-preset-agentconnect-mcp.md`](webchat-preset-agentconnect-mcp.md).
- **Language/dependencies**: TypeScript; **`@agentclientprotocol/sdk`** for ACP; `node:child_process` for subprocesses; `zod`.
- **Key interfaces**: local ACP JSON-RPC in §6.3; expose the "current session context" to D8 so injected tools carry the channel/thread handle.

### D7. ACP Adapters (Third Party)

- **Responsibilities**: implement the ACP **agent side** and start/drive a model harness locally. **Product code does not implement these**; use executables from the registry directly.
- **Choices (executables not maintained by us)**:
  - `claude-agent-acp` (official Zed adapter that drives the Claude Code CLI/harness).
  - The official Zed ACP adapter for `codex`.
  - Any other ACP-compatible agent is plug-and-play, which is ACP's core value.
- **Runtime form**: D6 starts the adapter as a subprocess over stdio, typically through `npx` or a binary. ACP registry configuration gives the ACP Host the startup command for each runtime.
- **Key interface**: ACP (§6.3) upward. The harness-specific interface below it is outside the daemon.

### D8. MCP Tool Server

- **Responsibilities**: provide **agent-to-agent collaboration and proactive messaging** by injecting daemon-owned tools into agents. The adapter retains platform credentials and the agent never sees them.
- **Remote admin MCP**: the built-in preset's entitled webchat session may also
  receive `agentconnect-admin` as a private, session-scoped HTTPS MCP descriptor.
  The runtime calls the CP endpoint directly; the daemon does not proxy the MCP body
  or hold an administrative broker. CP involvement remains limited to explicit
  management-tool calls, not browser message bodies or ACP streams.
- **Implementation path**: run an **MCP server** inside the daemon and configure the ACP adapter to use it. Most harnesses support tool integration through an MCP server. Internally it calls D3's `sendMessage` and D4's agent-discovery table.
- **Language/dependencies**: TypeScript; **`@modelcontextprotocol/sdk`** (MCP server with stdio transport); `zod` (tool input schema).
- **Exposed tool families**: unified messaging (`sendMessage`), channel context and discovery, memory, direct agent collaboration, orchestration, file reads, and eligible GitHub review submission. `packages/daemon/src/mcp/tools.ts` is authoritative.
- **Key interface**: MCP over stdio upward to the ACP adapter; calls daemon messaging, routing, collaboration, and orchestration services internally. See [`agents-collaboration-design.md`](agents-collaboration-design.md).

### D9. Workspace Manager

- **Responsibilities**: manage agent working directories. **The daemon always generates working-directory paths**; the CP/UX never supplies a path. Support two modes:
  - **(1) Repository workspace**: the daemon clones `gitRepo` at `branch` into an automatically generated path; the agent runs in `agentDir`, a subdirectory within the repository that defaults to the repository root. **Multiple agents may share one repository** by using different `agentDir` values. As a daemon-local optimization, the daemon may reuse one checkout per `(gitRepo, branch)` and point each agent to its own `agentDir`; this does not affect the protocol.
  - **(2) Scratch workspace**: without git, the daemon creates an empty working directory.
  - Long-term memory lives under the agent root, outside either workspace, and is selected through the memory provider described in [`memory-system-plan.md`](memory-system-plan.md).
  - One-click installation of a skill from a git repository into the workspace's skill directory.
- **Language/dependencies**: TypeScript; `simple-git` (git operations), `fs/promises`, and `zod`.
- **Key interfaces**: provide D6 with workspace preparation that creates or reuses the directory from `spec.workspace`, changes into `agentDir`, and returns the cwd used to launch the ACP adapter. Workspace configuration is embedded in the agent spec and distributed by the CP through `agent/launch`, `agent/upsert`, and `register/ok`.

### D10. Secrets Agent

- **Responsibilities**: accept assigned integration credentials from authenticated `integration/upsert` frames, update the corresponding daemon-local agent configuration, and refresh D3 after rotation or revocation.
- **Language/dependencies**: TypeScript and daemon-local configuration storage. The daemon has no direct Vault or cloud secret-manager client.
- **Key interfaces**: integration configuration frames from C5; credential injection into D3.

### D11. Local Store

- **Responsibilities**: session state; local cache of routing and cron definitions for degraded operation; message bodies, transcripts, display-name caches, durable ingress rows, and other daemon-local continuity data. The centralized side stores only session metadata and summaries.
- **Choice**: **SQLite** through Node's built-in `node:sqlite` synchronous API, with daemon-owned schema initialization and migrations.
- **Key interface**: accessed only by modules inside the daemon.

### D12. Telemetry Reporter

- **Responsibilities**: collect structured metrics and traces, attach trace IDs to normalized messages, and report session milestones and token usage without sending message bodies to the Control Plane.
- **Language/dependencies**: TypeScript; **OpenTelemetry** (`@opentelemetry/api` + `@opentelemetry/sdk-node`) and structured `pino` logs.
- **Key interfaces**: emit telemetry through the configured OTLP exporter; send metadata-only `event/session` and `usage/report` frames through D2.

---

## 5. Technology Choice Summary

| Dimension                | Choice                                         | Rationale in one sentence                                                                                                                          |
| ------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Primary language**     | TypeScript / Node.js 24.12+                    | Keep daemon-owned adapters in-process and share the `protocol` package across daemon/CP. ACP/MCP remain language-neutral stdio boundaries; see §4. |
| **Monorepo**             | pnpm workspaces                                | Keep `protocol`, `daemon`, `control-plane`, and `web` in one repository and prevent type drift.                                                    |
| **Protocol/validation**  | zod (shared schema)                            | One schema provides runtime validation and exported TypeScript types across processes.                                                             |
| **ACP library**          | `@agentclientprotocol/sdk`                     | Drive ACP adapters over stdio JSON-RPC.                                                                                                            |
| **ACP adapters**         | ACP registry executables                       | Keep harness-specific runtime implementations outside AgentConnect product code.                                                                   |
| **MCP injection**        | `@modelcontextprotocol/sdk`                    | Expose daemon-owned messaging, collaboration, memory, and orchestration tools.                                                                     |
| **Slack**                | `@slack/bolt` + `@slack/web-api`               | Support direct Socket Mode and daemon-owned outbound clients, with relay-delivered shared ingress.                                                 |
| **Telegram**             | `grammY`                                       | TypeScript-first Telegram bot framework.                                                                                                           |
| **WebSocket**            | `ws`                                           | Lightweight bidirectional control connection.                                                                                                      |
| **CP backend**           | Fastify + Prisma                               | Fast server plus a type-safe ORM.                                                                                                                  |
| **CP database**          | PostgreSQL                                     | Configuration, metadata, authorization, and audit data.                                                                                            |
| **Daemon local storage** | SQLite (`node:sqlite`)                         | Embedded storage for session continuity and degraded autonomy.                                                                                     |
| **Web UI**               | React + Next.js + Tailwind                     | Shared TypeScript types and a responsive console.                                                                                                  |
| **Secrets**              | `SecretCipher` with pluggable providers        | Apply the configured storage transform and keep secret values out of read APIs; encrypt at rest when an encrypting provider is enabled.            |
| **Observability**        | OpenTelemetry                                  | Produce telemetry at the daemon edge and export through the configured collector path.                                                             |
| **Process management**   | `node:child_process`                           | Start ACP adapter and model subprocesses.                                                                                                          |
| **cron**                 | `croner`                                       | Pure JavaScript scheduling with time-zone support.                                                                                                 |
| **git**                  | `simple-git`                                   | Manage repository workspaces.                                                                                                                      |
| **GitHub integration**   | GitHub App credentials and webhook event flows | Keep repository authorization and GitHub-triggered work explicit; see the dedicated GitHub design documents.                                       |

---

## 6. Inter-Module Communication Interfaces

Each of the five boundary types uses the protocol best suited to it:

| Boundary                                | Protocol                                             | Direction     | Payload                                             |
| --------------------------------------- | ---------------------------------------------------- | ------------- | --------------------------------------------------- |
| daemon ↔ Control Plane                  | **WebSocket + JSON frames (zod validation)**         | Bidirectional | Control/telemetry plus bounded on-demand BFF reads  |
| platform ↔ adapter                      | **Native platform API** (Slack Socket Mode/Telegram) | Bidirectional | User messages (data plane, closed loop at the edge) |
| adapter/router ↔ ACP Host ↔ ACP adapter | **ACP (JSON-RPC 2.0 over stdio)**                    | Bidirectional | Prompts, streaming updates, files, permissions      |
| ACP adapter ↔ agent tool                | **MCP (JSON-RPC over stdio)**                        | Bidirectional | Injected tool calls such as `sendMessage`           |
| Web UI ↔ API/BFF                        | **REST + SSE**                                       | Bidirectional | Configuration CRUD + live session events            |

### 6.1 Control-Plane Protocol: daemon ↔ Control Plane (WebSocket)

The authoritative contract is
[`daemon-cp-ws-protocol.md`](daemon-cp-ws-protocol.md) and
`packages/protocol/src/frame.ts`.

**Transport**: the daemon initiates one WebSocket. Every frame uses a common
envelope, with `type` selecting the payload schema through the
`FRAME_SCHEMAS` zod registry. The first `auth` frame carries a revocable opaque
API key. WebSocket `ping`/`pong` and application-level `heartbeat` frames
provide liveness.

```jsonc
// Common envelope
{
  "v": 1,
  "type": "<msgType>",
  "id": "<uuid>",
  "ts": "<RFC3339>",
  "corr": "<request-id-if-this-is-a-reply>",
  "payload": {/* selected by type */}
}
```

Frame families cover authentication and registration, agent lifecycle,
routing, integrations, crons, hooks and reviews, collaboration, memory, MCP
configuration, git credentials, session/workspace reads, telemetry, fleet
control, and correlated replies. C→D mutation frames carry `sessionEpoch` and,
where applicable, `launchId` fencing. Message prompts and ACP update streams do
not travel on this connection.

**Degraded semantics**: when the WebSocket disconnects, the daemon enters D1
local autonomy. It stops consuming new control commands, while established
sessions and daemon-local schedules continue from local state. After
reconnection, `auth` establishes a new epoch and `register` reconciles the
daemon with the current Control Plane snapshot.

### 6.2 Platform ↔ Adapter (Data Plane, Closed Loop at the Edge)

- **Slack**: direct integrations receive events over Socket Mode; shared ingress arrives from the relay. Outbound messages use the daemon-owned Web API client.
- **Telegram**: `grammY` long polling (or webhook); send through `sendMessage`.
- The adapter normalizes inbound events into `NormalizedMessage` (§6.6) and submits them to D4. **The Control Plane is never involved.**

### 6.3 Local ACP: ACP Host ↔ ACP Adapter (JSON-RPC 2.0 over stdio)

The ACP Host acts as the **client** and the ACP adapter as the **agent**. They are local subprocesses connected through stdio, with no network hop. Core ACP-standard methods:

**client → agent**

| Method           | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `initialize`     | Negotiate protocol version/capabilities, including the available MCP server list |
| `session/new`    | Create a session with `cwd` prepared by D9 and `mcpServers` supplied by D8       |
| `session/load`   | Restore an existing session (resume, unlike Hermes, which has no resume)         |
| `session/prompt` | Deliver a user or synthesized message from D4                                    |
| `session/cancel` | Cancel the current turn                                                          |

**agent → client (reverse notifications/requests)**

| Method                                    | Purpose                                                                                        |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `session/update`                          | **Streaming increments** (thinking / tool calls / text), which D6 uses to **condense output**  |
| `session/request_permission`              | Request permission for dangerous actions, mapped to communication policy / Web UI confirmation |
| `fs/read_text_file`, `fs/write_text_file` | Read/write workspace files through a D9 gateway with boundary enforcement                      |

> Key point: declaring `mcpServers` in `session/new` places D8 tools such as `sendMessage` into the agent's tool space. This is the concrete implementation of "inject tools into the agent."

### 6.4 MCP Tool Injection: ACP Adapter ↔ MCP Tool Server (D8)

D8 is declared to the agent as a stdio MCP server in `session/new`. The daemon
builds the tool list from the agent's integrations, runtime capabilities, and
organization policy:

- `sendMessage` sends to exactly one peer agent, platform channel or human, or
  parent session. The daemon resolves the target connection and keeps every
  platform credential outside the model context.
- Channel and identity tools expose the current channel, connected channels,
  users, members, profiles, files, and discoverable AgentConnect agents.
- Memory tools delegate to the configured memory provider.
- Orchestration tools start, inspect, and cancel multi-agent work.
- GitHub review submission is injected only for an eligible review-triggered
  session.

`packages/daemon/src/mcp/tools.ts` defines the descriptors and
`packages/daemon/src/mcp/ops.ts` implements their daemon-side operations.

### 6.5 Web UI ↔ API/BFF (REST + SSE)

The public REST surface is versioned under `/api/v1`. Human-facing resources
are organization-scoped under `/api/v1/orgs/:orgId` and protected by human
authentication plus membership and visibility checks. The Web UI uses these
routes for agents, integrations, sessions, crons, daemons, usage, and related
configuration.

`GET /api/v1/orgs/:orgId/stream` provides a visibility-filtered SSE feed of
metadata-only `event/session` milestones. Session detail routes obtain
transcripts and workspace reads from the owning daemon through correlated
control requests; the Control Plane does not persist message bodies or
attachment bytes.

`GET /api/v1/openapi.json` is authoritative for route paths and schemas.

### 6.6 Shared Data Models

`packages/protocol/src/frame.ts` and its imported zod schemas define every
daemon↔Control Plane frame. The shared platform enum covers `slack`,
`telegram`, `webchat`, `discord`, `feishu`, and `hook`.

`packages/daemon/src/messages/normalized.ts` defines the daemon-local
`NormalizedMessage`. It carries a stable message ID, trace ID, source,
platform, channel/thread coordinates, sender metadata, text, mention data,
attachments, direct-message state, and a typed trigger. Live normalized
messages and attachment fetch URLs stay on the daemon/relay data plane; an
authorized BFF read may proxy a bounded stored transcript projection.

Agent configuration embeds its daemon-owned workspace specification and has
zero or more integration and cron definitions. Integration frames carry only
the assigned bot configuration to the owning daemon. Session events sent to
the Control Plane contain metadata and summaries; transcript rows remain in
the daemon's local store.

---

## 7. End-to-End Sequence (Inbound Message)

```
A user posts in a Slack thread
 → D3 receives the event directly or through shared ingress, injects traceId,
   and normalizes it into NormalizedMessage
 → Local Router (D4) matches an agent from the local routing table
   (@mention / keyword / auto)
 → ACP Host (D6) calls session/prompt for that session
   (local stdio, no network)
 → claude-agent-acp (D7) drives the model; session/update streams back to D6
 → D6 condenses output: the channel receives only start/plan/problem/end + link
 → To message another channel or invoke another agent, the model calls
   sendMessage through D8, which delegates to daemon messaging/collaboration services
 → D3 replies in the thread or posts to the selected platform target
The Control Plane is never on the message path. D12 reports only session metadata
and usage through D2; OpenTelemetry data uses the configured OTLP exporter.
```

For a cron trigger, D5 constructs a synthetic message with `source:"cron"` and starts at D4. Everything afterward is identical, so it **still fires while the Control Plane is offline**.

---

## 8. Runtime and Packaging Boundaries

- **daemon**: one Node.js process distributed through the daemon package. It
  starts ACP adapters with `node:child_process`. One machine may run many
  agents, but each agent is assigned to one daemon.
- **Control Plane**: the API/BFF, orchestrator, registry, and WebSocket endpoint
  share the Fastify service and PostgreSQL persistence boundary.
- **Credentials**: release artifacts contain no platform credentials. The
  Control Plane sends each integration secret only to its owning daemon through
  authenticated `integration/upsert` frames.

---

## 9. Observability Reporting

- **Control connection**: `event/session` supplies metadata-only session
  milestones for the console, and `usage/report` supplies cumulative token and
  cost data. These small frames share D2's authenticated WebSocket.
- **OpenTelemetry**: traces and metrics use the daemon's configured OTLP
  exporters. This traffic does not contain platform credentials or attachment
  bytes.
- **Correlation**: the same trace ID follows a normalized message through
  platform ingress, routing, ACP execution, and reporting.
