# @agentconnect.md/vmm

Boots a Linux guest on macOS with Virtualization.framework and reports its lifecycle as
ND-JSON, so a daemon can run an agent's ACP runtime inside a VM instead of as a child
process. Design: [`docs/designs/vm-runtime-plane.md`](../../docs/designs/vm-runtime-plane.md).

macOS on Apple Silicon only. Everywhere else `pnpm build` and `pnpm test` skip with a
message; `AC_VMM_REQUIRE=1` turns a skip into an error, which is what CI's macOS job sets.

```sh
pnpm --filter @agentconnect.md/vmm build # swift build -c release, then codesign
pnpm --filter @agentconnect.md/vmm test  # signs the test bundle first, then swift test
make image FROM=runtime-sandbox:latest   # build a guest from that image's filesystem
make run                                 # boots ./image with ssh on 2222
```

## Supervised run

What the daemon uses. See [`docs/vm-runtime.md`](docs/vm-runtime.md) for the event shapes.

```sh
agentconnect-vmm run ./bundle \
  --cpus 1 --memory 2GiB \
  --forward 0:8085 \
  --data-disk /var/agent-data.img \
  --console-log /var/log/agent-console.log \
  --json
```

## How the daemon uses it

`agentconnect-daemon run --vm` boots one guest per agent and reaches the in-guest shim over the
forwarded loopback port. The daemon side lives in `packages/daemon/src/vm/`; the design is
[`docs/designs/vm-runtime-plane.md`](../../docs/designs/vm-runtime-plane.md).

The helper is invoked, never imported: it is a child process whose stdout is a lifecycle stream.
That is why `--json` exists, and why the guest console has to go somewhere else.

Env the daemon reads, all optional: `AC_VM_IMAGE`, `AC_VM_BINARY`, `AC_VM_CPUS`, `AC_VM_MEMORY`,
`AC_VM_DATA_DISK`, `AC_VM_MAX_GUESTS`, `AC_VM_TOTAL_VCPUS`. Defaults put the helper at
`<root>/vm/bin/agentconnect-vmm` and the image bundle at `<root>/vm/image`, and `--vm` refuses to
boot when either is absent rather than falling back to running agent code on the host.

## Building a guest image

```sh
./scripts/build-agent-image.sh --from image < oci-image > --output
```

The base is a parameter because the agent guest derives from the SAME `runtime-sandbox` image the
cluster path runs, so there is one definition of what a runtime image contains. The suite is read
from the base's `/etc/os-release`; the boot layer is apt-installed into that userland.

**The base must be Debian 13 (trixie).** On bookworm the guest boots to a completely silent console
and never reaches userspace: its 6.1 kernel ships `virtio_console` and `virtiofs` as MODULES, and
`MODULES=most` does not put the console driver in the initrd, so `console=hvc0` names a device whose
driver never loads. Trixie's 6.12 compiles both in. Bookworm also caps you at Docker 20.10 and
Compose v1, which has no `docker compose` subcommand at all. The build refuses rather than shipping
a silent image, and the check accepts either a built-in driver or one carried in the initrd because
which it is depends on the suite.

## Non-obvious facts

Inherited from the prototype this package was vendored from, and each one cost a debugging
session. Read before changing the corresponding code.

**The binary must be codesigned or nothing works.** Virtualization.framework requires
`com.apple.security.virtualization` and reports a missing entitlement as "invalid virtual
machine configuration". `make build` signs every time. `make test` signs the _test bundle_
too, because `validate()` is entitlement-gated. Plain `swift test` still passes, it just
exercises the unentitled branch. Ad-hoc signing (`codesign --sign -`) is enough, so no
Apple provisioning profile is needed.

**DispatchIO does not work for the vsock relay.** Its read handler never fires for these
descriptors, on any queue type, so bytes silently never move. `FDBridge` uses
`DispatchSource` read sources with blocking writes instead, one serial queue per direction.
Do not "simplify" it back to DispatchIO. `FDBridgeTests` guards this.

**Host to guest ports go over vsock, not NAT.** Virtualization.framework's NAT has no port
forwarding. `--forward H:G` accepts on `127.0.0.1:H` and connects to guest vsock port G,
where `vsock-forward@G.service` (socat) hands off to `127.0.0.1:G`. A new forwarded port
needs `vsock-forward@PORT` enabled in the _image_, not just `--forward` on the command line.

**Forwarded ports must be bridged in the image.** `manifest.json` carries `bridgedPorts`,
which must match the `vsock-forward@` units the guest enables. `run` warns on a `--forward`
that names anything else, because otherwise the connection just hangs.

**Concurrency is limited by total guest vCPUs, not RAM.** Past roughly 2x host cores in
summed vCPUs, guests start dying with `Attempted to kill init! exitcode=0x0000000b`, a
SIGSEGV in PID 1, while host memory is still 34% free. Ten 2-vCPU VMs are fine on an 8 core
host; twelve are not, and the same twelve are fine at 1 vCPU each. This is an admission
limit, not a tuning hint. See [`docs/performance.md`](docs/performance.md).

**Never reuse a disk clone after a VM was killed.** An unclean stop leaves a dirty ext4 and
the next boot fails with `EBADMSG` on a damaged block, which looks like a missing shared
library. Clone the rootfs fresh per run, which is why `/dev/vda` is disposable and
everything that must persist lives on the `--data-disk`.

**Stopping VMs one at a time serialises teardown into minutes.** Each guest takes several
seconds to shut down, so request stop on every guest first and then collect them.

**Guest shares are automounts.** Shares are declared in the guest `/etc/fstab` with
`x-systemd.automount`; plain entries produced failed units at boot whenever a share was not
passed.

**A `docker export` tar must be unpacked on the builder's own filesystem.** Extracting it onto a
bind-mounted macOS directory fails on the zoneinfo tree and cannot carry Linux ownership, so the
runtime user's uid 10001 is lost. Use `--delay-directory-restore --numeric-owner`, and keep the
rootfs off the host mount.

**Two packages the image needs are only _Recommends_, and recommends are off.**
`initramfs-tools` for the kernel, and `docker-cli` for `docker.io`. Miss the latter and you
get a running dockerd with no `docker` command, which looks like a PATH problem and is not.
With no initrd there is no `virtio_blk` and the kernel cannot mount `/dev/vda`.

**`mkfs.ext4 -d` is what makes the container build work.** It populates the filesystem from
a directory tree with no loop device, which a container cannot get, and it is why the image
build needs privileged Docker rather than running natively on macOS. Pseudo filesystems must
be unmounted first or `/proc` and `/dev` end up in the image.

**Whatever installs a service enables it.** `docker.sh` runs _after_ `configure.sh` because
it needs the `tester` account to exist, so `configure.sh` cannot enable docker units, and
`systemctl enable` fails on a unit that is not installed yet.

**Debian 13 arm64 `vmlinuz` is already a raw arm64 `Image`.** `extract-kernel.py` also
handles EFI zboot and gzip because that has changed between releases; it parses the zboot
header rather than calling `objcopy`, so it runs and tests on macOS.

**Never edit `scripts/guest/*.sh` while a build is running.** Bash reads a script
incrementally from the file, so rewriting it shifts the byte offsets under the running shell
and it resumes mid-token. The symptom is a nonsense error like
`line 138: uilder_tools: command not found` from a script that is valid on disk.
