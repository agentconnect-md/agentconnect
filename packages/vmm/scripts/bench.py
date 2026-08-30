#!/usr/bin/env python3
"""Measures how fast a VM boots and how many run at once.

  scripts/bench.py boot  [--runs 5] [--cpus 2] [--memory 2GiB]
  scripts/bench.py scale [--steps 1,2,4,6,8] [--cpus 2] [--memory 1GiB]

Disk clones use APFS copy-on-write, so each VM gets a private pristine root
filesystem for free instead of a multi-gigabyte copy.
"""
import argparse
import json
import os
import shutil
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VIRT = ROOT / ".build" / "release" / "virt"
IMAGE = ROOT / "image"

PROMPT = b"root@debian-vm"
COMMAND = b"echo BENCH$((21*2))\n"
COMMAND_REPLY = b"BENCH42"


def clone_bundle(tag, workdir):
    """Private disk per VM; kernel and initrd are read only so they are shared.

    Never reused across steps. A VM killed mid-boot leaves a dirty ext4, and the
    next boot off that disk fails with EBADMSG on whatever block was damaged.
    """
    target = workdir / f"vm{tag}"
    target.mkdir(parents=True, exist_ok=True)
    for name in ("kernel", "initrd.img", "manifest.json"):
        link = target / name
        if not link.exists():
            link.symlink_to(IMAGE / name)
    disk = target / "disk.img"
    if not disk.exists():
        subprocess.run(["cp", "-c", str(IMAGE / "disk.img"), str(disk)], check=True)
    return target


class Probe:
    """One VM plus the timestamps of everything it reached."""

    def __init__(self, index, bundle, cpus, memory, driver_port, ssh_port):
        self.index = index
        self.bundle = bundle
        self.cpus = cpus
        self.memory = memory
        self.driver_port = driver_port
        self.ssh_port = ssh_port
        self.marks = {}
        self.output = bytearray()
        self.process = None
        self.started = None
        self._threads = []

    def mark(self, name):
        self.marks.setdefault(name, time.monotonic() - self.started)

    def start(self):
        self.started = time.monotonic()
        self.process = subprocess.Popen(
            [
                str(VIRT), "run", str(self.bundle),
                "--cpus", str(self.cpus), "--memory", self.memory,
                "--forward", f"{self.driver_port}:9515",
                "--forward", f"{self.ssh_port}:22",
            ],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
        )
        self._threads = [
            threading.Thread(target=self._read_console, daemon=True),
            threading.Thread(target=self._poll_port, args=("ssh", self.ssh_port), daemon=True),
            threading.Thread(target=self._poll_driver, daemon=True),
        ]
        for thread in self._threads:
            thread.start()

    def _read_console(self):
        # os.read, not stdout.read: the buffered reader blocks until the full
        # requested size accumulates, which never happens once boot output stops.
        fd = self.process.stdout.fileno()
        sent = False
        while True:
            try:
                chunk = os.read(fd, 4096)
            except OSError:
                return
            if not chunk:
                return
            if not self.output:
                self.mark("first_output")
            self.output += chunk
            if not sent and PROMPT in self.output:
                self.mark("shell")
                self.process.stdin.write(COMMAND)
                self.process.stdin.flush()
                sent = True
            elif sent and COMMAND_REPLY in self.output.split(COMMAND)[-1]:
                self.mark("command")

    def _poll_port(self, name, port):
        while self.process.poll() is None:
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=2) as sock:
                    sock.settimeout(2)
                    if sock.recv(64):
                        self.mark(name)
                        return
            except OSError:
                pass
            time.sleep(0.2)

    def _poll_driver(self):
        url = f"http://127.0.0.1:{self.driver_port}/status"
        while self.process.poll() is None:
            try:
                with urllib.request.urlopen(url, timeout=2) as response:
                    if json.load(response)["value"]["ready"]:
                        self.mark("chromedriver")
                        return
            except (urllib.error.URLError, OSError, KeyError, ValueError):
                pass
            time.sleep(0.2)

    def wait_for(self, keys, timeout):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if all(key in self.marks for key in keys):
                return True
            if self.process.poll() is not None:
                return False
            time.sleep(0.1)
        return False

    def request_stop(self):
        if self.process.poll() is None:
            self.process.terminate()

    def await_stop(self, timeout):
        """Returns False when the guest had to be killed, leaving a dirty disk."""
        try:
            self.process.wait(timeout=timeout)
            return True
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=10)
            return False

    def stop(self, timeout=40):
        self.request_stop()
        return self.await_stop(timeout)


STAGES = ("first_output", "shell", "command", "ssh", "chromedriver")


def summarise(label, samples):
    print(f"\n{label}")
    print(f"  {'stage':<14} {'min':>7} {'median':>7} {'max':>7}")
    for stage in STAGES:
        values = [s[stage] for s in samples if stage in s]
        if not values:
            print(f"  {stage:<14} {'n/a':>7}")
            continue
        print(f"  {stage:<14} {min(values):>6.2f}s {statistics.median(values):>6.2f}s {max(values):>6.2f}s")


def bench_boot(args, workdir):
    print(f"boot latency: {args.runs} runs, {args.cpus} cpu, {args.memory} each")
    cold, warm = [], []
    for run in range(args.runs):
        bundle = clone_bundle(f"boot{run}", workdir)
        for phase, bucket in (("cold", cold), ("warm", warm)):
            probe = Probe(run, bundle, args.cpus, args.memory, 19515 + run, 12222 + run)
            probe.start()
            ok = probe.wait_for(("command", "ssh", "chromedriver"), args.timeout)
            clean = probe.stop()
            status = "ok" if ok else "TIMEOUT"
            print(f"  run {run} {phase:<4} {status} " +
                  " ".join(f"{k}={probe.marks[k]:.2f}s" for k in STAGES if k in probe.marks) +
                  ("" if clean else "  [killed, disk now dirty]"))
            if ok:
                bucket.append(dict(probe.marks))
            if not clean:
                break
        shutil.rmtree(bundle, ignore_errors=True)
    summarise("cold boot (fresh disk: ssh host keys, machine-id, first-boot units)", cold)
    summarise("warm boot (same disk, second boot)", warm)


def bench_scale(args, workdir):
    steps = [int(s) for s in args.steps.split(",")]
    print(f"concurrency: {args.cpus} cpu, {args.memory} per VM, host has "
          f"{host_cores()} cores and {host_memory_gib()} GiB")
    for count in steps:
        probes = []
        begin = time.monotonic()
        for index in range(count):
            bundle = clone_bundle(f"scale{count}_{index}", workdir)
            probe = Probe(index, bundle, args.cpus, args.memory, 19600 + index, 12300 + index)
            probe.start()
            probes.append(probe)

        ready = wait_all(probes, ("chromedriver",), args.timeout)
        elapsed = time.monotonic() - begin
        times = [p.marks["chromedriver"] for p in ready]
        print(f"\n  {count:>2} VMs: {len(ready)}/{count} reached chromedriver in {elapsed:.1f}s wall")
        if times:
            print(f"      per-VM chromedriver ready: min {min(times):.1f}s "
                  f"median {statistics.median(times):.1f}s max {max(times):.1f}s")
        for probe in probes:
            if probe not in ready:
                print(f"      VM {probe.index} FAILED, marks: {dict(probe.marks)}")
        print(f"      host memory pressure after: {memory_pressure()}")
        killed = stop_all(probes)
        if killed:
            print(f"      had to kill VMs {killed}, their disks are dirty")
        for probe in probes:
            shutil.rmtree(probe.bundle, ignore_errors=True)
        if len(ready) < count:
            print(f"\n  stopping the ramp: {count} is past what this host sustains")
            return


def stop_all(probes, timeout=60):
    """Ask every guest to shut down at once, then collect them. Stopping them one
    at a time serialises a 10 second shutdown per VM into minutes."""
    for probe in probes:
        probe.request_stop()
    deadline = time.monotonic() + timeout
    killed = []
    for probe in probes:
        remaining = max(1.0, deadline - time.monotonic())
        if not probe.await_stop(remaining):
            killed.append(probe.index)
    return killed


def wait_all(probes, keys, timeout):
    """One shared deadline, not `timeout` per VM: they boot in parallel."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        done = [p for p in probes if all(k in p.marks for k in keys)]
        if len(done) == len(probes):
            return done
        time.sleep(0.2)
    return [p for p in probes if all(k in p.marks for k in keys)]


def host_cores():
    return subprocess.run(["sysctl", "-n", "hw.ncpu"], capture_output=True, text=True).stdout.strip()


def host_memory_gib():
    raw = subprocess.run(["sysctl", "-n", "hw.memsize"], capture_output=True, text=True).stdout
    return int(raw.strip()) // (1 << 30)


def memory_pressure():
    out = subprocess.run(["memory_pressure", "-Q"], capture_output=True, text=True).stdout
    for line in out.splitlines():
        if "percentage" in line.lower():
            return line.strip()
    return out.strip().splitlines()[-1] if out.strip() else "unknown"


def main():
    # Line buffered so a redirected run shows progress instead of nothing until the end.
    sys.stdout.reconfigure(line_buffering=True)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("mode", choices=("boot", "scale"))
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--steps", default="1,2,4,6,8")
    parser.add_argument("--cpus", type=int, default=2)
    parser.add_argument("--memory", default=None)
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--workdir", default="/tmp/virt-bench")
    args = parser.parse_args()

    if args.memory is None:
        args.memory = "2GiB" if args.mode == "boot" else "1GiB"
    if not VIRT.exists():
        sys.exit(f"bench: {VIRT} is missing, run `make build` first")

    workdir = Path(args.workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    try:
        (bench_boot if args.mode == "boot" else bench_scale)(args, workdir)
    finally:
        print(f"\nclones left in {workdir}, remove with: rm -rf {workdir}")


if __name__ == "__main__":
    main()
