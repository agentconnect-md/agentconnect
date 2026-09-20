# Daemon Sandbox Backends

**Status: Partially implemented.** SRT remains the default. The opt-in Linux
microsandbox backend implements release image defaults and explicit overrides,
resource configuration, guest execution, host mounts, retained-disk stop/start,
and Docker/Compose tooling that agents can start inside each VM when needed.
Networking has one fixed requirement for isolated sessions: public internet
access, with no access to other session VMs or host/private networks. End-to-end
network and workload validation remains pending.

The VM implementation uses the existing workspace modes and lifecycle.

A backend is also what a daemon's executor facet wraps when it hosts sessions for
other members of its group; [session-executors.md](session-executors.md) §5 names the
execution strategies after these backends.

This extends [daemon configuration and lifecycle](daemon-detailed-design.md) and
uses the existing [execution-driver seam](cluster-spawn-and-shim.md#1-why-a-seam-at-all).
[Workspace ownership](git-workspace-model.md) remains a separate concern. The
Control Plane does not carry ACP or provider request traffic.

## 1. Configuration and ownership

The daemon-owned `sandbox` object in `~/.agentconnect/config.json` defaults to
`{ "backend": "srt", "env": {}, "mounts": [], "share": false }`. The minimal
configuration is:

```json
{
  "sandbox": {
    "backend": "srt"
  }
}
```

Release builds include the shared runtime image reference. This example uses
that default:

```json
{
  "security": {
    "requireSandbox": true
  },
  "sandbox": {
    "backend": "microsandbox",
    "env": {
      "PNPM_CONFIG_STORE_DIR": "/cache/pnpm"
    },
    "mounts": [
      {
        "source": "/srv/agent-cache/pnpm",
        "target": "/cache/pnpm",
        "mode": "writable"
      }
    ],
    "microsandbox": {
      "cpus": 2,
      "memoryMiB": 2048,
      "diskGiB": 10
    }
  }
}
```

The resource values shown are the defaults, not measured minimums or capacity
recommendations. All three are positive integers bounded by the SDK's supported
numeric ranges. Source/development builds have no release image default and
require an explicit `sandbox.microsandbox.image`, such
as `registry.example.com/agentconnect/runtime-sandbox-full:build-tag`. An explicit image
also overrides the release default. Networking is fixed backend behavior; the
strict VM configuration has no network modes, port mappings, or outbound-proxy
settings.

| Setting                        | Meaning and delivery status                                                                                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.backend`              | Implemented: `srt` is the default; `microsandbox` selects the Linux VM implementation for sandboxed launches.                                                                                                                                                                                                                               |
| `sandbox.env`                  | Environment defaults for sandboxed session runtimes, default `{}`; shared by SRT and microsandbox. Runtime and agent variables override them; daemon-enforced private paths and security settings remain authoritative.                                                                                                                     |
| `security.requireSandbox`      | Existing behavior: require sandboxed execution for every agent, using the selected backend.                                                                                                                                                                                                                                                 |
| Agent **Run in sandbox**       | Keeps its current role when the daemon does not require sandboxing. Selecting a backend does not change the trust choice for unsandboxed agents.                                                                                                                                                                                            |
| `sandbox.microsandbox.image`   | Implemented: optional, non-empty OCI override. Release builds default to their bundled shared-image reference; development builds require an explicit image. No Kubernetes image lookup is used.                                                                                                                                            |
| `cpus`, `memoryMiB`, `diskGiB` | Per-VM CPU allocation, memory limit, and capacity of each writable disk; defaults are `2`, `2048`, and `10`. New VMs have a root upper disk and a Docker data disk, plus one disk when overlay mounts are configured, each capped by `diskGiB`. All are sparse; host capacity planning remains the operator's responsibility.               |
| `sandbox.mounts`               | Operator-owned filesystem mappings, default `[]`, with `source`, `target`, and `mode` (`readonly` by default, or `writable` / `overlay`). SRT requires equal normalized host paths; microsandbox accepts absolute guest targets and `~/` relative to the session HOME. Workspace, HOME, and runtime state remain automatically provisioned. |
| `sandbox.share`                | Implemented: default `false`. `true` lets this machine host isolated sessions for the other members of its daemon group, under this machine's runtime sign-in, and opens one TLS-PSK port for them. Read at start; `config/push` cannot set it. See [Sharing a machine with its group](#sharing-a-machine-with-its-group).                  |

### Shared mounts and manual conversion

`sandbox.mounts` replaces `security.sandboxReadRoots` and
`security.sandboxWriteRoots`. The old fields are removed; the daemon does not
automatically migrate or retain a compatibility path for them. Convert existing
configuration manually using this table, then remove the old fields:

| Previous entry                                          | Entry to add to `sandbox.mounts`                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `security.sandboxReadRoots: ["/opt/toolchain"]`         | `{ "source": "/opt/toolchain", "target": "/opt/toolchain", "mode": "readonly" }`               |
| `security.sandboxWriteRoots: ["/srv/agent-cache/pnpm"]` | `{ "source": "/srv/agent-cache/pnpm", "target": "/srv/agent-cache/pnpm", "mode": "writable" }` |

The former mount-level `readOnly` field is also removed: replace `true` with
`mode: "readonly"` and `false` with `mode: "writable"` when upgrading the daemon.
Ordinary mount identities in retained VM bindings remain unchanged by this rename.

Keep a previously writable path writable when converting duplicate legacy
entries. Launch preparation consumes only `sandbox.mounts`. Normalization expands
host `~`, requires existing absolute sources, and resolves symlinks using the
current root normalization. Existing protected-path checks remain in effect.
After normalization, reject different sources mapped to the same target; merge
permissions only for entries with the same source and target.

For SRT, access remains additive: a read-only entry adds read access; it does not
revoke write access already granted by a workspace or writable mount. Retain
writable children of read-only parents rather than collapsing nested paths.
microsandbox applies actual guest mount flags: a nested read-only mount restricts
that subtree even inside a writable parent, and a writable child remains writable
inside a read-only parent. Keep these nested mappings. User mappings that overlap
the VM's automatically provisioned paths are rejected, except for children of
the session HOME. Runtime credentials, settings, sockets, and internal overlay
paths remain protected.

SRT uses the configured paths at their host locations: its filesystem rules do
not rename a host path inside the sandbox. Normalize `source` and `target` as
host paths and require them to be equal. A mapping such as
`/srv/agent-cache/pnpm` to `/cache/pnpm` fails validation for SRT. The same mapping
is supported by microsandbox, where `target` is an absolute guest path.
The shared configuration list is kept outside the
`sandbox.microsandbox` object.

For example, SRT uses the same common configuration shape:

```json
{
  "sandbox": {
    "backend": "srt",
    "env": {
      "PNPM_CONFIG_STORE_DIR": "/srv/agent-cache/pnpm"
    },
    "mounts": [
      {
        "source": "/srv/agent-cache/pnpm",
        "target": "/srv/agent-cache/pnpm",
        "mode": "writable"
      }
    ]
  }
}
```

Apply the effective read/write access through both the outer backend and any
runtime-native tool sandbox. A writable package cache must remain writable to
the actual tool process. Mount configuration does not rewrite package-manager
settings: point the package manager at the effective target path. Do not mount
an entire host HOME to make an isolated runtime work. Session retirement detaches
operator-owned mounts without deleting their host contents.

### Sandbox environment defaults

Use `sandbox.env` for machine-local settings that accompany mounts. Values are
strings passed literally: the daemon does not expand `~`, `${HOME}`, or shell
commands. The child tool may implement its own expansion, as pnpm does for
`${HOME}` in the example below. Environment variable names must be valid process
variable names; values may be empty, must not contain NUL, and are limited to
16,384 characters each.

The merge order is inherited environment, `sandbox.env`, runtime-definition env,
agent env/secrets, then daemon-owned runtime and security settings. Private
`HOME` and XDG directories remain session-owned. Config-file variables such as
`KUBECONFIG_DATA` follow the existing materialization rules. Unsandboxed agents,
daemon subprocesses, and runtime compatibility probes do not consume these
defaults. The local `chat` command uses them when running with SRT.

Restart the daemon after editing `config.json`. A retained microsandbox session
uses the updated environment when its runtime restarts; changing only
`sandbox.env` does not require replacing its VM. Changes to mounts, VM resources,
credential scope, or image content replace the VM while retaining its host-mounted
workspace, HOME, and memory. The VM root disk and its Docker and Overlay write
volumes are disposable across replacement; put durable files in host mounts.

### Shared bases with session-local writes

microsandbox also accepts `mode: "overlay"` for directory sources. Multiple
sessions, including sessions belonging to different agents, can read the same
host base while keeping additions, changes, and deletions on their own writable
layer. `readonly` rejects guest writes; `writable` writes directly to the host;
`overlay` never writes back to its host source. SRT rejects overlay mode.

For example, mount a shared pnpm store under the session's XDG data directory:

```json
{
  "sandbox": {
    "backend": "microsandbox",
    "env": {
      "PNPM_CONFIG_STORE_DIR": "${HOME}/.local/share/pnpm/store"
    },
    "mounts": [
      {
        "source": "/srv/agent-cache/pnpm",
        "target": "~/.local/share/pnpm/store",
        "mode": "overlay"
      }
    ]
  }
}
```

The source must be an existing, populated host store directory. `~` in `source`
uses the daemon's HOME; `~` in a microsandbox `target` uses the session HOME.
Verify the effective target with `pnpm store path` in the actual session and
project, since package-manager versions, environment, and filesystem layout
affect the default.
An explicit store setting keeps pnpm from choosing a project-local store when
the workspace and mounted store are on different filesystems. This shares store
contents only; each session still has its own `node_modules`. Registry metadata
is a separate cache, so a populated store alone does not guarantee a fresh
session can install fully offline.

The daemon mounts each base read-only at an internal path and allocates one
session-owned ext4 disk for all its overlay upper/work directories. Before
starting session processes, it mounts the merged directories as root through
the SDK. Suspension retains the disk; resume recreates the mounts; session
deletion removes the disk. Root setup rejects symlinks in target directories.
Overlay targets cannot overlap other configured mounts. Changes to the configured
mount layout still require discarding a retained VM before recreating it.

Use a stable base while sessions have it mounted. Live host mutation consistency
and cache invalidation controls are separate work; this mode does not make an
OverlayFS lower layer safe to modify in place. Guest cache misses stay private
and are not automatically published for other sessions.

Configuration is machine-local desired state. Agent configuration can select a
runtime and request sandboxing, but cannot supply backend executables, images,
or mounts. Future backends add a typed configuration member and an implementation at the existing execution-plane
composition point. Do not add speculative backend branches throughout ACP.

### VM availability and configuration changes

The current microsandbox integration supports Linux with usable KVM. Startup
installs the pinned `microsandbox@0.6.17` package through the daemon's RuntimeStore,
preserving its native platform package, and gives it a daemon-owned state home.
It collects the cached images it no longer needs, prepares the image, boots a
temporary VM, validates the runtime table, and checks stop/start before admitting
VM launches. Checking `/dev/kvm` alone would not establish availability. With `requireSandbox=true`, an unavailable backend
refuses startup. Otherwise the daemon can still serve unsandboxed agents, but a
requested microsandbox launch fails explicitly, with no fallback to SRT or a host
process. Existing optional-SRT fallback semantics are unchanged. The standalone
`chat` command currently refuses microsandbox configuration; use daemon sessions.
The upstream SDK requires its derived Unix socket paths to fit Linux's 108-byte
limit, so an unusually long daemon root can fail preflight.

This implementation adds no new backend for Linux hosts without usable KVM. They can
keep SRT, including fail-closed startup with `security.requireSandbox=true`. The
new VM boundary requires bare metal or a VM exposing nested virtualization;
Podman/runsc with systrap remains a future no-KVM option, not a hidden fallback.

The manager persists each environment ID, sandbox ID, requested image/resources/
mount specification, and a hash of the SDK's saved configuration. Reuse rejects
missing or changed bindings and configuration rather than silently recreating the
VM. Each new session owns a VM using the image configured at creation, including
sessions that share workspace files. Its private HOME lives under
`runtime-homes/<session-leaf>/home` unless it already owns a confined session
directory. For shared workspaces, native-memory directories mount the agent's
existing memory store so Console reads and edits reach every session; runtime
state stays in the session's HOME. Image changes apply to new sessions;
resume keeps the original image, runtime versions, HOME and disks until session
retention removes them. Sessions created in a legacy shared agent VM continue
using that VM until its last session retires. Resource and mount changes still
require environment recreation. Image
digest resolution and in-place disk migration remain proposed.

Because each release pins its own image, an upgraded daemon would otherwise leave
the previous release's image cached forever. Startup therefore collects the image
cache before it pulls, keeping the configured image and every image a persisted
binding still records, which a retained VM validates when it starts, and removing
the rest one reference at a time. Whole-cache pruning is not used: it removes any
image no sandbox has booted, which includes the image a daemon just pulled and
has not started a session on. A removal the backend refuses because a sandbox
still boots from that image is kept and logged, and a cache that cannot be read
is logged without failing startup, so collection never costs availability. The
temporary preparation VM has a stable name and is reclaimed before it is
recreated; a start interrupted before its teardown would otherwise leave a VM
behind that pins a retired image.

The ACP runtime, its two helper endpoints, workspace filesystem operations and
skill publication use the same persistent Node shim and WebSocket protocol as
Kubernetes, so a VM and a pool pod are driven the same way. The local driver
carries that WebSocket over agentd's TCP stream to guest loopback; it does not
publish a host port or add a forwarding process. Daemon-run Git continues to use
direct SDK exec. The shim starts with each running VM, before anything else runs
in it, and a VM whose shim or helper endpoints cannot start is refused. It does
not prevent idle suspension. Each request holds the VM until it finishes, and a
resumed VM gets a new binding generation and identity token. The binding grants
`acp`, `tunnel`, `read` and the skill channels, and nothing else. Its credential
lives for a day rather than a pod's ten minutes. The shim renews at half that
lifetime by presenting the same one-time token again, which proves nothing new,
and a renewal ends any helper stream with a frame in flight, such as the MCP
bridge's connection.

The daemon stages its bundled shim and audited skills CLI in root-owned `/run`
files on startup, including when the VM retains an older runtime image. This
updates preparation code without replacing the session's image or disks. The
same root step creates the shim's runtime directory, `/run/agentconnect`, for
the image's ordinary user, which is the pool image's layout. Skill
source acquisition and the authoritative journal remain on the daemon; workspace
inspection, installation, verification, and cleanup execute inside the VM. A
legacy daemon-owned skill receipt can seed the new journal after its original
host-side recovery completes under the workspace lock. The journal is keyed by
the host directory's canonical path and storage identity, so replacing a VM
preserves ownership while replacing its workspace revokes it. Console file and
skill reads use this same
guest filesystem view: virtiofs symlinks and executable modes are not interpreted
through their host-side representation.

Retired-root sweeps skip cold VMs; explicit Console reads may resume them. If
optional microsandbox initialization fails, host file inspection remains
available while VM launches remain refused. Kubernetes and microsandbox share
the paged skill receipt protocol and require duty admission before serving
activation or explicit launch prepares a sandbox workspace.

Kubernetes mode retains `K8sDriver`, its resource configuration, and image rollout.
An explicitly configured local microsandbox backend
with `--k8s` is rejected as conflicting configuration; an omitted/default local
backend has no effect on pool execution. Sharing an image does not mean nesting
microsandbox inside every pool pod.

### Runtime discovery

A self-hosted daemon combines host installations, image installations, and the
stored credential sources used to prepare runtime authentication. Discovery checks
the specific authentication file and, for a shared provider store, the corresponding
provider record. Configuration directories and empty stores do not establish a login.

Host and Sandbox apply the same display rule using their own binary availability:

| Binary available | Stored login | Display                                                            |
| ---------------- | ------------ | ------------------------------------------------------------------ |
| Yes              | Yes          | Runtime models and capabilities; retain any observed login failure |
| Yes              | No           | Login required                                                     |
| No               | Yes          | Binary not installed on host / Binary not installed in image       |
| No               | No           | Hidden                                                             |

The daemon probes host installations to learn their models and capabilities.
These metadata probes use host SRT when available and otherwise run on the host;
they do not submit a model turn. With microsandbox selected, `requireSandbox`
continues to require VM isolation for agent sessions, without requiring host SRT.
The image table supplies the guest command and binary version. A candidate missing
from that table remains visible with **Binary not installed in image** when it has
a stored login. An installed image runtime without a stored login remains visible
in the Sandbox view with **Login required**.

Stored credentials indicate configuration, not current validity. Successful model
enumeration does not establish a login or clear the absence of stored credentials.
Expired logins remain visible; an authentication failure from the host probe or a real turn
records the existing login requirement. For sandbox execution, the console shows
**Binary not installed in image** first and **Login required** only after the
image contains that runtime. The underlying authentication status is retained.

File and database discovery currently covers Claude, Codex, Qoder, OMP, Grok, pi,
OpenCode, DSH, Hermes, Auggie, Cline, Amp, Gemini/Qwen/Kimi OAuth, Qwen saved API
keys, Antigravity ACP file logins, Devin, and Copilot's stored token map. These
descriptors also prepare the corresponding files in the private runtime HOME.
Keyring-only logins are not detected by file discovery. Credential formats without
a shared discovery descriptor retain the runtime probe's authentication result.

### API key protection

Claude Code and Codex file-based API logins use microsandbox's built-in TLS proxy.
The daemon discovers Claude's saved `primaryApiKey` in its active global config
(including `CLAUDE_CONFIG_DIR` and the legacy `.config.json` layout), or Codex's
`OPENAI_API_KEY` in `CODEX_HOME/auth.json`. Private copies contain placeholders;
the raw host API credential file is not mounted. Claude retains the existing
global-config seed allowlist, and private settings survive later preparation.
Codex's private `auth.json` is a regular projected file, replacing the shared
auth-file link for API logins. Matching key values in its seeded `config.toml`
and launch environment are replaced too. No native authentication environment
variable is added, so the runtime still selects its own authentication method.

Claude authorizes its configured `ANTHROPIC_BASE_URL` host, defaulting to
`api.anthropic.com`. Codex resolves the host `config.toml`, selected profile and
`CODEX_CONFIG` overrides: the built-in provider uses `openai_base_url` or
`api.openai.com`; a custom provider can use the file login when
`requires_openai_auth = true`. `OPENAI_BASE_URL` does not control the pinned Codex
runtime's routing. Unsupported endpoints keep the placeholder without receiving
proxy injection; there is no plaintext fallback. Guest-side endpoint changes
cannot authorize an additional host. This path covers registered `claude-acp`
and `codex-acp` file logins, not keyring-only, helper-only or environment-only keys.

Pure OAuth logins keep their existing shared credentials and native refresh.
Claude can also keep a separate shared OAuth directory alongside its projected
API config. If that directory contains the raw API config, launch refuses the
overlapping mount. Codex files explicitly selecting a non-API authentication
mode while also storing an API key are refused rather than exposing the key or
silently changing native authentication. These mixed-source layouts remain
compatibility follow-ups; this change does not add OAuth proxying.

For DeepSeek Harness in microsandbox, the daemon resolves the standard
`DEEPSEEK_API_KEY` reference using the existing credential-file descriptors and
DSH parser (`.credentials.yaml`, including the legacy layout and version-1 refs,
then `.env`). An explicit launch or inherited host key takes precedence, so a
malformed unused YAML seed cannot override it. The guest
receives only a placeholder; microsandbox's built-in TLS proxy substitutes the key
in request headers for `https://api.deepseek.com`. A non-default base URL in the
launch environment, host environment or DSH `.env` refuses the launch with a
diagnostic. Custom credential-reference names are outside this first implementation.

OpenCode uses the same proxy and lifecycle for `type: api` records in its native
`auth.json` (including XDG data-directory overrides). Each provider receives its
own placeholder and allowed HTTPS hosts; providers sharing a key share one
placeholder with their combined authorized hosts. Routing comes from standard host OpenCode
config and `OPENCODE_CONFIG_CONTENT`, then provider defaults or OpenCode's cached model
catalog. Unknown or unsupported destinations keep placeholders but receive no
proxy key injection; other providers can still start and authenticate. Configure
a supported HTTPS host `provider.options.baseURL` to enable that provider. There
is no fallback to mounting its real API key. An absent or unusable catalog only
affects providers that need that catalog, not providers with known defaults;
guest workspace configuration cannot authorize a new destination. Standard
providers do not require a warm model cache. Copies of the protected keys in
seeded OpenCode credential values, Bearer headers, and JSON environment config are
replaced too, without replacing matching substrings in paths or unrelated text.
The host files are unchanged.
This path protects keys discovered in native `auth.json`; it does not discover
additional keys stored only in other configuration sources.
`OPENCODE_CONFIG` and `OPENCODE_CONFIG_DIR` paths are not imported or used for proxy
routing; use the standard host config locations or `OPENCODE_CONFIG_CONTENT`.
Symlinked host files are skipped, matching native HOME seeding. Credential import
uses the registered `opencode` state profile, not command-name matching for custom
runtime IDs.

OpenCode OAuth and `wellknown` records remain unchanged in the mounted private credential file
and are readable by the guest. Guest-refreshed OAuth records survive subsequent
preparation. OAuth-only launches retain the existing seeding path, without proxy
secrets or additional credential shielding. This change does not add an OAuth
proxy or refresh coordinator.
API records for providers configured only inside the guest retain their native local login
behavior on resume; they are not host-managed proxy credentials. Blank or malformed
API keys are not selected for protection and do not prevent preparing other records.

pi uses the same proxy for file-based `type: api_key` records in `auth.json` and
provider `apiKey` fields in `models.json`, honoring `PI_CODING_AGENT_DIR`. Its
shared state descriptors now discover and seed `models.json` for both SRT and
microsandbox. The VM receives projected auth, model and settings files; matching
key values and Bearer headers are replaced, and host files remain unchanged.
Providers sharing a literal key share a placeholder and their authorized hosts.
Routing uses the host's JSONC `models.json` provider and model `baseUrl` values,
with audited defaults for Anthropic, OpenAI, DeepSeek, Google, xAI, OpenRouter,
Groq and Mistral. Guest model edits cannot authorize additional destinations.

This pi path supports literal API keys. Command-based keys, interpolation and
structured provider `env` credentials are replaced by inert placeholders without
executing helpers or importing their secret values. Unknown providers and
unsupported endpoints also retain placeholders without proxy injection; their
keys are never mounted as a fallback. Extra secrets stored only in arbitrary
headers or extensions are not discovered by this path. Symlinked host files are
skipped, matching native HOME seeding. OAuth records and guest-only logins retain
their existing behavior, including refreshed private OAuth state on resume.
Pure OAuth launches do not enable secret injection. SRT authentication and tool
policies are unchanged; it imports the native files without this VM proxy.

Grok Build uses the same proxy for literal `model.<id>.api_key` values with an
explicit HTTPS `base_url` in the host's `config.toml`. The shared state inventory
honors `GROK_HOME` and `GROK_AUTH_PATH` and seeds only the native auth file plus
`config.toml`, `managed_config.toml` and `requirements.toml`, excluding backups.
Both discovery and VM projection inspect these files, including conditional TOML
tables. Matching values and Bearer headers become placeholders; TOML dates,
unrelated settings and refreshed guest OAuth state survive projection and resume.
Repeated keys share a placeholder and their host-authorized destinations.

Grok keys in cached `auth.json` API records, managed/requirements layers,
version overrides or models without an explicit supported endpoint are hidden
without authorizing injection. Inherited endpoints, interpolation, helpers and
environment-only logins are not resolved. Those API configurations remain
unavailable; there is no plaintext fallback. OAuth keeps its native behavior.
Host system-wide `/etc/grok` files are not imported. Secrets stored only in
arbitrary headers or extensions are outside discovery. Native Grok 1.0.25's
per-model API path was verified with the SDK CA and a real ACP tool turn; its
cached xAI API-login path still needs validation with a valid native login.

Qwen Code uses the same proxy for keys saved in `settings.json`: model-provider
`envKey` references to the file's `env` values (including native protocol defaults
and `providerProtocol` mappings), plus legacy `security.auth.apiKey`. This is file
credential import; environment-only logins are not added. Shared discovery and
private-HOME seeding honor `QWEN_HOME`, and private launches pin both `QWEN_HOME`
and `QWEN_RUNTIME_DIR`. The seed inventory includes native settings, OAuth and
account files, excluding settings backups and runtime snapshots.

Only explicit HTTPS model `baseUrl` or legacy auth `baseUrl` values from the host
settings authorize proxy injection. Missing or unsupported endpoints, unknown
protocols and interpolation keep placeholders without importing a plaintext key.
Default endpoints, `.env`, workspace/CLI overrides and extra keys stored only in
arbitrary fields are outside this path. Matching key values and Bearer headers in
the seeded files are replaced; repeated keys share their authorized destinations.
Guest edits cannot authorize new hosts. OAuth-only launches retain native seeding,
and guest-refreshed OAuth state survives API-key rotation. SRT imports the same
native files without enabling this VM proxy. Native Qwen 0.23.3's OpenAI-compatible
API path was verified with the SDK CA and a real ACP tool turn.

Oh My Pi uses the same proxy for API keys in its native `agent.db`, honoring
`PI_CODING_AGENT_DIR`. The existing credential-table extractor writes placeholders
before inserting any row into the private database; API keys never enter its
journal during seeding. Native OAuth and login metadata are preserved. Routing
covers the audited built-in Anthropic, OpenAI, DeepSeek, Google, xAI, OpenRouter,
Groq and Mistral endpoints. Unknown providers keep placeholders without injection.
Custom model files are not part of the existing HOME seed; model-file-only keys,
broker/command/environment credentials and OAuth protection remain outside this
path. Native OMP 18.1.17 completed an ACP model/tool turn through this proxy.

OMP resume checks a host-only copy of the private database and WAL, opened through
directory/file descriptors without following guest symlinks. The original files
are never rewritten, preserving OAuth refreshes and usage records. This check is
bounded to 256 MiB combined. Retained plaintext or incompatible API records require
a new session; existing data is retained. Key values for unchanged bindings rotate
through the stopped-VM lifecycle; changed login identities or shared-key groups
may require a new session. OAuth-only and SRT launches keep native seeding.

Amp uses the same proxy for nonempty `apiKey@<service URL>` entries in its native
`secrets.json`, including `XDG_DATA_HOME` relocation. The record's HTTPS host
authorizes header injection; changing guest settings cannot authorize another
destination. HTTP, custom ports, URL userinfo and malformed addresses retain
placeholders without injection. Shared keys share a binding across their allowed
hosts. Native JSONC settings, including `AMP_SETTINGS_FILE`, are projected into
the private HOME with matching key values replaced. Unrelated credential records
and guest-only logins retain native behavior; stopped-VM rotation preserves them.
This covers native Amp CLI file login, not the adapter's separate
`amp-acp/credentials.json` setup file, environment-only credentials, or arbitrary
workspace configuration. SRT keeps native authentication. Amp ACP 0.9.0 and the
native CLI were checked with synthetic credentials; an authenticated model/tool
turn remains a release acceptance task.

When a DeepSeek key is available, the daemon projects the credential seed files
with that ref replaced by the placeholder; other provider refs, OAuth records and
existing private logins are preserved. Without a DeepSeek key, normal seeding is
unchanged. On the currently supported Linux backend, projection holds directory
and file descriptors without following symlinks and publishes by atomic rename,
so a guest swapping a file or parent cannot redirect a daemon write. The daemon
rejects mounts exposing protected host paths, sharing SRT's
boundary and runtime-state inventory, and supplies the guest CA environment even
when process-environment inheritance is disabled. Keys stay out
of serialized launch metadata and environment bindings. The SDK persists its own
secret configuration on the host; this protection is against guest access.
All VM launches reject requested mounts of the host SDK state directory, its
ancestors or its descendants, including launches for runtimes that do not use
secret injection themselves. Public support helpers live outside SDK state;
retained VMs can keep their previous exact read-only helper mounts.
The proxy does not redact provider responses, so the allowed provider remains a
trusted recipient of the key.

The pinned SDK installs the proxy CA into the guest system bundle before execution.
Combining it with operator-provided trust bundles is deferred: protected runtime
launches explicitly refuse custom `TLS_TRUST_ENV`, `CODEX_CA_CERTIFICATE`, `REQUESTS_CA_BUNDLE` or
`CURL_CA_BUNDLE` settings instead of silently replacing them. Use SRT for those
configurations until custom trust is supported.

New VMs receive the proxy configuration at creation. Retained protected VMs reload
the host key before starting again; already-running VMs keep their current key
until stopped and resumed. Previously unprotected VMs fail configuration
reuse and retain their data: start a new session instead of treating an old disk
that may contain credentials as protected. If a protected VM's credential later
disappears, restore that credential and retry or start a new session; no VM or
session data is automatically discarded. SRT and Kubernetes authentication
paths are unchanged. No separate daemon HTTP proxy or networking option is added.

## 2. Selecting the backend

The choice favors session development workflows over maximum hardening.
microsandbox is the first new backend because its full guest environment is a
better fit for ordinary Docker workflows; performance still needs measurement.

| Option                                | Development experience and operating cost                                                                                                                                                                                     | Decision                                                                                         |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| SRT / bubblewrap                      | Already integrated, uses host tools, no image or guest kernel. Current network wrapping mainly serves proxy-aware HTTP(S) clients; host access to development servers and arbitrary network tools is not a general guarantee. | Keep the default and existing behavior during rollout.                                           |
| Podman / crun                         | Familiar OCI images, volumes, port publishing, and inexpensive ordinary containers. A separate nested Docker environment adds storage, permissions, and networking work.                                                      | Retain as the performance baseline and a possible lightweight future backend.                    |
| Podman / gVisor                       | Rootless integration exists and systrap needs no KVM. Nested Docker requires extra network/storage configuration; starting dockerd does not establish unmodified Compose or Testcontainers compatibility.                     | Do not choose it first for this Docker-oriented workflow.                                        |
| Docker Sandboxes (`sbx`)              | Provides a VM-based agent environment and Docker-enabled templates, but adds product-specific lifecycle setup and a separate VM startup cost.                                                                                 | Keep as a comparison, not the first daemon integration. This is distinct from Docker Engine.     |
| microsandbox                          | OCI images, streaming execution APIs, independent VMs, and an official independent-Docker example. Requires KVM on Linux; beta APIs and disk/lifecycle limits need an adapter and tests.                                      | First new backend, initially opt-in.                                                             |
| OpenSandbox / OpenShell               | Broader sandbox services with additional server, gateway, policy, or execution components.                                                                                                                                    | Defer: the first change needs an execution backend for the daemon, not another management plane. |
| Kata / direct Firecracker integration | Useful VM building blocks, particularly around Kubernetes; a direct VMM integration also needs image, networking, and guest execution machinery.                                                                              | Defer; revisit for a specific pool or scale requirement.                                         |

[gVisor's Docker guide](https://gvisor.dev/docs/tutorials/docker-in-gvisor/) requires
raw-packet support, disabling dockerd's automatic iptables management, and extra
network setup. It recommends inner host networking for affected port-exposure
scenarios; Docker 29 also needs a suitable storage arrangement. Its example uses
an outer Docker/runsc setup, not our untested rootless Podman/DinD combination.
[microsandbox's Docker example](https://docs.microsandbox.dev/examples/docker/docker-in-sandbox)
uses `docker:dind`, a flat ext4 disk, and an ordinary guest dockerd. This supports
prioritizing its compatibility test; it is not proof that every Compose project
or Testcontainers cleanup helper already works.

Measure complete Linux agent sessions before drawing performance or density
conclusions. Vendor guest-boot figures and empty-container timings are not
substitutes for ACP readiness, dependency installation, and Docker workloads.

Cloud deployment is possible without bare metal on supported
[EC2 instance types](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/amazon-ec2-nested-virtualization.html)
and [Google Compute Engine types](https://docs.cloud.google.com/compute/docs/instances/nested-virtualization/overview#restrictions),
with nested virtualization explicitly enabled. Check the deployed machine type
and measure there; do not extrapolate bare-metal or desktop boot numbers.

## 3. Session environment and image contract

`MicrosandboxManager` supplies the existing `SpawnDriver` contract. ACP runs
through the VM's shim with the same `createRemoteRuntime` the pool uses: the shim
resolves the command and its executable hints in the guest, starts the runtime as
the image's ordinary user in its own process group, relays its stdio as numbered
frames, and reports its exit. The driver sends the image's environment beneath
the launch environment and names the workspace root as the working directory, as
a direct guest exec did. The VM starter sets `AC_SHIM_COMPLETE_ENV=1`, because
the daemon that drives the VM is on the same machine, so the shim treats that
environment as whole and adds none of the fill-ins a pod template supplies: no
provider variables, no Codex auth request composed from an inherited key, no
DeepSeek preset. The flag is the starter's own claim and is not implied by an
identity that arrived on stdin. Stop closes the
runtime's stdin, signals its process
group, and escalates to a kill past the deadline. A lost shim ends every runtime
on it at once and fences the VM, so the host is rebuilt on the next turn; a
stop the shim does not confirm with the runtime's exit fences the VM as well. The
runtime's stderr arrives on the shim's stream and is written to the daemon's
stderr; the shim's own tagged lines go to the debug log. Native tools run inside
the existing harness and VM. There is no external CLI invocation for each tool
call.

Daemon-owned Git operations for mounted workspaces execute Git through the SDK,
sharing command policy and result parsing with the pool runner. A small shell
checks physical guest paths and then replaces itself with Git; no Node dispatcher
starts per command. Canonical clone preparation outside an exposed
workspace remains host-side. Workspace reads and attachment access use host-backed
directories mounted at the same guest paths. Once a VM exists, workspace mutations
run a small Python operation in the guest: renaming a staged clone on the host
can leave the VM's cached directory view stale, while a guest rename is immediately
visible to guest Git. Initial directory preparation remains local before VM boot.
This does not require a second filesystem copy or a Kubernetes tunnel. The
runtime's command lookup happens in the shim, and generated launch files use the
guest file API. Filesystem
mutations retain descriptor-anchored paths, no-follow checks, and atomic writes;
write content streams over stdin and its complete byte count is checked before
publication. The shim's tunnel host serves the MCP and Git credential sockets at
the pool's in-guest paths and proxies each connection over the channel to this
daemon's own socket, so the guest reaches those two servers and nothing else;
the image's Kubernetes entrypoint and control connection are not started.

New sessions use their own `agent/session-…` environment, writable runtime HOME,
disk, and guest network namespace. Retained legacy sessions and canonical
workspace preparation continue using the `agent/agent` environment. Existing
shared-workspace versus session-workspace choices still govern repository data;
separate VMs do not make a deliberately shared host mount private. Linked-worktree
Git metadata, secondary repositories, and file attachments keep consistent guest
paths. This change does not redesign Git storage.

### Current image contract and VM storage

The resolved OCI image must contain Node at
`/usr/local/bin/node`, `/usr/bin/git`, Python 3.11+ for filesystem operations and shim staging, the declared runtime tools,
and `/opt/agentconnect/runtime/k8s-runtimes.json`. The daemon's full image also
includes `bubblewrap` and `socat` for the native Claude sandbox.
Startup reads and validates that table in a real VM; individual
runtime execution and full-session compatibility still need workload checks.

The SDK's `create()` does not execute OCI ENTRYPOINT/CMD automatically. The manager
explicitly stages and starts the shim, which starts the requested runtime commands.
The pool's Kubernetes security context, volumes, and resource limits do not
travel inside its OCI image. In particular, the pool's shim startup and UID/HOME
configuration are not a substitute for the local VM's launch settings. See the
upstream [execution semantics](https://docs.microsandbox.dev/sandboxes/commands).

Each streaming execution owns an SDK `AgentClient` connection. The daemon uses
the pinned SDK's exec protocol and explicitly closes that client before reporting
process completion or releasing the VM's active-execution count. Closing stdin
sends EOF; it does not close a process that is still running. This avoids relying
on garbage collection of the SDK's high-level exec handles, while retaining
cancellation, backpressure, and live output limits. The shim itself and
daemon-run Git are the executions that use this channel; ACP streams are
multiplexed on the shim's WebSocket instead.
After an output-limit failure, the daemon kills the process and drains its
terminal event before closing: the pinned relay can otherwise reuse the client
ID while old output is still arriving. Losing transport before that terminal
event fences and stops the VM before another execution can reuse it.

New VMs share the image's read-only layers and keep root filesystem changes in a
private writable upper disk. Each VM also owns an ext4 disk mounted at
`/var/lib/docker`, so Docker's OverlayFS snapshots do not nest on the root
OverlayFS mount. Both sparse disks use `diskGiB` as their individual capacity.
Workspace, HOME, and cache mounts retain their existing ownership and isolation.
Creating a VM does not copy the full base image, including on hosts without
reflink support. Generated launch files are written after boot through the guest
file API.

Existing flat-root VMs keep their saved layout and data when resumed. A new
binding records ownership of its Docker disk; older bindings do not acquire or
delete separate disks. Suspend retains both writable disks. Discard deletes the
VM and then its owned Docker disk, retaining the binding if disk cleanup fails
so the operation can be retried. SDK connections are explicitly detached after
the VM stops. Resume and disk deletion retry the pinned SDK's transient disk-lock
contention for up to one second after shutdown.

Each VM mounts `/run` as tmpfs so process IDs and service sockets cannot survive
a stop/start while application data remains on the persistent disks. Operator
mounts cannot replace `/run` or `/var/lib/docker`. Shim staging creates
`/run/agentconnect` on that tmpfs for the image's ordinary user, so a VM and a
pool pod serve the helper sockets at the same paths.

In pinned version `0.6.17`, starting a retained flat-disk VM still validates the
OCI image's VMDK cache. The manager runs the official
`msb pull <image> --materialize layered --quiet` before its VM probe, preparing
the shared layers and VMDK without generating an unused flat base disk. Retained
flat VMs continue to use their original disk. The same image preparation runs
before version activation during CLI upgrades; startup still verifies VM
boot and stop/start, reusing the prepared image cache.

### Release image selection and Docker

Stable system dependencies live in manually published `base-<version>` tags of
the two runtime image packages, built from `docker/runtime-sandbox-base.Dockerfile`.
Both bases provide Node, Git, the build toolchain and Chrome with its system
libraries. Only the full base adds Docker, bubblewrap and socat. Neither base
installs agent-browser or an ACP harness. Updating system dependencies requires a
base build and an explicit digest update; release builds reuse these pinned bases
even with an empty build cache.

`docker/runtime-sandbox.Dockerfile` owns the application versions and installation.
The full image first adds Antigravity in an independent, fixed-version layer,
then agent-browser, then the other harnesses. The pool image starts with
agent-browser and then installs its harnesses. Routine application upgrades change
these exact version pins and use the normal release image build, without publishing
another base. Standalone downloads also pin SHA-256. The shim remains an independent
compilation stage whose small helper payload is copied last into both final images;
it does not need a separately published image.

The release build bundles `dist/release.json` with a `runtimeSandboxImage` OCI
reference. It names the current release's `runtime-sandbox-full:v<version>` alias.
The image workflow creates this alias even when it reuses an older component
image. The pool continues to use the separate `runtime-sandbox` image. Both targets
share the same helper payload over their respective application layers. Additional
self-hosted runtimes belong in the full application stage. The pool provides Claude Code,
Codex, and DeepSeek Harness. The full image additionally installs Antigravity,
Cline, Devin, GitHub Copilot, Grok Build, Oh My Pi, OpenCode, pi, Qwen Code,
Qoder CLI, and Qoder CN CLI. The `qoder` compatibility ID resolves to `qoder-cli`
before host discovery and image projection. Both IDs share one native launch
definition and one probe state; reported `aliasOf` metadata lets the Console show
one entry while existing agent configurations retain either ID. Explicit runtime
overrides remain independent. pi includes both its ACP adapter and the underlying
CLI. Packages are version-pinned; standalone downloads also pin their SHA-256.

Each application stage bakes an explicit runtime roster and generates its own runtime table
after installation by probing the executables as the ordinary runtime user, without
provider credentials. Missing executables fail the build instead of silently
reducing the roster. Installed runtimes remain discoverable without a saved login;
saved logins also keep runtimes visible when their executable is missing.
General development toolchain expansion can follow independently.
The daemon package is published before image finalization; the matching
image workflow must complete before this default can be pulled. A missing image
fails preflight rather than selecting another version.
Runtime-image input changes also trigger daemon package publication so its
bundled default follows the updated image.
The release images are currently Linux amd64; an arm64 daemon must configure
a compatible image explicitly. The full image's Antigravity binary requires
AVX in the guest CPU; amd64 emulation without AVX cannot run that runtime.

To update system dependencies, edit `docker/runtime-sandbox-base.Dockerfile` and run
the **Build runtime bases** workflow manually in GitHub Actions. Its default tag is
`base-YYYYMMDD-HHMMSS` in UTC; an optional explicit tag must also include the date.
The workflow refuses to overwrite an existing tag, publishes both bases and verifies
each with the application layers, runtime table and real shim session. Successful jobs
report digest-pinned references in the run summary and upload them as artifacts.
Update the two base ARGs in the release Dockerfile to those verified references.

For a local build, use a new tag and an amd64 host with AVX for full application
verification. Push candidates before checking them: nothing references a new tag
until the release Dockerfile pins it. Run these commands from the repository root:

```bash
set -eu
BASE_VERSION=20260911.2
for variant in runtime-sandbox runtime-sandbox-full; do
  docker buildx build --builder "$(docker context show)" --platform linux/amd64 \
    -f docker/runtime-sandbox-base.Dockerfile --target "$variant-base" \
    -t "ghcr.io/agentconnect-md/$variant:base-$BASE_VERSION" --load .
  docker push "ghcr.io/agentconnect-md/$variant:base-$BASE_VERSION"
done

for variant in runtime-sandbox runtime-sandbox-full; do
  docker buildx build --builder "$(docker context show)" --platform linux/amd64 \
    -f docker/runtime-sandbox.Dockerfile --target "$variant-verify" \
    --build-arg "RUNTIME_SANDBOX_BASE=ghcr.io/agentconnect-md/runtime-sandbox:base-$BASE_VERSION" \
    --build-arg "RUNTIME_SANDBOX_FULL_BASE=ghcr.io/agentconnect-md/runtime-sandbox-full:base-$BASE_VERSION" \
    --output type=cacheonly .
  node scripts/verify-runtime-image.mjs "$variant" \
    --build-arg "RUNTIME_SANDBOX_BASE=ghcr.io/agentconnect-md/runtime-sandbox:base-$BASE_VERSION" \
    --build-arg "RUNTIME_SANDBOX_FULL_BASE=ghcr.io/agentconnect-md/runtime-sandbox-full:base-$BASE_VERSION"
done
```

The `-verify` target runs the runtime-table probe, the static in-image checks and the
shim smoke test — the image's own entrypoint started as the pod starts it, the daemon
side dialling it over loopback, the real ACP runtime answering `initialize` and
`session/new` — as build stages, so the host needs no toolchain. The host script
checks the tini entrypoint and browser path inherited from the pinned system base,
follows application-stage inheritance and checks the final non-root user. Other
configuration overrides are rejected. The release fingerprint includes application
assets and installation scripts as well as Dockerfile pins and shim content.
To try a built image by hand, build
the `$variant` target with `--load -t "$variant:local"` and, after `pnpm install` and
`pnpm --filter '@agentconnect.md/daemon^...' build`, run
`pnpm --filter @agentconnect.md/daemon exec tsx scripts/smoke-runtime-image.mts "$variant:local"`,
which starts the container with `docker run` and drives the same steps.

After both variants pass, inspect the pushed tags' registry digests with
`docker buildx imagetools inspect`. Verify anonymous pulls, then update both `ARG`
defaults in `docker/runtime-sandbox.Dockerfile` to `tag@sha256:digest` references in
the dependency update PR. Do not overwrite an existing base tag.
Changing only the manual base Dockerfile does not publish a daemon or release image;
changing a base digest in the release Dockerfile does. Normal release CI continues
to verify the final images and exercise a real ACP session through the shim.

An explicit daemon image overrides this metadata. Development builds remove
release metadata and require an explicit image; they do not derive a default
from the development package version. Release defaults and explicit image
overrides select the image for newly created VMs. Retained environments compare
the recorded platform manifest identity with the configured image: another tag
for the same digest reuses the VM, while changed content replaces it on refresh.

The full image contains `bubblewrap` and `socat` for native credential shields;
bubblewrap supports `--argv0` so Codex can start while its state directory is
hidden. It also includes pinned Docker Engine, CLI, containerd, Buildx, and Compose packages.
The pool image does not include those tools or the Docker sudo grant.
The full image's ordinary container user and shim entrypoint remain in
place. Image construction installs and verifies the tools; it does not start
Docker. The image provides this command for manual startup inside the VM:

```sh
sudo -n dockerd > /tmp/dockerd.log 2>&1 &
docker info
```

Wait for that command's Docker server to become ready before using containers.
Agent-tool startup remains pending acceptance: the current native Codex sandbox
sets `no_new_privs`, which prevents this sudo command from elevating.
The image grants the `agent` user permission to run `dockerd` through sudo and
access the Docker group's Unix socket. It does not grant unrestricted sudo.
A custom image owns its corresponding tools and startup permissions.

There is no daemon Docker configuration, automatic startup, health gate, or
Docker process supervisor. Docker failures are ordinary tool failures and do not
stop an otherwise healthy agent VM. The host Docker socket is not mounted by the
backend; ambient host Docker contexts and connection paths are removed from guest
launches. Managed-pool pod privileges are unchanged by the image's installed tools.

Docker image layers, named volumes, and build caches live on the VM's retained
ext4 Docker disk. The image's manual `dockerd` command starts its own containerd,
whose data root is `/var/lib/docker/containerd/daemon`, on the same disk. A custom
image that starts a separate system containerd must also place that service's
data root on ext4; Docker's `data-root` setting does not relocate a separate
containerd's storage. Stopping retains the data; after a VM restart the agent
starts dockerd again when needed. VM retirement deletes the owned disk.
Docker-published ports belong to the
VM's network namespace, so two sessions can use the same internal port. This does not publish the port on the
daemon host or provide a remote browser preview.

### Session network isolation

In session-isolation mode, each session's VM has its own network environment.
The required behavior is fixed:

- Sessions can access the public internet, including DNS, Git, and package registries.
- Sessions cannot connect directly to other session VMs or to host/private-network services.
- Services inside one session can communicate normally, including guest loopback
  and Docker container networks.

Shared workspace mode continues to reuse the agent's VM and therefore its
network environment; separate conversations in that mode are not isolated VMs.
SRT retains its existing network integration.

The current manager selects upstream's `single-tenant` deployment profile,
retains its default public-only outbound policy, and configures no published
ports. See [microsandbox networking](https://docs.microsandbox.dev/networking/overview).
The backend uses the SDK guest channel for daemon communication. This does not
require allowing guest access to the host's general network services.
The existing policy is the implementation baseline; complete-session tests must
still establish public egress and denied host/private/peer connectivity, including
applicable IPv4/IPv6 host addresses and aliases. The upstream
[host category](https://github.com/superradcompany/microsandbox/blob/v0.6.17/crates/network/lib/policy/destination.rs#L40)
covers the VM gateway; a routable public address belonging to the host can still classify
as public. Blocking that route remains an implementation/validation gap. Selecting
a deployment profile alone is not evidence that these checks passed.

Two isolated sessions can each listen on guest port 3000 or publish a Docker
container on guest port 5432 without a conflict. Those ports belong to separate
VM networks. Allocating different host ports is only needed when exposing these
services through listeners on the daemon host; it does not create session
isolation. Host port publication, dynamic preview forwarding, and remote browser
access are outside this delivery scope. No daemon networking configuration is
added for them.

### Stop, restart, and retirement

- A completed turn keeps its environment available for the existing idle policy.
- The existing ACP host idle/max-lifetime policy stops the host. The VM manager
  refuses suspend/removal while executions remain active, and the idle sweep also
  stops VMs left idle after workspace preparation. Stopping retains mounted
  workspace/HOME data and the private disk. Detached guest background processes
  are not independently leased and end when the VM stops.
- Start boots a new guest process environment from retained disk and re-establishes
  ACP; use runtime `session/load` when supported. It does not resume process memory,
  an old TCP connection, or an interrupted guest process.
- Before admitting new VM launches, daemon restart stops recorded owned VMs that
  are still running. It retains their disks and replaces the shim and ACP
  processes on the next start; it does not adopt the old running processes.
- Agent installation starts a background workspace prefetch that refreshes changed
  agent-level VMs without awaiting all agents before daemon readiness. Unchanged
  VMs remain asleep; session-owned VMs refresh on their next use. Workspace preparation
  for that agent joins the same queue. Activation and refresh prepare mounts without
  starting ACP; initialization and session loading happen at the actual runtime wake.
- A replacement stops the old VM, creates a fresh candidate with the desired
  mounts, verifies mount presence and permissions, and atomically commits its binding.
  Only then are the old VM and its owned disks removed. A failed candidate preserves
  the old binding and reports failure rather than silently using obsolete settings.
  Durable candidate and retirement records permit cleanup after an interrupted swap.
- VM identity and the full persisted configuration hash must still match their
  binding before refresh. An externally altered VM is refused, not automatically
  adopted or erased. Host-mounted files are never copied or deleted by VM replacement.
- Retirement uses existing dirty/unpushed-work protection before deleting a
  session's retained storage. VM removal deletes its private disk and binding;
  operator-owned host mount contents are not deleted by VM removal.

The inspected SDK does not provide general pause/resume of running process state.
Lifecycle and configuration-reuse rules are documented
[upstream](https://docs.microsandbox.dev/sandboxes/lifecycle).

### Host-strategy shim launcher

[session-executors.md](session-executors.md) §5 names `host` as an execution
strategy: the same shim, started as a plain child process of the daemon with no
sandbox around it, which [architecture.md](architecture.md) §9.1 already treats
as an operator's choice. `startHostShim` (`execution/host-shim.ts`) is that
launcher. Its one production caller is the executor facet
([below](#sharing-a-machine-with-its-group)); the launcher itself opens no
network listener.

- **Linux only.** Elsewhere it refuses with the reason the design gives: the
  shim's console read path is fd-bound and its helper locations are image-fixed.
- **A short per-session runtime root**, `<daemonRoot>/hs/<12 hex>`, mode `0700`.
  It sits beside the sessions and not under a session HOME because every socket
  beneath it must fit the AF_UNIX path budget; a daemon root too long for that is
  refused. The shim receives it as `AC_SHIM_RUNTIME_ROOT`, so its tunnel sockets,
  Git config and skill staging are per session and two sessions on one machine
  cannot replace each other's endpoints.
- **A unix socket, never TCP.** The shim proves itself to whoever dials it and
  authenticates nobody
  ([cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) §3). A pod's network
  policy or a VM's guest loopback decides who can dial there; on a host, a
  loopback port is reachable by every local user and by a sandboxed agent on the
  same machine. `AC_SHIM_SOCKET` makes the shim listen on
  `<runtimeRoot>/shim.sock` and nowhere else.
- **Identity on stdin**, as for the VM, and a workspace root
  `<daemonRoot>/sessions/<leaf>` with `workspace`, `repos` and `home` created
  `0700`. The shim's HOME is that `home`; of the daemon's environment it inherits
  only `PATH`, `LANG`, `LC_ALL` and `TZ`, so a provider key in the daemon's
  environment does not reach a runtime through the pod fill-ins.
- **No complete environment.** The holder that drives a host shim may be another
  machine, whose environment describes that machine. The shim therefore fills
  HOME and the other machine facts itself, exactly as a pod does.
- **Its own process group.** Stop signals the group, the shim ends the runtimes
  it started before exiting (no pod or VM teardown follows on a host), a kill
  follows past the deadline, and the runtime root is removed. The workspace stays.
- **A marked-process sweep behind it.** Each runtime leads a process group of
  its own, exactly as in a pod, so the group signal reaches only the shim; a shim
  that crashes or is killed ends nothing. The launcher therefore mints a random
  per-shim mark (not the identity token), the shim receives it as
  `AC_SHIM_RUNTIME_MARK`, and the ACP runner copies it into every runtime's
  environment in both environment modes. Pods and VMs set no mark and are
  unchanged. Whenever the shim has exited — a stop, a crash, a failed start — and
  before the runtime root is removed, the launcher reads `/proc/<pid>/environ` of
  this user's processes and kills each one that carries exactly that mark, by
  group when it leads one. The mark is verified at kill time, so a recycled pid is
  never signalled. The sweep exists for crashes, not for containment: a process
  that clears its environment and re-parents escapes it, which is the limit the
  daemon's own unsandboxed local launch already has (architecture.md §9.1).
- **It ends with its daemon.** A `host` session's process tree ends with the
  daemon (session-executors.md §9), and a daemon that is killed, runs out of
  memory or crashes stops nothing itself. The launcher therefore hands the shim
  one extra descriptor, named by `AC_SHIM_PARENT_FD`, whose other end it holds
  and never writes. The kernel closes that end when the daemon goes, however it
  goes; the shim reads end-of-file as that event, ends its runtimes as it does on
  a stop, sweeps its own mark because no launcher is left to do it, and exits. Its
  output went to that daemon too, so a host shim ignores write errors on it: a
  log line that fails must not end the shim before its runtimes. It is an event,
  not a poll, and the identity on stdin is read as before. The shim watches only
  when it listens on `AC_SHIM_SOCKET`; pods and VMs are unchanged.
- **A restart finishes what is left.** The launcher writes the mark to
  `<runtimeRoot>/mark` before it starts the shim, so there is no moment at which
  a marked process exists that a later daemon life cannot find; the facet's
  per-session record is written before the launch and would have to be rewritten
  after it. When the executor facet starts, and before any shim start it
  serializes, `sweepStaleHostShims` takes every runtime root under
  `<daemonRoot>/hs` that no live shim of this process owns, sweeps the mark it
  names — an earlier life's shim carries it too — and removes the root. Only a
  value shaped like a mark is looked for, and the sweep still matches it exactly
  in `/proc/<pid>/environ` at kill time. A `prepare` therefore never starts a
  second shim over a session directory an earlier life's shim still runs in.
- **Helpers from the daemon's installation.** `AC_SHIM_HELPER_ROOT` is the
  directory that holds `shim/index.js`, which resolves the MCP bridge, the
  merge-when-ready watcher and the `gh` token entry from the daemon's own bundle.
  The git-credential wrapper, the `gh` wrapper directory and the DeepSeek preset
  have no counterpart in an installation; the launcher reports them in
  `missingHelpers` rather than naming a path that is not there.

The launcher returns the socket path, the runtime root, the helper root, the
workspace root, the identity token, the missing helpers, an exit promise and
`stop`. The daemon-side authors of sandbox paths (`sandboxGitCredentialTarget`,
`buildSandboxMcpServers`) accept that runtime root, so the git-credential socket
variable, the Git config location and `AC_MCP_ENDPOINT` move with it; the default
is the image's layout.

`effectiveStrategies` (`execution/strategies.ts`) is the effective strategy
table: `host` and `microsandbox`, each available or unavailable with a reason.
`microsandbox` reads the probe behind `sandboxUnavailable`. The executor facet
reports its own reading of the table at registration.

### Sharing a machine with its group

`sandbox.share` switches on the executor facet
([session-executors.md](session-executors.md) §3, §6, §7, §10): this daemon hosts
`session`-isolated sessions for the other members of its daemon group. It is the
**machine owner's** consent, so it lives in this machine's config file, is read
once at start, and is not among the keys `config/push` may set. Off, which is the
default, the daemon is exactly what it was: no listener, no executor facts at
registration, no `hostedSessions` on the heartbeat, and a relayed
`executor/prepare` answered `facet_off`. The code is `execution/executor-facet.ts`
and `execution/executor-pipe.ts`; `daemon.ts` only wires it.

```json
{ "sandbox": { "share": true } }
```

**What it lends.** CPU and disk, and — the part that is easy to miss — this
machine's **runtime sign-in**: a session placed here runs under whatever runtime
login or API-key configuration this machine has. Each launch that starts the shim
seeds the session's `home` from it with the local confined tier's own preparers
(`prepareRuntimeHome`, `prepareSharedRuntimeCredentials`), for every runtime the
machine admits, because a `prepare` names no runtime: a shared login is linked to
the machine's own file, other runtimes' small config and credential files are
copied once, and files already in the session's `home` always win. Provider
credentials and agent secrets still come from the session's holder, over the
encrypted pipe. One gap is open: a preparer that answers with an environment
variable rather than a file in HOME (the Claude secure-storage directory) has no
channel to a `host` runtime yet, so that sign-in is not usable on an executor
until one exists.

**When the facet is on.** Only when `share` is true, the effective strategy table
has an available entry, and the listener is bound. This version prepares the
`host` strategy alone, so the facet is on only on Linux, and it reports
`microsandbox` as unavailable to holders until it can prepare one. A machine that
shares but can run no strategy, or cannot bind, starts with the facet dark and
logs why.

**What it opens.** One TCP listener on every interface, on an ephemeral port that
registration publishes as `capabilities.executor.endpoint`. Nothing fixes the port
because nothing needs to know it in advance; the cost is that a host firewall
filtering inbound LAN traffic has no fixed port to allow. The published address is
the local address the Control Plane connection leaves from, which on a LAN is the
interface the machine's peers reach it on; a multi-homed machine where that is
wrong has no override yet. On that port:

- TLS 1.3 with a pre-shared key and no certificate, the suite pinned to
  `TLS_AES_128_GCM_SHA256` on both ends (a callback-supplied key is bound to
  SHA-256, so a peer that prefers another suite fails instead of falling back).
  The PSK identity is the session's leaf. The key is 32 random bytes, minted per
  launch, held in memory only, returned once in the `prepare` reply the Control
  Plane relays, and never logged or written to disk.
- Nothing is served before a handshake succeeds under the key of an environment
  that is live on this machine. An unknown identity is answered with a key nobody
  holds, so it fails exactly as a wrong key does and the listener does not reveal
  which sessions it hosts. A handshake has ten seconds; the sockets waiting for one
  are capped at twice the session capacity (at least eight) and one more is dropped
  unread; refusals are logged as a count once a minute, never as an identity, an
  address or a key.
- After the handshake the socket is piped byte for byte to that session's shim
  unix socket, and the facet parses nothing. A `prepare` can therefore only arrive
  on the Control Plane connection. One pipe per environment: a newly admitted dial
  closes the one before it.

**Preparing an environment.** A relayed `executor/prepare` reserves a slot against
`limits.maxConcurrentSessions` — counting preparations in flight and this machine's
own isolated sessions, and refusing only a `prepare`, never the machine's own
births — and answers `full` with the live count when it cannot. It then applies the
launch's binding generation, the highest of which is kept on disk beside the
environment (`<daemonRoot>/sessions/<leaf>.json`, written durably before anything
else happens):

- _The generation already applied_ joins the preparation in flight or returns the
  same reply — the same key, nothing rotated, no pipe closed. Once that launch is
  gone (the environment stopped for idleness, its shim exited, or the daemon
  restarted) the answer is `launch_retired`, never a second key.
- _A higher generation_ is a new launch: `<daemonRoot>/sessions/<leaf>/{workspace,repos,home}`
  is created or attached, the shim is started if it is not running, a fresh key is
  minted, and the pipe admitted under the old key is closed. Environment starts are
  serialized, as VM starts are.
- _A lower generation_ is `stale_generation` and changes nothing.

An environment is bound to the agent it was created for: a `prepare` that names
another agent is refused, because the Control Plane vouched only for the agent the
request names. `microsandbox` is `strategy_unavailable`, and a draining daemon
answers `draining`.

**Idle stop.** An environment with no admitted pipe for sixty seconds — two of the
holder dialer's capped reconnect delays, so a blip it is still retrying through is
not read as idle — has its shim stopped. Its slot is freed, its key and cached
reply are dropped, and its directory and applied generation stay.

**Orphan reconcile.** Every ten minutes the facet sweeps its on-disk inventory,
which is labelled by agent id and session leaf and nothing else, against the two
authorities the pool's reconciler uses: the Control Plane's `agent/exists` and the
**shared** data-plane store's session rows. It discards an environment whose agent
is gone, whose session key the store no longer lists, or whose row names another
executor — only when it is older than ten minutes, has no live shim and no admitted
pipe, and was not re-prepared since the lookups. It never judges dirtiness, and it
retains everything when either authority cannot answer. A daemon that mounts no
shared data plane can answer for no session, so it retains every environment and
says so at start; the shared store is a prerequisite of sharing
([daemon-groups.md](daemon-groups.md) §5). The sweep also runs with `share` off, so
what an earlier run left is still collected.

**Shutdown.** Hosted environments join the daemon's existing shutdown drain and
add no phase: once it starts, `prepare` is refused, environments with a connected
holder get `limits.shutdownDrainMs`, and then every shim is stopped (which runs its
marked-process sweep). A machine hosting nothing spends nothing. Directories stay;
keys die with the process, so a holder's next launch sends a new `prepare`.

**Withdrawing consent.** `share` is read at start. Switched off, the machine is
nobody's candidate, creates nothing and opens no port, so an environment that
already exists here cannot be attached either until `share` is on again; it stays
on disk until its session retires.

## 4. Delivery and acceptance

Delivery is split into independently reviewable steps:

1. **Implemented — SRT configuration and mounts:** add `sandbox.backend: "srt"`
   and `sandbox.mounts`, remove legacy security roots, and apply mount permissions
   to SRT and native tools. Existing configuration is converted manually. Preserve
   the pool and unsandboxed-agent paths.
2. **Implemented, workload validation pending — minimal microsandbox execution:**
   explicit image and resources, Linux VM boot/runtime-table/stop-start checks,
   shim-backed ACP streams and helper tunnels, SDK-backed guest Git, shared host
   filesystem paths, and retained environment lifecycle. Keep upstream public-only
   networking and SRT as default.
3. **Implemented — release image and Docker:** bundle the shared release image
   reference with explicit override support, and provide Docker/Compose tools
   and manual startup permissions in the image. Verify actual workloads and
   lifecycle below.
4. **Pending — network and workload validation:** verify public egress, denied
   host/private/peer connectivity, and concurrent sessions using the same guest
   ports. Complete native-tool, Docker, and lifecycle checks; fix demonstrated
   gaps without adding network modes or host port publication.
5. **Pending — performance measurement:** run real projects at increasing session
   counts. Change the default only after compatibility and resource measurements
   support it.

Implementation status above does not establish successful end-to-end daemon
execution. Pull requests that reach this path boot one real VM in CI
(`packages/daemon/scripts/smoke-microsandbox-runtime.mts`): the startup probe, the
image's ACP runtime answering `initialize` through the shim on a cold, a running
and a resumed VM, the runtime's user, directory and environment, and both helper
endpoints reached from inside the guest. It submits no model turn and checks no
network policy. The current VM slice still needs complete-session and lifecycle
evidence, with the following acceptance checks:

| Area                       | Required evidence                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing behavior          | Default SRT, required/optional sandbox policy, and Kubernetes execution remain usable. No-KVM behavior is explicit.                                                                                                                                                         |
| Mounts                     | SRT accepts equal normalized paths and rejects remapping; read-only is the default and writable mounts reach native tools. Verify nested/duplicate entries, VM guest targets and mount flags, package-cache access, and host-data preservation on retirement.               |
| Image and complete session | Explicit image preparation, ACP initialize/new/load, output, cancellation, cleanup, and a real native-tool turn succeed. Verify the release image default, explicit overrides, and metadata-free development builds.                                                        |
| Docker                     | Compose and Testcontainers work, including DNS, random ports, bind mounts, build cache, and cleanup helpers. Two sessions use the same internal ports.                                                                                                                      |
| Networking                 | Verify public DNS/Git/npm egress, denied host/private/peer connections across applicable IPv4/IPv6 addresses and aliases, and successful same-port listeners in two isolated sessions. Guest loopback and Docker networking must remain usable.                             |
| Lifecycle                  | Idle stop preserves work/cache; start re-establishes ACP; daemon restart fences old hosts; dirty/unpushed work prevents destructive retirement.                                                                                                                             |
| Performance                | Measure cold image preparation, warm disk clone, stopped-session restart, ACP-ready latency, and Git/install/build duration. At 1/10/20 sessions, record whole-environment memory, peaks, disk growth, CPU limits, and cleanup. Record reflink versus sparse-copy behavior. |

Keep plain Podman/crun and Docker Sandboxes as labeled comparison arms where
useful. Compare actual agent sessions before deciding latency or density targets.
