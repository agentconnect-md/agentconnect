# Detailed Design: Daemon (CLI / Configuration / Lifecycle / Platform Integration / CP Interaction)

> Status: Implemented.
>
> Related documents:
>
> - Architecture: [`daemon-centric-architecture.md`](daemon-centric-architecture.md), explaining why the architecture is daemon-centric.
> - System-level detailed design: [`daemon-centric-detailed-design.md`](daemon-centric-detailed-design.md), covering the modules, technology choices, and interfaces of the full system (Control Plane + Daemon).
> - Collaboration design: [`agents-collaboration-design.md`](agents-collaboration-design.md), covering the product model and MCP-injected agent messaging.
>
> This document specifies daemon modules D1-D12: CLI shape and persistent
> service, local configuration, agent directories, CP control with offline
> degradation, consolidated platform connections, child-process lifecycles,
> ACP-to-platform translation, and the outbound CP WebSocket client.

> **Current implementation notes:** the frame table in section 10 is only an
> overview; [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) and
> `packages/protocol/src/frame.ts` are authoritative for the wire. Telegram,
> Discord, and Feishu platform drivers are implemented. Slack additionally
> supports shared-bot relay ingress; see
> [shared-bot-relay.md](shared-bot-relay.md) and
> [feishu-integration.md](feishu-integration.md).

---

## 1. Component Structure and Responsibilities

This chapter summarizes the daemon's **modules and their responsibilities**. Every later chapter expands one or more of them. A daemon is a **self-contained "message ingress + agent execution" unit**: platform integration, local routing, ACP driving, tool injection, scheduled triggers, and degraded autonomy form a closed loop **inside one process**. The WebSocket to the Control Plane carries control traffic and bounded, authorized BFF reads; live platform messages and ACP updates stay off that connection.

### 1.1 Three Process Relationships (Establish the Boundaries First)

| Relationship                       | Protocol                                       | Payload                                                     | Details      |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- | ------------ |
| daemon <-> Control Plane           | WebSocket + JSON, initiated outbound by daemon | Control/telemetry plus bounded on-demand daemon-local reads | section 10   |
| daemon <-> IM platform             | Platform-native API, such as Slack Socket Mode | User messages; edge-connected data-plane loop               | sections 6/9 |
| ACP Host <-> ACP adapter <-> model | ACP, JSON-RPC 2.0 over **stdio**               | Prompt / streaming updates / files / permissions            | section 7    |
| ACP adapter <-> injected tools     | MCP, JSON-RPC over stdio                       | Tool calls such as sendMessage                              | section 9.4  |

> Most daemon modules are **in-process modules** sharing memory and an event bus. Only the ACP adapter/model runs as a **local child process** over stdio. ACP and MCP are therefore local protocols, not network protocols.

### 1.2 Component Overview

```
                       +------------ Control Plane ------------+
                       | Orchestrator - Registry & Auth - Secrets |
                       +-------------------+-------------------+
                         Control WebSocket: control/orchestration/
                         telemetry + bounded on-demand BFF reads
                                           |
   +-------------------------- Daemon (local, one process) --------------------------+
   |  Supervisor (bootstrap/lifecycle/degradation controller)                         |
   |  CP-Client (one WS)      <---disk---> ~/.agentconnect/** (desired state)         |
   |        |                                      |                                  |
   |  Reconciler (diff desired <-> actual, converge) <---watch------------------------+
   |   |- ConnectionManager - Platform Adapters (slack-adapter, etc.)                 |
   |   |        | send/receive + normalize                                             |
   |   |- Local Router / Normalizer - route table (NormalizedMessage -> agent/session) |
   |   |- Scheduler (cron/loop, local trigger -> synthetic message)                    |
   |   |- ACP Host (local ACP client) --stdio--> ACP Adapter child -> model harness    |
   |   |- MCP Tool Server (inject sendPlatformMessage, etc.) --MCP/stdio--> adapter    |
   |   |- Workspace Manager (git-repo / from-scratch / skills)                         |
   |   |- Local Store (SQLite: sessions/routes/crons/transcript/telemetry buffer)       |
   |   `- Telemetry (metrics/logs/traces)                                               |
   +----------------------------+------------------------------------------------------+
                  Slack/Telegram bot API (direct edge data plane)
                                        v
                                   IM platform
```

### 1.3 Daemon Module Responsibilities

| Module                                    | Form                            | Responsibility                                                                                                                                                    | Details             |
| ----------------------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
| **Supervisor**                            | In-process core                 | Process bootstrap, lifecycle of every module, and **degradation controller** that switches to local autonomy when CP disconnects                                  | sections 2.4/5.4    |
| **CP-Client**                             | In process                      | Maintains the single WebSocket to CP; authentication, heartbeat, reconnect backoff, orchestration, telemetry, and scoped on-demand BFF reads                      | section 10          |
| **Reconciler**                            | In process                      | Idempotently converges disk desired state against runtime actual state by opening/closing connections, starting/stopping agents, and adding/removing crons        | section 5           |
| **ConnectionManager + Platform Adapters** | In process; daemon-owned        | Consolidates platform connections by credential; platform send/receive; rich-text and attachment normalization; owns platform tokens                              | sections 6/9        |
| **Local Router / Normalizer**             | In process                      | Converts inbound events to `NormalizedMessage`; selects `(agent, session)` from the route table; trigger rules and multi-agent arbitration                        | sections 6.3/8      |
| **Scheduler**                             | In process                      | Fires cron/loop **locally**, including while CP is offline, and injects synthetic messages into Router                                                            | sections 4.2/7.4    |
| **ACP Host**                              | In process; local ACP client    | Starts and drives adapters through ACP; manages session lifecycles; **converges** streaming agent output                                                          | section 7           |
| **ACP Adapters**                          | **Third-party child processes** | `claude-agent-acp` / `codex`: implement the ACP agent side and launch the local model harness                                                                     | sections 7.1/3.3    |
| **MCP Tool Server**                       | In process; local MCP server    | Injects tools such as `sendPlatformMessage`, `listChannelAgents`, and `messageAgent`, filling ACP gaps                                                            | section 9.4         |
| **Workspace Manager**                     | In process                      | Manages `git-repo` and `from-scratch` workspaces, installs skills, and returns `cwd` from `prepareWorkspace`                                                      | section 4.3         |
| **Local Store**                           | Embedded SQLite                 | Session state, route/cron cache for degradation, thread transcript, and pending telemetry buffer                                                                  | section 3.2         |
| **Telemetry**                             | In process                      | Metrics/traces use direct OTLP side path (`startDaemonOpenTelemetry`, configured through `OTEL_*`); usage/facts use `usage/report` and `facts/*`; injects traceId | section 10.2        |
| **Secrets Agent** (future)                | In process                      | Credential lease delivery/rotation; the current version stores tokens directly in configuration                                                                   | future; section 3.3 |

### 1.4 Control Plane Components Used by the Daemon

The daemon does not implement these, but interacts with them through the section 10 WebSocket frames. See the upstream designs for CP internals.

- **Orchestrator:** Sends orchestration commands such as `route/assign`, `agent/upsert`, `agent/stop`, `cron/upsert`, and `daemon/drain`; uses daemon load/health for placement and scaling.
- **Registry & Auth:** Daemon registration and health records, capabilities, and **API-key** authentication, rotation, and revocation; see [daemon-api-key-auth.md](daemon-api-key-auth.md).
- **Secrets Service** (future): Delivers platform credentials on demand; not connected in the current version, as noted in section 3.3.

---

## 2. Daemon as a CLI Program and Persistent System Process

### 2.1 Form

`agentconnect`, optionally shortened to `acd` for AgentConnect Daemon, is a **single executable CLI**. It can run in the foreground for development/debugging or be installed as a persistent launchd/systemd service. Package it as an `npm bin` with optional `pkg` / container images. It starts ACP adapters on demand through `spawn` (`execa`).

> The **OS service manager owns lifecycle**: macOS launchd or Linux systemd `--user`. Do not use an application-managed detached child + PID file. After `install-service` writes the unit, `up`, `down`, and `restart` operate the system service directly. Crash restart and boot start belong to the service manager. Use `run` for foreground development or a container entrypoint. Redirect logs uniformly to `~/.agentconnect/logs/daemon.log`. System-service management is not supported on `win32`; `pickController` throws an explicit error directing the user to `run`.

### 2.2 Subcommands

| Command                             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentconnect run [--agent <name>]` | Run the daemon in the **foreground** for development or as container PID 1. By default, run all `active` agents under `--agents-dir`. `--agent <name>` runs the single agent whose `id == <name>`, ignoring `status`, with no extra configuration.                                                                                                                                                                                                                                                              |
| `agentconnect up`                   | Start an **installed system service** using launchd `bootstrap` or systemd `--user enable --now`. If not installed, exit nonzero and suggest `install-service` or `run`. Renamed from `start`.                                                                                                                                                                                                                                                                                                                  |
| `agentconnect down`                 | Stop the installed service using launchd `bootout` or systemd `--user disable --now`. If absent, behave like `up` and suggest `install-service` or `run`. Renamed from `stop`.                                                                                                                                                                                                                                                                                                                                  |
| `agentconnect restart`              | Run `down`, tolerating an already-stopped service, then `up`; both use the system service.                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `agentconnect status`               | Print service state (installed / running / PID / log path) and runtime state (CP connection, platform connections, active agents/sessions, degradation flag). Works even when no service is installed.                                                                                                                                                                                                                                                                                                          |
| `agentconnect install-service`      | Generate/install a launchd plist or systemd unit and run `daemon-reload`; **do not start automatically**. Print the `agentconnect up` hint.                                                                                                                                                                                                                                                                                                                                                                     |
| `agentconnect uninstall-service`    | Run `down`, then remove the unit file.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `agentconnect agent list`           | **Read-only:** list agents found under `--agents-dir`, including id, status, runtime, name, and directory. CP or manual `agent.json` editing owns business configuration; daemon only converges disk state, so CLI has no local create/update/delete operations.                                                                                                                                                                                                                                                |
| `agentconnect login`                | **Interactive CP onboarding:** prompt/read CP URL + token, then probe auth through `probeAuth`, which sends only `auth`, never `register`. On failure, show the reason and allow one token retry; a second failure exits 1. **Persist credentials only after success.** Ask whether to install as a background service: yes -> `install-service` + `up` and exit; no -> foreground `run` until Ctrl-C. Non-TTY falls back to flags, still probes/persists and skips prompts; there is no separate `--no-input`. |
| `agentconnect chat [message]`       | **Connect locally to one agent:** recursively discover agents under `--agents-dir`; use the only agent automatically, or require `--agent <name>` when several exist. Resolve its runtime, including registry defaults, launch the local ACP adapter, and converse over ACP. With `message`, send once, stream the reply, and exit; without it, enter a REPL. Do **not** start Slack, scheduler, store, CP, or the rest of daemon.                                                                              |

### 2.3 CLI Flags Override Configuration

**Precedence, high to low: `CLI flag > environment variable > config.json > built-in default`.** CLI flags override only **process-level** configuration such as endpoints, roots, and log level; they do not mutate agent business configuration.

| Flag                    | Config field overridden        | Purpose                                                                                                                                            |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config <path>`       | Locates the file itself        | Specify config.json, default `~/.agentconnect/config.json`.                                                                                        |
| `--root <dir>`          | Locates the root               | Override `~/.agentconnect`; maps to `AGENTCONNECT_ROOT`.                                                                                           |
| `--cp-url <wss://...>`  | `controlPlane.url`             | Override the CP endpoint; this is the most common override.                                                                                        |
| `--cp-key <key>`        | `controlPlane.key`             | Override the opaque, long-lived, revocable CP **API key**; see [daemon-api-key-auth.md](daemon-api-key-auth.md).                                   |
| `--no-cp` / `--offline` | `controlPlane.enabled=false`   | Force local-only mode with no CP connection.                                                                                                       |
| `--daemon-id <id>`      | `daemonId`                     | Override/specify daemon identity.                                                                                                                  |
| `--log-level <lvl>`     | `logging.level`                | trace/debug/info/warn/error.                                                                                                                       |
| `--agents-dir <dir>`    | `agentsDir`                    | Override agent discovery root. Daemon/`chat` recursively collect `agent.json`, skipping `node_modules`, `.git`, dot directories, depth about four. |
| `--agent <name>`        | Selector                       | Select by `agent.id`: single-agent `run` ignoring status, or disambiguate `chat`.                                                                  |
| `--max-agents <n>`      | `limits.maxAgents`             | Capacity reported to CP + local hard limit.                                                                                                        |
| `--require-sandbox`     | `security.requireSandbox=true` | Require every agent to run in an OS sandbox; refuse daemon startup if unsupported.                                                                 |
| `--dry-run`             | n/a                            | Load and validate all configuration and print the reconcile plan without opening connections/processes.                                            |

All environment equivalents use the `AGENTCONNECT_` prefix, such as `AGENTCONNECT_CP_URL`, `AGENTCONNECT_CP_KEY`, and `AGENTCONNECT_ROOT`, for containers and system services.

### 2.4 Mapping In-Process Responsibilities to CLI

`run`, including the same `run` managed by a service after `up`, starts every module in the section 1.2 diagram corresponding to upstream D1-D12: Supervisor, CP-Client, ConnectionManager and Platform Adapters, Local Router, Scheduler, ACP Host, MCP Tool Server, Workspace Manager, Local Store, and Telemetry. Secrets Agent remains future work. Sections 6-10 expand the parts directly related to the eight requirements.

### 2.5 Persistent System Service (Managed by the OS)

One **`ServiceController`** abstracts lifecycle, dispatching macOS to launchd, Linux to systemd `--user`, and `win32` to an error. It supplies the shared primitives behind `up`, `down`, `restart`, `status`, `install-service`, and `uninstall-service`:

```
install(opts)   Write the unit file (+ daemon-reload); do not start.
uninstall()     Run down(), then delete the unit.
up()            Load/enable + start.
down()          Stop + unload/disable.
status()        { installed, running, pid?, label, logPath }
isInstalled()   Whether the unit file exists.
```

- **macOS (launchd):** `~/Library/LaunchAgents/md.agentconnect.daemon.plist`, label `md.agentconnect.daemon`, reference `packages/cli/src/service/launchd.ts`. `ProgramArguments = [execPath, cliEntry, "run"]`; `RunAtLoad=true`; `KeepAlive.SuccessfulExit=false`; `StandardOutPath` / `StandardErrorPath` point to `~/.agentconnect/logs/daemon.log`. `up` uses `launchctl bootstrap gui/$UID <plist>` with `load -w` fallback; `down` uses `launchctl bootout gui/$UID/<label>` with `unload -w` fallback; status uses `launchctl print` / `list`.
- **Linux (systemd `--user`):** `~/.config/systemd/user/agentconnect.service`, with `[Service] ExecStart=execPath cliEntry run`, `Restart=always`, `Environment=AGENTCONNECT_ROOT=<root>`, and `[Install] WantedBy=default.target`. Run `systemctl --user daemon-reload` after writing. `up = enable --now`; `down = disable --now`; status uses `is-active`, `is-enabled`, and `show -p MainPID`.
- **Testability:** Pure builders `buildPlist` / `buildSystemdUnit` generate unit contents for direct assertions. Every `launchctl` / `systemctl` call uses an injectable `exec(cmd,args)` dependency, replaced by test stubs with no real side effects.
- **Credentials:** Unit files include only nonsensitive `AGENTCONNECT_ROOT`, and only when nondefault. The opaque CP API key and platform tokens currently live directly in `config.json` / `agent.json`, never the plist/unit. The key has no prefix and cannot be redacted by a content pattern; logs, telemetry, and error frames must structurally redact values of `--cp-key`, `apiKey`, and `Bearer ...` before leaving the edge.
- The `run` process handles `SIGTERM` / `SIGINT`: stop accepting new messages, drain active turns to a deadline, close platform connections, close ACP adapter children, then exit.

> The service-install branch of `login` invokes this controller. After successful auth probing and persistence, yes -> `install()` + `up()` and exit; no -> start foreground `run` using the same Daemon construction and signal handling.

---

## 3. Configuration File: `~/.agentconnect/config.json`

### 3.1 Core Principle: Configuration Files Are Desired State

This chapter, section 4 agents, and section 5 Reconciler form one theme:

- `~/.agentconnect/config.json` + `~/.agentconnect/agents/**` are the daemon's **single source of truth for desired state**: agents, platform connections, and channel bindings are written to disk.
- **Control Plane is not another source of truth; it is the remote editor + orchestrator for these files.** CP sends changes over the control WebSocket, daemon persists them, and Reconciler converges disk desired state into process actual state.
- Therefore, **the last desired state remains complete when CP is offline**, and daemon continues running it. After reconnect, CP resumes editing and orchestration.

This directly satisfies the requirement that CP can modify agent configuration while a disconnected daemon continues using existing configuration: **CP edits these persistent files, and they remain present.**

```
        +------------- Control Plane -------------+
        | Orchestrator / Web UI: remote edit + placement |
        +-------------------+---------------------+
                   control WS | agent/upsert, integration/upsert, route/assign, ...
                              v
   +---------------- Daemon (local) ----------------+
   | CP-Client ----persist----> ~/.agentconnect/** desired |
   |                                  | watch/change        |
   |                                  v                     |
   | Reconciler -- diff desired/actual --> converge          |
   |   |- ConnectionManager (platform connections)           |
   |   |- AgentManager (ACP adapter child processes)          |
   |   `- Scheduler (cron/loop)                               |
   +---------------------------------------------------------+
```

### 3.2 Root Layout

```
~/.agentconnect/
|- config.json                 # Machine/daemon configuration; this section.
|- acp_registry.json           # Raw ACP registry response cache; section 3.3.1.
|- acp_registry.cache.json     # Registry validators {etag,lastModified,fetchedAt}.
|- agents/                     # Per-agent configuration + default workspace; section 4.
|  `- <agent-id>/
|     |- agent.json
|     `- workspace/
|- state/
|  `- local.sqlite            # Sessions/routes/cron last-run/telemetry buffer.
`- logs/
   `- daemon.log
```

The layout keeps machine configuration, per-agent desired state, durable runtime state, and logs separate. The organizational unit is the **agent**, so each agent receives its own directory, while process lifecycle belongs to the OS service manager rather than application-managed PID or running-marker files.

### 3.3 `config.json` Schema (Machine-Level; **No Business Agents**)

```jsonc
{
  "version": 1,

  // Daemon identity. If initially absent, mint a local UUID and write it back,
  // stable per installation. CP may correct it during register/auth. It then remains stable.
  "daemonId": "cmp-7f3a...",

  // ---------- Most important: Control Plane access ----------
  "controlPlane": {
    "enabled": true, // false / --no-cp -> local-only mode (section 5.4)
    "url": "wss://cp.example.com/daemon", // Control-plane WebSocket endpoint
    "key": "<opaque-api-key>", // Long-lived, revocable CP API key in plaintext here; CP stores only HMAC
    "heartbeatMs": 15000 // Reconnect backoff is hard-coded 1s->30s+jitter; no tls/reconnect block
  },

  // Agent configuration directory, default <root>/agents; --agents-dir overrides.
  "agentsDir": "~/.agentconnect/agents",

  // Web App base URL for session deep links; otherwise accept the CP-distributed
  // value, then fall back to http://localhost:3000.
  "webAppUrl": "https://console.example.com",
  // Daemon-level MCP definitions and external memory plugins, referenced by agent name.
  "mcpServers": {},
  "memoryPlugins": {},
  // Shared-bot relay-roster snapshot distributed through register/ok.relays / relay/roster
  // and persisted for reconnect after offline restart; see shared-bot-relay.md and section 6.1.
  "relays": [],

  // ---------- ACP runtime registry, referenced by name from agent.json ----------
  // An agent states runtime:"claude-acp"; ACP-registry defaults plus these overrides decide launch.
  // Optional: omit to use all registry defaults. Entries override by name or add private runtimes.
  "runtimes": {
    "claude-acp": {
      // Example override: add allowlisted environment variables to the registry default.
      "command": "npx",
      "args": ["-y", "@agentclientprotocol/claude-agent-acp@0.51.0"],
      "env": [
        // Allowlisted injection; reference claude-agent-acp resolveSettings.
        { "name": "CLAUDE_CODE_EXECUTABLE", "value": "" },
        { "name": "MAX_THINKING_TOKENS", "value": "" }
      ]
    }
  },

  // ---------- Local security boundary ----------
  "security": {
    // Default true: prevent ACP runtimes from inheriting cloud apps/connectors
    // attached to the logged-in account. Explicit/local and AgentConnect-injected MCP remain.
    // Set false to permit inheritance; restart daemon, affecting future ACP children only.
    "isolateAccountApps": true,

    // Default false. true / --require-sandbox requires every agent to run in an OS sandbox.
    // If bwrap (Linux) or sandbox-exec (macOS) is unavailable, daemon refuses to start.
    "requireSandbox": false
  },

  // Daemon-local config.json / agent.json are secret-bearing files: CP API keys and
  // assigned platform credentials are plaintext there and must be protected by file
  // permissions. CP API-key records are HMAC-only; managed tenant secrets pass through
  // the configured SecretCipher. Provider selection comes from runtime configuration.

  // ---------- Observability ----------
  // logging has only level. No telemetry block: process entry startDaemonOpenTelemetry
  // bootstraps from OTEL_* such as OTEL_EXPORTER_OTLP_ENDPOINT and sends OTLP directly.
  "logging": { "level": "info" },

  // ---------- Local capacity/limits ----------
  "limits": {
    "maxAgents": 8,
    "maxConcurrentSessions": 32,
    "agentIdleTimeoutMs": 900000 // Reclaim ACP adapter after 15m idle; background-aware reclaim: background-task-aware-reclaim.md.
  }
}
```

On POSIX hosts, AgentConnect removes group/other access from existing
`config.json` and `agent.json` files; newly created or rewritten files use mode
`0600`. Agent directories created by the daemon use `0700`; existing custom
agent directories and higher custom parents are left unchanged.

#### 3.3.1 Default Runtimes Come from the ACP Registry

`config.json.runtimes` is **optional**. At daemon/`chat` startup, `resolveRuntimes` merges registry defaults with configuration overrides by name, with config taking priority. An `agent.json` containing only `"runtime": "claude-acp"` therefore works without runtime setup.

- **Source:** `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`, shaped `{version, agents}`, where each agent includes `id / name / version / distribution`.
- **Fetch/cache:** Fetch at runtime and persist raw response to `~/.agentconnect/acp_registry.json` plus validators `{etag,lastModified,fetchedAt}` to `~/.agentconnect/acp_registry.cache.json`. Use conditional `If-None-Match` / `If-Modified-Since`. On 304, network failure, or about 4.5-second timeout, use cache. Offline with no cache yields an empty registry.
- **Startup:** **Cache first + background refresh.** Existing cache applies synchronously; background refresh affects the next start, so network never blocks daemon startup.
- **Version pinning:** Keep `@version` from the registry snapshot, such as `@agentclientprotocol/claude-agent-acp@0.51.0`, for reproducibility. Refresh updates the version.
- **Map `distribution` to `RuntimeDef {command,args,env}`** for the current `process.platform` + architecture:
  - `npx` -> `npx -y <package@version> [...args]`; `-y` avoids interactive install independently of the pin.
  - `uvx` -> `uvx <package==version> [...args]`.
  - `binary` -> use `cmd` / `args` / `env` under the current key such as `darwin-aarch64`, `linux-x86_64`, or `windows-x86_64`; skip when absent.
- **Limitation:** Binary distributions map only `cmd`, such as `./goose`; they do **not** download `archive`. The user must install it or put it on PATH. Spawn `ENOENT` should produce a friendly message. `RuntimeDef` does not retain archive URLs.

### 3.4 Field Precedence and Merge

Apply, later overriding earlier: built-in defaults including **ACP-registry runtime defaults** -> `config.json` -> `AGENTCONNECT_*` environment -> CLI flags. `controlPlane.url` is overridden most often through `--cp-url` because one image connects to different CP environments.

### 3.5 Validation and Live Reload

- Validate with Zod schemas from `protocol`. Invalid configuration makes `run` refuse startup with field-level errors. CP delivery or manual editing owns `config.json`; daemon offers no mutation CLI.
- Changes to `config.json` trigger Reconciler evaluation of connections, runtimes, and limits. Changes to **`controlPlane.url` / `daemonId` require restart**, because they affect identity and connection ownership.

---

## 4. `~/.agentconnect/agents/`: Agent Configuration and Default Workspace

### 4.1 Directory Layout (One Subdirectory per Agent)

```
~/.agentconnect/agents/
`- deploy-bot/                 # Conventionally agent-id; authoritative ID is agent.json.id.
   |- agent.json               # Complete declaration; section 4.2.
   |- workspace/               # Default workspace; from-scratch uses this directly.
   |  |- memory.md             # Persisted memory in from-scratch mode.
   |  `- .skills/              # Installed skills.
   `- sessions/                # Optional local snapshots; authoritative state is state/local.sqlite.
```

- `agent.json.id` is globally unique, referenced by CP orchestration and `route/*`, and selected by `--agent <name>`.
- **Discovery is recursive:** daemon/`chat` bounded-recursively collect any `agent.json` under `--agents-dir`, skipping `node_modules`, `.git`, dot directories, to depth about four. Pointing `--agents-dir` directly at one agent finds depth-zero `agent.json`. `loadAgents` selects `status==="active"`; `--agent` / `chat` selection ignores status.
- **Workspace resolution:** Relative `agent.json.workspace.path` is relative to the agent directory. In `git-repo` mode, daemon clones/pulls there.

### 4.2 `agent.json` Schema

This aligns upstream section 6.6 `Agent` / `Integration` / `Workspace` / `CronJob` with the daemon's current `AgentSchema`, `IntegrationSchema`, and `SlackConfigSchema` in `packages/daemon/src/agents/agent-schema.ts`.

```jsonc
{
  "id": "deploy-bot",
  "name": "Deploy Bot",
  "status": "active", // "active" | "inactive" | "paused"

  // Key in config.json.runtimes; overrides apply only to this agent.
  "runtime": "claude",
  "runtimeOverrides": {
    "model": "claude-opus-4-8",
    "env": [{ "name": "MAX_THINKING_TOKENS", "value": "8000" }]
  },

  // ---------- Workspace/memory modes from upstream D9 ----------
  "workspace": {
    "mode": "git-repo", // "git-repo" | "from-scratch"
    "path": "./workspace",
    "gitRepo": "git@github.com:acme/ops.git",
    "gitBranch": "main",
    "pullOnNewSession": true, // git pull --ff-only before each new session; see packages/daemon/src/workspace/workspace-manager.ts
    "skills": ["deploy", "rpc-health"]
  },

  // ---------- IM: one agent can have many integrations ----------
  "integrations": [
    {
      "id": "slack-ops",
      "platform": "slack", // "slack" | "telegram" | "discord" | "feishu"; all implemented
      "slack": {
        // mode:"direct" (default; daemon opens Socket Mode) or "shared"
        // (relay-pool ingress; daemon holds xoxb only and opens no socket)
        "botToken": "xoxb-...", // Web API, plaintext in current version
        "appToken": "xapp-1-...", // Socket Mode; direct mode only
        "signingSecret": "...",
        "botUserId": "U0BOT...", // Bot user ID for mention matching
        // Unified rules replace subscribedChannels/mentionAnyChannel/respondToDms.
        // Each is { channel?, thread?, match }, where kind is mention|dm|keyword|auto.
        "bindRules": [
          { "match": { "kind": "mention" } }, // @mention in any channel
          { "match": { "kind": "dm" } }, // DM
          { "channel": "C0ALERTS", "match": { "kind": "auto" } }, // Process all messages
          { "channel": "C0TEAM", "match": { "kind": "mention" } } // Mention only
        ],
        "allowedUserIds": [], // Empty means all; integration-level authz copied to derived rules
        "notificationChannelId": "C0NOTIF"
      }
    }
  ],

  // ---------- Communication behavior/output convergence ----------
  "output": { "mode": "low" }, // none|minimal|low(default)|medium|high; none records only

  // ---------- Permission policy mapped to ACP session/request_permission ----------
  "permissions": { "policy": "ask", "autoApprove": ["Read", "Grep"] },

  // ---------- Daemon-local cron/loop; fires while CP is offline ----------
  // trigger prompts the agent. Optional target first posts to that channel and replies in its
  // thread; no target is headless and writes transcript only. origin:"cp" marks CP entries,
  // which coexist with handwritten entries; enabled:false pauses an entry.
  "crons": [
    {
      "id": "daily-health",
      "schedule": "0 9 * * *",
      "target": { "platform": "slack", "channel": "C0TEAM" },
      "trigger": "Send the daily system health report"
    }
  ]
}
```

### 4.3 Workspace Preparation (`cwd` for ACP `session/new`)

Before a new or reloaded session, Session Manager calls `prepareWorkspace(agent)`:

1. `git-repo`: validate `agentDir`; clone the configured repository and branch if no checkout exists, or run a best-effort `git pull --ff-only` with an approximately 4.5-second timeout when `pullOnNewSession` is enabled. A clone failure is fatal because no checkout exists; a pull failure is nonfatal so offline execution can continue from disk.
2. `from-scratch`: ensure the workspace directory exists; agent memory is initialized separately under the agent root by `packages/daemon/src/agents/memory.ts`.
3. Return the absolute repository root, validated `agentDir`, or from-scratch directory as the `cwd` for section 7 `session/new` or `session/load`.

Workspace preparation is implemented by `packages/daemon/src/workspace/workspace-manager.ts` and invoked from `packages/daemon/src/session/session-manager.ts`.

### 4.4 Agent Environment / Secrets: CP Configuration + Child-Process Injection

Ordinary environment variables and write-only secrets are configured only through Console / CP `AgentSpec.env` and `AgentSpec.secrets`. Daemon persists them under `agent.json.runtimeOverrides.{env,secrets}`, and `agentChildEnv()` merges/injects them when starting an ACP child.

- Secret wins over ordinary env with the same name; daemon security/runtime injection remains higher priority.
- Env/secrets changes affect host spawn. Reconcile evicts the old host so the next start uses the new values.
- Daemon **does not read** a sibling `.env` and does not interpolate `${VAR}` in `agent.json`; configuration, descriptions, and cron-trigger strings remain literal.
- Secret values are never logged. The model receives only secret names and confidentiality constraints; values exist only in child environment, with unified secret masking as a leak backstop.

---

## 5. CP Control + Offline Degradation: Reconciler

This implements requirement 4 using section 3.1 configuration-as-desired-state.

### 5.1 CP Changes Agent Configuration by Changing Files

CP orchestration/configuration frames are persisted atomically under `~/.agentconnect/**` by CP-Client:

| CP delivery                                      | Daemon persistence action                                                                                        |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `agent/upsert{ agentId, spec }` / `agent/remove` | Write/create/delete `agents/<id>/agent.json`; `CpAgentRegistry` uses disk as truth, with no in-memory duplicate. |
| `integration/upsert` / `integration/remove`      | Mutate owning `agent.json.integrations[]` through `CpIntegrationRegistry`, marked `origin:"cp"`.                 |
| `register/ok` roster snapshot                    | Fully **converge** agents/integrations/crons/assignments to disk/local cache; explicit `drop.*` removes entries. |
| `agent/stop{ agentId }`                          | Set `status:"inactive"` while keeping directory.                                                                 |
| `route/assign` / `route/update`                  | Update local route table persisted in `state/local.sqlite`.                                                      |
| `cron/upsert` / `cron/remove`                    | Mutate `agent.json.crons[]`.                                                                                     |
| `config/push{ keys }` EVT                        | Apply allowlisted runtime knobs **in memory**, without persistence; see note below.                              |

REQ commands such as `agent/upsert`, `agent/stop`, `cron/upsert`, `cron/remove`, and `route/assign` receive `ack{ refId, ok }` after persistence/convergence.

`config/push` has only `{ keys }` as an EVT with **no reply**. It merges
allowlisted nonsensitive keys (`logging.level`, `limits.maxAgents`,
`limits.maxConcurrentSessions`, and `limits.agentIdleTimeoutMs`; see
`mergeConfigPush`) into the live in-memory configuration and applies them
immediately, rebuilding the logger for level changes. It does not persist or
ACK; nonallowlisted keys are ignored and logged. Desired agent and integration
state is delivered through the dedicated upsert frames and the authoritative
`register/ok` roster.

### 5.2 Reconciler: Desired State -> Actual State

Changes from **CP**, an **agentconnect agent command**, or **manual file edits** all use one reconciler, driven by `chokidar` on `agents/**` plus explicit triggers:

```
desired = read(config.json + every agent.json with status=active)
actual  = live platform connections / ACP adapters / registered crons
plan    = diff(desired, actual)
apply(plan):
  - New/changed integration -> ConnectionManager opens/updates connection
  - active -> inactive       -> drain sessions and reclaim ACP adapter child
  - runtime/workspace change -> applies to next new session; do not interrupt active
  - cron change              -> Scheduler upsert/remove
```

Convergence is **idempotent**: restart from disk desired state yields the same runtime state.

### 5.3 State Alignment While CP Is Online

After connecting, CP-Client sends `register` with capabilities and `localState` for current agents/integrations/crons/assignments. CP returns an **authoritative roster snapshot** in `register/ok`; daemon fully converges it to disk, then Reconciler converges runtime. Later deltas use `agent/upsert`, `integration/upsert`, `route/update`, and related frames. **CP is the editor, not a runtime dependency.**

### 5.4 Offline / Degraded Semantics

| Scenario                                 | Behavior                                                                                                                               |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| CP temporarily unreachable               | CP-Client reconnects with exponential backoff. Platform connections, active sessions, and crons continue from last disk desired state. |
| New agent placement / scaling            | **Paused**, because CP orchestration is required; catches up after reconnect.                                                          |
| `--no-cp` / `controlPlane.enabled=false` | Pure local mode from disk, suitable for single-machine self-hosted / BYO.                                                              |
| Telemetry                                | Buffer in `state/local.sqlite` and upload after recovery.                                                                              |

---

## 6. Consolidating and Managing Multi-Agent Platform Connections

A daemon can host many agents, each with many integrations. **Do not open one independent connection per integration**; consolidate by credential.

### 6.1 Consolidation Key: `(platform, credential fingerprint)`

- **Slack `mode:"direct"` (default):** One **Socket Mode connection = one Slack App = one `appToken` + `botToken` set**. `SlackConnection` in `packages/daemon/src/slack/connection.ts` creates `new App({ token, appToken, socketMode: true })`. The key is the `appToken` fingerprint.
- **Slack `mode:"shared"` (relay ingress):** Shared-bot ingress does not run in daemon. The **relay pool** receives Events API traffic, arbitrates, and pre-addresses delivery. Daemon holds only `xoxb` for egress and **opens no socket**. It dials each relay in the CP-distributed roster from `register/ok.relays` / `relay/roster`, persisted in `config.json.relays`, using `cp/relay-client.ts` / `relay-manager.ts`. See section 7.3 of [shared-bot-relay.md](shared-bot-relay.md).
- Usually one agent = one bot = one Slack App, but two agents sharing one App and `appToken` use **one connection**, with inbound events routed by channel binding.
- **Telegram:** One grammY long-polling `getUpdates` connection per bot token.
- **Discord:** One gateway connection per bot token.
- **Feishu:** One WSClient per app (`appId` + `appSecret`); see [feishu-integration.md](feishu-integration.md).

### 6.2 Startup Consolidation

```
1. Scan integrations[] for every active agents/<id>/agent.json.
2. Read platform tokens, plaintext in the current version.
3. Group/deduplicate by (platform, credential fingerprint).
4. Open one ConnectionManager connection per group; retry failures and report alert.
5. Derive the local `RoutingRule[]` layer from every integration's `bindRules` through `rulesFromAgent()`.
```

One `RoutingRule` model drives routing. Every integration `bindRules[]` entry derives a `source:"config"` local rule with agentId, integrationId, platform, scope, match, and allowedUserIds. Merge these with `source:"cp"` rules and arbitrate through `routeRules()`. Cache the local layer in `state/local.sqlite` for degradation; CP-layer persistence is described in sections 8.7/6.3. `rulesFromAgent()` in `packages/daemon/src/router/routing-rule.ts` derives the local rules, and `routeRules()` in `packages/daemon/src/router/routing-table.ts` defines arbitration.

### 6.3 Inbound Event -> Agent Routing

After a Slack event reaches a connection:

1. Over the union of local and CP rules, calculate **scope candidates** whose scope and `allowedUserIds` pass, then **kind candidates** whose `mention` / `dm` / `keyword` / `auto` matches.
2. First-match arbitration: **explicit @bot mention** -> **thread affinity** (single reachable agent continues; multiple reachable agents require mention) -> **CP per-sessionKey override** -> **local layer**. Within a layer: `mention > dm > keyword > auto`.
3. On match, normalize to `NormalizedMessage` with `traceId` and send to section 7 ACP Host. On null, drop + debug-log; it may still enter thread transcript for later catch-up.

> **Conflicts:** If A has channel-specific `auto` and B has broad `mention`, each participates by its own rule and a mentioned message goes only to that agent. **Local is baseline and CP overrides by sessionKey, but explicit `@bot` wins across layers.** A CP agentId with no matching local agent/Slack integration is unserviceable: keep it for reconciliation, skip it in `route()`, warn, and include in `heartbeat.degradedScopes`.

### 6.4 Connection Lifecycle and Live Updates

- Integration add/delete/credential change makes Reconciler open a new connection, close the old, or reconnect without affecting others.
- A disconnected platform connection reconnects directly with exponential backoff, bypassing CP. Persistent failure reports an `event/session` alert.
- ConnectionManager dispatches by platform through `{open,close,send}` drivers. Slack, Telegram, Discord, and Feishu each have implemented connection/normalize/render modules under `src/{slack,telegram,discord,feishu}/`. A new platform adds a driver without changing routing/consolidation.

---

## 7. Agent and Child-Process Lifecycle: Message -> ACP -> Claude/Codex

### 7.1 Process Tree

```
agentconnect daemon (Node, one process)
 |- ConnectionManager          One connection per platform credential
 |- Local Router / Normalizer  In process
 |- ACP Host                   Local ACP client, in process
 |- MCP Tool Server            In-process stdio MCP server
 `- One per active agent:
      claude-agent-acp / codex-acp      Child, stdio JSON-RPC local ACP
       `- One per session:
            Claude Agent SDK Query      Long-lived child
             `- native claude binary / codex engine
```

One ACP adapter child can host multiple sessions through its internal `sessions` map. Each session starts one long-lived Query child reused across prompts; it is not one process per message.

### 7.2 Agent (ACP Adapter) State Machine

```
inactive --(reconcile status=active)--> provisioned
provisioned --(first message / warm-start)--> starting
   starting: spawn runtime child through execa -> ACP initialize capability handshake
starting --ok--> ready --(error/crash)--> restarting --> ready
ready --(idle > agentIdleTimeoutMs)--> draining --> provisioned
ready --(status=inactive / agent/stop)--> draining --> inactive
```

- **Lazy start + warm pool:** First message starts by default; CP can request warm-start for frequent agents. Reclaim idle adapters to save memory on multi-agent edge machines.
- **Crash recovery:** ACP Host detects adapter exit, restarts it, and attempts `session/load` for active sessions. Failure marks the session interrupted and notifies its channel.

### 7.3 Session State Machine (Thread = Session)

`thread = one task = one context`. Session key is `(platform, channel, thread, agentId)`, allowing one session per agent in a shared thread:

```
none --(first thread message)--> preparing (git pull / memory)
preparing --> creating (session/new: cwd + mcpServers)
creating --> idle
idle --(message/cron synthetic message)--> prompting (session/prompt)
prompting --(streaming session/update)--> idle (turn ends with stopReason)
idle --(cancel)--> cancelling (session/cancel, 30s forced backstop) --> idle
idle --(long inactivity / TTL)--> closed (metadata retained; body in Local Store)
closed --(new thread message)--> resuming (session/load) --> idle
```

### 7.4 Message-to-Execution Flow

```
Slack thread message
 -> ConnectionManager receives Socket Mode event
 -> Normalizer injects traceId -> NormalizedMessage
 -> Local Router selects (agentId, integrationId)
 -> Ensure that agent's ACP adapter is ready, starting if needed
 -> Find/create session by (channel, thread):
      new -> prepareWorkspace -> session/new {cwd, mcpServers:[MCP Tool Server]}
      existing -> reuse / session/load
 -> session/prompt {sessionId, prompt:[text block, attachments...]}
 -> claude-agent-acp drives Claude; session/update streams to ACP Host
 -> ACP Host converges -> translates -> replies through the same Slack connection
 -> For proactive send / other agent, model calls injected MCP tool
No Control Plane on this path; only converged events + metrics report through section 10.
```

For cron, Scheduler constructs a `source:"cron"` synthetic `NormalizedMessage` and starts at Local Router. CP offline does not stop it.

### 7.5 ACP Methods (Local stdio JSON-RPC; ACP Host Client, Adapter Agent)

| Direction       | Method                                    | Purpose                                                                                                                                             |
| --------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| client -> agent | `initialize`                              | Negotiate protocol/capabilities, including `fs` and `terminal`.                                                                                     |
| client -> agent | `session/new`                             | Send prepared `cwd` and MCP Tool Server in `mcpServers`.                                                                                            |
| client -> agent | `session/load`                            | Resume a session/thread.                                                                                                                            |
| client -> agent | `session/prompt`                          | Deliver user/synthetic content blocks: text/image/resource.                                                                                         |
| client -> agent | `session/cancel`                          | Cancel current turn, with adapter 30-second forced backstop. `!stop` / `!cancel` map here.                                                          |
| agent -> client | `session/update`                          | Streaming deltas: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `usage_update`; ACP Host converges output. |
| agent -> client | `session/request_permission`              | Dangerous-operation authorization mapped to permissions policy / Web confirmation.                                                                  |
| agent -> client | `fs/read_text_file`, `fs/write_text_file` | Workspace files with Workspace Manager `PathGuard`.                                                                                                 |

Names and shapes follow ACP and `@agentclientprotocol/claude-agent-acp`. Internally, the adapter implements the wire methods `session/new`, `session/prompt`, and `session/update` as `newSession`, `prompt`, and `sessionUpdate`. Declaring `mcpServers` in `session/new` is the tool-injection point.

---

## 8. Slack-to-Agent Message Routing Rules

Section 6 covers connection consolidation and static rule derivation. This section defines runtime selection of `(agentId, sessionId)` for one inbound event.

### 8.0 Unified `RoutingRule` Model (Two Layers)

There is one rule type:

```ts
interface RoutingRule {
  agentId: string // Local agent.id and CP identifier
  integrationId: string // Daemon-local Slack connection
  scope: { channel?: string; thread?: string } // Missing channel means any
  match: { kind: 'mention' } | { kind: 'dm' } | { kind: 'keyword'; value: string } | { kind: 'auto' }
  allowedUserIds?: string[] // Daemon authz extension, not protocol BindRule
  source: 'config' | 'cp'
  epoch?: number // CP layer only: routingEpoch fence
}
```

- **Local layer (`source:"config"`):** Derived from `agent.json.slack.bindRules` through `rulesFromAgent`; copies integration-level allowedUserIds. Always active and authoritative for offline/bootstrap. Legacy migration: `subscribedChannels{trigger:"all"}` -> `{channel, match:auto}`; `trigger:"mention"` -> `{channel, match:mention}`; `mentionAnyChannel` -> unscoped mention; `respondToDms` -> dm.
- **CP layer (`source:"cp"`):** `route/assign` per-sessionKey overrides, `route/update` global rules, and `register/ok` reconcile snapshot. Persist to Local Store and use across restart/disconnect.
- **Priority:** local is baseline, CP overrides by sessionKey, except explicit `@bot` wins across layers.

### 8.1 Routing Inputs

An event arrives on one platform connection with connectionId, event type, channelId, thread_ts, user, text with `<@BOT>` markers, and attachments. The connection already narrows candidates to agents whose integrations use it.

- **scope-candidates:** Rules whose channel/thread scope matches and whose allowedUserIds is absent/empty or includes sender. Ignore kind. Unique agentIds are **reachable agents** for thread gating.
- **kind-candidates:** Scope candidates whose kind matches: mention when `msg.mentionedBots` includes that rule's agent botUserId; dm when `msg.isDm`; case-insensitive keyword in text; auto always.
- Human senders use the complete ladder. For Slack bot senders, compare sender app ID to managed app identity in the collaboration snapshot, with resolved bot user/bot ID fallback on the same daemon. Drop any AgentConnect-managed bot before command/model admission. An unmanaged third-party Slack bot can match only an explicit mention, never DM/thread/keyword/auto. Bot senders on other platforms do not route.

### 8.2 Routing Order (First Match Wins)

```
Event arrives on connectionId
|
|- 0. Pre-filter structural events, managed agent bots, or no-text/no-attachment.
|     Drop third-party Slack bots without an explicit mention of this bot.
|
|- 1. Explicit @bot mention, highest across layers:
|     mention candidate whose bot is in msg.mentionedBots. Beats thread affinity.
|
|- 2. Thread affinity, bypassing kind:
|     if msg.thread and threadOwner(channel,thread) is among reachable agents:
|       - one reachable agent -> continue to owner regardless of kind
|       - multiple reachable agents -> mention-gated; step 1 failed, so activate none
|         and return null; transcript may still record it for catch-up
|     On activation, resume + replay gaps per section 8.5.
|
|- 3. CP per-sessionKey override:
|     if a source:"cp" kind candidate is scoped to msg.channel/thread,
|     select only among CP kind candidates using step 5.
|
|- 4. Local layer where CP does not override channel:
|     select remaining local kind candidates with step 5.
|
|- 5. In-layer priority: mention > dm > keyword > auto.
|     Mention was handled by step 1, leaving dm > keyword > auto.
|
`- 6. No match -> null and drop; authz failures were excluded while building candidates
      and produce audit records.
```

Return `{ agentId, integrationId }` or `null`. For one-reachable-agent thread continuation, use any owner scope-candidate integrationId.

### 8.3 Multi-Agent / Multi-Binding Arbitration

| Situation                                                   | Rule                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Message mentions one specific bot                           | Deliver **only to that agent**, ignoring broad matches; explicit mention wins across layers.           |
| Third-party Slack bot mentions a specific bot               | Permit step 1. Without explicit mention, do not deliver even for auto channel or thread owner.         |
| AgentConnect-managed agent bot sends message                | Never activate through Slack, regardless of mention/auto; agent-to-agent uses internal `messageAgent`. |
| A has channel `auto`, B has broad `mention`                 | Each participates by rule: A consumes auto; B only when mentioned.                                     |
| Thread owner exists, but new message mentions another agent | Explicit mention precedes affinity and transfers the thread, opening/resuming that agent's session.    |
| Local and CP rules both exist for a channel                 | CP overrides local by sessionKey. Skip unserviceable CP agentId and count `degradedScopes`.            |
| CP offline                                                  | Route from local layer only plus persisted CP layer; `register/ok` reconverges after reconnect.        |

This ladder is authoritative for `route()`.

### 8.4 After Match: Normalize and Deliver

1. A mid-thread @ trigger fetches the full thread history as context prefix.
2. Inject `traceId` and normalize to `NormalizedMessage{ source:"user", platform, channel, thread, sender, text, attachments, trigger }`.
3. Find/create session by `(channel, thread, agentId)`, apply section 8.5 continuation/catch-up, and call ACP Host `session/prompt`.

### 8.5 Session Continuation Within a Thread

Several bots and humans can alternate in one thread. Each agent owns its own session there. While an agent is skipped, the thread advances; when mentioned again it must **resume the same session** and **see what happened during the gap**.

- **Session persists while skipped:** X remains `idle`, not closed.
- **Thread transcript + per-session marker:** Local Store orders all messages. X records `lastDeliveredTs`. Even a human-only or other-bot message that activates no agent enters transcript.
- **Catch-up replay on activation:** When routing selects X, read all messages after `lastDeliveredTs`, including other-bot/human turns, prepend them as context to the current prompt, use `session/load` if necessary, and advance marker to current.
- **Cross-agent context uses transcript, never a shared ACP session:** Each agent has an independent session; shared visibility comes entirely from text replay.

Example:

```
1) First message in thread A mentions BotA.
   -> Create S_A; BotA handles it; markerA advances.
2) Reply mentions BotB or a human.
   -> BotB creates/resumes S_B while S_A remains idle and markerA does not move.
   -> A human-only reply activates no agent but is stored in transcript.
3) Thread A mentions BotA again.
   -> Resume S_A, prepend every message after markerA, including BotB/human traffic,
      append current prompt, and advance markerA.
```

If S_A closed by TTL, use `session/load`; on failure, start a new session but still replay transcript for continuity.

### 8.6 Routing Non-User Sources (Bypasses)

- **Cron/loop:** Scheduler constructs `source:"cron"` with explicit agent, bypassing matching. With target channel, daemon first posts trigger text as a real anchor and replies in its thread; without target, run headless with no platform output and record only in the transcript.
- **`sendPlatformMessage` / `messageAgent`:** Active outbound tools. If a platform message reaches another subscribed agent's channel, it re-enters section 8.2 as a new inbound event, enabling platform-mediated collaboration.
- **Session commands:** `!stop` / `!queue` are intercepted by `parseCommand` before section 8.2, never prompt or transcript.

### 8.7 CP-Layer Mechanism and Persistence (`CpRoutingLayer`)

`CpRoutingLayer` persists through Local Store and is driven by `cp/client.ts` through `ConfigApply`:

- State: `routingEpoch`, `assignments: Map<sessionKeyStr, RoutingRule[]>` where `sessionKeyStr = ${platform}:${channel}:${thread ?? "-"}`, and `globalRules`. `effectiveRules()` flattens CP rules for merging with local.
- **`route/assign {sessionKey, agentId, bindRules}`:** Expand rules scoped to sessionKey as `source:"cp"`, resolve integration as below, upsert/persist assignment, return `route/assign/ack {ok:true, sessionKey}`.
- **`route/update {routingEpoch, rules[]}` EVT:** When `routingEpoch >= cached`, replace `globalRules`, set each rule's `epoch=routingEpoch`, bump the epoch, and persist. Otherwise ignore and log the stale update. Parse `rules[].match` as a `BindRule` match; skip and log malformed items.
- **`register/ok.assignments[]`:** Converge exactly to snapshot, apply `drop.assignments`, adopt epoch, persist.
- **agentId local resolution:** `agent.json.id` equals CP agentId. Resolve a Slack integration at match time. Missing agent/integration remains stored but unserviceable, warned, and counted degraded; hot addition makes it serviceable.
- **Autonomy:** During restart/disconnect, route with local layer + last persisted CP layer. Local layer is rederived at startup.

Wire stale-epoch fencing (`epoch < sessionEpoch`) and routingEpoch are independent version dimensions.

### 8.8 In-Session Commands (`!stop` / `!queue`)

Some thread messages control the running agent rather than prompt it. `parseCommand` from `commands/commands.ts` intercepts them in `onInbound` **before routing**; they enter neither transcript nor model.

- **Prefix:** Slack reserves slash commands, so use `!`; also parse `/` for Telegram/Discord. Command must immediately follow prefix; `hello!` and `! note` are normal text.
- **Vocabulary:** `!stop` / `!cancel` interrupt current turn; `!queue <text>` runs text after idle.

Run `route()` on the command to locate `(agentId, integrationId)`, preserving thread affinity and allowedUserIds. If no target, ignore and log.

- **`!stop` / `!cancel`:** For an in-flight session, first clear its queue, then send ACP `session/cancel`, and reply `🛑 Stopped.`. If nothing is running, reply `Nothing is running to stop.`
- **`!queue <text>`:** If busy, enqueue stripped text in `queued: Map<acpSessionId, NormalizedMessage[]>` and reply `📥 Queued`; if idle, dispatch immediately. On clean turn completion, FIFO-dispatch one queued message, which chains the next. On prompt error, do not dispatch; retain the queue.

This is daemon-local and bypasses CP. It differs from CP `agent/stop`, which stops the whole agent process, and continues in degraded mode.

---

## 9. Platform Message Translation: ACP <-> Slack / Telegram / Discord / Feishu

Two directions are implemented: outbound ACP `session/update` -> platform,
inbound platform -> ACP content, plus active MCP send. Slack, Telegram,
Discord, and Feishu use the common platform-driver boundary.

### 9.1 Outbound: ACP `session/update` -> Slack (Convergence + Translation)

Goal: **channel contains only start / plan / problem / finish + link**, while details remain in Web App. ACP Host converges streaming updates through the mode-aware `OutputConverger` in `packages/daemon/src/slack/render.ts`; outbound writes are serialized by `SlackSendQueue` in `packages/daemon/src/slack/send-queue.ts`.

**`medium` / `high` message-style progress:**

| ACP update                       | Slack translation                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`            | `OutputConverger` buffers text until the daemon's approximately 2-second idle flush; `splitIntoSections()` in `slack/formatter.ts` splits blocks <=12000 characters before posting native CommonMark. |
| `agent_thought_chunk`            | `high` only: context block, edit later thought in place.                                                                                                                                              |
| `tool_call` / `tool_call_update` | `OutputConverger` flushes pending body text, updates transient status, emits in-place progress in `medium`/`high`, and emits terminal tool output once in `high`.                                     |
| `plan`                           | Render concise plan.                                                                                                                                                                                  |
| `usage_update`                   | Do not render; send usage telemetry.                                                                                                                                                                  |
| `stopReason`                     | Completion message + Web App session link.                                                                                                                                                            |

**`low` default:** Keep only agent body text and final result as channel messages. All activity signals use transient [`assistant.threads.setStatus`](https://docs.slack.dev/reference/methods/assistant.threads.setStatus), not chat messages.

| ACP update                       | Low-mode action                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `agent_message_chunk`            | Buffer body text.                                                                    |
| `tool_call` / `tool_call_update` | Flush body as post, then set status to tool title.                                   |
| `agent_thought_chunk`            | Set status `"is thinking…"`.                                                         |
| `usage_update`                   | Ignore for rendering.                                                                |
| `onFinal`                        | Flush remaining body as result post, clear status with `''`; no done/details footer. |

- Status sequence: cold start `"is starting up…"`, prompting/thinking `"is thinking…"`, tool title, then `''`. `dispatch()` checks cold state before `sessions.handle()` boots host. `loading_messages` is a small constant such as `['Working on it…','Crunching through it…','Hang tight…']`.
- **Best effort:** Wrap `setStatus` in try/catch with debug logging.
  `chat:write` suffices for channel/DM/assistant rendering; failures do not
  interrupt dispatch and have no fallback message. `status:''` clears the
  indicator.
- **Slack identity/title:** Agent/assistant DM session title uses `assistant.threads.setTitle`. Agent body messages in DM/channel use `chat.postMessage.username`, preferring trimmed `displayName` then `name`, requiring `chat:write.customize`. System chrome—status, permission/elicitation cards, failures/notices—keeps Slack App identity. For an old install with exact `missing_scope(chat:write.customize)`, retry without username, cool down to app identity, and periodically probe authorization.

**`none` mode:** Full body still records in session transcript through a `recordOnly` post handled before checking platform connection, but send nothing to IM. Reuse headless/webchat's `replyConn = undefined`; activity/status/typing/reply/footer are all no-op. Background completion notifications gated at `≥ medium` do not fire.

Thread semantics: main progress goes at the thread anchor or, for a subscribed thread, uses `thread_ts`; tool-output messages reply in the same thread. `SlackSendQueue` rate-limits API calls, including the `chat.postMessage` Tier3 limit of 50rpm. The effective output mode is the per-session override when present, otherwise `agent.output.mode`.

### 9.2 Inbound: Slack Event -> ACP `session/prompt` Content

- Extract text from `app_mention` / `message`. For a mid-thread @mention, `SlackConnection.getThreadReplies()` in `packages/daemon/src/slack/connection.ts` fetches the full thread through `conversations.replies`, and `SessionManager` uses that snapshot as prompt context.
- Download attachment bytes from `files.url_private` with bot token and create ACP `image` / `resource` blocks.
- Normalize to `NormalizedMessage`, then `session/prompt`.

### 9.3 Telegram / Discord / Feishu Mapping (Implemented)

Drivers implement `{ open, close, reply(threadRef, content), sendMessage(target, content), normalizeInbound(event) }`. ACP convergence is platform-independent; only final rendering differs.

| Capability   | Slack                           | Telegram               | Discord                    |
| ------------ | ------------------------------- | ---------------------- | -------------------------- |
| Receive      | Socket Mode WS                  | long polling / webhook | gateway WS                 |
| Thread model | `thread_ts`                     | reply message / topic  | thread / message reference |
| Rich text    | Block Kit `markdown` CommonMark | MarkdownV2 / HTML      | markdown / embed           |
| Active send  | `chat.postMessage`              | `sendMessage`          | channel webhook / REST     |
| Limit        | <=12000 per markdown block      | split at 4096          | split at 2000              |

Feishu uses the same interface with WSClient under `src/feishu/`; see [feishu-integration.md](feishu-integration.md).

### 9.4 Active Send / Agent-to-Agent: MCP Tool Injection

ACP can only reply to the current thread. Daemon's **MCP Tool Server** adds proactive platform send / agent calls. Declare it in `session/new.mcpServers`; platform tokens remain in the connection and invisible to the agent.

Implemented tools in `src/mcp/tools.ts`: `sendPlatformMessage`; collaboration
`listChannelAgents` / `messageAgent`; channel/user information
`getCurrentChannel`, `listChannels`, `listKnownUsers`, `listChannelMembers`,
`getUserProfile`; attachment readers `readSlackFile`, `readTelegramFile`;
memory `readMemory`, `writeMemory`, `searchMemory`; orchestration
`startOrchestration`, `getOrchestration`, `cancelOrchestration`; and others.

---

## 10. WebSocket Client Interaction with Control Plane

The connection carries orchestration, control, and telemetry plus scoped,
bounded request/reply reads of daemon-local session, tool-body, memory, and
workspace data. Those reads are proxied to an authorized BFF caller without
Control Plane persistence. Live platform messages and ACP update streams stay
on the daemon or relay data plane.

### 10.1 Connection and Authentication

`packages/daemon/src/cp/client.ts` owns the CP connection FSM, frame dispatch,
and protocol codec integration; `config-apply.ts` applies CP-owned state.
Reusable `Transport` and `ReqRep` mechanics live in
`@agentconnect.md/connection`, while `decodeEnvelope`, `buildEnvelope`,
`encode`, `MAX_FRAME_BYTES`, and `InboundControlExt` live in
`@agentconnect.md/protocol` as the single wire truth.

- Daemon **dials out** one WebSocket to `controlPlane.url`, subprotocol `agentconnect.v1`, NAT/edge friendly.
- `CpClient.start()` is **nonblocking, local-first**: starts the background connection loop and returns. CP unreachability or auth failure does not block/fail `Daemon.start()`.
- FSM: `CONNECTING -> AUTHENTICATING -> REGISTERING -> READY -> (DRAINING) -> CLOSED`, plus offline `DEGRADED`.
- First frame is `auth{ apiKey, agentVersion, daemonId?, resume? }` using the opaque token at `config.json.controlPlane.key`. `auth/ok` supplies `sessionEpoch` / `heartbeatSec` and authoritative `daemonId`; `onDaemonId` writes it to config when needed. 4401 invalid/revoked/expired/user-key-on-WS terminates without retry; 1011 transient DB/internal errors retry.
- After auth, send `register`; apply `register/ok` snapshot, adopt `routingEpoch`, enter READY.
- Backoff is built-in 1s -> 30s + jitter, with application heartbeat load snapshot and ping/pong. Close 4401 stops; 4409 epoch conflict reconnects with full register; 4429/1011/1012/drop retry. Drop enters DEGRADED.
- Inbound fencing: `epoch < sessionEpoch` -> `error STALE_EPOCH`; control before READY -> `error PROTOCOL_STATE`.
- **`probeAuth` in `packages/cli/src/cp/auth-probe.ts`:** `login` reuses `ClientTransport` + `ReqRep`, sends only auth, closes after `auth/ok{daemonId}` success or returns `{ok:false, reason}` on 4401/error/dial/timeout. It is self-contained and never hangs. Persist credentials only on success.

Envelope:

```jsonc
{
  "v": 1,
  "type": "<msgType>",
  "id": "<uuid>",
  "ts": "2030-01-02T03:04:05.000Z", // RFC3339, not numeric epoch
  "corr": "<uuid>", // Reply frames only: request ID
  "payload": {/* by type */}
}
```

### 10.2 Frame Table (Daemon View)

> **Overview only.** This omits session read, workspace, memory, gitcred, secrets, mcpserver, hook, and other families. Authoritative wire: [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) and `packages/protocol/src/frame.ts`.

**Upstream, daemon -> CP**

| Type                                  | Payload highlights                                                                                                                   | Semantics                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `auth`                                | `{ apiKey, daemonId? }`                                                                                                              | First-frame opaque-token auth.                     |
| `register`                            | `{ host, capabilities:{platforms,runtimes,acp,features}, maxAgents, localState:{assignments,crons,leases,agents[],integrations[]} }` | Register/capabilities/local state for reconcile.   |
| `heartbeat`                           | `{ load:{cpu,mem,agents}, health:"ok\|degraded", activeSessions, degradedScopes[] }`                                                 | Heartbeat/load/degraded scopes.                    |
| `ack`                                 | `{ refId, ok, error? }`                                                                                                              | Persistence/convergence result for downstream REQ. |
| `event/session`                       | `{ sessionId, agentId, phase:"start\|plan\|problem\|end", link, summary }`                                                           | Converged UI event, not body.                      |
| `usage/report`                        | `{ sessionId, agentId, platform?, channel?, lastActivityAt, usage }`                                                                 | Latest-wins session token/cost.                    |
| `facts/daemon-runtimes` and `facts/*` | Runtime/MCP/memory probe snapshots                                                                                                   | Observed facts with REPLACE semantics.             |

Metrics and traces use the direct **OTLP side path** bootstrapped by `OTEL_*`,
not the Control Plane WebSocket. Only `usage/report` and `facts/*` use the
control channel.

**Downstream, CP -> daemon:** Most persist then reconcile, except in-memory `config/push` and CP-route `route/*`.

| Type                                        | Payload highlights                                                                                                                              | Daemon action                                                                                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/push` EVT                           | `{ keys }` only                                                                                                                                 | Merge allowlisted `logging.level`, `limits.*` into memory immediately; no disk/reply; ignore+log others.                                                          |
| `agent/upsert` / `agent/remove`             | `{ agentId, spec }` / `{ agentId }`                                                                                                             | Write/delete `agents/<id>/agent.json`; hot reload.                                                                                                                |
| `agent/launch`                              | `{ agentId, runtime, workspaceId, capabilities, spec, mode }` with launchId fence                                                               | CP-started agent; reply `agent/launched`.                                                                                                                         |
| `agent/detach` / `agent/activate`           | `{ agentId, moveId, ... }`                                                                                                                      | Safe cold move: quiesce+archive local root / atomically apply authoritative bundle and resume.                                                                    |
| `agent/stop`                                | `{ agentId }`                                                                                                                                   | Set inactive + drain.                                                                                                                                             |
| `integration/upsert` / `integration/remove` | `{ integrationId, ... }`                                                                                                                        | Mutate owning `agent.json.integrations[]`.                                                                                                                        |
| `route/assign`                              | `{ sessionKey:{platform,channel,thread}, agentId, bindRules }`                                                                                  | Persist CP assignment and return `route/assign/ack`.                                                                                                              |
| `route/update`                              | `{ routingEpoch, rules:[...] }`                                                                                                                 | Replace CP global rules when epoch is current; EVT.                                                                                                               |
| `register/ok` REP snapshot                  | `{ routingEpoch, agents[], integrations[], crons[], assignments[], leases[], mcpServers[], memoryConnections[], relays[], collabRoutes, drop }` | Authoritative full convergence: persist agents/integrations; upsert CP-origin crons and prune `drop.*`; converge assignments; persist/redial relays; adopt epoch. |
| `cron/upsert` / `cron/remove`               | `{ cronId, agentId, schedule, target?, trigger, enabled }`                                                                                      | Mutate owning `agent.json.crons[]`, marked CP origin; Reconciler re-registers. On fire, post target anchor + thread reply, or execute headless.                   |
| `daemon/drain`                              | `{ scope:{kind:"agent"\|"daemon"\|"session",...}, deadline }`                                                                                   | Graceful drain for scaling/rebalance; `drain/progress`, then `drain/done`.                                                                                        |
| `daemon/restart` / `daemon/upgrade`         | `{ reason, drainFirst }` / `{ targetVersion, drainFirst }`                                                                                      | Fleet control: drain then exit for supervisor restart/upgrade.                                                                                                    |

### 10.3 Register Payload (`RegisterReq`)

```jsonc
{
  "host": "my-machine", // Display only.
  "capabilities": {
    "platforms": ["slack", "telegram", "discord", "feishu"], // Implemented platform drivers
    "runtimes": ["claude", "codex"], // Object.keys(resolveRuntimes); validate executables at startup
    "acp": true,
    "features": [] // Capability flags
  },
  "maxAgents": 8,
  "localState": {
    // What the daemon currently believes it holds, used for reconciliation
    "assignments": ["slack:C0TEAM:-"], // Session keys currently being served
    "crons": ["daily-health"], // Registered cron IDs
    "leases": [], // Held lease IDs
    "agents": [{ "agentId": "...", "origin": "cp" }], // On-disk replicas + source markers
    "integrations": [{ "integrationId": "...", "origin": "cp" }] // On-disk replicas + source markers
  }
}
```

The Control Plane returns an **authoritative full snapshot** in `register/ok`
for agents, integrations, crons, assignments, relays, and other desired state.
The daemon converges the snapshot, and explicit `drop.*` entries prune stale
Control Plane-owned replicas on reconnect. See section 3.3 of
[daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md).

### 10.4 Degradation and Reconnect

WebSocket drop -> CP-Client enters DEGRADED and reconnects with backoff. Daemon remains autonomous: platform connections, active/resumed sessions, crons, and local + persisted CP routing continue. New CP orchestration pauses. Reconnect `register` with resume, then converge `register/ok`.

---

## 11. End-to-End Directory and Sequence Summary

```
~/.agentconnect/
  config.json          <- machine configuration such as controlPlane.url
  acp_registry.json (+ cache) <- ACP registry cache
  agents/<id>/
    agent.json         <- runtime/workspace/integrations/bindRules/crons
    workspace/         <- cwd
  state/local.sqlite   <- local+CP routes / cron / sessions / telemetry
  logs/daemon.log      <- OS-managed lifecycle; no PID/marker

Startup: run -> validate -> recursively discover desired agents -> consolidate connections
       -> connect CP nonblocking -> register -> reconcile -> listen
Message: Slack -> route(local union CP) -> ACP session/prompt -> adapter/model
       -> converge session/update (low uses setStatus) -> Slack; never CP
Control: CP agent/integration/route/config knobs -> disk/CP route -> reconcile
Login: probeAuth -> persist -> install+up or foreground run
Offline: local + persisted CP routing continue; placement pauses; register/ok catches up
```

## 12. Component Mapping and Open Questions

| Upstream module                      | This document                             |
| ------------------------------------ | ----------------------------------------- |
| D1 Supervisor / degradation          | sections 2.4, 5, 5.4                      |
| D2 CP-Client                         | section 10                                |
| D3 Platform Adapters / consolidation | sections 6, 8, 9                          |
| D4 Local Router                      | sections 6.3, 7.4, 8                      |
| D5 Local Scheduler                   | sections 4.2, 7.4                         |
| D6/D7 ACP Host / adapter             | sections 7.1-7.5                          |
| D8 MCP Tool Server                   | section 9.4                               |
| D9 Workspace Manager                 | section 4.3                               |
| D10 Integration/secret projection    | sections 3.3, 4.4, and 10                 |
| D11 Local Store                      | section 3.2 `state/local.sqlite`          |
| D12 Telemetry                        | section 10.2 OTLP side path + usage/facts |

**Open questions:**

1. Arbitration when many agents bind one channel; sections 8.2/8.3 define rules, but real multi-agent cases need load testing.
2. Session affinity and lossless rebalance; drain exists, migration remains undecided.
3. Initial daemonId mint versus Control Plane correction.
4. Credential management: daemon-to-Control-Plane uses a long-lived revocable
   **CP API key** with rotation/revocation in
   [daemon-api-key-auth.md](daemon-api-key-auth.md). Managed platform
   credentials pass through the configured Control Plane cipher and are
   plaintext while in use in the TLS-protected delivery frame, daemon memory,
   and daemon-local `agent.json`; rotation must keep those replicas converged.
