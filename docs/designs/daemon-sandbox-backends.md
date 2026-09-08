# Daemon Sandbox Backends

**Status: Partially implemented.** SRT remains the default. The opt-in Linux
microsandbox backend implements explicit image selection, resource configuration,
guest execution, host mounts, and retained-disk stop/start. A complete real-daemon
workload remains an acceptance gate. Default release image selection, Docker,
network configuration, and port publication remain **Proposed**.

The first VM implementation uses the existing workspace modes and lifecycle.
Docker, Compose, and development networking are subsequent additions to that
execution path.

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

The current microsandbox configuration requires an explicit image. Replace the
example reference with a compatible runtime image:

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
      "image": "registry.example.com/agentconnect/runtime-sandbox:build-tag",
      "cpus": 2,
      "memoryMiB": 2048,
      "diskGiB": 10
    }
  }
}
```

The resource values shown are the defaults, not measured minimums or capacity
recommendations. All three are positive integers bounded by the SDK's supported
numeric ranges. The VM configuration is strict: `docker` and `network` fields
are not accepted yet.

| Setting                        | Meaning and delivery status                                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.backend`              | Implemented: `srt` is the default; `microsandbox` selects the Linux VM implementation for sandboxed launches.                                                                                                                                                                                                                         |
| `security.requireSandbox`      | Existing behavior: require sandboxed execution for every agent, using the selected backend.                                                                                                                                                                                                                                           |
| Agent **Run in sandbox**       | Keeps its current role when the daemon does not require sandboxing. Selecting a backend does not change the trust choice for unsandboxed agents.                                                                                                                                                                                      |
| `sandbox.microsandbox.image`   | Implemented: required, non-empty OCI reference when selecting microsandbox. No bundled release default or Kubernetes image lookup is used.                                                                                                                                                                                            |
| `cpus`, `memoryMiB`, `diskGiB` | Implemented: per-VM CPU allocation, memory limit, and disk capacity; defaults are `2`, `2048`, and `10`. Host capacity planning remains the operator's responsibility.                                                                                                                                                                |
| `docker`                       | Proposed: start an independent Docker daemon inside each VM. Requires Docker tools in the selected image; never means mounting the host Docker socket. Default false until the Docker-enabled shared image and workload checks are delivered.                                                                                         |
| `sandbox.mounts`               | Implemented: operator-owned filesystem mappings, default `[]`, with `source`, `target`, and `readOnly` (default `true`). SRT requires equal normalized host paths; microsandbox accepts absolute guest targets. Workspace, HOME, and runtime state remain automatically provisioned.                                                  |
| `network.access`               | Proposed: `development` allows public, private-network, and host connectivity subject to mandatory control/admin exclusions; `public` allows public egress and required daemon endpoints; `none` disables external egress. The proposed default is `development`; the current implementation retains upstream public-only networking. |
| `network.ports`                | Proposed: guest service ports exposed through daemon-assigned host ports. `host: 0` requests an available port. The backend binds and verifies the mapping; retry allocation conflicts and release mappings on teardown.                                                                                                              |
| `network.outboundProxy`        | Proposed: optional host-side SOCKS URL for microsandbox's outbound transport.                                                                                                                                                                                                                                                         |

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
retirement/recreation or a future data-migration operation. Resolved-image metadata
and upgrade tooling remain proposed.

Kubernetes mode retains `K8sDriver`, its resource configuration, and image rollout.
An explicitly configured local microsandbox backend
with `--k8s` is rejected as conflicting configuration; an omitted/default local
backend has no effect on pool execution. Sharing an image does not mean nesting
microsandbox inside every pool pod.

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

Daemon-owned Git operations for mounted workspaces use the existing shim Git
handler through SDK execution. Canonical clone preparation outside an exposed
workspace remains host-side. Workspace reads and attachment access use host-backed
directories mounted at the same guest paths. Once a VM exists, workspace mutations
use the existing guest filesystem handler: renaming a staged clone on the host
can leave the VM's cached directory view stale, while a guest rename is immediately
visible to guest Git. Initial directory preparation remains local before VM boot.
This does not require a second filesystem copy or a Kubernetes tunnel. Command
lookup and generated launch files use the guest execution/file APIs. Small
daemon tool channels use the guest helper and vsock; the image's Kubernetes
entrypoint and control connection are not started.

VM identity follows workspace placement. Shared mode reuses the agent's
`agent/agent` environment. An isolated session uses its own `agent/session-…`
environment, writable runtime HOME, disk, and guest network namespace. Existing
shared-workspace versus session-workspace choices still govern repository data;
separate VMs do not make a deliberately shared host mount private. Linked-worktree
Git metadata, secondary repositories, and file attachments keep consistent guest
paths. This change does not redesign Git storage.

### Current image contract and flat disks

An explicit OCI image is required. The runtime image must contain Node at
`/usr/local/bin/node`, Python 3 for the guest helper, the declared runtime tools,
and `/opt/agentconnect/runtime/k8s-runtimes.json`. The existing pool image contains
these components. Startup reads and validates that table in a real VM; individual
runtime execution and full-session compatibility still need workload checks.

The SDK's `create()` does not execute OCI ENTRYPOINT/CMD automatically. The manager
explicitly starts the bundled local guest helper and requested runtime commands.
The pool's Kubernetes security context, volumes, and resource limits do not
travel inside its OCI image. In particular, the pool's shim startup and UID/HOME
configuration are not a substitute for the local VM's launch settings. See the
upstream [execution semantics](https://docs.microsandbox.dev/sandboxes/commands).

The first implementation uses private flat ext4 root disks and explicit
host-bound workspace/cache mounts. The clone strategy is `auto`: preparation can
reuse a base image, while each private disk clone can fall back from reflink to
sparse copying on the host filesystem. Measure both image preparation and cloning.
Flat disks do not provide native snapshots or rootfs patches; generated launch
files are written after boot through the guest file API.

In pinned version `0.6.17`, starting a retained flat-disk VM still validates the
OCI image's VMDK cache. The manager therefore runs the official
`msb pull <image> --materialize all --quiet` before its VM probe, preparing both
image forms, and tests stop/start. The VM continues to use its flat disk. This
uses the upstream CLI and package without an upstream source patch; cold image
preparation includes the extra materialization cost.

### Proposed release image selection and Docker

Add release-generated metadata bundled with the daemon containing the published
`runtimeSandboxImage` OCI reference. Generate it from the release workflow's
component-version output, so local daemons use the same artifact as the pool
without querying a cluster. This is new metadata: today's `poolRuntimeImage()`
resolves the Kubernetes SandboxTemplate, and is not a local default resolver.
An explicit daemon image would override this metadata; builds without metadata
would still require an explicit image. This default resolver is not implemented.
The current shared image does not include a configured Docker daemon.

For `docker=true`, extend that shared image with Docker Engine and the Compose
plugin, and explicitly start dockerd inside the VM with guest privileges before
launching the harness. Configure the harness user to reach the guest Docker
socket. Keep Docker opt-in for sessions that do not need its resource cost. A
custom image must satisfy the same runtime/tool contract or fail its admission
probe; do not silently install missing tools on every session start.

Docker data and build caches would use the retained flat disk. Docker Engine,
Compose, and Testcontainers compatibility remain separate acceptance work; the
current backend neither starts dockerd nor exposes a `docker` setting.

### Current network and proposed development/preview experience

The current implementation selects upstream's `single-tenant` deployment profile
and leaves its default public-only network policy unchanged: public egress and
gateway DNS are available; private, host, loopback, link-local, and metadata
destinations are denied. There are no published ports and no daemon network or
outbound-proxy settings yet. The following development and preview behavior is
**Proposed**, not enabled by selecting microsandbox today.

Development networking should let package managers, Git, databases, and web
servers behave normally. The proposed profile admits the connectivity described
in section 1 without per-domain approval prompts. Translate upstream's public-only
rules deliberately; they are not the proposed development profile. The stricter
multi-tenant profile is not selected here: it disables host access and port
publication needed by this future local workflow.

Before broad development rules, deny the daemon's registered control/admin
listeners and deployment-configured management endpoints, including the local
Setup Server. Match their actual ports across the host gateway and all relevant
IPv4/IPv6 addresses; the `host` group alone does not cover every LAN alias.
Admission fails if these rules cannot be installed. Unknown host services require
operator configuration; this profile does not discover every management service.
Apply destination policy before an outbound SOCKS proxy as well.

When the runtime needs an allowed host service, guest `127.0.0.1` refers to the
guest. Use `host.microsandbox.internal` and configure the destination listener and
network rules for that route. SRT retains its existing network integration. See
[microsandbox networking](https://docs.microsandbox.dev/networking/overview) and
[its outbound proxy](https://docs.microsandbox.dev/networking/outbound-proxy).

Two sessions could both use guest ports 3000 and 5432. The daemon would allocate separate
host listeners and report their effective mappings; the browser would get an address
for the selected session. Remote-daemon preview needs a separately provided
tunnel or preview route: returning that machine's localhost URL is not
a working remote preview. Live preview bytes must not be added to the CP control
WebSocket.

Native microsandbox port mappings are creation-time configuration in the inspected
API; its modify interface does not expose changing ports/network. First support
declared ports. Automatic discovery and opening arbitrary ports in a running
session requires a daemon-owned guest forwarding channel, including WebSocket
upgrade for development servers, and is a later deliverable. Do not claim the SDK
already supplies that experience.

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
  are still running. It retains their disks and replaces the guest helper and ACP
  processes on the next start; it does not adopt the old running processes.
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
3. **Proposed — image and development features:** add release image metadata,
   Docker/Compose support, and configured networking/declared ports with admin
   exclusions. These configuration fields are not part of the current schema.
4. **Proposed — developer experience and measurement:** run real projects and add
   dynamic preview forwarding separately. Change the default only after compatibility
   and resource measurements support it.

Implementation status above does not establish successful end-to-end daemon
execution. The current VM slice still needs complete-session and lifecycle
evidence; proposed features have their own subsequent acceptance gates:

| Area                       | Required evidence                                                                                                                                                                                                                                                           |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing behavior          | Default SRT, required/optional sandbox policy, and Kubernetes execution remain usable. No-KVM behavior is explicit.                                                                                                                                                         |
| Mounts                     | SRT accepts equal normalized paths and rejects remapping; read-only is the default and writable mounts reach native tools. Verify nested/duplicate entries, VM guest targets and mount flags, package-cache access, and host-data preservation on retirement.               |
| Image and complete session | Explicit image preparation, ACP initialize/new/load, output, cancellation, cleanup, and a real native-tool turn succeed. Proposed release image defaults need separate verification when implemented.                                                                       |
| Docker — Proposed          | Compose and Testcontainers work, including DNS, random ports, bind mounts, build cache, and cleanup helpers. Two sessions use the same internal ports.                                                                                                                      |
| Networking                 | Verify current public Git/npm egress and denied host/private destinations. Proposed profiles additionally need an allowed host database, preview/WebSockets, and control/admin exclusions across gateway/address aliases, including with SOCKS.                             |
| Lifecycle                  | Idle stop preserves work/cache; start re-establishes ACP; daemon restart fences old hosts; dirty/unpushed work prevents destructive retirement.                                                                                                                             |
| Performance                | Measure cold image preparation, warm disk clone, stopped-session restart, ACP-ready latency, and Git/install/build duration. At 1/10/20 sessions, record whole-environment memory, peaks, disk growth, CPU limits, and cleanup. Record reflink versus sparse-copy behavior. |

Keep plain Podman/crun and Docker Sandboxes as labeled comparison arms where
useful. Compare actual agent sessions before deciding latency or density targets.
