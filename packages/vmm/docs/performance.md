# Measured performance

> Measured on the PROTOTYPE image this package was vendored from, whose payload was a browser and a
> WebDriver rather than an agent runtime. The absolute latencies therefore describe a different
> workload; what carries over, and what the daemon's admission limit is built on, is the shape:
> roughly 1.6s to a usable guest and the vCPU sum as the binding constraint on concurrency.

Host: MacBook Air M3, 8 cores (4 performance + 4 efficiency), 16 GiB, macOS 26.3.
Guest: Debian 13 arm64, kernel 6.12.101, Chromium 151 with chromedriver.
Reproduce with `scripts/bench.py`, which is what produced every number here.

## Boot latency

`./scripts/bench.py boot --runs 5` (2 vCPU, 2 GiB, 10 boots, all succeeded):

| Stage                                  | min   | median | max   |
| -------------------------------------- | ----- | ------ | ----- |
| first kernel output                    | 0.40s | 0.42s  | 0.49s |
| chromedriver answering `/status`       | 1.55s | 1.56s  | 1.83s |
| ssh accepting connections              | 1.56s | 1.58s  | 1.84s |
| shell prompt, command run, output back | 2.27s | 2.38s  | 2.49s |

So **a VM is usable for browser work about 1.6 seconds after launch**, and gives you
a shell with a command executed in about 2.4 seconds.

Cold boot (fresh disk clone: ssh host key generation, machine-id, first-boot units)
and warm boot (second boot of the same disk) came out the same to within noise.
There is no first-boot penalty worth designing around.

chromedriver becomes ready _before_ the console prompt appears. It starts at
`multi-user.target` while agetty is still painting the login banner.

### Cost of Docker in the image

dockerd is enabled by default and delays the rest of userspace:

|                          | without Docker | with Docker |
| ------------------------ | -------------- | ----------- |
| chromedriver ready       | 1.56s          | 2.17s       |
| shell with a command run | 2.38s          | 3.60s       |

Build with `--no-docker` if boot latency matters more than containers.

## Concurrency

`./scripts/bench.py scale`. Each VM gets a private APFS copy-on-write clone of
`disk.img`, which costs nothing to make, and its own forwarded ports.

| VMs | per VM          | total vCPU | reached chromedriver | median ready         |
| --- | --------------- | ---------- | -------------------- | -------------------- |
| 1   | 2 vCPU, 1 GiB   | 2          | 1/1                  | 1.6s                 |
| 2   | 2 vCPU, 1 GiB   | 4          | 2/2                  | 1.7s                 |
| 4   | 2 vCPU, 1 GiB   | 8          | 4/4                  | 2.1s                 |
| 6   | 2 vCPU, 1 GiB   | 12         | 6/6                  | 3.4s                 |
| 8   | 2 vCPU, 1 GiB   | 16         | 8/8                  | 4.8s                 |
| 10  | 2 vCPU, 1 GiB   | 20         | 10/10                | 6.0s                 |
| 12  | 2 vCPU, 1 GiB   | 24         | **8/12**             | 9.9s                 |
| 12  | 1 vCPU, 1 GiB   | 12         | 12/12                | clean                |
| 16  | 1 vCPU, 768 MiB | 16         | 14/16                | clean-ish, see below |

**10 VMs is the comfortable ceiling on this host**, and all 10 are ready in about
six and a half seconds from a cold start.

### What breaks, and why it is not memory

At 12 VMs with 2 vCPU each the guests do not run out of memory, they crash:

```
Kernel panic - not syncing: Attempted to kill init! exitcode=0x0000000b
systemd[1]: Freezing execution.
```

`0xb` is SIGSEGV in PID 1. Host memory never went below 34% free in any run, so
this is not memory pressure. The variable that tracks the failures is **total
vCPUs against host cores**:

| total vCPU | ratio to 8 cores | outcome                                      |
| ---------- | ---------------- | -------------------------------------------- |
| 20         | 2.5x             | all fine                                     |
| 24         | 3.0x             | systemd segfaults in 4 of 12 guests          |
| 12         | 1.5x             | all fine                                     |
| 16         | 2.0x             | 14 of 16, one kernel trace, one frozen PID 1 |

Dropping from 2 vCPU to 1 vCPU took the same 12 VMs from 8/12 to 12/12, with real
WebDriver sessions verified running concurrently on four of them.

**Rule of thumb: keep the sum of guest vCPUs at or under about 2x host cores.**
Prefer more VMs with 1 vCPU over fewer with 2 if the workload is a browser waiting
on a network, which is most test workloads.

## Two traps the harness hit

**Reusing a disk clone across runs corrupts it.** A VM killed mid-boot leaves a
dirty ext4, and the next boot off that disk fails with `EBADMSG` on whatever block
was damaged, which surfaces as nonsense like
`error while loading shared libraries: libdouble-conversion.so.3 ... Error 74`.
`e2fsck` on that clone reported real errors while a fresh clone was clean.
`bench.py` now makes a pristine clone per step and deletes it after.

**Stopping VMs one at a time serialises teardown into minutes.** Each guest takes
several seconds to shut down, so 12 sequential stops is far slower than sending
every guest its shutdown request first and then collecting them. `stop_all` does
the latter.

## Caveats

Numbers are from one host with Docker and a few containers already running. The
absolute figures will move on other hardware; the shape (about 1.6s to a usable
browser, vCPU sum as the binding constraint) should hold.

Concurrency was measured to the point of chromedriver answering, plus WebDriver
sessions on a sample. It is not a throughput benchmark: it does not measure how
fast N VMs actually run tests once busy.
