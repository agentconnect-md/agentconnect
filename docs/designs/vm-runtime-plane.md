# The VM Runtime Plane: A Hypervisor Boundary for a Self-Hosted Daemon

> **Status:** Mechanism implemented and unit-tested behind `--vm` (M0, M2, M3, M4, M5 of the plan
> below). **The guest image is not built yet (M1)**, so `--vm` refuses to boot on any host today:
> its preflight demands an image bundle that nothing currently produces. Every claim below about
> the daemon side is checkable against code; every claim about the guest is a design.
>
> **Scope:** daemon + a new Swift package. No protocol change, no control-plane change, no console
> change.
>
> **Related designs:** [architecture.md](architecture.md) §3.1, §9.1 ·
> [cluster-spawn-and-shim.md](cluster-spawn-and-shim.md) §1, §3, §8 ·
> [daemon-detailed-design.md](daemon-detailed-design.md) §2.6
>
> **Staged scope:** this is the mechanism. The distribution story (prebuilt guest images, their
> security refresh cadence) is sketched in §10 and not built. A provider key is present inside the
> guest, exactly as it is inside a sandbox pod today, so this suits self-hosted bring-your-own-key.

An agent's runtime can already run somewhere other than the daemon's own host: `--k8s` puts it in a
sandbox pod. That mode assumes a cluster. This adds a third placement for a machine an operator
sits at, where the isolation boundary is a hypervisor rather than a pod, and where the guest has a
real kernel and can therefore run containers.

The invariant is untouched. ACP is still daemon-owned and never crosses the control plane
(`architecture.md` §5.3); here it crosses one loopback socket into a guest this daemon booted.

## 1. Problem

Two costs, both specific to a self-hosted daemon on macOS.

1. **A project cannot boot its own services.** `packages/daemon/src/launch/prepare.ts` strips
   `DOCKER_HOST`, `CONTAINER_HOST`, `PODMAN_HOST` and
   `TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE` from a confined child, deliberately, so an agent cannot
   reach the host's container daemon. There is consequently no supported way for an agent to run
   the Postgres its own test suite needs. Handing it the host socket is not an option: that is
   root-equivalent on the daemon's machine.
2. **"Run any code" is not contained on this platform.** `packages/daemon/src/acp/sandbox.ts`
   returns no mechanism off Linux, with the reason recorded in the code: macOS needs a
   runtime-neutral credential strategy before a private HOME plus Seatbelt is safe. So an agent on
   a Mac is `architecture.md` §9.1's _operator-trusted code_, with the daemon account's ambient
   authority. That is a legitimate documented position, and it means the honest answer to "may I
   let this agent run anything?" is "only if you trust it".

Neither is fixable by tightening the process sandbox. A container does not help either: on macOS
Docker is itself a VM, so the agent would be inside a guest the daemon does not control and still
could not nest containers usefully.

The fix is to make the sandbox a VM the daemon owns outright.

## 2. Core principles

**P1 - The shim protocol is the seam, not the placement.** A guest is a different place to reach
the shim. `ShimDialer`, `ShimSession`, `createRemoteRuntime`, `ShimGitRunner`, `ShimWorkspaceFs`,
`ShimMemoryFs`, `ShimFileSink`, `ClusterSkillClient` and `TunnelBinder` are used unchanged. If a
change to any of them were needed, that would be evidence the placement is leaking upward.

**P2 - The transport is the authentication.** See §5. This is the one place the VM path is
_stronger_ than the pod path, and the design leans on it rather than reimplementing TokenReview.

**P3 - The rootfs is disposable; one disk is not.** See §6. This is what makes suspend, resume and
image upgrade cheap, and it is what neutralizes the dirty-filesystem failure mode.

**P4 - Admission is measured, not tuned.** See §8. Past a known ratio, guests do not slow down,
they panic. Refusing a launch is the only outcome better than booting a guest that dies.

**P5 - Fail closed.** A misconfigured `--vm` refuses the boot. Degrading to a local child process
is precisely the outcome the mode exists to prevent.

### Decision summary

| #   | Decision                                                                                                |
| --- | ------------------------------------------------------------------------------------------------------- |
| D1  | One VM per agent, suspended and resumed, mirroring the sandbox-pod lifecycle.                           |
| D2  | The ACP runtime runs inside the guest, reached through the existing shim over vsock.                    |
| D3  | Identity is a per-boot secret; the vsock transport is the primary proof (§5).                           |
| D4  | Two disks: a disposable rootfs clone and a persistent per-agent data disk (§6).                         |
| D5  | The hypervisor lives in a separate Swift package invoked as a child process, not a Node binding.        |
| D6  | `--vm` is the first placement that advertises the `sandbox` capability honestly (§7).                   |
| D7  | No cluster state machine: no claim, no warm pool, no API server, so no `LaunchRegistry`/`SandboxLease`. |
| D8  | Linux/KVM is a documented future backend, not built (§11 R1).                                           |

## 3. Goals and non-goals

**Goals**

1. An agent can run arbitrary code, including `docker compose up`, without that code holding the
   daemon user's authority.
2. A self-hosted macOS daemon can honour `security.requireSandbox`, which it currently cannot at
   all.
3. Zero change to the shim protocol, the daemon-CP protocol, or the console.

**Non-goals**

Linux/KVM guests, as an implementation. The seam is hypervisor-neutral and the backend is separate
work with no prior art in hand; on Linux the existing bwrap sandbox already provides a kernel
boundary, so this is additive there rather than filling a hole. The **images** are nonetheless
designed to serve it (§10.1): an arm64 guest boots under either hypervisor, so adding a KVM backend
later is a host-side driver and not a second image line.

macOS guests. Virtualization.framework supports them; nothing here needs one, and they carry
licensing constraints Linux does not.

Snapshots. `saveMachineStateTo` would make resume faster than a 2 second boot. It is not worth a
new on-disk format for two seconds, and a snapshot is a second thing to invalidate on image
upgrade. Reopened if boot latency ever dominates a turn.

Intel Macs. The guest image is arm64. Reopened only if an operator asks.

A shared pool of pre-warmed guests. Boot is ~2 seconds, which is thirty times faster than the pod
path's cold-start budget, so pre-warming buys little and costs idle vCPUs against the ceiling in
§8.

## 4. The seam

`SpawnDriver` (`packages/daemon/src/acp/spawn-driver.ts`) is unchanged. `VmDriver` is its third
implementation, beside `LocalDriver` and `K8sDriver`, and returns the same byte-stream pair plus
lifecycle.

The larger half of the seam did have to change. `K8sRuntimePlane` was ~25 members typed concretely
on `K8sDriver` and `ShimDialer`, so nothing else could implement it. It was split: `RuntimePlane`
(`packages/daemon/src/runtime-plane/contract.ts`) holds every member the daemon consumes, with
`driver` narrowed to `SpawnDriver`; `K8sRuntimePlane extends RuntimePlane` keeps `driver: K8sDriver`
and `dialer: ShimDialer`, neither of which anything outside `src/k8s/` reads.

That extraction is only correct because a second implementer arrived to check it, which is the rule
`CLAUDE.md` states. Retyping `daemon.ts` to the neutral interface and having the type-check pass is
the proof that no cluster concept had leaked into it. One had: a log line naming the leaked
`SandboxClaim` after a failed discard. It became `describeResidue?(agentId)`, which the VM plane
answers with a state directory.

Four things moved out of `src/k8s/` in the same change, having gained a second consumer:
`createRemoteRuntime` and `TunnelBinder` to `src/shim/` (neither imported anything from k8s),
`RUNTIME_GRANTS`/`PROBE_GRANTS` to `src/shim/grants.ts`, and `sandboxMemoryRoot` beside
`ShimMemoryFs`. `src/vm/` has no dependency on `src/k8s/`.

## 5. Isolation and trust boundary

`architecture.md` §9.1 is normative and this does not strengthen it silently. What changes is
narrow: on a `--vm` daemon an agent is **not** operator-trusted code, because the boundary is a
hypervisor rather than the operator's decision to trust it. Every other sentence of §9.1 stands,
including that an unsandboxed agent elsewhere remains trusted by choice.

### 5.1 Why the transport is the proof

The pod path authenticates the sandbox with an audience-restricted projected ServiceAccount token
verified by `TokenReview`, and `cluster-spawn-and-shim.md` §3 explains why the dial target is
explicitly _not_ identity: pod IPs are reusable and the Sandbox status mirroring them is
asynchronous.

None of that applies here. A guest is reached on a loopback port that this daemon's own helper bound
to exactly one `VZVirtualMachine` it created, forwarded to a vsock port on that machine and nowhere
else. There is no routable address, no reuse, and no third party that can be on the other end.

A per-boot secret is still minted and delivered on a read-only virtiofs share, and it still has a
job: **fencing boots, not authenticating strangers.** A guest that outlives its launch, still
holding a stale secret, must not bind as its successor. `VmBootRegistry` names each boot
`vm-<agentId>-<generation>` and retires the secret when the boot ends, so a replaced guest is a
different peer at the protocol level.

### 5.2 What this does not guarantee

Hypervisor escape. Virtualization.framework is the boundary and a bug in it is out of scope, as a
kernel escape from a pod is out of scope for `--k8s`.

Egress control. The guest gets NAT and reaches the network as the host does. There is no per-agent
egress policy, which the cluster path also lacks today.

Provider-key confinement. The key reaches the runtime, so it is inside the guest. This is the same
admission `cluster-spawn-and-shim.md` makes, and the same managed egress proxy would fix both.

## 6. Two disks, and why suspend is cheap

| Disk            | Maps to | Content                               | Lifetime                                          |
| --------------- | ------- | ------------------------------------- | ------------------------------------------------- |
| `/dev/vda` root | the pod | base image, copy-on-write clone       | **Disposable.** Recreated per boot.               |
| `/dev/vdb` data | the PVC | `/agent` workspace, `/var/lib/docker` | **Persistent per agent.** Deleted with the agent. |

**A dirty rootfs is never read again.** An unclean stop leaves an inconsistent ext4, and the next
boot off it fails with `EBADMSG` on whatever block was damaged, which surfaces as a missing shared
library and sends the reader in entirely the wrong direction. Cloning fresh per boot removes the
failure mode rather than mitigating it. On APFS the clone is copy-on-write and costs nothing, which
is what makes per-boot affordable.

**`/var/lib/docker` is on the data disk deliberately.** Without that, every resume re-pulls every
image and the container story is unusable in practice.

**An image upgrade needs no migration.** The next boot clones the new base. Contrast
`cluster-spawn-and-shim.md` §7, where a persisted Sandbox needs a resume-time JSON Patch of its
container image with preconditions. Rollback is repointing one symlink.

**Generations come from the durable store**, `LocalStore.nextSandboxGeneration`, never a
process-local counter. The reason `cluster-spawn-and-shim.md` §8 gives applies unchanged: a
successor restarting at 1 would be refused as stale.

**Takeover is a genuine non-member.** `adoptAgent` is a no-op. A pod outlives the daemon that
claimed it, so adopting one is real; a guest is a child process that dies with its daemon, so there
is nothing to adopt. `withSandbox` needs no lease either, because nothing suspends a guest except an
explicit call.

## 7. Capability advertisement

`daemon-detailed-design.md` §2.6 refuses to advertise `sandbox` under `--k8s`, and is right to:
"advertising a sandbox that is not there is worse than advertising none" on the cluster's default
runtimeClass. A hypervisor is not in that position. `--vm` therefore advertises `sandbox`, and
satisfies `security.requireSandbox`, which on macOS nothing else can.

`SANDBOX_KEEP_ALIVE_FEATURE` and `AGENT_WAKE_FEATURE` become conditional on placement rather than on
`--k8s`: a VM agent also has something to hold and something to wake. No new feature string is
minted, because the control plane needs to know nothing new.

## 8. Resource admission

From measurement on an 8-core M3, not from a model. Past roughly **2x host cores in summed guest
vCPUs**, guests stop booting and start dying with `Kernel panic - not syncing: Attempted to kill
init! exitcode=0x0000000b`, a SIGSEGV in PID 1, while host memory is still a third free. Ten
2-vCPU guests are fine; twelve are not; the same twelve are fine at 1 vCPU each.

So `VmAdmission` refuses a launch that would cross the ceiling, before a generation is spent or
anything is created on disk, with a message naming the limit. The alternative an operator would
otherwise debug is init segfaulting for no visible reason.

The default is **1 vCPU per guest**, because more guests at one beat fewer at two for work that
waits on a network, which is most agent work. Teardown asks every guest to stop before waiting on
any: each spends seconds in its own shutdown, so sequential teardown of a dozen takes minutes.

## 9. Failure model

| Failure                            | Impact                   | Behavior                                                                  |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------- |
| Helper missing or unsigned         | no guest can boot        | preflight refuses startup, naming the build command                       |
| Guest image missing                | no guest can boot        | preflight refuses startup, naming the build command                       |
| Host over the vCPU ceiling         | this launch only         | refused with the limit named; nothing created                             |
| Guest fails to boot                | this launch only         | helper reports `exited` before `booting`; launch fails, placement cleaned |
| Guest exits on its own             | the launch ends          | next turn boots a fresh generation                                        |
| Shim channel lost                  | the launch ends          | same path; a lost channel is not distinguishable from a dead guest        |
| Guest ignores the shutdown request | data disk left dirty     | force power off after the deadline; the guest fscks the data disk on boot |
| Daemon killed                      | every guest dies with it | data disks survive; the next start boots fresh guests onto them           |

## 10. Images: two architectures, one tag, three hosts

**Not built.** This section settles the shape; M1 implements it.

### 10.1 What is and is not shareable

A guest image is a kernel, an initrd and a root filesystem. All three are architecture-specific, so
there are no shared _bytes_. What is shared is everything else, and that is the part that matters:
one build definition, one guest contract (shim on vsock 8085, `/dev/vdb` as the data disk, the boot
secret share), and one tag. Publishing an OCI index means `vm-image:1.2.3` resolves to the right
artifacts per host, exactly as a container tag does.

Two images serve three hosts:

| Image       | Virtualization.framework | KVM          |
| ----------- | ------------------------ | ------------ |
| linux/arm64 | Apple Silicon            | arm64 Linux  |
| linux/amd64 | not supported (§3)       | x86_64 Linux |

The same arm64 rootfs boots under both hypervisors. Nothing in it is VZ-specific: virtio-blk,
virtio-net, virtio-fs and vsock are the same devices either way, and the guest side of the port
bridge (`socat VSOCK-LISTEN`) does not know which hypervisor is on the other end. What differs is
the host driver, which is the backend seam, plus one kernel argument: VZ presents the console as
`hvc0` while a typical KVM host uses `ttyS0`. That belongs on the launch, not in the image, and the
helper already accepts `--kernel-arg` to override what the manifest carries.

### 10.2 Rosetta is attached, not baked

`VZLinuxRosettaDirectoryShare` is a **host** capability shared into the guest at launch, so there is
no separate "arm64 with Rosetta" image and there should not be one. The image only has to know how
to use a share if it is offered: mount the `rosetta` tag and register the x86_64 ELF magic with
binfmt_misc. One arm64 image therefore covers Apple Silicon with and without Rosetta, and arm64
Linux, where the equivalent would be qemu-user-static and is a separate decision.

The plumbing exists in the vendored guest scripts (an `x-systemd.automount` for the tag, a
`binfmt.d` registration, `systemd-binfmt` enabled), with two problems M1 must fix:

1. It is installed only for the prototype's `cft-rosetta` browser variant, so it is tied to a
   payload this image does not carry.
2. The registration is a static `/etc/binfmt.d/` drop-in using the `F` (fix-binary) flag, which
   opens the interpreter **at registration time**. With no Rosetta share attached that fails and
   leaves a failed unit at every boot. It has to become conditional on the share actually being
   there, after the automount, rather than unconditional at boot.

Rosetta on Linux is also marked unverified in the prototype's own notes: the path is wired and has
never been run. Treat §13.3 as open on it.

### 10.3 Building and publishing both

The obstacle recorded earlier was that `build.yaml` **loads** a verified target into the local
daemon before pushing, and `docker load` cannot take a multi-platform manifest. Native runners
dissolve it rather than working around it:

1. A job per architecture on its own runner: `ubuntu-latest` for amd64, `ubuntu-24.04-arm` for
   arm64. GitHub-hosted arm64 Linux runners are free for public repositories, which this is.
2. Each loads only its own single-platform image, runs the verification, and pushes **by digest**.
3. A final job composes the index with `docker buildx imagetools create` from the two digests.

Emulating arm64 on an x86 runner is the wrong answer here specifically because
`scripts/verify-runtime-image.mjs` does not read the Dockerfile, it `docker run`s the image. Under
qemu-user that is slow and it changes what is being tested.

This also makes `runtime-sandbox` itself multi-arch, which is worth more than this feature: it is
what lets the cluster path run on arm64 nodes at all. The cost is roughly double build time and
registry storage for those targets.

The guest rootfs should be derived from the already-built `runtime-sandbox` image for its own
architecture, so there is one definition of what a runtime image contains rather than two that
drift.

### 10.6 The base is Debian 13, and that decision is taken

Measured, not predicted. A guest built from a bookworm base boots to a **completely silent console**
and never reaches userspace; the same build from trixie reaches 17 targets with zero failed units,
formats its data disk, starts Docker, and answers on both ssh and the shim port through the vsock
bridge.

The cause is that bookworm's 6.1 kernel ships `virtio_console` and `virtiofs` as modules, and
`MODULES=most` does not put the console driver in the initrd, so `console=hvc0` names a device whose
driver never loads. Trixie's 6.12 compiles both in, which is why the prototype never had to think
about it. Bookworm is also worse at the feature this design exists for: Docker 20.10 and Compose v1,
which has no `docker compose` subcommand, against trixie's Docker 26 and Compose v2.

`docker/runtime-sandbox.Dockerfile` therefore takes its base from `ARG NODE_BASE`, now defaulting to
`node:24-trixie-slim`. The move is evidenced rather than assumed: the image builds on trixie and
**all 18 checks in `scripts/verify-runtime-image.mjs` pass**, including the live ACP probe that
re-derives the runtime table from the image itself. The guest is then built from that image's
filesystem, so the single-definition goal in §10.3 holds.

Two consequences of `docker export` worth stating, because both were bugs before they were notes.
An export carries the filesystem and **not** the image config, so every `ENV`, `USER`, `WORKDIR` and
`ENTRYPOINT` is dropped and the guest's systemd unit restates what it needs. And anything the image
creates under `/run` is shadowed: systemd mounts `/run` as a fresh tmpfs at boot, so the image's
`/run/agentconnect` is gone and the tunnel sockets have nowhere to bind. The unit recreates it with
`RuntimeDirectory`. The `/agent` home skeleton has the same shape of problem against the data-disk
bind mount, and is stashed at build time and seeded on first boot.

### 10.4 The client side### 10.4 The client side

Reuse the shape of `packages/cli/src/version-store.ts`: versioned directories, a `current` symlink,
channel and rollback target, integrity verified before a boot. Never commit an image to git: a 2 GiB
rootfs in history is permanent and every contributor clones it.

### 10.5 Security refresh, and a gap this exposes

Because the rootfs is disposable, all guest security maintenance is necessarily image-level, and
nothing should add in-guest `unattended-upgrades`: it would not persist.

`scripts/component-versions.sh` decides a component is unchanged from **git** build inputs, and there
are no scheduled workflows, so a CVE fixed in the Debian base triggers no rebuild today. This
already affects `runtime-sandbox`. The fix is to pin the base by digest and add a scheduled job that
bumps it, which turns an upstream fix into a real diff the existing logic already handles correctly.

## 11. Rejected alternatives

**R1 - A Linux/KVM backend in the same change.** Deferred, not refuted. Doubles the work with no
prior art, and Linux already has a kernel boundary via bwrap, so it fills no hole there.

**R2 - Replace the bwrap/SRT sandbox rather than sit beside it.** Refused. bwrap is a working
boundary on the platform where it runs, it costs milliseconds against a VM's two seconds, and the
`skills` CLI cell depends on the offline SRT provider. Three placements is the honest count.

**R3 - Agent on the host, Docker only in the guest.** Much smaller, and it solves the wrong half:
the agent's own code stays exactly as contained as it is today, which is the second problem in §1.

**R4 - A container instead of a VM.** On macOS Docker is already a VM the daemon does not control.
Nesting inside it gives a weaker boundary and a worse container story.

**R5 - Drive Virtualization.framework from Node via a native binding.** Avoids a second language and
throws away working, tested Swift. The entitlement story also gets harder: the _binary_ must carry
`com.apple.security.virtualization`, which for a binding means entitling Node itself.

**R6 - Reuse `LaunchRegistry`, `SandboxLease` and `ChannelBinder`.** They encode claims, warm pools
and an API server. A VM launch is "is this agent's guest up, and is its shim bound". Reusing them
would import concepts with no referent here, and the shared parts (`ShimDialer`, `ShimSession`) are
reused already.

**R7 - Snapshot and restore instead of boot.** See §3.

**R8 - Trust the loopback port as identity with no secret at all.** Nearly defensible per §5.1, and
refused because it leaves boots unfenced: a guest outliving its launch could answer for its
successor.

## 12. Implementation plan

Milestones are merge order. Each is several small independently-mergeable PRs; local and `--k8s`
behaviour stays green at every merge. Spine: M0 → (M2) → M3 → M4 → M5, with M1 independent.

**M0 - Vendor the hypervisor helper.** `packages/vmm`, a Swift package producing the signed
`agentconnect-vmm`. Adds a detached console, a second block device, ephemeral port binding and
ND-JSON lifecycle events to what the prototype had. _Done._

**M1 - Guest image.** `packages/vmm/scripts/build-agent-image.sh` turns a runtime-sandbox image's
rootfs into a bootable guest: boot layer, units, initrd, ext4. **Built from the real image and
booted on real hardware**, with the production shim answering on its vsock-forwarded port. The base
suite question is settled in §10.6. _Done._

**M2 - Extract `RuntimePlane`.** Pure refactor. _Done._

**M3 - `VmDriver` and `VmRuntimePlane`.** _Done._

**M4 - Admission and limits.** _Done._

**M5 - Flag, capability, preflight.** `--vm`, mutual exclusion with `--k8s`, `sandbox` advertised,
`requireSandbox` satisfied, preflight refusals naming build commands. _Done._

## 13. Validation

### 13.1 What tests cover

The end-to-end assembly is covered without a hypervisor: a real `ShimServer`, a real `ShimClient`
presenting a real boot secret, and a real `ShimDialer` binding through `VmDriver`. That is the test
that can falsify P1, and it passes with the shim layer unmodified.

The helper's event contract is asserted against **bytes captured from a real run** of the Swift
binary, so a drift in its encoder fails in the daemon suite rather than at launch.

Swift-side coverage is configuration assembly, the CLI contract, the vsock relay and the event
shapes. Booting a guest is not unit-testable and is verified by hand.

### 13.2 What is verified by hand, on real hardware

Confirmed already, against the prototype image: guest boots, ephemeral port reported and reachable,
data disk visible as `/dev/vdb`, console detached to a file with stdout left clean, `SIGTERM`
producing a clean systemd poweroff and an `exited` event.

Still to confirm, and blocked on M1: an agent turn end to end, git over the shim's `exec`, an agent
running `docker compose up -d` with Postgres and querying it, a suspend and resume finding both the
workspace and the pulled image, and the gitcred and MCP tunnels.

### 13.3 Open questions M1 must answer

| Question                                                    | Blocks                     | If the answer is no                                               |
| ----------------------------------------------------------- | -------------------------- | ----------------------------------------------------------------- |
| Can the runtime-sandbox rootfs be made bootable by overlay? | the single-definition goal | build a purpose-made rootfs and accept two definitions            |
| Does the shim run unmodified under systemd in a guest?      | P1                         | the shim gains a launch mode, and P1 is weaker than claimed       |
| What does dockerd cost in boot latency here?                | the 1 vCPU default         | raise the default and lower the guest ceiling                     |
| Does `passno=2` fsck recover a force-powered-off data disk? | §9's last two rows         | resume needs an explicit repair step before the workspace is used |

## 14. Implementation map

| Piece                  | Where                                           |
| ---------------------- | ----------------------------------------------- |
| Hypervisor helper      | `packages/vmm/` (Swift)                         |
| Neutral plane contract | `packages/daemon/src/runtime-plane/contract.ts` |
| Helper supervision     | `packages/daemon/src/vm/vmm-process.ts`         |
| Helper event contract  | `packages/daemon/src/vm/events.ts`              |
| Boot identity          | `packages/daemon/src/vm/identity.ts`            |
| Driver                 | `packages/daemon/src/vm/driver.ts`              |
| Plane                  | `packages/daemon/src/vm/runtime-plane.ts`       |
| Two-disk layout        | `packages/daemon/src/vm/disks.ts`               |
| Host admission         | `packages/daemon/src/vm/admission.ts`           |
| Settings and preflight | `packages/daemon/src/vm/settings.ts`            |
| Mode wiring            | `packages/daemon/src/daemon.ts`, `src/index.ts` |
