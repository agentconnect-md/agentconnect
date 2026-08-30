# The Swift side

## Layout

| File                                  | Responsibility                                           |
| ------------------------------------- | -------------------------------------------------------- |
| `Sources/agentconnect-vmm/main.swift` | subcommand dispatch only                                 |
| `CLIOptions.swift`                    | argument parsing, `PortForward`, `DirectoryShare`        |
| `ImageBundle.swift`                   | bundle layout and `manifest.json`                        |
| `KernelCommandLine.swift`             | command line where later arguments override earlier ones |
| `VirtualMachineFactory.swift`         | builds the `VZVirtualMachineConfiguration`               |
| `VirtualMachineSession.swift`         | boot, delegate callbacks, signals, shutdown              |
| `SerialConsole.swift`                 | stdin/stdout on the virtio console                       |
| `PortForwarder.swift`                 | host TCP to guest vsock                                  |
| `TCPListener.swift`, `FDBridge.swift` | the plumbing underneath                                  |
| `Entitlements.swift`                  | up-front entitlement check                               |

Everything except `main.swift` lives in `VmmCore` so it can be tested.

## Entitlements are mandatory

Virtualization.framework refuses to work without
`com.apple.security.virtualization`, and the error it gives for an unsigned binary
just says the configuration is invalid. `VirtualMachineFactory.makeConfiguration`
therefore checks the entitlement first and tells you to run `make sign`.

`make build` signs on every build. `make test` signs the test bundle too, because
`VZVirtualMachineConfiguration.validate()` is itself entitlement-gated.

## The VM configuration

Direct kernel boot with `VZLinuxBootLoader`: kernel, initrd, and the command line
from the manifest. No EFI, no bootloader, no partition table. `disk.img` is a bare
ext4 filesystem attached as `/dev/vda`.

Devices: virtio block, virtio net with NAT, virtio console, virtio entropy, a
memory balloon, a vsock device, and one virtiofs device per `--share`.

`--cpus` and `--memory` are clamped into the range the framework allows rather
than rejected, so an over-ambitious value degrades instead of failing.

## Host to guest networking

NAT gives the guest outbound access but Virtualization.framework provides no port
forwarding, and the guest is not routable from macOS. Ports come back over vsock:

```
macOS 127.0.0.1:9515
  -> TCPListener accepts
  -> VZVirtioSocketDevice.connect(toPort: 9515)
  -> guest: socat VSOCK-LISTEN:9515 -> TCP 127.0.0.1:9515
  -> chromedriver
```

The guest side is the templated `vsock-forward@.service`; `9515` and `22` are
enabled in the image. Forwarding any other port means enabling
`vsock-forward@PORT` in the guest as well as passing `--forward`.

`agentconnect-vmm run` warns at boot when a `--forward` targets a guest port the manifest does
not list as bridged, because the failure mode otherwise is a connection that hangs
with no explanation.

The listener binds loopback only. A forwarded port is a hole into the guest and
has no business being reachable from the local network.

### FDBridge, and why not DispatchIO

`FDBridge` relays bytes between the accepted TCP socket and the vsock descriptor
using `DispatchSource` read sources with blocking writes, one serial queue per
direction.

The first implementation used `DispatchIO`, which looks like the natural fit. Its
read handler never fired for these descriptors, on any queue type, so nothing
crossed the bridge: chromedriver appeared to hang rather than fail. `FDBridgeTests`
covers both directions, multi-chunk transfers, and close detection, so a
regression here shows up in the test suite instead of as a mysterious timeout.

## Shells

The console is a real getty: the image enables `serial-getty@hvc0` with an agetty
autologin override, so `agentconnect-vmm run` drops you at a root prompt. That is the only way
in before networking is up, which is why it autologs in.

ssh comes over the same vsock bridge as everything else, via `vsock-forward@22`.
`scripts/shell.sh` wraps it with `StrictHostKeyChecking=no` and
`UserKnownHostsFile=/dev/null`, because the image regenerates its host keys on
first boot and every rebuild would otherwise look like a man-in-the-middle.

`VIRT_SSH_USER` picks the account, `VIRT_SSH_PORT` the forwarded port. Use `tester`
for anything that launches the browser; root cannot run Chromium with its sandbox
enabled.

## Shutdown

`SIGINT` and `SIGTERM` call `requestStop()`, which Linux sees as a power button
press and turns into a normal systemd shutdown. A second signal forces
`stop()`. `ISIG` stays enabled on the console so ctrl-c reaches `agentconnect-vmm` rather than
the guest shell, which means an unresponsive guest is always escapable.

## Shares

`--share TAG=PATH` mounts at `/mnt/TAG` in the guest. `out`, `share` and `rosetta`
are pre-declared in the guest's `/etc/fstab` as `x-systemd.automount`, so they
mount on first access and a share that was not passed does not produce a failed
unit at boot. Any other tag needs a manual `mount -t virtiofs TAG /some/path`.

## Supervised runs

A daemon does not want an interactive console, and it cannot know in advance which
host ports are free. Four options exist for that case, and they compose:

| Option               | Effect                                                               |
| -------------------- | -------------------------------------------------------------------- |
| `--json`             | ND-JSON lifecycle events on stdout: one `booting`, then one `exited` |
| `--console-log PATH` | the guest console goes to `PATH`, leaving stdout to the events       |
| `--forward 0:G`      | binds an ephemeral loopback port, reported in `booting`              |
| `--data-disk PATH`   | a second virtio block device, `/dev/vdb`                             |

`booting` is emitted after the forwards bind, so its `forwards` array carries the
ports a caller can actually dial. It is not a readiness signal: the guest is still
booting at that point, and readiness is the caller's own successful dial.

```json
{"cpuCount":2,"dataDisk":"/var/agent.img","event":"booting","forwards":[{"guestPort":22,"hostPort":52308}],"kernelCommandLine":"console=hvc0 root=/dev/vda rw loglevel=4","memoryBytes":2147483648,"vmmVersion":"1.0.0"}
{"code":0,"event":"exited","reason":"guest-powered-off"}
```

`reason` separates a guest that powered itself off from one this process tore down
(`forced`), one the guest failed out of (`guest-error`), and a configuration that
never started (`start-failed`). A supervisor needs that distinction to decide
whether an exit is a fault worth reporting.

The two disks are not symmetric. `/dev/vda` is a disposable clone of the base image,
recreated per boot, so a dirty filesystem after an unclean stop is discarded rather
than repaired. `/dev/vdb` is the persistent one and is where anything that must
survive a stop belongs.
