#!/usr/bin/env bash
# Builds a bootable VM guest image from an OCI image's root filesystem.
#
# The base is a parameter rather than a build: the agent image derives from the SAME
# runtime-sandbox image the cluster path runs, so there is one definition of what a runtime image
# contains. Passing a different base is how this gets tested without provider credentials.
#
# The rootfs is populated with `mkfs.ext4 -d`, which needs no loop device and therefore works
# inside a container. macOS has no mkfs.ext4 at all, which is why the work happens in Docker.
set -euo pipefail

FROM_IMAGE="ghcr.io/agentconnect-md/runtime-sandbox:latest"
OUTPUT="image"
ARCH=""
SUITE=""
DISK_SIZE="12G"
BUILDER_IMAGE=""
DOCKER=1
SSH=1

usage() {
  cat << 'HELPTEXT'
build-agent-image.sh - build a bootable VM guest from an OCI image

USAGE
  build-agent-image.sh [options]

OPTIONS
  --from IMAGE       OCI image whose rootfs becomes the guest (default: runtime-sandbox:latest)
  --output DIR       where to write the bundle (default: image)
  --arch ARCH        arm64 | amd64 (default: the host's)
  --suite SUITE      Debian suite of the base (default: read from the base's /etc/os-release)
  --disk-size SIZE   rootfs size, e.g. 12G (default: 12G)
  --builder IMAGE    builder container (default: debian:<suite>)
  --no-docker        leave Docker out of the guest
  --no-ssh           leave the ssh server out of the guest
  -h, --help
HELPTEXT
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      FROM_IMAGE="$2"
      shift 2
      ;;
    --output)
      OUTPUT="$2"
      shift 2
      ;;
    --arch)
      ARCH="$2"
      shift 2
      ;;
    --suite)
      SUITE="$2"
      shift 2
      ;;
    --disk-size)
      DISK_SIZE="$2"
      shift 2
      ;;
    --builder)
      BUILDER_IMAGE="$2"
      shift 2
      ;;
    --no-docker)
      DOCKER=0
      shift
      ;;
    --no-ssh)
      SSH=0
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "build-agent-image.sh: unknown option '$1'" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$ARCH" ]]; then
  case "$(uname -m)" in
    arm64 | aarch64) ARCH="arm64" ;;
    x86_64 | amd64) ARCH="amd64" ;;
    *)
      echo "build-agent-image.sh: unsupported host architecture $(uname -m)" >&2
      exit 2
      ;;
  esac
fi
# The builder only unpacks, chroots and mkfs: its own suite need not match the base's.
BUILDER_IMAGE="${BUILDER_IMAGE:-debian:trixie}"

command -v docker > /dev/null || {
  echo "build-agent-image.sh: docker is required" >&2
  exit 2
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$OUTPUT"
OUTPUT_ABS="$(cd "$OUTPUT" && pwd)"

echo "==> exporting the rootfs of $FROM_IMAGE ($ARCH)"
# `create` + `export` rather than `save`: this wants the flattened filesystem, not layers.
CONTAINER="$(docker create --platform "linux/$ARCH" "$FROM_IMAGE" /bin/true)"
docker export "$CONTAINER" > "$WORK/base-rootfs.tar"
docker rm -f "$CONTAINER" > /dev/null

echo "==> building the guest (boot layer, kernel, ext4)"
exec docker run --rm --privileged --platform "linux/$ARCH" \
  -e "AC_ARCH=$ARCH" -e "AC_SUITE=$SUITE" -e "AC_DISK_SIZE=$DISK_SIZE" \
  -e "AC_DOCKER=$DOCKER" -e "AC_SSH=$SSH" -e "AC_FROM=$FROM_IMAGE" \
  -v "$SCRIPT_DIR/guest:/guest:ro" \
  -v "$WORK:/work" \
  -v "$OUTPUT_ABS:/out" \
  "$BUILDER_IMAGE" /guest/agent-image.sh
