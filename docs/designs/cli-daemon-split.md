# CLI and Daemon Split

> **Status:** Current implementation contract
>
> **Related designs:**
>
> - [daemon-detailed-design.md](daemon-detailed-design.md) describes daemon
>   startup and local runtime behavior.
> - [daemon-cp-ws-protocol.md](daemon-cp-ws-protocol.md) defines the
>   `daemon/restart` and `daemon/upgrade` control requests.
> - [daemon-centric-architecture.md](daemon-centric-architecture.md) defines the
>   Control Plane and daemon trust boundary.

AgentConnect separates its stable user entry point from the frequently updated
daemon payload:

| Package                       | Binary                | Responsibility                                                       |
| ----------------------------- | --------------------- | -------------------------------------------------------------------- |
| `@agentconnect.md/cli`        | `agentconnect`        | Version store, service lifecycle, login, delegation, and supervision |
| `@agentconnect.md/daemon`     | `agentconnect-daemon` | Platform connections, agent execution, and daemon-owned subcommands  |
| `@agentconnect.md/protocol`   | none                  | Shared frames and the planned-restart exit code                      |
| `@agentconnect.md/connection` | none                  | Shared Control Plane transport used by daemon and CLI login probe    |

The CLI does not import or depend on the daemon package. Both packages build
self-contained distributions. The daemon binary remains available for
development and recovery, but normal use goes through `agentconnect` so version
selection and supervision remain consistent.

## 1. Command ownership

The CLI implements these commands:

- `up`, `down`, `restart`, and `status`
- `install-service`, `uninstall-service`, and `instances`
- `login`
- `install`
- `version`, `version list`, `version install`, `version use`, and
  `version prune`
- `upgrade`

`agentconnect run` is a special CLI-owned supervision shell. It starts the
active daemon and can respawn it after a planned restart.

Every other positional command is delegated verbatim to the active daemon.
This includes `chat`, `agent list`, the hidden `mcp-bridge`,
`git-credential`, and `gh-token` helpers, and daemon commands added in a later
daemon release. The CLI forwards the original arguments, inherits standard I/O,
and propagates the daemon process's exit status or terminating signal.

The split keeps daemon business logic out of the CLI while allowing the daemon
command surface to evolve without a matching CLI release.

### 1.1 Login

`agentconnect login` belongs to the CLI because it combines onboarding with
service or foreground startup. It:

1. performs an auth-only daemon WebSocket exchange;
2. writes the accepted Control Plane URL and key to local config;
3. in interactive mode, ensures the selected daemon channel is installed when
   the root has no active version, then either installs and starts the OS service
   or enters the foreground `run` shell.

The login probe uses `@agentconnect.md/protocol`,
`@agentconnect.md/connection`, and `ws`. It does not import daemon config or
runtime code. The daemon still performs the authoritative full config validation
when it starts.

## 2. Version store

The CLI stores daemon releases below the configured AgentConnect root:

```text
<root>/
  versions/
    <version>/
      dist/index.js
      package.json
  current -> versions/<version>
  versions.json
  versions.lock
  cli-entry
```

- `versions/<version>` contains one extracted daemon package.
- `current` is the only active-version pointer.
- `versions.json` stores the selected release channel and the previous active
  version.
- `versions.lock` serializes changes to the store.
- `cli-entry` contains the CLI distribution entry path so a supervised daemon
  can invoke the CLI without relying on `PATH`. Every CLI invocation refreshes
  it on a best-effort basis.

`--root` and `AGENTCONNECT_ROOT` select an alternate root. In repository
development, `AGENTCONNECT_DAEMON_ENTRY` bypasses the version store and points
delegation directly at a daemon entry.

### 2.1 Install

`agentconnect install [version]` is an alias for
`agentconnect version install [version]`.

An install:

1. resolves `@agentconnect.md/daemon` from the CLI-configured npm registry;
2. chooses an explicit existing version, or the configured channel's `latest`
   or `rc` dist-tag;
3. verifies the downloaded tarball against registry integrity metadata;
4. checks the declared Node engine before and after extraction;
5. requires the extracted package to contain `dist/index.js`;
6. extracts into a temporary directory and atomically publishes the version
   directory.

The first installed version is activated automatically. Installing another
version does not switch the active daemon.

The accepted input is a version of the fixed daemon package. The Control Plane
and command line cannot supply an arbitrary package name or tarball URL.
`AGENTCONNECT_NPM_REGISTRY` is local CLI configuration and is never populated
from a Control Plane lifecycle request.

### 2.2 Activate and prune

`agentconnect version use <version>` atomically replaces the `current` symlink
with a relative link to an installed version. The replaced version becomes the
rollback target in `versions.json`.

`agentconnect version prune --keep <n>` removes older inactive versions by
installation modification time. The active and previous versions are always
protected. The default keeps two additional prunable versions.

Mutating version commands hold a root-scoped inter-process lock. Install and
use fail fast when another live writer owns the lock; prune and upgrade wait.
A lock is reclaimable only when its recorded process is gone or the PID has
been reused, not merely because the lock is old.

## 3. Local upgrade

`agentconnect upgrade` resolves and installs a target, then switches `current`
to it. The target comes from `--to <version>` or the selected `stable` or `rc`
channel.

Without `--restart`, the running daemon is unchanged. The selected version takes
effect on its next launch.

With `--restart`, the CLI:

1. switches `current`;
2. restarts the installed service, if one exists;
3. samples service state and requires a stable running PID;
4. switches back to the previous version and restarts it when that health check
   reports failure.

The local health check is intentionally process-level. It cannot prove that the
daemon reached Control Plane `READY`; remote lifecycle tracking provides that
stronger signal. If no service is installed, `--restart` leaves the new version
selected and reports that there was no service to restart.

## 4. Supervision

Control Plane restart and upgrade commands are accepted only when the daemon
knows a supervisor will relaunch it. The launcher sets
`AGENTCONNECT_SUPERVISOR` to either `cli` or `service`.

The shared `RESERVED_RESTART_CODE` is a nonzero planned-exit code. It
distinguishes lifecycle relaunch from a normal foreground exit and satisfies
launchd's nonzero-exit restart condition.

### 4.1 Foreground shell

`agentconnect run`:

1. installs and activates the selected channel's daemon when the root has no
   active version;
2. launches `<root>/current/dist/index.js run` with
   `AGENTCONNECT_SUPERVISOR=cli`;
3. re-resolves `current` and respawns only when the daemon exits with
   `RESERVED_RESTART_CODE`;
4. propagates every other exit status or signal.

One exception to step 4: an **interactive startup failure**. When the daemon
exits nonzero (no signal) within the startup window of an interactive
foreground run — stdin and stderr are TTYs, no service supervisor, no
`AGENTCONNECT_DAEMON_ENTRY` dev override, no pending stop — the shell offers a
recovery menu instead of dying with the exit code:

1. switch back to the recorded `previous` version and retry (offered only when
   that version is still installed);
2. force re-download the channel's latest version (replacing the possibly
   corrupt installed bundle) and retry;
3. print the manual `agentconnect version list / install / use` commands and
   exit.

A successful switch re-enters the respawn loop; declining (empty answer,
Ctrl-C, or EOF) propagates the original exit status unchanged. Non-interactive
and service runs never prompt — their supervisor must see the real exit code.

The shell forwards `SIGTERM` to the child. Terminal `SIGINT` reaches both
processes through the foreground process group, so the shell waits for and
faithfully reproduces the child's termination instead of double-delivering the
signal.

### 4.2 OS service

The CLI supports:

- a per-user launchd LaunchAgent on macOS;
- a systemd user service on Linux.

Other platforms must use foreground `agentconnect run`.

The generated service executes:

```text
<node> <cli dist entry> run --root <root>
```

That is the CLI's own run shell (§4.1) — the unit supervises the CLI, and the
CLI supervises the daemon. This indirection exists for the environment: service
managers give user units a minimal `PATH` and never source shell profiles, so
in service mode the run shell launches the daemon **through the user's
interactive login shell** (`$SHELL -l -i -c 'exec "$0" "$@"' <node> <entry>
run`, with a fish variant; the shell `exec`s the daemon in place, preserving
the pid). The daemon is therefore born with a fresh terminal-equivalent
environment — version-managed node/npx, `~/.local/bin`, profile `export`s —
and tracks profile edits at every service restart.

Readiness is watched via the daemon's `<root>/daemon.lock` (lock content ==
child pid, valid because `exec` preserves the pid). If the login shell never
reaches the daemon before the deadline — a hanging or `exec`-hijacking profile
(`tmux`), or a profile error — the run shell SIGKILLs the attempt's **whole
process group** (the launch is `detached`, so a profile blocking in a child
command is reaped too, not just the shell pid) and falls back to plain direct
spawns for the rest of the process's life, so a broken profile degrades the
environment rather than the service. On systemd the unit sets `KillMode=mixed`
so a stop delivers `SIGTERM` to the run shell only — which forwards exactly one
`TERM` to the daemon, preserving graceful drain — while the final `KILL`
escalation still sweeps the whole cgroup. Hosts whose login shell has no safe
exec template (tcsh &c.) use the direct spawn from the start. The unit also
bakes in an install-time `PATH` snapshot as a floor for the CLI itself and the
direct-spawn fallback, and the daemon prepends its own Node bin dir on startup
as a last-resort backstop (covers legacy direct-ExecStart units).

It sets `AGENTCONNECT_SUPERVISOR=service` for the CLI; the daemon child runs
with `AGENTCONNECT_SUPERVISOR=cli` because the CLI run shell is its supervisor
and handles `RESERVED_RESTART_CODE` itself. A non-default root is also passed
through `AGENTCONNECT_ROOT`, but the unit's `--root` is the authority: the run
shell launches the daemon through the user's interactive login shell, so a
profile that exports `AGENTCONNECT_ROOT` would otherwise pull the service onto
another root — and, with several instances installed, onto another instance's
lock, sqlite, and MCP socket. The run shell re-resolves `current` at every
(re)spawn, so changing daemon versions does not require rewriting the service
definition. Legacy units that execute `<root>/current/dist/index.js run`
directly keep working and migrate to the CLI form on the next `install-service`.

`install-service` writes the service definition but does not start it;
`agentconnect up` starts it. `uninstall-service` stops and removes it. The
service definition retains the Node executable and the CLI entry path used
during installation, so a Node runtime change — or a CLI reinstall that moves
its entry — requires reinstalling the service.

Interactive `agentconnect login` ensures an active daemon version exists before
installing and starting the service, so first-time onboarding does not require a
separate `agentconnect install`.

#### 4.2.1 Several services on one host

The instance identity is `<root>`: config, `daemon.lock`, `state/local.sqlite`,
`run/mcp.sock`, `logs/`, the agents dir, and the whole version store are already
root-relative, and `daemonId` is minted per root and persisted in that root's
`config.json`, so two daemons on one host register as two distinct daemons. The
only host-global name was the unit itself, so `--instance <name>` is the handle
that separates them (`packages/cli/src/service/instance.ts`):

- names match `^[a-z0-9][a-z0-9_-]{0,31}$` — safe in a systemd unit name and a
  launchd label, and short enough to keep `<root>/run/mcp.sock` inside the
  ~104-byte UDS path limit;
- the unit is `agentconnect@<name>.service` (a concrete unit file, not a
  template instantiation) or `md.agentconnect.daemon.<name>`; the **default
  instance keeps `agentconnect.service` / `md.agentconnect.daemon` unchanged**,
  so an existing install is never orphaned;
- without `--root`, a named instance's root is `~/.agentconnect-<name>`;
- `install-service` records `{ instance, label }` in `<root>/service.json`, so a
  command that knows only the root — notably the CP-commanded
  `upgrade --to <v> --root <root>` the daemon spawns (§6.2) — addresses that
  instance's unit rather than the default one;
- `--instance` is CLI vocabulary only. `run` and delegated commands are rewritten
  to the `--root <dir>` form before argv reaches the daemon;
- `agentconnect instances` lists what is installed (instance, state, root, unit)
  by scanning the OS's own unit directory, so nothing can go stale;
- **one root, one service**: `install-service` refuses a unit whose root another
  instance's unit already claims, since both daemons would fight over that root's
  `daemon.lock`, sqlite and MCP socket and the loser would crash-loop.
  Re-installing the SAME instance stays idempotent (the legacy-unit migration).

Every actionable message repeats the selector in the command it suggests
(`commandSelector`), so a copy-paste after `--instance dev login` manages `dev`
and not the default instance.

`AGENTCONNECT_ROOT` is baked in whenever the RESOLVED root is non-default, not
when a `--root` flag happened to be typed — an env-driven install would
otherwise write a unit with no root and start on `~/.agentconnect`.

Three things stay the operator's to get right, because the CLI cannot detect
them: each instance must own **disjoint platform credentials** (two daemons
holding one Slack app's socket-mode connection or polling one Telegram bot will
split or fight over ingress); host-global env such as `AC_READINESS_PORT` or the
OTLP endpoints must be set per instance rather than exported from a shell
profile, since the login-shell launch inherits the profile; and each root
carries its own copy of the daemon bundle, so N instances cost N version stores
(which is also what lets one instance canary a version).

## 5. Stable helper entry

Daemon-created MCP, Git credential, and `gh` helper references may outlive one
daemon process. They use the stable daemon entry:

```text
<root>/current/dist/index.js
```

This keeps helper invocations on the same selected version after an upgrade and
avoids embedding a specific extracted version directory in repository config or
session state. Development mode uses `AGENTCONNECT_DAEMON_ENTRY`, with the
running entry as a final fallback when no version store exists.

The separate `<root>/cli-entry` file is used only when the daemon needs the CLI
to install and activate a Control Plane-requested version.

## 6. Control Plane lifecycle commands

The org-scoped REST surface exposes:

```text
POST /api/v1/orgs/:orgId/daemons/:id/restart
POST /api/v1/orgs/:orgId/daemons/:id/upgrade
GET  /api/v1/orgs/:orgId/daemons/:id/lifecycle/:opId
```

The upgrade body supplies a version string. The Control Plane sends only that
version in `daemon/upgrade`; registry choice, package name, and tarball
resolution remain local to the CLI.

The Control Plane authorizes the caller against the daemon and permits one
pending lifecycle operation per daemon. Restart still requires a live `READY`
connection. Upgrade uses the same live path when available; a daemon that has
previously advertised `daemon-bootstrap-upgrade-v1` may instead receive a
durable queued upgrade while offline or stuck before `READY`. The Control Plane
persists the operation before either delivery path.

The lifecycle request is not retransmitted. A definite rejection closes the
operation as failed. A lost reply is ambiguous because the daemon may already
be draining, so the operation remains pending for later completion or expiry.
An HTTP `202` means the command was accepted or may have been accepted; it does
not mean the daemon has returned successfully.

Completion requires a later authenticated connection epoch to reach `READY`.
Restart accepts any reported daemon version. Upgrade additionally requires the
daemon's reported version to equal the requested target. This prevents the
original connection or an old-version relaunch from being recorded as a
successful upgrade.

### 6.1 Daemon restart

The daemon accepts `daemon/restart` only when:

- `AGENTCONNECT_SUPERVISOR` identifies the CLI shell or OS service; and
- no other lifecycle operation is running.

After acknowledging, it drains local work, stops, and exits with
`RESERVED_RESTART_CODE`. The supervisor resolves `current` and starts the
selected daemon.

### 6.2 Daemon upgrade

The daemon also requires a target version and a valid `<root>/cli-entry`. It
invokes the CLI equivalent of:

```text
agentconnect upgrade --to <version> --root <root>
```

This installs and activates the target without asking the service controller to
restart the process that is currently issuing the command. If the CLI step
fails, the daemon stays running and clears its in-flight lifecycle guard. If it
succeeds, the daemon drains and exits with `RESERVED_RESTART_CODE`; its
supervisor then launches the new `current` version.

Remote completion is determined by the later `READY` registration. Unlike a
local `upgrade --restart`, the remote flow does not perform process-level
automatic rollback after the old daemon exits.

### 6.3 Auth-time bootstrap recovery

The installed daemon entry performs a bounded auth-only bootstrap check before
loading the full daemon business graph. It advertises
`bootstrapProtocolVersion: 1` only when a CLI/service supervisor and a valid
`<root>/cli-entry` are present. The check reads only the Control Plane URL and
daemon key; complete config validation remains the full daemon's responsibility.
A Control Plane or network failure skips the check and preserves local-first
startup.

When the authenticated daemon has a pending upgrade, `auth/ok.lifecycle`
carries its operation id and target version. The bootstrap invokes the existing
CLI `upgrade --to <version> --root <root>` implementation. Failure leaves the
current version selected, reports `daemon/bootstrap/result{status:"failed"}`
while the connection is still registering, and continues ordinary startup.
Success reports `installed` and exits with `RESERVED_RESTART_CODE`; the existing
supervisor then resolves the newly selected `current` entry.

If the process was already running and repeatedly failing the full register
handshake, the ordinary daemon CP client advertises and consumes the same
auth-time directive. This prevents a locally alive but protocol-incompatible
daemon from waiting forever for a `READY`-only command.

The directive is idempotent and remains pending until a daemon reaches `READY`
on the exact target version. A process already running that version proceeds to
registration instead of reinstalling or restarting again. Historical daemons
that never advertised `daemon-bootstrap-upgrade-v1` cannot be recovered through
this path and still require an online control connection or host-side upgrade.

## 7. Security and trust boundaries

- The Control Plane stays off the platform-message and ACP execution hot paths.
  Lifecycle requests use the existing daemon control WebSocket.
- The CLI downloads only `@agentconnect.md/daemon` from its locally selected
  registry and refuses packages without verifiable integrity metadata.
- Exact version selection is resolved against registry metadata, and extracted
  Node engine requirements and the daemon entry are validated before activation.
- Version directories and the active symlink are published atomically.
- The version-store lock is separate from the daemon singleton lock because
  they protect different resources.
- The AgentConnect root contains executable path pointers, selected binaries,
  configuration, and credentials. Its filesystem permissions are part of the
  local trust boundary.
- Lifecycle operations are authorization-checked, organization-scoped,
  connection-epoch fenced, and completed only after a later `READY`
  registration.
- The daemon refuses a remote lifecycle request when exiting would leave it
  without an identified supervisor.
