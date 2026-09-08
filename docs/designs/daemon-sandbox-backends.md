# Daemon Sandbox Backends

**Status: Proposed.** This document defines configurable self-hosted sandbox
backends; it does not describe shipped configuration.

The daemon continues to default to SRT. Operators can select microsandbox and
configure its image, resources, mounts, and networking. The initial priority is a
usable development environment: independent sessions, ordinary network access,
Docker and Compose, and predictable stop/start behavior.

This extends [daemon configuration and lifecycle](daemon-detailed-design.md) and
uses the existing [execution-driver seam](cluster-spawn-and-shim.md#1-why-a-seam-at-all).
[Workspace ownership](git-workspace-model.md) remains a separate concern. The
Control Plane does not carry ACP or provider request traffic.

## 1. Configuration and ownership

Add a daemon-owned `sandbox` object to `~/.agentconnect/config.json`. The minimal
configuration preserves today's backend:

```json
{
  "sandbox": {
    "backend": "srt"
  }
}
```

An illustrative microsandbox configuration is:

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
      "cpus": 4,
      "memoryMiB": 4096,
      "diskGiB": 32,
      "docker": true,
      "network": {
        "access": "development",
        "ports": [
          {
            "guest": 3000,
            "host": 0
          }
        ]
      }
    }
  }
}
```

Values above are example resource allocations, not measured minimums. New fields
are strictly validated; they are not an untyped pass-through to a vendor SDK.

| Setting                        | Proposed meaning                                                                                                                                                                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sandbox.backend`              | `srt` by default; `microsandbox` selects the VM implementation for sandboxed launches.                                                                                                                                                                                                                                      |
| `security.requireSandbox`      | Keeps its current role: require sandboxed execution for every agent. It checks the selected backend rather than hardcoding SRT.                                                                                                                                                                                             |
| Agent **Run in sandbox**       | Keeps its current role when the daemon does not require sandboxing. Selecting a backend does not change the trust choice for unsandboxed agents.                                                                                                                                                                            |
| `sandbox.microsandbox.image`   | Optional OCI reference. Omitted uses the runtime image reference in new release-generated metadata bundled with the daemon. An explicit image wins; a development build without metadata requires one. Record the resolved digest.                                                                                          |
| `cpus`, `memoryMiB`, `diskGiB` | Per-session CPU allocation, memory limit, and disk capacity. Validate against backend support and daemon capacity.                                                                                                                                                                                                          |
| `docker`                       | Start an independent Docker daemon inside each VM. Requires Docker tools in the selected image; never means mounting the host Docker socket. Default false until the Docker-enabled shared image and workload checks are delivered.                                                                                         |
| `sandbox.mounts`               | Shared operator-owned filesystem mappings for both backends; defaults to `[]`. Each entry has `source`, `target`, and `readOnly` (default `true`). SRT requires the same host path on both sides; microsandbox supports a different guest target. Session workspace, HOME, and runtime state are provisioned automatically. |
| `network.access`               | `development` allows public, private-network, and host connectivity subject to mandatory control/admin exclusions; `public` allows public egress and required daemon endpoints; `none` disables external egress. Default `development`. Remote model use requires connectivity.                                             |
| `network.ports`                | Guest service ports exposed through daemon-assigned host ports. `host: 0` requests an available port. The backend binds and verifies the mapping; retry allocation conflicts and release mappings on teardown.                                                                                                              |
| `network.outboundProxy`        | Optional host-side SOCKS URL for microsandbox's outbound transport.                                                                                                                                                                                                                                                         |

### Shared mounts and configuration migration

Move operator-owned paths out of `security.sandboxReadRoots` and
`security.sandboxWriteRoots` into `sandbox.mounts`. Both backend adapters consume
this one normalized list; mounts are not nested under `sandbox.microsandbox`.

| Previous entry                                          | Migrated entry                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `security.sandboxReadRoots: ["/opt/toolchain"]`         | `{ "source": "/opt/toolchain", "target": "/opt/toolchain", "readOnly": true }`                |
| `security.sandboxWriteRoots: ["/srv/agent-cache/pnpm"]` | `{ "source": "/srv/agent-cache/pnpm", "target": "/srv/agent-cache/pnpm", "readOnly": false }` |

Convert existing configuration to the new list and remove the two legacy fields
when migration succeeds. Expand host `~`, require existing absolute sources,
and resolve symlinks using the current root normalization. Coalesce duplicate
legacy paths; a path previously declared writable remains writable. Runtime
launch preparation consumes only the migrated list, not two parallel policies.
Existing protected-path checks remain in effect.
After normalization, reject different sources mapped to the same target; merge
permissions only for entries with the same source and target.

Access remains additive: a read-only entry adds read access; it does not revoke
write access already granted by a workspace or writable mount. Normalize overlaps
to the same effective access for both backends, and retain writable children of
read-only parents rather than collapsing all nested paths into one entry.

SRT uses the configured paths at their host locations: its filesystem rules do
not rename a host path inside the sandbox. Normalize `source` and `target` as
host paths and require them to be equal. A mapping such as
`/srv/agent-cache/pnpm` to `/cache/pnpm` fails validation for SRT. The same mapping
is valid for microsandbox, where `target` is an absolute guest path. Migrated
same-path entries therefore work with either backend; operators can choose new
guest targets when switching to microsandbox.

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
or mounts. Future backends add a typed
configuration member and an implementation at the existing execution-plane
composition point. Do not add speculative backend branches throughout ACP.

### Availability and changes

Probe the selected backend with an actual launch/command, not only binary
detection. On Linux, microsandbox requires usable KVM; checking `/dev/kvm` alone
does not prove a VM can start. With `requireSandbox=true`, an unavailable backend
refuses startup. Otherwise the daemon can still serve trusted unsandboxed agents,
but a requested microsandbox launch must fail explicitly. It must not silently
fall back to SRT or an ordinary host process. Existing optional-SRT fallback
semantics are unchanged by this proposal.

This release adds no new backend for Linux hosts without usable KVM. They can
keep SRT, including fail-closed startup with `security.requireSandbox=true`. The
new VM boundary requires bare metal or a VM exposing nested virtualization;
Podman/runsc with systrap remains a future no-KVM option, not a hidden fallback.

Record backend, runtime version, image digest, effective configuration hash, and
sandbox generation with the daemon-local session execution record. Settings apply
to newly created environments. A retained VM keeps its original configuration;
`connectOrCreate` is not an upgrade operation. Restarting the daemon can reload
configuration, but must not destroy an existing session to apply it. Backend or
image changes require a new environment or a separately implemented, explicit
migration of retained data. Publish only the capability/status facts needed by
the existing daemon catalog, not host paths.

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

Implement a `MicrosandboxDriver` behind `SpawnDriver`. Keep ACP's bidirectional
byte streams and stop/exit contract. Use the SDK's streaming execution channel
with persistent stdin; tools run inside the already-running harness and VM,
rather than paying a VM creation or external CLI round trip for each tool call.

The driver is only part of the integration. Compose the guest implementations of
`GitRunner`, `WorkspaceFs`/workspace placement, session retirement, and artifact
access at the same execution-plane boundary. Reuse the existing shim's operation
handlers where useful, without importing Kubernetes service-account binding into
local VM control. Command lookup, generated files, and executable hints resolve
in the guest. Merely replacing ACP spawn would leave file and Git operations
incorrectly targeting the host filesystem.

Each microsandbox session gets a distinct environment, writable runtime HOME,
disk, and network namespace. Existing shared-workspace versus session-workspace
choices still govern repository data; separate VMs do not magically make a
deliberately shared host mount private. Linked-worktree Git metadata, secondary
repositories, file attachments, and Docker bind mounts need consistent guest
paths. Do not redesign the Git storage model in this change.

### Image and Docker

Add release-generated metadata bundled with the daemon containing the published
`runtimeSandboxImage` OCI reference. Generate it from the release workflow's
component-version output, so local daemons use the same artifact as the pool
without querying a cluster. This is new metadata: today's `poolRuntimeImage()`
resolves the Kubernetes SandboxTemplate, and is not a local default resolver.
An explicit daemon image overrides the metadata; builds without metadata require
an explicit image. The current image contains runtimes and a shim, runs as UID
10001 with `HOME=/agent`, and is not yet a Docker-daemon image. Its Kubernetes
security context, volumes, and resource limits do not travel inside the OCI
image. The microsandbox backend supplies its own launch settings.

For `docker=true`, extend that shared image with Docker Engine and the Compose
plugin, and explicitly start dockerd inside the VM with guest privileges before
launching the harness. Configure the harness user to reach the guest Docker
socket. Keep Docker opt-in for sessions that do not need its resource cost. A
custom image must satisfy the same runtime/tool contract or fail its admission
probe; do not silently install missing tools on every session start.

Use flat ext4 root disks for the first microsandbox integration, including Docker
data and build caches. Host-bound workspace/cache mounts remain explicit. A
prepared base image can be reused, but the private disk clone may fall back from
reflink to sparse copying on the host filesystem. Measure both preparation and
per-session cloning. Current flat-disk support rejects rootfs patches and native
snapshots: provision generated files through the execution/file channel after
boot, and do not promise snapshot-based warm pools.

The SDK's `create()` does not execute OCI ENTRYPOINT/CMD automatically. The driver
must explicitly launch the expected shim/harness and optional dockerd. These
details follow the inspected microsandbox
[command reference](https://docs.microsandbox.dev/cli/sandbox-commands) and
[execution semantics](https://docs.microsandbox.dev/sandboxes/commands).

### Network and preview experience

Development networking should let package managers, Git, databases, and web
servers behave normally. The default local profile admits the connectivity
described in section 1; it does not present users with per-domain approval prompts.
microsandbox's default public-only rules must therefore be translated deliberately,
not mistaken for our development profile. Its stricter multi-tenant profile is
not selected here: it disables host access and port publication needed by this
local workflow.

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

Two sessions can both use guest ports 3000 and 5432. The daemon allocates separate
host listeners and reports their effective mappings; the browser gets an address
for the selected session. Remote-daemon preview needs a separately provided
authorized tunnel or preview route: returning that machine's localhost URL is not
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
- Idle reclaim waits for turns, background jobs, and active execution leases to
  finish, then stops processes/VM while retaining workspace, HOME, and Docker data.
- Start boots a new guest process environment from retained disk and re-establishes
  ACP; use runtime `session/load` when supported. It does not resume process memory,
  an old TCP connection, or an interrupted Docker build.
- Daemon restart reconciles its recorded sandbox IDs and generations, adopts only
  owned retained environments, and replaces the old ACP process before
  admitting new turns. Read-only console visits do not wake a stopped VM.
- Retirement uses existing dirty/unpushed-work protection before deleting a
  session's retained storage. VM removal also removes its private Docker cache.

The inspected SDK does not provide general pause/resume of running process state.
Lifecycle and configuration-reuse rules are documented
[upstream](https://docs.microsandbox.dev/sandboxes/lifecycle).

## 4. Delivery and acceptance

This is a design-only change. Implement in independently reviewable steps:

1. **Configuration and capability reporting:** retain SRT defaults; add the typed
   backend choice, shared mounts and legacy-root migration, real availability
   checks, release image metadata, and explicit no-KVM behavior. Preserve the pool
   and unsandboxed-agent paths.
2. **microsandbox execution:** integrate the image, disk, ACP streams, workspace
   and Git/file operations, declared ports with admin exclusions, and stop/start.
   Add the shared image's optional Docker/Compose support.
3. **Developer experience and measurement:** run real projects and add dynamic
   preview forwarding separately. Change the default only after compatibility
   and resource measurements support it.

Use a small integration matrix:

| Area                       | Required evidence                                                                                                                                                                                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Existing behavior          | Default SRT, required/optional sandbox policy, and Kubernetes execution remain usable. No-KVM behavior is explicit.                                                                                                                                                                               |
| Mounts                     | Legacy roots migrate to the shared list with equivalent access. SRT accepts identical paths and rejects remapping; microsandbox maps guest targets. Verify read-only and writable paths from native tools, nested/duplicate entries, package-cache use, and host-data preservation on retirement. |
| Image and complete session | Bundled release image selection and explicit overrides work; image preparation, ACP initialize/new/load, output, cancellation, cleanup, and a real native-tool turn succeed.                                                                                                                      |
| Docker                     | Compose and Testcontainers work, including DNS, random ports, bind mounts, build cache, and cleanup helpers. Two sessions use the same internal ports.                                                                                                                                            |
| Networking                 | Git/npm, an allowed host database, web preview and WebSockets work. Registered control/admin endpoints are unreachable through gateway and host address aliases, including when SOCKS is configured.                                                                                              |
| Lifecycle                  | Idle stop preserves work/cache; start re-establishes ACP; daemon restart fences old hosts; dirty/unpushed work prevents destructive retirement.                                                                                                                                                   |
| Performance                | Measure cold image preparation, warm disk clone, stopped-session restart, ACP-ready latency, and Git/install/build duration. At 1/10/20 sessions, record whole-environment memory, peaks, disk growth, CPU limits, and cleanup. Record reflink versus sparse-copy behavior.                       |

Keep plain Podman/crun and Docker Sandboxes as labeled comparison arms where
useful. Compare actual agent sessions before deciding latency or density targets.
