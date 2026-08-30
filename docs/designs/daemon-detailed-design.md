# Detailed Design: Daemon (CLI / Configuration / Lifecycle / Platform Integration / CP Interaction)

> Status: Implemented.
>
> Related documents:
>
> - Architecture: [`architecture.md`](architecture.md), explaining why the Control Plane stays off the message hot path.
> - System-level detailed design: [`system-detailed-design.md`](system-detailed-design.md), covering the modules, technology choices, and interfaces of the full system (Control Plane + Daemon).
> - Collaboration design: [`agents-collaboration-design.md`](agents-collaboration-design.md), covering the product model and MCP-injected agent messaging.
>
> This document specifies daemon modules D1-D12: CLI shape and persistent
> service, local configuration, agent directories, CP control with offline
> degradation, consolidated platform connections, child-process lifecycles,
> ACP-to-platform translation, and the outbound CP WebSocket client.

> **Current implementation notes:** the frame table in section 10 is only an
> overview; [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) and
> `packages/protocol/src/frame.ts` are authoritative for the wire. Telegram,
> Discord, and Lark / Feishu platform drivers are implemented. Slack additionally
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
| **MCP Tool Server**                       | In process; local MCP server    | Injects tools such as `sendMessage`, `listAgents` (org-scoped peer discovery), and `messageAgent`, filling ACP gaps                                               | section 9.4         |
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
| `agentconnect agent list`           | **Read-only:** list user-authored agents found under `--agents-dir`, including id, status, runtime, name, and directory. CP agents are memory-only and therefore are not part of this local-file listing.                                                                                                                                                                                                                                                                                                       |
| `agentconnect login`                | **Interactive CP onboarding:** prompt/read CP URL + token, then probe auth through `probeAuth`, which sends only `auth`, never `register`. On failure, show the reason and allow one token retry; a second failure exits 1. **Persist credentials only after success.** Ask whether to install as a background service: yes -> `install-service` + `up` and exit; no -> foreground `run` until Ctrl-C. Non-TTY falls back to flags, still probes/persists and skips prompts; there is no separate `--no-input`. |
| `agentconnect chat [message]`       | **Connect locally to one agent:** recursively discover agents under `--agents-dir`; use the only agent automatically, or require `--agent <name>` when several exist. Resolve its runtime, including registry defaults, launch the local ACP adapter, and converse over ACP. With `message`, send once, stream the reply, and exit; without it, enter a REPL. Do **not** start Slack, scheduler, store, CP, or the rest of daemon.                                                                              |

### 2.3 CLI Flags Override Configuration

**Precedence, high to low: `CLI flag > environment variable > config.json > built-in default`.** CLI flags override only **process-level** configuration such as endpoints, roots, and log level; they do not mutate agent business configuration.

| Flag                             | Config field overridden        | Purpose                                                                                                                                            |
| -------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--config <path>`                | Locates the file itself        | Specify config.json, default `~/.agentconnect/config.json`.                                                                                        |
| `--root <dir>`                   | Locates the root               | Override `~/.agentconnect`; maps to `AGENTCONNECT_ROOT`.                                                                                           |
| `--api-url <wss://...>`          | `controlPlane.url`             | Override the API endpoint; this is the most common override.                                                                                       |
| `--api-key <key>`                | `controlPlane.key`             | Override the opaque, long-lived, revocable daemon **API key**; see [daemon-api-key-auth.md](daemon-api-key-auth.md).                               |
| `--no-cp` / `--offline`          | `controlPlane.enabled=false`   | Force local-only mode with no CP connection.                                                                                                       |
| `--daemon-id <id>`               | `daemonId`                     | Override/specify daemon identity.                                                                                                                  |
| `--log-level <lvl>`              | `logging.level`                | trace/debug/info/warn/error.                                                                                                                       |
| `--agents-dir <dir>`             | `agentsDir`                    | Override agent discovery root. Daemon/`chat` recursively collect `agent.json`, skipping `node_modules`, `.git`, dot directories, depth about four. |
| `--agent <name>`                 | Selector                       | Select by `agent.id`: single-agent `run` ignoring status, or disambiguate `chat`.                                                                  |
| `--max-agents <n>`               | `limits.maxAgents`             | Capacity reported to CP + local hard limit.                                                                                                        |
| `--require-sandbox`              | `security.requireSandbox=true` | Require every agent to run in the Linux SRT sandbox; refuse daemon startup on unsupported or failed hosts.                                         |
| `--k8s`                          | n/a (mode switch)              | Run runtimes in cluster sandbox pods instead of on this host; see section 2.6 for what that changes.                                               |
| `--key-server <url>`             | `KEY_SERVER`                   | Cloud-only service for session-scoped model credentials, http or https as the deployment chooses; see [key-server.md](key-server.md).              |
| `--key-server-token-path <path>` | `KEY_SERVER_TOKEN_PATH`        | File re-read as the key-server bearer token on every request.                                                                                      |
| `--dry-run`                      | n/a                            | Load and validate all configuration and print the reconcile plan without opening connections/processes.                                            |

General environment equivalents use the `AGENTCONNECT_` prefix, such as `AGENTCONNECT_CP_URL`, `AGENTCONNECT_CP_KEY`, and `AGENTCONNECT_ROOT`. The cloud model seam uses `MODEL_TOKEN`, `MODEL_BASE_URL`, their runtime-scoped replacements (`ANTHROPIC_MODEL_*`, `OPENAI_MODEL_*`, `DEEPSEEK_MODEL_*`), `KEY_SERVER`, and `KEY_SERVER_TOKEN_PATH` as documented above.

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

- **macOS (launchd):** `~/Library/LaunchAgents/md.agentconnect.daemon.plist`, label `md.agentconnect.daemon` (a named instance adds `.<name>` to both — cli-daemon-split.md §4.2.1), reference `packages/cli/src/service/launchd.ts`. `ProgramArguments = [execPath, cliEntry, "run", "--root", root]`; `RunAtLoad=true`; `KeepAlive.SuccessfulExit=false`; `StandardOutPath` / `StandardErrorPath` point to `~/.agentconnect/logs/daemon.log`. `up` uses `launchctl bootstrap gui/$UID <plist>` with `load -w` fallback; `down` uses `launchctl bootout gui/$UID/<label>` with `unload -w` fallback; status uses `launchctl print` / `list`.
- **Linux (systemd `--user`):** `~/.config/systemd/user/agentconnect.service` (a named instance is `agentconnect@<name>.service`), with `[Service] ExecStart=execPath cliEntry run --root <root>`, `Restart=always`, `Environment="AGENTCONNECT_ROOT=<root>"`, and `[Install] WantedBy=default.target`. Run `systemctl --user daemon-reload` after writing. `up = enable --now`; `down = disable --now`; status uses `is-active`, `is-enabled`, and `show -p MainPID`.
- **Service environment (login-shell launch):** service managers give user units a minimal `PATH` and never source shell profiles, so without repair npx-distributed ACP runtimes probe as "not installed". The unit therefore runs the **CLI run shell** (`ExecStart=<node> <cli-entry> run`), which in service mode launches the daemon through the user's interactive login shell (`$SHELL -l -i -c 'exec "$0" "$@"' …`, `packages/cli/src/service-spawn.ts` + `shell-exec.ts`) — the daemon inherits a fresh terminal-equivalent environment and tracks profile edits at every restart. Readiness is verified via `<root>/daemon.lock` (pid preserved by `exec`); a hanging or broken profile is killed at a deadline and the run shell falls back to direct spawns. Two static floors back this up: an install-time `PATH` snapshot baked into the unit (`InstallOpts.envPath`) and the daemon prepending `dirname(process.execPath)` on startup (`packages/daemon/src/runtimes/exec-path.ts`, covers legacy direct-ExecStart units). See cli-daemon-split.md §4.2 for the full contract.
- **Testability:** Pure builders `buildPlist` / `buildSystemdUnit` generate unit contents for direct assertions. Every `launchctl` / `systemctl` call uses an injectable `exec(cmd,args)` dependency, replaced by test stubs with no real side effects.
- **Multiple instances:** One host can run several daemon services side by side. `--instance <name>` names the unit and defaults the root to `~/.agentconnect-<name>`; `<root>/service.json` maps a root back to its unit so `--root`-only commands (the CP-commanded upgrade) hit the right one; `agentconnect instances` lists them. The default instance's unit names are unchanged. See cli-daemon-split.md §4.2.1.
- **Credentials:** Unit files include only nonsensitive `AGENTCONNECT_ROOT`, and only when nondefault. The opaque CP API key lives in `config.json`; hand-authored local integrations may carry platform tokens in `agent.json`, while CP-delivered tokens remain memory-only. None belongs in the plist/unit. The key has no prefix and cannot be redacted by a content pattern; logs, telemetry, and error frames must structurally redact values of `--api-key`, `apiKey`, and `Bearer ...` before leaving the edge.
- The `run` process handles `SIGTERM` / `SIGINT`: stop accepting new messages, drain active turns to a deadline, close platform connections, close ACP adapter children, then exit.

> The service-install branch of `login` invokes this controller. After successful auth probing and persistence, yes -> `install()` + `up()` and exit; no -> start foreground `run` using the same Daemon construction and signal handling.

### 2.6 Cluster Mode (`--k8s`)

`run --k8s` is the same binary and the same Daemon, supervising runtimes in cluster sandbox pods rather than as local subprocesses. It is a mode switch rather than a separate build, and it exists so that every behavior assuming "daemon and runtime share one machine" is disabled — or given a pod-shaped implementation — in one place instead of being re-decided per call site.

| Behavior under `--k8s`                                                                                                                                                                                                                   | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No HOST runtime probe sweep and no probe refresh; the sweep runs in the probe sandbox instead, and no phase-2 model enumeration runs at all                                                                                              | There is no runtime binary next to the daemon — runtimes ship in the sandbox image, so a host sweep can only ever answer "nothing". The models a runtime offers still have to be ASKED of it, which is why the probe sandbox runs one credentialed session per declared runtime (below). Phase-2 enumeration needs a per-model isolated HOME on this host and has none, so a cluster runtime stops at the phase-1 seed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Host executable discovery is replaced by that table (`runtimes/k8s-runtimes.ts`)                                                                                                                                                         | Discovery can only ever answer "nothing" in a daemon pod, which would advertise and launch no runtime at all.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A declared curated-source runtime is admitted only when the image installed it as its own executable AND published its build-time `initialize` snapshot, and is then sourced `image`; every other curated declaration is dropped, loudly | Curated admission is a successful ACP probe, and `--k8s` runs none — but the image's own build-time probe is that evidence, taken in the very image the runtime will run in. Re-sourcing is what carries it: an entry left `curated` would sit forever pending the host probe this mode never makes. A declaration with no snapshot behind it is still just a claim.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| No SRT/bwrap mechanism detection; `runInSandbox` has no local effect                                                                                                                                                                     | The pod is the isolation unit. `security.requireSandbox` therefore refuses startup with an explanation rather than silently meaning something else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `sandbox` / `sandbox-required` are not advertised                                                                                                                                                                                        | This shape runs with the cluster's default runtimeClass; advertising a sandbox that is not there is worse than advertising none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Git credentials reach the runtime through the shim's `gitcred` tunnel, and every pointer is in the POD's coordinates                                                                                                                     | The helper socket exists only on the daemon's filesystem, and a `credential.helper` line naming a daemon path is an executable the pod has never had — which surfaces as an authentication failure, not a missing file. The pointers resolve from the same predicate that decides where git runs, so the environment cannot describe one filesystem while the git that reads it runs in another.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Skills are not installed for a cluster agent                                                                                                                                                                                             | Acquisition, the ledger and stale-executable removal are all local-filesystem work; pointing them at a pod path would write them onto the daemon's own disk. Its own migration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Session-isolated workspaces are materialized on the pod's volume                                                                                                                                                                         | A logical-session worktree now lives beside the checkout at `<mount>/worktrees/<sid>`: the WorkspaceFs seam and the shim's exec allowlist (`worktree add`/prune) materialize it in the pod, and the retention GC reads the pod's tree through the same seam ([multi-repository-workspaces.md](multi-repository-workspaces.md) Phase 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The console's Git panel resolves its root in the POD's coordinates, like the ACP cwd; its last-fetch time is withheld, and an unchanged path's existence is asked of git rather than of a filesystem                                     | Same rule as the credential pointers: the environment must not describe one filesystem while the git that reads it runs in another. Resolving `agent.workspace.path` here handed a ShimGitRunner a daemon path, the shim's cwd fence refused it, and the panel reported "not a git checkout" over a real checkout. `.git/FETCH_HEAD`'s mtime is the only record of a fetch and no subcommand reports it, so that one field answers "unknown" until the shim can stat.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Every console workspace read needs a BOUND sandbox; with no channel both seams refuse with `sandbox-unavailable` rather than waking the pod                                                                                              | The console re-reads on each session page view, so waking on a read would resurrect a suspended pod on every visit and fight the idle sweep. What it must not do is answer as if it knew: falling through to this daemon's filesystem reports "not a git checkout" and an empty file tree for a workspace that is intact and comes back on the agent's next turn. It is the one workspace reason that is TRANSIENT, so the CP answers 503 **with** the code — a 400 would tell the console to stop retrying, and a bare 503 is indistinguishable from a daemon that may never return. The reachability answer and the resolution are ONE step, not a check followed by a use: the shim re-dials at half its credential TTL, so a fence that probes and then resolves can be handed this daemon's filesystem by the second call — which is how a read reports an empty workspace and a create publishes onto the daemon disk. Sandbox mode therefore has no local fallback at all. The console closes the loop with an explicit press rather than better prose: `POST /agents/:id/wake` resolves the dispatch member, claims the duty if that member does not hold it, and brings the sandbox to Running plus a shim bind — no host, no ACP session — after which the same read succeeds. A GET still wakes nothing. |
| The console's Files panel and local-skills list are served by the `read` channel, which runs the SAME workspace file operations inside the pod                                                                                           | They answer with file bytes, so unlike git there is nothing to orchestrate — the daemon names one operation and the shim performs it on the mounted volume. It does NOT run the daemon's implementation: on a volume the agent's runtime writes to, checking a path and then acting on it is a window that no amount of re-checking closes, so the pod side resolves one path (the mount, which cannot be renamed) and takes every step below it from an open descriptor. Linux-only, and a symlinked directory inside the workspace is refused rather than resolved — the single behavioural divergence, recorded in [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) §5 along with what the two halves still share.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A cluster agent's skills are whatever its repository committed, reported as `repo`                                                                                                                                                       | The daemon installs none into a pod (row above), so there is no ownership ledger for one — but `.claude/skills` committed in the checkout is real, is what the harness loads, and is now listed. The sandbox walk is its own traversal because the local one STREAMS dirents against a hostile checkout and no channel can stream a directory; containment it inherits from the shared operations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The bootstrap upgrade path is refused on the mode: startup skips it, and the daemon-side capability is off regardless of supervisor marker or `cli-entry`                                                                                | A cluster daemon's version is its image, and self-installing would exit the pod for a version the cluster never asked for. Refusing on the mode means a stale pointer on the root volume or an inherited `AGENTCONNECT_SUPERVISOR` cannot re-enable it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| The idle sweep also suspends the pod of an agent whose host it reclaimed, and agent REMOVAL deletes the SandboxClaim                                                                                                                     | An idle pod runs nothing, and a deleted agent's volume is unreachable from this filesystem — so the two endings the local path gets for free (a stopped child, an `rmSync` checkout) need pod-shaped implementations. Both are one rule each in [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) §8; suspension keeps the volume, removal is what takes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

The declared table lives in the runtime image and is obtained by ASKING a sandbox which runtimes it provides (the shim's `probe` channel), because a list compiled into the daemon or copied into a ConfigMap can be wrong about the image with nothing noticing and lists the runtime ids the image provides, optionally with the image's version pin and a model snapshot. Commands and arguments still come from the resolved catalog, which is served cache-first and can therefore be satisfied by an `acp_registry.json` baked into the image. A declared model snapshot is reported with `modelsSource: 'cached'`: no live probe confirmed it, so model capability gates stay permissive.

**One member per runtime image runs that probe for the whole pool** ([k8s-daemon-pool.md](k8s-daemon-pool.md) §3): members elect through a claim in the shared store keyed on the image the SandboxTemplate pins, and the winner publishes its whole answer for the others to adopt. Nothing is lost by sharing it — the answer is about the image, and a second member asking the same image the same question can only get the same answer at the cost of another pod. Nothing is risked either, because the key IS the image: a template bump is a different row, so a member never adopts a previous image's runtimes, and a rollout is simply two questions. A member that cannot read the image, cannot reach the store, or cannot parse what it finds probes for itself.

**The models come from a second, credentialed pass over the SAME held sandbox** (`runtimes/cluster-probe.ts`): each declared runtime is launched in the pod through the cluster driver, given one throwaway session, and asked what its model selector advertises — reported `probed`, exactly like a host sweep. The table alone cannot answer this and must not pretend to: it is generated at image build time, in an image that deliberately carries no provider credentials, so it publishes no model list and every cluster runtime reached the console with an empty picker. Credentials are the whole difference, and they exist in the two places this launch already reaches — the deployment's own pair on the daemon (`*_MODEL_TOKEN` / `*_MODEL_BASE_URL`, written onto each runtime's own provider surface exactly as a real launch writes it) and the pod's `AC_*` fill-in on the SandboxTemplate. A deployment whose egress mints its keys per session configures an endpoint with no key, and codex and DeepSeek Harness refuse `session/new` outright without one — so the probe launches those with a stand-in key (`PROBE_PLACEHOLDER_KEY`) it never spends: the enumeration reads the model selector and never prompts, and losing the whole picker to a credential nothing needs is the worse answer. A runtime that answers `authRequired` is recorded as installed-but-logged-out rather than failing the sweep, unless the probe carried no credential at all for a runtime that takes one (`uncredentialed`), which is the deployment's gap and keeps the declared facts — publishing it would empty the picker and ask the user to log a pod in; a runtime the probe could not REACH keeps the image's declared facts, because an empty `probed` list is a strict model gate and one slow pod must not refuse an agent the table already vouches for; and a sweep that fails at all costs model detail, never the runtime list.

`--k8s` selects an implementation; it must not change product semantics. A `k8s` branch inside business logic — rather than in the driver, reporting, or startup-assembly layers — means a seam is missing. The credential and workspace paths are the worked example: they are resolvers (`runsInSandbox`, the git runner, the credential target) rather than conditionals at each call site.

#### Kubernetes as the supervisor

`AGENTCONNECT_SUPERVISOR=k8s` declares that the kubelet stands in for launchd/systemd **and** for the CLI's version store. Kubernetes supervises those two roles asymmetrically, so the lifecycle contract distinguishes them rather than gating both on "is a supervisor present":

- **`daemon/restart` is supported.** The daemon drains and exits with the reserved restart code, and `restartPolicy: Always` brings the container back in place, in the same pod — the same shape as a systemd process restart. Re-register plus an incremented epoch remains the control plane's completion signal. Note the kubelet applies an exponential restart backoff (capped in the minutes), so repeated restarts complete more slowly than under systemd; a control-plane timeout should be calibrated against that rather than against a local restart.
- **`daemon/upgrade` is refused on the mode**, not on the supervisor marker. A live upgrade command is delivered to every ready daemon without consulting the advertised `daemon-bootstrap-upgrade-v1` capability, so admission is the last line of defence — and cluster mode must hold the same invariant as the capability check: an inherited `AGENTCONNECT_SUPERVISOR=service` plus a stale but valid `cli-entry` on the root volume cannot reach the installer. The reason says the running version is the pod's image, because "no supervisor" would send an operator looking in the wrong place when a `cli-entry` does exist. Upgrading means rolling the Deployment.
- **A declared supervisor is still required.** `--k8s` alone does not admit a restart: exiting with nothing to bring the process back leaves the daemon down, so the launcher has to declare `k8s`.

Draining is the existing SIGTERM path — gate new turns, await in-flight ones, cancel stragglers — which is what a `preStop` hook and a SIGTERM both reach. The turn wait is classed by whether the work can move to a successor: under `--k8s`, and for a **set-placed** agent's turn on any duty-holding member, it runs to `limits.poolShutdownDrainMs` (the member also releases each held group with an acknowledged `duty/release`; k8s-daemon-pool.md §12); a **daemon-placed** agent's turn — work no successor can take, stamped `placement` on the duty grant's member — is cut at `limits.shutdownDrainMs`, so an in-place restart of a machine full of pinned agents never pays the pod-eviction wait. **`terminationGracePeriodSeconds` must exceed that budget**, or the kubelet SIGKILLs mid-drain and the graceful window is a promise the deployment cannot keep. The daemon cannot read its own grace period (it has no pod read access), so at startup in cluster mode it logs the drain deadline it will actually use and leaves the alignment to the deployment.

**Readiness is a published fact, not a timer.** A `--k8s` daemon's process is ready long before it can serve anything: it still has to register with the control plane and learn from a sandbox what the runtime image provides. So it publishes one predicate — startup complete **and** CP registration acknowledged **and** the runtime probe returned **and** not draining — on the two sinks a pod probe can read, `GET /readyz` on `AC_READINESS_PORT` and a marker file at `AC_READINESS_FILE`. The two sinks default differently on purpose: the HTTP endpoint is opt-in (`AC_READINESS_PORT`, off until a port is named, and it must never be routed by a Service — it is a probe surface only), while the marker file is on by default at `/var/run/agentconnect/ready` and is turned off only by setting `AC_READINESS_FILE` empty, so a pod that mounts a writable path gets an `exec` probe with no configuration at all. Neither exists outside cluster mode, where the process being up is the signal. The predicate goes false synchronously with the SIGTERM latch, which is what stops new traffic while the pod keeps running for the whole drain; and clearing a stale marker is the first statement of `start()`, because a file on a mounted path outlives the container that wrote it. `packages/daemon/src/readiness.ts`; [k8s-daemon-pool.md](k8s-daemon-pool.md) §12 for what the rollout does with it.

Single-instance safety differs by shape. A daemon that owns its state — one machine, one SQLite store — keeps the singleton lock plus a `ReadWriteOncePod` volume and `strategy: Recreate`, so no two processes overlap on it. A pool member owns none: its state root is an `emptyDir`, its durable store is the shared data plane, and its exactly-one responsibilities are duty leases rather than a volume — which is what lets the pool roll with `maxSurge: 100%` and `maxUnavailable: 0` instead of replacing in place.

---

## 3. Configuration File: `~/.agentconnect/config.json`

### 3.1 Core Principle: Local Files and CP Memory Are Separate Desired-State Sources

This chapter, section 4 agents, and section 5 Reconciler form one theme:

- Hand-authored `~/.agentconnect/config.json` and `agents/**/agent.json` files are the local desired-state source and remain user-owned.
- CP agent specs, integrations, and crons are a separate **memory-only** desired-state source, re-converged by `register/ok` after each connection. Receiving a CP agent deletes only a same-id `agent.json`; every other local file remains untouched.
- An already-running daemon continues using its in-memory CP state while disconnected. After a daemon restart, CP-managed agents resume only after the CP roster reconnects; local agents remain independently bootable from disk.

The daemon persists only a secret-free `.cp-agent-id` marker in a dedicated child data root for CP agents, so workspace and memory directories can be reused without persisting CP configuration or credentials. Marker-only roots discovered after restart are reported as CP-owned replicas but are not activated; this lets the next roster reconciliation remove stale roots without reviving an agent whose in-memory spec was lost.

```
        +------------- Control Plane -------------+
        | Orchestrator / Web UI: remote edit + placement |
        +-------------------+---------------------+
                   control WS | agent/upsert, integration/upsert, route/assign, ...
                              v
   +---------------- Daemon (local) ----------------+
   | CP-Client ----memory-----> CP desired-state registries  |
   | local files ----watch----> local desired-state snapshot |
   |                                  |                     |
   | Reconciler -- merge/diff desired/actual --> converge    |
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

    // Default false. true / --require-sandbox requires every agent to run in the
    // Linux SRT/bwrap sandbox. macOS and Windows are not supported in this rollout.
    "requireSandbox": false,

    // Origins that daemon-managed workspace clone/pull may target. Default ["*"]
    // admits any valid https/ssh origin; exact entries (scheme and non-default
    // port are part of the match, no partial wildcards or paths) tighten it, and
    // [] disables remote Git workspaces entirely.
    "workspaceGitAllowedOrigins": ["https://github.com", "ssh://github.com"]
  },

  // Daemon-local config.json / agent.json are secret-bearing files: CP API keys and
  // assigned platform credentials are plaintext there and must be protected by file
  // permissions. CP API-key records are HMAC-only; managed tenant secrets pass through
  // the configured SecretCipher. Provider selection comes from runtime configuration.

  // ---------- Observability ----------
  // logging has only level. No telemetry block: process entry startDaemonOpenTelemetry
  // bootstraps from OTEL_* such as OTEL_EXPORTER_OTLP_ENDPOINT and sends OTLP directly.
  "logging": { "level": "info" },

  // ---------- Staged feature rollout ----------
  "features": {
    // Default true. When enabled, interactive IM answer text is staged until a
    // turn-final thread refresh accepts it; changed context causes bounded
    // regeneration in the same ACP session. Set false to opt out (kill switch).
    "turnFinalContextRefresh": true
  },

  // ---------- Local capacity/limits ----------
  "limits": {
    "maxAgents": 32,
    "maxConcurrentSessions": 32,
    "agentIdleTimeoutMs": 900000 // Reclaim ACP adapter after 15m idle; background-aware reclaim: background-task-aware-reclaim.md.
  }
}
```

On POSIX hosts, AgentConnect removes group/other access from existing
`config.json` and `agent.json` files; newly created or rewritten files use mode
`0600`. Agent directories created by the daemon use `0700`; existing custom
agent directories and higher custom parents are left unchanged.

### Linux ACP runtime sandbox

AgentConnect currently enables runtime sandboxing on Linux only. The daemon uses
the exact-pinned `@anthropic-ai/sandbox-runtime` package, backed by `bubblewrap`,
and launches a separate SRT provider process for each ordinary ACP host so policy
state is never shared between agents. The host must provide working `bwrap`,
`socat`, and `rg` executables and permit unprivileged user namespaces. Startup
performs a live probe rather than treating installed binaries as sufficient, and
logs its verdict: `sandbox: bwrap ready`, or a warning carrying the provider's
own failure text and the daemon's `PATH`. A failed probe is not confined to
agent launches — managed skill installation runs the pinned skills CLI inside
the same kernel sandbox and has no fail-open path, so it fails on every
reconcile until the missing dependencies are installed.

An enabled sandbox gives the runtime a private HOME, hides daemon-owned agent
metadata and the host source from which that runtime state was seeded, and
re-allows reads only for the workspace, private HOME, managed memory,
`run/config-files`, `.agentconnect/runtime-policy`, trusted runtime installation
roots, and the runtime's selected host credential path. Writes are limited to
the workspace, private HOME, managed memory, SRT temporary storage, and that
credential path. Outbound
domains are approved by a provider callback and Unix sockets remain
compatibility-open during this rollout. Proxy-aware HTTP(S) clients retain web
egress, but SRT's isolated Linux network namespace means host access to an
agent-started local server and clients that ignore the proxy environment are not
yet compatibility guarantees; issue #312 tracks those boundaries. SRT's
temporary directory is redirected below the private HOME and its shared
`/tmp/claude` fallback is hidden.

The Claude ACP parent is trusted to manage the host Claude login. By default,
AgentConnect resolves the host config directory from `CLAUDE_CONFIG_DIR`, falling
back to `$HOME/.claude`, and passes that directory to the private-HOME runtime as
`CLAUDE_SECURESTORAGE_CONFIG_DIR`. This preserves the host CLI's default
`.credentials.json` in place and permits Claude's temporary-file-plus-rename
refresh behavior. AgentConnect does not rewrite host Claude settings or relocate
the host credential between secure-storage directories. Claude's nested sandbox
denies this parent-only path to model-authored Bash and its descendants.

Operators who do not want the trusted ACP parent to see the rest of the host
Claude config directory can create a dedicated absolute directory and set
`CLAUDE_SECURESTORAGE_CONFIG_DIR` in the host Claude `settings.json` environment,
then run host `claude /login`. AgentConnect follows that setting and re-opens only
the selected directory. A daemon process environment value takes precedence over
the settings value; to keep host `/login` on the same path, set the value in the
environment used by both processes or prefer Claude settings. If neither is set,
the Claude config directory is the intentional trusted default. Installations
whose settings already select an `agentconnect-auth` directory continue using it.

Read access outside the explicitly denied agent/runtime-state roots remains
unchanged in this rollout. This is not yet a whole-host read allowlist: unrelated
host files and another runtime's credential source require a separate policy.

When sandboxing is only an agent preference and the live probe fails, the daemon
logs a warning and runs that agent without confinement. With
`security.requireSandbox=true` or `--require-sandbox`, the same failure refuses
daemon startup. macOS and Windows always follow this unsupported-host behavior;
this rollout intentionally adds no runtime-specific Keychain integration.

`security.workspaceGitAllowedOrigins` is a daemon-local remote-origin policy. Tenant
workspace configuration cannot widen it, and the control plane intentionally
keeps only transport/credential validation because different daemons may permit
different self-managed Git services. A manual GitLab or self-managed workspace
therefore requires the daemon operator to add its exact HTTPS or SSH origin and
restart the daemon. A configured array replaces the defaults, so deployments
that still use GitHub or GitHub App workspaces must keep the corresponding
GitHub origins in the array.

Daemon-managed workspace clone/pull does not inherit proxy variables, system or
user Git routing config, or user SSH config. It refuses HTTPS redirects and
secondary bundle/packfile URI downloads, disables automatic submodule and Git
LFS fetching, and rejects checkout-local URL rewrites, includes, and proxy
overrides before pull. Operators should use an explicit repository URL
(including an SSH port when needed) instead of redirects, proxies, or SSH host
aliases. This policy covers daemon-managed workspace materialization only;
agent-initiated Git commands and configured skill-source installation have
separate trust boundaries.

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

Apply, later overriding earlier: built-in defaults including **ACP-registry runtime defaults** -> `config.json` -> `AGENTCONNECT_*` environment -> CLI flags. `controlPlane.url` is overridden most often through `--api-url` because one image connects to different CP environments.

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
2. `from-scratch`: ensure the workspace directory exists; agent memory is initialized separately under the agent root by `packages/daemon/src/memory/store.ts`.
3. Return the absolute repository root, validated `agentDir`, or from-scratch directory as the `cwd` for section 7 `session/new` or `session/load`.

Workspace preparation is implemented by `packages/daemon/src/workspace/workspace-manager.ts` and invoked from `packages/daemon/src/session/session-manager.ts`.

### 4.4 Agent Environment / Secrets: CP Configuration + Child-Process Injection

Ordinary environment variables and write-only secrets can be configured through Console / CP `AgentSpec.env` and `AgentSpec.secrets`. The daemon keeps CP values in memory and `agentChildEnv()` merges/injects them when starting an ACP child; it never writes those values to `agent.json`.

- Secret wins over ordinary env with the same name; daemon security/runtime injection remains higher priority.
- Env/secrets changes affect host spawn. Reconcile evicts the old host so the next start uses the new values.
- Daemon **does not read** a sibling `.env` and does not interpolate `${VAR}` in `agent.json`; configuration, descriptions, and cron-trigger strings remain literal.
- Secret values are never logged. The model receives only secret names and confidentiality constraints; values exist only in child environment, with unified secret masking as a leak backstop.

---

## 5. CP Control + Offline Degradation: Reconciler

This implements requirement 4 using section 3.1 configuration-as-desired-state.

### 5.1 CP Configuration Is Applied in Memory

CP agent, integration, and cron frames are applied to memory-only registries by CP-Client. Other control-plane state retains the persistence policy listed below:

| CP delivery                                      | Daemon persistence action                                                                    |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `agent/upsert{ agentId, spec }` / `agent/remove` | Upsert/remove the in-memory CP agent; delete only a same-id local `agent.json`.              |
| `integration/upsert` / `integration/remove`      | Upsert/remove the in-memory CP integration overlay.                                          |
| `register/ok` roster snapshot                    | Fully **converge** memory-only agents/integrations/crons; explicit `drop.*` removes entries. |
| `agent/stop{ agentId }`                          | Set `status:"inactive"` while keeping directory.                                             |
| `route/assign` / `route/update`                  | Update local route table persisted in `state/local.sqlite`.                                  |
| `cron/upsert` / `cron/remove`                    | Upsert/remove the in-memory CP cron overlay.                                                 |
| `config/push{ keys }` EVT                        | Apply allowlisted runtime knobs **in memory**, without persistence; see note below.          |

REQ commands such as `agent/upsert`, `agent/stop`, `cron/upsert`, `cron/remove`, and `route/assign` receive `ack{ refId, ok }` after application/convergence.

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
desired = merge(local active agent.json files, CP agents/integrations/crons in memory)
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
- **Lark / Feishu:** One SDK client per app (`appId` + `appSecret`); direct mode opens
  `WSClient`, while HTTP mode keeps the client send-only and receives
  pre-addressed relay ingress. See [feishu-integration.md](feishu-integration.md).

### 6.2 Startup Consolidation

```
1. Scan integrations[] for every active agents/<id>/agent.json.
2. Read platform tokens, plaintext in the current version.
3. Group/deduplicate by (platform, credential fingerprint).
4. Open one ConnectionManager connection per group; retry failures and report alert.
5. Derive the local `RoutingRule[]` layer from every integration's `bindRules` through `rulesFromAgent()`.
```

One `RoutingRule` model drives routing. Every integration `bindRules[]` entry derives a `source:"config"` local rule with agentId, integrationId, platform, scope, and match. Merge these with `source:"cp"` rules and arbitrate through `routeRules()`. Cache the local layer in `state/local.sqlite` for degradation; CP-layer persistence is described in sections 8.7/6.3. `rulesFromAgent()` in `packages/daemon/src/router/routing-rule.ts` derives the local rules, and `routeRules()` in `packages/daemon/src/router/routing-table.ts` defines arbitration.

### 6.3 Inbound Event -> Agent Routing

After a Slack event reaches a connection:

1. Over the union of local and CP rules, calculate **scope candidates**, then **kind candidates** whose `mention` / `dm` / `keyword` / `auto` matches.
2. First-match arbitration: **explicit @bot mention** -> **thread affinity** (single reachable agent continues; multiple reachable agents require mention) -> **CP per-sessionKey override** -> **local layer**. Within a layer: `mention > dm > keyword > auto`.
3. On match, normalize to `NormalizedMessage` with `traceId` and send to section 7 ACP Host. On null, drop + debug-log; it may still enter thread transcript for later catch-up.

> **Conflicts:** If A has channel-specific `auto` and B has broad `mention`, each participates by its own rule and a mentioned message goes only to that agent. **Local is baseline and CP overrides by sessionKey, but explicit `@bot` wins across layers.** A CP agentId with no matching local agent/Slack integration is unserviceable: keep it for reconciliation, skip it in `route()`, warn, and include in `heartbeat.degradedScopes`.

### 6.4 Connection Lifecycle and Live Updates

- Integration add/delete/credential change makes Reconciler open a new connection, close the old, or reconnect without affecting others.
- A disconnected platform connection reconnects directly with exponential backoff, bypassing CP. Persistent failure reports an `event/session` alert.
- ConnectionManager dispatches by platform through `{open,close,send}` drivers. Slack, Telegram, Discord, and Lark / Feishu each have implemented connection/normalize/render modules under `src/{slack,telegram,discord,feishu}/`. A new platform adds a driver without changing routing/consolidation.

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

The built-in preset's entitled webchat session may receive an additional
session-scoped remote HTTPS MCP descriptor. It uses the normal agent-scoped ACP
host; this feature does not require a dedicated adapter, private socket, or OS
sandbox. See section 7.6 and
[`webchat-preset-agentconnect-mcp.md`](webchat-preset-agentconnect-mcp.md).

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

### 7.6 Built-in Preset Webchat Admin MCP

The built-in `agentconnect` preset may attach the CP-hosted administrative MCP
catalog only to a private, user-owned webchat session. It never attaches this
catalog to an arbitrary agent, an IM session, automation, or an agent-to-agent
session.

For an entitled built-in preset turn, the daemon attempts the standard ACP HTTPS
MCP descriptor regardless of runtime id, artifact, version, launch provenance,
capability probe, or sandbox mode. The runtime is already arbitrary executable
code inside its configured boundary, so those properties are compatibility facts,
not an additional security boundary. AgentConnect defines no private ACP
capability or runtime-generated retry header.

Daemon registration advertises `webchat_remote_mcp_v1` whenever confidential
remote-grant delivery is active. The relay delivers only a non-secret entitlement.
The daemon obtains a short-lived opaque grant from the CP over revision-fenced
issue/accept/activate control frames, then first attempts the CP MCP URL and active
Bearer grant on `session/new` or `session/load` as structured runtime configuration.
If the runtime rejects that session configuration, the daemon retries without the
additional descriptor so ordinary webchat can continue. It does not put the grant
in the prompt, proxy MCP requests, mint per-request assertions, or run an
administrative broker.

The runtime calls the standard CP `POST /api/v1/mcp` endpoint directly. The CP
derives the actor from the stored grant and durable webchat owner, re-runs live
authorization, and owns confirmation plus fail-closed at-most-once execution for
every operation with side effects, surfacing uncertain outcomes as explicit
ambiguous terminal states. Standard JSON-RPC request ids index grant-scoped
transport receipts only; CP-owned operation and execution-attempt fences provide
the durable execution identity. Tool catalog execution is therefore a control operation; browser messages and ACP
`session/update` streams remain on the relay↔daemon/daemon-local data path and
never cross the CP.

Administration fails closed. A runtime that rejects the descriptor is retried
without it; a stale or expired generation, unavailable CP, or invalid grant produces
no `agentconnect-admin` descriptor or a bounded tool error. Ordinary webchat and
daemon-local MCP tools continue when the runtime can create or load a descriptor-free
session. The daemon never falls back to its shared MCP socket, daemon API key,
organization principal, user API key, or system-prompt secret.

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
  source: 'config' | 'cp'
  epoch?: number // CP layer only: routingEpoch fence
}
```

- **Local layer (`source:"config"`):** Derived from `agent.json.slack.bindRules` through `rulesFromAgent`. Always active and authoritative for offline/bootstrap. Legacy migration: `subscribedChannels{trigger:"all"}` -> `{channel, match:auto}`; `trigger:"mention"` -> `{channel, match:mention}`; `mentionAnyChannel` -> unscoped mention; `respondToDms` -> dm.
- **CP layer (`source:"cp"`):** `route/assign` per-sessionKey overrides, `route/update` global rules, and `register/ok` reconcile snapshot. Persist to Local Store and use across restart/disconnect.
- **Priority:** local is baseline, CP overrides by sessionKey, except explicit `@bot` wins across layers.

### 8.1 Routing Inputs

An event arrives on one platform connection with connectionId, event type, channelId, thread_ts, user, text with `<@BOT>` markers, and attachments. The connection already narrows candidates to agents whose integrations use it.

- **scope-candidates:** Rules whose channel/thread scope matches. Ignore kind. Unique agentIds are **reachable agents** for thread gating.
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

Run `route()` on the command to locate `(agentId, integrationId)`, preserving thread affinity and conversation admission. If no target, ignore and log.

- **`!stop` / `!cancel`:** For an in-flight session, first clear its queue, then send ACP `session/cancel`, and reply `🛑 Stopped.`. If nothing is running, reply `Nothing is running to stop.`
- **`!queue <text>`:** If busy, enqueue stripped text in `queued: Map<acpSessionId, NormalizedMessage[]>` and reply `📥 Queued`; if idle, dispatch immediately. On clean turn completion, FIFO-dispatch one queued message, which chains the next. On prompt error, do not dispatch; retain the queue.

This is daemon-local and bypasses CP. It differs from CP `agent/stop`, which stops the whole agent process, and continues in degraded mode.

---

## 9. Platform Message Translation: ACP <-> Slack / Telegram / Discord / Lark / Feishu

Two directions are implemented: outbound ACP `session/update` -> platform,
inbound platform -> ACP content, plus active MCP send. Slack, Telegram,
Discord, and Lark / Feishu use the common platform-driver boundary.

### 9.1 Outbound: ACP `session/update` -> Slack (Convergence + Translation)

Goal: **channel contains only start / plan / problem / finish + link**, while details remain in Web App. ACP Host converges streaming updates through the mode-aware `OutputConverger` in `packages/daemon/src/slack/render.ts`; outbound writes are serialized by `PlatformSendQueue` in `packages/daemon/src/platforms/send-queue.ts`.

**`medium` / `high` message-style progress:**

| ACP update                       | Slack translation                                                                                                                                                                                     |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_message_chunk`            | `OutputConverger` buffers text until the daemon's approximately 2-second idle flush; `splitIntoSections()` in `slack/formatter.ts` splits blocks <=12000 characters before posting native CommonMark. |
| `agent_thought_chunk`            | `high` only: context block, edit later thought in place.                                                                                                                                              |
| `tool_call` / `tool_call_update` | `OutputConverger` flushes pending body text, updates transient status, emits in-place progress in `medium`/`high`, and emits terminal tool output once in `high`.                                     |
| `plan`                           | Render concise plan.                                                                                                                                                                                  |
| `usage_update`                   | Do not render; send usage telemetry.                                                                                                                                                                  |
| `stopReason`                     | Completion message + Web App session link.                                                                                                                                                            |

**`low` default:** Keep only agent body text and final result as channel messages. All activity signals use the transient agent-session working state ([`agents.sessions.setStatus`](https://docs.slack.dev/reference/methods/agents.sessions.setStatus)), not chat messages. The enum carries no custom text: a non-empty status maps to `processing` (Slack renders "is working…" plus the native Stop control in the DM container), a clear maps to `active`.

| ACP update                       | Low-mode action                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `agent_message_chunk`            | Buffer body text.                                                                    |
| `tool_call` / `tool_call_update` | Flush body as post, then set status to tool title.                                   |
| `agent_thought_chunk`            | Set status `"is thinking…"`.                                                         |
| `usage_update`                   | Ignore for rendering.                                                                |
| `onFinal`                        | Flush remaining body as result post, clear status with `''`; no done/details footer. |

- Status sequence: any non-empty label (cold start, thinking, tool title) keeps the session `processing`; `''` transitions it to `active`. The connection dedupes writes per (channel, thread, identity), so a turn produces one `processing` and one `active` regardless of how many labels stream through. `dispatch()` checks cold state before `sessions.handle()` boots host.
- **One slot, many turns:** Slack keeps ONE agent-session status per (app, channel, thread) — no session id in the API, no agent field on `agent_session_stopped` — while participant fan-out legitimately runs sibling turns against it. A turn leaving the slot (finish, failure, cancel, stop target) therefore SETTLES it instead of clearing: the newest surviving sibling's `processing` is re-asserted under its own identity (verified live: a fresh `processing` also resolves a pending "Stopping…" back into a working row), and only an empty thread transitions to `active`. The native Stop targets the turn the row is naming — on the Socket arm, where one daemon owns every turn the bot runs, the connection tracks the last `processing` writer as the slot's displayed owner and cancels that one turn (fallback: the thread's newest session, cold gate keys included); the survivor then takes the row over, so stopping B hands the row back to a still-working A. The relay-forwarded arm reaches every participant daemon, whose per-daemon settlements could disagree over the one global slot, so it keeps the globally consistent all-stop (cancel every local turn, final write `active`) until displayed ownership has a cross-daemon authority. A turn displaced by a newer message leaves the slot alone — it belongs to its successor, whose admission-time `processing` is the last write.
- **Best effort:** Wrap `setStatus` in try/catch with debug logging.
  `chat:write` suffices for the enum; failures do not interrupt dispatch and
  have no fallback message. `status:''` clears the indicator.
- **Slack identity/title:** Agent/assistant DM session title uses `agents.sessions.rename`. The working indicator and agent body messages carry `username`/`icon_url`, preferring trimmed `displayName` then `name`, requiring `chat:write.customize`; Slack keeps the session-status identity sticky until rewritten, so the dedupe key includes it. System chrome—permission/elicitation cards, failures/notices—keeps Slack App identity. For an old install with exact `missing_scope(chat:write.customize)`: body messages retry without username, cool down to app identity, and periodically probe authorization; the working indicator retries without identity and latches it off for the connection's lifetime (a reconnect re-probes).

**`none` mode:** Full body still records in session transcript through a `recordOnly` post handled before checking platform connection, but send nothing to IM. Reuse headless/webchat's `replyConn = undefined`; activity/status/typing/reply/footer are all no-op. Background completion notifications gated at `≥ medium` do not fire.

Thread semantics: main progress goes at the thread anchor or, for a subscribed thread, uses `thread_ts`; tool-output messages reply in the same thread. `PlatformSendQueue` rate-limits API calls, including the `chat.postMessage` Tier3 limit of 50rpm. The effective output mode is the per-session override when present, otherwise `agent.output.mode`.

### 9.2 Inbound Attachments -> ACP `session/prompt` Content

- Extract text from `app_mention` / `message`. For a mid-thread @mention, `SlackConnection.getThreadReplies()` in `packages/daemon/src/slack/connection.ts` fetches the full thread through `conversations.replies`, and `SessionManager` uses that snapshot as prompt context.
- Download attachment bytes from `files.url_private` with bot token and create ACP `image` / `resource` blocks.
- Decode a relay-delivered, size-bounded webchat image locally and feed it through the same ACP attachment-block builder. Keep the bounded image only in the daemon-local transcript so an authorized console history read can display it again; the Control Plane proxies that read without persisting the bytes.
- Normalize to `NormalizedMessage`, then `session/prompt`.

### 9.3 Telegram / Discord / Lark / Feishu Mapping (Implemented)

Drivers implement `{ open, close, reply(threadRef, content), sendMessage(target, content), normalizeInbound(event) }`. ACP convergence is platform-independent; only final rendering differs.

| Capability   | Slack                           | Telegram               | Discord                    |
| ------------ | ------------------------------- | ---------------------- | -------------------------- |
| Receive      | Socket Mode WS                  | long polling / webhook | gateway WS                 |
| Thread model | `thread_ts`                     | reply message / topic  | thread / message reference |
| Rich text    | Block Kit `markdown` CommonMark | MarkdownV2 / HTML      | markdown / embed           |
| Active send  | `chat.postMessage`              | `sendMessage`          | channel webhook / REST     |
| Limit        | <=12000 per markdown block      | split at 4096          | split at 2000              |

Lark / Feishu uses the same interface with a direct `WSClient` or an HTTP-mode
send-only SDK client under `src/feishu/`; see
[feishu-integration.md](feishu-integration.md).

### 9.4 Active Send / Agent-to-Agent: MCP Tool Injection

ACP can only reply to the current thread. Daemon's **MCP Tool Server** adds proactive platform send / agent calls. Declare it in `session/new.mcpServers`; platform tokens remain in the connection and invisible to the agent.

Implemented tools in `src/mcp/tools.ts`: the unified `sendMessage` (which absorbed the
former `sendPlatformMessage` and `messageAgent`); collaboration `listAgents` (deprecated
alias `listChannelAgents`) and `viewSessionStatus`; channel/user information
`getCurrentChannel`, `listChannels`, `listKnownUsers`, `listChannelMembers`,
`getUserProfile`; attachment readers `readSlackFile`, `readTelegramFile`;
memory `readMemory`, `writeMemory`, `searchMemory`; and others.

The orchestration triple `startOrchestration` / `getOrchestration` /
`cancelOrchestration` is **retired from the injected tool surface**: its send half
duplicated `sendMessage` (fan-out to N workers is N `sendMessage` calls with
`toAgent.needsReply`) and its status half duplicated `viewSessionStatus`. The descriptors
live on in `RETIRED_ORCHESTRATION_TOOLS` and `executeTool` still dispatches them, so
sessions already warm with the old descriptors and still-open orchestration records keep
resolving — but no agent is offered them. The daemon-side machinery below (durable
records, correlation recording, the re-armed deadline wake) is unchanged; the deadline is
the one capability `sendMessage(needsReply)` cannot yet express and is kept so
`needsReply` can gain an optional deadline on top of it.

`listAgents` is **org**-scoped, not channel-scoped: it issues `channel/agents` with
no channel and gets back every peer in the organization that the directional call
policy admits, so a session with no IM integration (webchat, webhook, dreaming,
memory-only) can still discover and wake peers. A `channel` argument is an optional
filter. Authorization for a wake is that same call policy, evaluated against the
daemon's copy of the collaboration snapshot (`CpCollabRoutes.admits`, fail-closed on
an unknown agent); `channel` remains only the session/delivery coordinate — but as that
coordinate it is checked for **integrity**: a recorded coordinate must have the caller in
its membership, an unrecorded one on a persisted IM platform is refused, and an unrecorded
one on a channel-free platform is replaced by the caller-derived `a2a:<callerAgentId>`
before the session key is minted. See
[agent-collaboration-implementation.md](agent-collaboration-implementation.md) §2.2/§2.5
and [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) §7.7.

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

| Type                                     | Payload highlights                                                                                                                   | Semantics                                                                                  |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| `auth`                                   | `{ apiKey, daemonId? }`                                                                                                              | First-frame opaque-token auth.                                                             |
| `register`                               | `{ host, capabilities:{platforms,runtimes,acp,features}, maxAgents, localState:{assignments,crons,leases,agents[],integrations[]} }` | Register/capabilities/local state for reconcile.                                           |
| `heartbeat`                              | `{ load:{cpu,mem,agents}, health:"ok\|degraded", activeSessions, degradedScopes[] }`                                                 | Heartbeat/load/degraded scopes.                                                            |
| `ack`                                    | `{ refId, ok, error? }`                                                                                                              | Persistence/convergence result for downstream REQ.                                         |
| `event/session`                          | `{ sessionId, agentId, phase:"start\|plan\|problem\|end", link, summary }`                                                           | Converged UI event, not body.                                                              |
| `usage/report`                           | `{ sessionId, agentId, platform?, channel?, lastActivityAt, usage }`                                                                 | Latest-wins session token/cost.                                                            |
| `facts/daemon-runtimes` and `facts/*`    | Runtime/MCP/memory probe snapshots                                                                                                   | Observed facts with REPLACE semantics.                                                     |
| `mcp/invocation/mint` (legacy)           | Old broker delegation and exact-request fields                                                                                       | Superseded by direct runtime-to-CP remote MCP; never emitted with `webchat_remote_mcp_v1`. |
| `webchat/mcp-delegation/revoke` (legacy) | Old broker delegation id and generation                                                                                              | Superseded by access grants; retained only while the old capability is supported.          |
| `webchat/mcp-grant/issue`                | `{ conversationId, descriptorInstanceId }`                                                                                           | Request a new pending revision for one exact session descriptor.                           |
| `webchat/mcp-grant/accept`               | `{ grantId, authorityGeneration, descriptorInstanceId, grantRevision }`                                                              | Accept one exact staged revision; CP activates it and revokes its predecessor atomically.  |
| `webchat/mcp-grant/revoke`               | `{ conversationId, authorityGeneration, reason }`                                                                                    | Revoke every access grant for one exact logical authority generation.                      |

Metrics and traces use the direct **OTLP side path** bootstrapped by `OTEL_*`,
not the Control Plane WebSocket. Only `usage/report` and `facts/*` use the
control channel.

**Downstream, CP -> daemon:** Agent specs, integrations, crons, and `config/push` stay in memory; routes and the other explicitly durable control state follow their per-frame policies below.

| Type                                        | Payload highlights                                                                                                                              | Daemon action                                                                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config/push` EVT                           | `{ keys }` only                                                                                                                                 | Merge allowlisted `logging.level`, `limits.*` into memory immediately; no disk/reply; ignore+log others.                                                   |
| `webchat/mcp-grant/issued`                  | `{ grantId, authorityGeneration, descriptorInstanceId, grantRevision, token, expiresAt }`                                                       | CAS-stage only a newer persisted `(authorityGeneration, grantRevision)` fence; revision never resets across generations and raw token remains memory-only. |
| `webchat/mcp-grant/activate`                | Same exact grant/revision tuple as the accepted request                                                                                         | CAS-install only the activated full fence into the exact runtime session descriptor.                                                                       |
| `agent/upsert` / `agent/remove`             | `{ agentId, spec }` / `{ agentId }`                                                                                                             | Update the in-memory CP registry; delete only a same-id `agent.json`; hot reconcile.                                                                       |
| `agent/launch`                              | `{ agentId, runtime, workspaceId, capabilities, spec, mode }` with launchId fence                                                               | CP-started agent; reply `agent/launched`.                                                                                                                  |
| `agent/detach` / `agent/activate`           | `{ agentId, moveId, discardActiveTurns?, ... }`                                                                                                 | Safe move: hard-cut source turns or stage/archive a replica / atomically apply the authoritative bundle and resume.                                        |
| `agent/stop`                                | `{ agentId }`                                                                                                                                   | Set inactive + drain.                                                                                                                                      |
| `integration/upsert` / `integration/remove` | `{ integrationId, ... }`                                                                                                                        | Update the in-memory CP integration overlay.                                                                                                               |
| `route/assign`                              | `{ sessionKey:{platform,channel,thread}, agentId, bindRules }`                                                                                  | Persist CP assignment and return `route/assign/ack`.                                                                                                       |
| `route/update`                              | `{ routingEpoch, rules:[...] }`                                                                                                                 | Replace CP global rules when epoch is current; EVT.                                                                                                        |
| `register/ok` REP snapshot                  | `{ routingEpoch, agents[], integrations[], crons[], assignments[], leases[], mcpServers[], memoryConnections[], relays[], collabRoutes, drop }` | Authoritative full convergence of memory-only CP agent state; converge assignments, persist/redial relays, and adopt epoch.                                |
| `cron/upsert` / `cron/remove`               | `{ cronId, agentId, schedule, target?, trigger, enabled }`                                                                                      | Update the in-memory CP cron overlay; Reconciler re-registers. On fire, post target anchor + thread reply, or execute headless.                            |
| `daemon/drain`                              | `{ scope:{kind:"agent"\|"daemon"\|"session",...}, deadline }`                                                                                   | Graceful drain for scaling/rebalance; `drain/progress`, then `drain/done`.                                                                                 |
| `daemon/restart` / `daemon/upgrade`         | `{ reason, drainFirst }` / `{ targetVersion, drainFirst }`                                                                                      | Fleet control: drain then exit for supervisor restart/upgrade.                                                                                             |

### 10.3 Register Payload (`RegisterReq`)

```jsonc
{
  "host": "my-machine", // Display only.
  "capabilities": {
    "platforms": ["slack", "telegram", "discord", "feishu"], // Implemented platform drivers
    "runtimes": ["claude", "codex"], // Object.keys(resolveRuntimes); validate executables at startup
    "acp": true,
    "features": ["session-visibility-v1", "webchat_remote_mcp_v1"] // Advertised when confidential remote-grant delivery is active.
  },
  "maxAgents": 32,
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

### 10.5 Delegated Admin-MCP Operations

This feature is on by default on the CP; enablement is gated on the daemon
advertising `webchat_remote_mcp_v1`. Before deploying, ship compatible CP,
relay, daemon, and runtime builds; verify private webchat session enforcement,
credential redaction, exact grant revocation, revision-fenced descriptor
activation, and CP-owned operation idempotency; then confirm live registration
advertises both `session-visibility-v1` and `webchat_remote_mcp_v1`.

No OS sandbox package, Linux kernel setting, runtime identity/version/provenance,
capability probe, private ACP field, or runtime-generated idempotency header is a
feature prerequisite. Runtime integration coverage verifies standard descriptor
installation and replacement as a compatibility check, not an admission gate;
CP-owned operations provide the write execution fence.

Start with a canary and observe grant, descriptor, request, operation, and
confirmation metrics. Labels are closed outcomes/reasons only; they exclude user,
organization, agent, conversation, grant, operation, token, Authorization header,
request body, tool arguments, response body, and transcript values.

Rollback rolls the daemon back to a build that does not advertise
`webchat_remote_mcp_v1` (stopping new establishment) and invokes the bounded
active-grant revocation path. Ordinary webchat continues. Emergency containment
can revoke one grant, conversation, user, agent, organization, or all feature
grants without isolating a daemon.

The complete staged procedure and stable metric labels are in
[`webchat-preset-agentconnect-mcp.md` §13](webchat-preset-agentconnect-mcp.md#13-capability-and-rollout)
and
[`§14`](webchat-preset-agentconnect-mcp.md#14-observability).

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
