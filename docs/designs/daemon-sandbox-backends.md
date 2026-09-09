# Daemon Sandbox Backends

**Status: Partially implemented.** SRT remains the default. The opt-in Linux
microsandbox backend implements release image defaults and explicit overrides,
resource configuration, guest execution, host mounts, retained-disk stop/start,
and Docker/Compose tooling that agents can start inside each VM when needed.
Networking has one fixed requirement for isolated sessions: public internet
access, with no access to other session VMs or host/private networks. End-to-end
network and workload validation remains pending.

The VM implementation uses the existing workspace modes and lifecycle.

This extends [daemon configuration and lifecycle](daemon-detailed-design.md) and
uses the existing [execution-driver seam](cluster-spawn-and-shim.md#1-why-a-seam-at-all).
[Workspace ownership](git-workspace-model.md) remains a separate concern. The
Control Plane does not carry ACP or provider request traffic.

## 1. Configuration and ownership

The daemon-owned `sandbox` object in `~/.agentconnect/config.json` defaults to
`{ "backend": "srt", "mounts": [] }`. The minimal configuration is:

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
    "mounts": [
      {
        "source": "/srv/agent-cache/pnpm",
        "target": "/cache/pnpm",
        "readOnly": false
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

| Setting                        | Meaning and delivery status                                                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `sandbox.backend`              | Implemented: `srt` is the default; `microsandbox` selects the Linux VM implementation for sandboxed launches.                                                                                                                                                                        |
| `security.requireSandbox`      | Existing behavior: require sandboxed execution for every agent, using the selected backend.                                                                                                                                                                                          |
| Agent **Run in sandbox**       | Keeps its current role when the daemon does not require sandboxing. Selecting a backend does not change the trust choice for unsandboxed agents.                                                                                                                                     |
| `sandbox.microsandbox.image`   | Implemented: optional, non-empty OCI override. Release builds default to their bundled shared-image reference; development builds require an explicit image. No Kubernetes image lookup is used.                                                                                     |
| `cpus`, `memoryMiB`, `diskGiB` | Per-VM CPU allocation, memory limit, and capacity of each writable disk; defaults are `2`, `2048`, and `10`. New VMs have a root upper disk and a Docker data disk, each capped by `diskGiB`. Both are sparse; host capacity planning remains the operator's responsibility.         |
| `sandbox.mounts`               | Implemented: operator-owned filesystem mappings, default `[]`, with `source`, `target`, and `readOnly` (default `true`). SRT requires equal normalized host paths; microsandbox accepts absolute guest targets. Workspace, HOME, and runtime state remain automatically provisioned. |

### Shared mounts and manual conversion

`sandbox.mounts` replaces `security.sandboxReadRoots` and
`security.sandboxWriteRoots`. The old fields are removed; the daemon does not
automatically migrate or retain a compatibility path for them. Convert existing
configuration manually using this table, then remove the old fields:

| Previous entry                                          | Entry to add to `sandbox.mounts`                                                              |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `security.sandboxReadRoots: ["/opt/toolchain"]`         | `{ "source": "/opt/toolchain", "target": "/opt/toolchain", "readOnly": true }`                |
| `security.sandboxWriteRoots: ["/srv/agent-cache/pnpm"]` | `{ "source": "/srv/agent-cache/pnpm", "target": "/srv/agent-cache/pnpm", "readOnly": false }` |

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
the VM's automatically provisioned paths are rejected in either direction.

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
    "mounts": [
      {
        "source": "/srv/agent-cache/pnpm",
        "target": "/srv/agent-cache/pnpm",
        "readOnly": false
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

Configuration is machine-local desired state. Agent configuration can select a
runtime and request sandboxing, but cannot supply backend executables, images,
or mounts. Future backends add a typed configuration member and an implementation at the existing execution-plane
composition point. Do not add speculative backend branches throughout ACP.

### VM availability and configuration changes

The current microsandbox integration supports Linux with usable KVM. Startup
installs the pinned `microsandbox@0.6.17` package through the daemon's RuntimeStore,
preserving its native platform package, and gives it a daemon-owned state home.
It prepares the image, boots a temporary VM, validates the runtime table, and
checks stop/start before admitting VM launches. Checking `/dev/kvm` alone would
not establish availability. With `requireSandbox=true`, an unavailable backend
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
VM. A retained VM keeps its original configuration. Restarting the daemon does
not upgrade it or migrate its disk; configuration changes require an explicit
retirement/recreation or a future data-migration operation. Image digest
resolution and upgrade tooling remain proposed.

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

`MicrosandboxManager` supplies the existing `SpawnDriver` contract. ACP uses the
SDK's bidirectional byte streams with persistent stdin and process exit/signals;
stop sends a termination signal and escalates to a kill when needed. Native tools
run inside the existing harness and VM. There is no external CLI invocation for
each tool call.

Daemon-owned Git operations for mounted workspaces execute Git through the SDK,
sharing command policy and result parsing with the pool runner. A small shell
checks physical guest paths and then replaces itself with Git; no Node dispatcher
starts per command. Canonical clone preparation outside an exposed
workspace remains host-side. Workspace reads and attachment access use host-backed
directories mounted at the same guest paths. Once a VM exists, workspace mutations
run a small Python operation in the guest: renaming a staged clone on the host
can leave the VM's cached directory view stale, while a guest rename is immediately
visible to guest Git. Initial directory preparation remains local before VM boot.
This does not require a second filesystem copy or a Kubernetes tunnel. Command
lookup and generated launch files use the guest execution/file APIs. Filesystem
mutations retain descriptor-anchored paths, no-follow checks, and atomic writes;
write content streams over stdin and its complete byte count is checked before
publication. A Python process bridges MCP and Git credential sockets over vsock;
the image's Kubernetes
entrypoint and control connection are not started.

VM identity follows workspace placement. Shared mode reuses the agent's
`agent/agent` environment. An isolated session uses its own `agent/session-…`
environment, writable runtime HOME, disk, and guest network namespace. Existing
shared-workspace versus session-workspace choices still govern repository data;
separate VMs do not make a deliberately shared host mount private. Linked-worktree
Git metadata, secondary repositories, and file attachments keep consistent guest
paths. This change does not redesign Git storage.

### Current image contract and VM storage

The resolved OCI image must contain Node at
`/usr/local/bin/node`, `/usr/bin/git`, Python 3.11+ for filesystem operations and socket bridges, the declared runtime tools,
and `/opt/agentconnect/runtime/k8s-runtimes.json`. The daemon's full image also
includes `bubblewrap` and `socat` for the native Claude sandbox.
Startup reads and validates that table in a real VM; individual
runtime execution and full-session compatibility still need workload checks.

The SDK's `create()` does not execute OCI ENTRYPOINT/CMD automatically. The manager
explicitly starts the Python socket bridge and requested runtime commands.
The pool's Kubernetes security context, volumes, and resource limits do not
travel inside its OCI image. In particular, the pool's shim startup and UID/HOME
configuration are not a substitute for the local VM's launch settings. See the
upstream [execution semantics](https://docs.microsandbox.dev/sandboxes/commands).

Each streaming execution owns an SDK `AgentClient` connection. The daemon uses
the pinned SDK's exec protocol and explicitly closes that client before reporting
process completion or releasing the VM's active-execution count. Closing stdin
sends EOF; it does not close a process that is still running. This avoids relying
on garbage collection of the SDK's high-level exec handles, while retaining
independent ACP streams, cancellation, backpressure, and live output limits.
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
mounts cannot replace `/run` or `/var/lib/docker`. The Python bridge creates its private socket
directory at `/tmp/agentconnect` as the image's ordinary user; the pool keeps its
existing `/run/agentconnect` paths.

In pinned version `0.6.17`, starting a retained flat-disk VM still validates the
OCI image's VMDK cache. The manager therefore runs the official
`msb pull <image> --materialize all --quiet` before its VM probe, preparing both
image forms, and tests stop/start. Retained flat VMs continue to use their original disk. This
uses the upstream CLI and package without an upstream source patch; cold image
preparation includes the extra materialization cost.

### Release image selection and Docker

The release build bundles `dist/release.json` with a `runtimeSandboxImage` OCI
reference. It names the current release's `runtime-sandbox-full:v<version>` alias.
The image workflow creates this alias even when it reuses an older component
image. The pool continues to use the separate `runtime-sandbox` image. Both targets
share a base stage with the toolchain, browser, ACP runtimes, and shim. Additional
self-hosted runtimes belong in the full target. The pool provides Claude Code,
Codex, and DeepSeek Harness. The full image additionally installs Antigravity,
Cline, Devin, GitHub Copilot, Grok Build, Oh My Pi, OpenCode, pi, Qwen Code,
Qoder CLI, and Qoder CN CLI. The legacy `qoder` catalog ID uses the same Qoder
CLI executable as `qoder-cli`. pi includes both its ACP adapter and the underlying
CLI. Packages are version-pinned; standalone downloads also pin their SHA-256.

Each image bakes an explicit runtime roster and generates its own runtime table
by probing the installed executables as the ordinary runtime user, without
provider credentials. Missing executables fail the build instead of silently
reducing the roster. Installing a runtime does not establish a host login or
make it a discovery candidate; credential discovery still governs that list.
General development toolchain expansion can follow independently.
The daemon package is published before image finalization; the matching
image workflow must complete before this default can be pulled. A missing image
fails preflight rather than selecting another version.
Runtime-image input changes also trigger daemon package publication so its
bundled default follows the updated image.
The release images are currently Linux amd64; an arm64 daemon must configure
a compatible image explicitly. The full image's Antigravity binary requires
AVX in the guest CPU; amd64 emulation without AVX cannot run that runtime.

An explicit daemon image overrides this metadata. Development builds remove
release metadata and require an explicit image; they do not derive a default
from the development package version. Upgrading to a different default image
reference remains a configuration change under the persisted-VM checks above.
Pin an explicit image to retain the same reference across daemon upgrades.

The full image contains `bubblewrap` and `socat` for native Claude credential
shields, plus pinned Docker Engine, CLI, containerd, Buildx, and Compose packages.
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
  are still running. It retains their disks and replaces the socket bridge and ACP
  processes on the next start; it does not adopt the old running processes.
- Existing bindings may retain the retired helper's exact read-only mount. Its
  file remains an inert mount source; new VMs do not mount it. VM identity and the
  full persisted configuration hash still have to match.
- Retirement uses existing dirty/unpushed-work protection before deleting a
  session's retained storage. VM removal deletes its private disk and binding;
  operator-owned host mount contents are not deleted by VM removal.

The inspected SDK does not provide general pause/resume of running process state.
Lifecycle and configuration-reuse rules are documented
[upstream](https://docs.microsandbox.dev/sandboxes/lifecycle).

## 4. Delivery and acceptance

Delivery is split into independently reviewable steps:

1. **Implemented — SRT configuration and mounts:** add `sandbox.backend: "srt"`
   and `sandbox.mounts`, remove legacy security roots, and apply mount permissions
   to SRT and native tools. Existing configuration is converted manually. Preserve
   the pool and unsandboxed-agent paths.
2. **Implemented, workload validation pending — minimal microsandbox execution:**
   explicit image and resources, Linux VM boot/runtime-table/stop-start checks,
   SDK-backed ACP streams and guest Git, shared host filesystem paths, and retained
   environment lifecycle. Keep upstream public-only networking and SRT as default.
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
execution. The current VM slice still needs complete-session and lifecycle
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
