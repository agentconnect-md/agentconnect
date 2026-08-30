#!/usr/bin/env bash
# Runs INSIDE a privileged builder container. Turns an OCI rootfs into a bootable guest.
set -euo pipefail

ARCH="${AC_ARCH:?}"
# Overridden by detect_suite once the base is unpacked: the boot layer is apt-installed INTO the
# base's userland, so the suite is the base's to state, not the caller's to guess.
SUITE="${AC_SUITE:-}"
DISK_SIZE="${AC_DISK_SIZE:?}"
WITH_DOCKER="${AC_DOCKER:-1}"
WITH_SSH="${AC_SSH:-1}"
COMPOSE_KIND="none"
# Assembled on the BUILDER's own filesystem, never on the bind-mounted host directory: a macOS
# volume is case-insensitive and cannot carry Linux ownership, so extracting there loses the uid
# the runtime user is fixed to and fails outright on the zoneinfo tree.
ROOTFS=/rootfs
OUT=/out

log() { echo "    $*"; }

builder_tools() {
  log "installing builder tools"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends e2fsprogs binutils zstd python3 xz-utils \
    initramfs-tools-core cpio > /dev/null
}

unpack_base() {
  log "unpacking the base rootfs"
  mkdir -p "$ROOTFS"
  # --delay-directory-restore: a `docker export` tar replaces directories with symlinks as it goes
  # (the zoneinfo tree does), and without it tar fails the whole extraction on those entries.
  # --numeric-owner: the runtime user is uid 10001 by number, and restoring by NAME would remap it
  # against the builder's /etc/passwd and hand the agent a workspace it cannot write.
  tar --delay-directory-restore --numeric-owner -xf /work/base-rootfs.tar -C "$ROOTFS"
}

detect_suite() {
  local detected
  detected="$(sed -n 's/^VERSION_CODENAME=//p' "$ROOTFS/etc/os-release" 2> /dev/null | tr -d '"')"
  if [[ -z "$detected" ]]; then
    echo "agent-image: cannot read VERSION_CODENAME from the base image's /etc/os-release" >&2
    exit 1
  fi
  if [[ -n "$SUITE" && "$SUITE" != "$detected" ]]; then
    log "base is $detected, not the requested $SUITE; using $detected"
  fi
  SUITE="$detected"
  log "base suite: $SUITE"
}

prepare_chroot() {
  log "preparing the chroot"
  # Recommends off keeps the image lean; every package this guest needs is therefore explicit,
  # including two that are ONLY recommends and whose absence is silent: initramfs-tools (no initrd
  # means no virtio_blk and the kernel cannot mount /dev/vda) and docker-cli (a running dockerd
  # with no `docker` command, which looks like a PATH problem and is not).
  printf 'APT::Install-Recommends "false";\nAPT::Install-Suggests "false";\n' \
    > "$ROOTFS/etc/apt/apt.conf.d/99-no-recommends"
  # A package must not try to start its daemon inside a chroot with no init.
  printf '#!/bin/sh\nexit 101\n' > "$ROOTFS/usr/sbin/policy-rc.d"
  chmod +x "$ROOTFS/usr/sbin/policy-rc.d"
  cp /etc/resolv.conf "$ROOTFS/etc/resolv.conf"
  mount -t proc proc "$ROOTFS/proc"
  mount -t sysfs sys "$ROOTFS/sys"
  mount -o bind /dev "$ROOTFS/dev"
  mount -t devpts devpts "$ROOTFS/dev/pts"
}

in_chroot() { chroot "$ROOTFS" /usr/bin/env DEBIAN_FRONTEND=noninteractive "$@"; }

install_boot_layer() {
  log "installing the boot layer"
  local packages=(
    "linux-image-$ARCH" initramfs-tools systemd-sysv systemd-resolved udev dbus kmod
    iproute2 iputils-ping socat e2fsprogs less procps
  )
  [[ "$WITH_SSH" == "1" ]] && packages+=(openssh-server)
  # Debian's own Docker packages, so the image carries no third-party apt repo or signing key.
  # The set differs by suite and the difference is silent: trixie splits the CLI into `docker-cli`
  # and ships Compose v2, while bookworm folds the CLI into `docker.io` and has no `docker-cli` at
  # all. Asking apt what exists beats hardcoding a suite and failing the whole build on the one
  # package that moved.
  [[ "$WITH_DOCKER" == "1" ]] && packages+=(docker.io docker-cli docker-compose containerd)
  in_chroot apt-get update -qq
  local available=()
  for package in "${packages[@]}"; do
    if in_chroot apt-cache show "$package" > /dev/null 2>&1; then
      available+=("$package")
    else
      log "skipping $package: not in $SUITE"
    fi
  done
  in_chroot apt-get install -y -qq --no-install-recommends "${available[@]}" > /dev/null
  if [[ "$WITH_DOCKER" == "1" ]]; then
    COMPOSE_KIND="$(in_chroot sh -c 'docker compose version >/dev/null 2>&1 && echo v2 || { command -v docker-compose >/dev/null 2>&1 && echo v1 || echo none; }')"
    log "docker $(in_chroot dpkg-query -W -f='${Version}' docker.io 2> /dev/null || echo unknown), compose $COMPOSE_KIND"
  fi
}

write_units() {
  log "writing units"
  local sysd="$ROOTFS/etc/systemd/system"

  # The data disk is where everything that must survive a boot lives. The rootfs is a clone that is
  # thrown away, so this runs before anything reads /agent: format on first boot, repair after an
  # unclean stop, then bind the two trees the guest actually writes to.
  cat > "$sysd/ac-data-disk.service" << 'EOF'
[Unit]
Description=AgentConnect data disk
DefaultDependencies=no
After=systemd-udev-settle.service
Wants=systemd-udev-settle.service
Before=docker.service agentconnect-shim.service local-fs.target
ConditionPathExists=/dev/vdb

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/ac-prepare-data-disk

[Install]
WantedBy=sysinit.target
EOF

  cat > "$ROOTFS/usr/local/sbin/ac-prepare-data-disk" << 'EOF'
#!/bin/sh
# Idempotent: the disk survives boots, so every step has to tolerate having been done already.
set -eu
DISK=/dev/vdb
MOUNT=/mnt/acdata
if ! blkid -s TYPE -o value "$DISK" > /dev/null 2>&1; then
  echo "ac-data-disk: formatting $DISK"
  mkfs.ext4 -q -L acdata "$DISK"
else
  # A forced power off leaves the journal dirty; repair before mounting rather than after a failure.
  e2fsck -p "$DISK" || true
fi
mkdir -p "$MOUNT"
mountpoint -q "$MOUNT" || mount "$DISK" "$MOUNT"
mkdir -p "$MOUNT/workspace" "$MOUNT/docker"
# First boot only: the image ships a home skeleton at /agent that the bind mount below would
# otherwise hide, leaving the runtime with a HOME that has none of its dotfiles.
if [ -d /opt/agentconnect/agent-skel ] && [ -z "$(ls -A "$MOUNT/workspace" 2> /dev/null)" ]; then
  cp -a /opt/agentconnect/agent-skel/. "$MOUNT/workspace/"
fi
chown 10001:10001 "$MOUNT/workspace"
mkdir -p /agent /var/lib/docker
mountpoint -q /agent || mount --bind "$MOUNT/workspace" /agent
mountpoint -q /var/lib/docker || mount --bind "$MOUNT/docker" /var/lib/docker
EOF
  chmod +x "$ROOTFS/usr/local/sbin/ac-prepare-data-disk"

  # The shim: the only thing this guest exists to run, as the same uid the pod runs it under so a
  # data disk written by one placement is readable by the other.
  cat > "$sysd/agentconnect-shim.service" << 'EOF'
[Unit]
Description=AgentConnect shim
After=network-online.target ac-data-disk.service
Wants=network-online.target
Requires=ac-data-disk.service

[Service]
User=10001
Group=10001
# The image creates /run/agentconnect, but /run is a tmpfs systemd mounts fresh at boot, so that
# directory is shadowed and the tunnel sockets (gitcred, mcp) would have nowhere to bind. Recreated
# here, owned by this service, which is also what cleans it up.
RuntimeDirectory=agentconnect
RuntimeDirectoryMode=0700
# `docker export` carries the filesystem and NOT the image config, so every ENV the Dockerfile set
# is gone by the time this runs and has to be restated.
Environment=HOME=/agent
Environment=AC_SHIM_WORKSPACE_ROOT=/agent
Environment=AC_SHIM_PORT=8085
Environment=NODE_OPTIONS=--dns-result-order=ipv4first
Environment=npm_config_update_notifier=false
ExecStart=/usr/local/bin/node /opt/agentconnect/shim/index.js
Restart=always
RestartSec=1
# Errors to the console as well as the journal. The journal is volatile here and the guest is torn
# down with its launch, so a runtime that dies takes the only record of why with it; the console is
# the one stream the daemon captures to a file that outlives the boot.
StandardError=journal+console

[Install]
WantedBy=multi-user.target
EOF

  # Virtualization.framework's NAT has no port forwarding, so host access arrives over vsock and
  # socat hands it to the guest's own loopback. A port only reaches the host if a unit is enabled
  # for it here AND the manifest lists it, which is what `bridgedPorts` is checked against.
  cat > "$sysd/vsock-forward@.service" << 'EOF'
[Unit]
Description=Bridge guest vsock port %i to 127.0.0.1:%i
After=network.target

[Service]
ExecStart=/usr/bin/socat VSOCK-LISTEN:%i,fork,reuseaddr TCP:127.0.0.1:%i
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
EOF

  # Rosetta is a HOST capability attached at launch, not part of this image, so this must do
  # nothing at all when no share was passed. `mount` is attempted rather than declared in fstab
  # because a missing virtiofs tag is a failed unit at every boot on a host without Rosetta.
  cat > "$sysd/ac-rosetta.service" << 'EOF'
[Unit]
Description=Register Rosetta for x86_64 binaries, when the host shared one
DefaultDependencies=no
After=systemd-binfmt.service
Before=agentconnect-shim.service
ConditionVirtualization=vm

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/ac-register-rosetta
StandardOutput=journal

[Install]
WantedBy=sysinit.target
EOF

  cat > "$ROOTFS/usr/local/sbin/ac-register-rosetta" << 'EOF'
#!/bin/sh
# Absence is the normal case: no Rosetta share means an arm64-only guest, which is fine.
set -eu
mkdir -p /mnt/rosetta
mount -t virtiofs rosetta /mnt/rosetta 2>/dev/null || exit 0
[ -x /mnt/rosetta/rosetta ] || exit 0
mountpoint -q /proc/sys/fs/binfmt_misc || mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
# The F flag opens the interpreter AT REGISTRATION, which is why this cannot be a static
# /etc/binfmt.d drop-in: with no share attached that registration fails and leaves a failed unit.
printf ':rosetta:M::\x7fELF\x02\x01\x01\x00\x00\x00\x00\x00\x00\x00\x00\x00\x02\x00\x3e\x00:\xff\xff\xff\xff\xff\xfe\xfe\x00\xff\xff\xff\xff\xff\xff\xff\xff\xfb\xff\xff\xff:/mnt/rosetta/rosetta:CF' \
  > /proc/sys/fs/binfmt_misc/register
echo "ac-rosetta: x86_64 binaries will run under Rosetta"
EOF
  chmod +x "$ROOTFS/usr/local/sbin/ac-register-rosetta"
}

configure_guest() {
  log "configuring the guest"
  echo "agentconnect-vm" > "$ROOTFS/etc/hostname"
  printf '127.0.0.1\tlocalhost\n127.0.1.1\tagentconnect-vm\n' > "$ROOTFS/etc/hosts"

  # Only the root filesystem: everything else this guest mounts is conditional on the host having
  # passed it, and a declared mount for a tag that was not passed is a failed unit at boot.
  printf 'LABEL=root\t/\text4\tdefaults\t0 1\n' > "$ROOTFS/etc/fstab"

  # The boot secret the shim proves its incarnation with, at the path the shim already reads
  # (SHIM_IDENTITY_TOKEN_PATH). Read-only, and an automount so a guest booted without it still
  # comes up rather than failing a unit.
  mkdir -p "$ROOTFS/var/run/ac-identity" "$ROOTFS/mnt/acdata" "$ROOTFS/mnt/rosetta"
  printf 'acboot\t/var/run/ac-identity\tvirtiofs\tro,noauto,nofail,x-systemd.automount,x-systemd.mount-timeout=5s\t0 0\n' \
    >> "$ROOTFS/etc/fstab"

  cat > "$ROOTFS/etc/systemd/network/10-virtio.network" << 'EOF'
[Match]
Name=en*

[Network]
DHCP=yes
EOF

  # Autologin on the virtio console: the only way in before the network is up, and the console is
  # not reachable from outside the host process that owns it.
  mkdir -p "$ROOTFS/etc/systemd/system/serial-getty@hvc0.service.d"
  cat > "$ROOTFS/etc/systemd/system/serial-getty@hvc0.service.d/autologin.conf" << 'EOF'
[Service]
ExecStart=
ExecStart=-/sbin/agetty --autologin root --noclear %I $TERM
EOF

  if [[ "$WITH_SSH" == "1" ]]; then
    # Regenerated on first boot: baking host keys into a shared image would give every guest ever
    # cloned from it the same identity.
    rm -f "$ROOTFS"/etc/ssh/ssh_host_*
    cat > "$ROOTFS/etc/systemd/system/regenerate-ssh-host-keys.service" << 'EOF'
[Unit]
Description=Regenerate ssh host keys on first boot
Before=ssh.service
ConditionPathExistsGlob=!/etc/ssh/ssh_host_*_key

[Service]
Type=oneshot
ExecStart=/usr/bin/ssh-keygen -A

[Install]
WantedBy=multi-user.target
EOF
  fi

  # Kept aside because the data disk mounts over /agent at boot: without this the runtime's HOME
  # is an empty directory on first boot rather than the one the image prepared.
  if [[ -d "$ROOTFS/agent" ]] && [[ -n "$(ls -A "$ROOTFS/agent" 2> /dev/null)" ]]; then
    mkdir -p "$ROOTFS/opt/agentconnect"
    cp -a "$ROOTFS/agent" "$ROOTFS/opt/agentconnect/agent-skel"
    log "stashed the /agent home skeleton for first boot"
  fi

  # Three drivers the guest cannot come up without, and none of them arrives on its own.
  #
  # `virtio_console` is a MODULE and `MODULES=most` does not include it, so `console=hvc0` names a
  # device whose driver never loads and the guest boots to a completely silent console. It has to
  # be in the initrd, not merely on the rootfs, because the console is wanted before switch_root.
  #
  # The vsock transport and virtiofs are needed by userspace rather than early boot, but waiting on
  # modalias autoload is a race: socat binding AF_VSOCK before the transport is up fails the
  # forward, and the host then sees its connection reset with nothing in the log to say why.
  printf 'virtio_console\nvirtio_blk\nvirtiofs\n' > "$ROOTFS/etc/initramfs-tools/modules"
  printf '# The guest is reached over vsock and shares arrive over virtiofs.\nvmw_vsock_virtio_transport\nvirtiofs\n' \
    > "$ROOTFS/etc/modules-load.d/agentconnect.conf"

  local units=(systemd-networkd systemd-resolved agentconnect-shim ac-data-disk ac-rosetta "vsock-forward@8085")
  [[ "$WITH_SSH" == "1" ]] && units+=(ssh regenerate-ssh-host-keys "vsock-forward@22")
  [[ "$WITH_DOCKER" == "1" ]] && units+=(docker containerd)
  in_chroot systemctl enable "${units[@]}" > /dev/null 2>&1
  # Nothing waits on the network here; the shim's peer dials in over vsock.
  in_chroot systemctl disable systemd-networkd-wait-online.service > /dev/null 2>&1 || true
  # The runtime user comes from the BASE image, so a test base may not have one.
  if [[ "$WITH_DOCKER" == "1" ]]; then
    in_chroot id -u agent > /dev/null 2>&1 && in_chroot usermod -aG docker agent || log "no 'agent' user in the base; skipping docker group"
  fi
}

rebuild_initramfs() {
  log "rebuilding the initrd with the virtio drivers"
  # `-k all` rather than `-u`: in a chroot the "current" kernel is the BUILDER's, so a plain update
  # can silently target a version that is not installed here. Failures are fatal: a guest whose
  # initrd lacks virtio_console boots to a completely silent console with nothing to debug from.
  in_chroot update-initramfs -u -k all
  local initrd listing
  initrd="$(ls "$ROOTFS"/boot/initrd.img-* | head -1)"
  # Read the initrd from INSIDE the chroot: its initramfs-tools matches the initrd it produced,
  # and a listing that fails for its own reasons would otherwise read as a missing driver.
  if ! listing="$(in_chroot lsinitramfs "/boot/$(basename "$initrd")" 2>&1)"; then
    echo "agent-image: could not read the generated initrd:" >&2
    printf '%s\n' "$listing" | tail -5 >&2
    exit 1
  fi
  # Available means built into the kernel OR carried in the initrd, and which one it is depends on
  # the suite: trixie's kernel compiles virtio_console and virtiofs in, bookworm's ships them as
  # modules that `MODULES=most` does not pick up. Checking only the initrd fails a perfectly good
  # trixie image; checking only the config fails a bookworm one.
  # Spelled out rather than derived: the module name and its config symbol do not match for
  # virtiofs (CONFIG_VIRTIO_FS), and a transform that guesses passes the check by accident.
  local config missing=() entry module symbol
  config="$(ls "$ROOTFS"/boot/config-* 2> /dev/null | head -1)"
  for entry in "virtio_console:CONFIG_VIRTIO_CONSOLE" "virtiofs:CONFIG_VIRTIO_FS"; do
    module="${entry%%:*}"
    symbol="${entry##*:}"
    grep -q "^$symbol=y" "$config" 2> /dev/null && continue
    grep -q "$module" <<< "$listing" && continue
    missing+=("$module")
  done
  if ((${#missing[@]})); then
    echo "agent-image: ${missing[*]} is neither built into the kernel nor in the initrd;" >&2
    echo "             the guest would boot to a silent console with nothing to debug from" >&2
    exit 1
  fi
  log "virtio_console and virtiofs are reachable at boot"
}

export_kernel() {
  log "extracting the kernel"
  local vmlinuz initrd
  vmlinuz="$(ls "$ROOTFS"/boot/vmlinuz-* | head -1)"
  initrd="$(ls "$ROOTFS"/boot/initrd.img-* | head -1)"
  python3 /guest/extract-kernel.py "$vmlinuz" "$OUT/kernel"
  cp "$initrd" "$OUT/initrd.img"
}

finalize() {
  log "finalizing"
  rm -f "$ROOTFS/usr/sbin/policy-rc.d"
  in_chroot apt-get clean
  rm -rf "$ROOTFS/var/lib/apt/lists"/* "$ROOTFS/tmp"/* || true
  : > "$ROOTFS/etc/machine-id"
  umount -l "$ROOTFS/dev/pts" "$ROOTFS/dev" "$ROOTFS/sys" "$ROOTFS/proc"
}

build_disk() {
  log "building the root filesystem ($DISK_SIZE)"
  # -d populates from a directory tree with no loop device, which a container cannot get. The
  # pseudo filesystems above are unmounted first or /proc and /dev end up inside the image.
  # Built locally then copied sparsely: written straight to the host mount, an 8 GiB image would
  # materialize every zero block instead of staying a hole.
  truncate -s "$DISK_SIZE" /disk.img
  mkfs.ext4 -q -F -L root -d "$ROOTFS" /disk.img
  cp --sparse=always /disk.img "$OUT/disk.img"
}

export_runtime_table() {
  # The image declares what runtimes it ships, generated by PROBING itself at build time. Copied out
  # so the daemon can read it without booting a probe guest, and so it can never drift from the
  # rootfs in the same bundle.
  local table="$ROOTFS/opt/agentconnect/runtime/k8s-runtimes.json"
  if [[ -f "$table" ]]; then
    cp "$table" "$OUT/k8s-runtimes.json"
    log "exported the image's declared runtime table"
  else
    log "base declares no runtime table; the daemon will fall back to its own catalog"
  fi
}

write_manifest() {
  log "writing the manifest"
  local docker_version="null" bridged='[8085]'
  [[ "$WITH_SSH" == "1" ]] && bridged='[22, 8085]'
  if [[ "$WITH_DOCKER" == "1" ]]; then
    docker_version="\"$(in_chroot dpkg-query -W -f='${Version}' docker.io 2> /dev/null || echo unknown)\""
  fi
  cat > "$OUT/manifest.json" << EOF
{
  "suite": "$SUITE",
  "architecture": "$ARCH",
  "kernelCommandLine": "console=hvc0 root=/dev/vda rw loglevel=4",
  "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "bridgedPorts": $bridged,
  "docker": $([[ "$WITH_DOCKER" == "1" ]] && echo true || echo false),
  "dockerVersion": $docker_version,
  "compose": "$COMPOSE_KIND",
  "base": "${AC_FROM:-unknown}",
  "kernelRelease": "$(basename "$(ls "$ROOTFS"/boot/vmlinuz-* | head -1)" | sed 's/^vmlinuz-//')"
}
EOF
}

builder_tools
unpack_base
detect_suite
prepare_chroot
install_boot_layer
write_units
configure_guest
rebuild_initramfs
export_kernel
export_runtime_table
write_manifest
finalize
build_disk
log "done: $OUT"
