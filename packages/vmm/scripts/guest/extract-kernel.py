#!/usr/bin/env python3
"""Turn a Debian vmlinuz into the raw image VZLinuxBootLoader expects.

Debian ships arm64 kernels as EFI zboot binaries: a small PE stub wrapping a
compressed Image. Virtualization.framework will not boot that, so unwrap it here
using the zboot header rather than objcopy, which keeps this runnable anywhere.
"""
import gzip
import lzma
import struct
import subprocess
import sys
from pathlib import Path

ARM64_IMAGE_MAGIC = b"ARM\x64"
ARM64_MAGIC_OFFSET = 0x38

ZBOOT_MAGIC = b"zimg"
ZBOOT_MAGIC_OFFSET = 12
ZBOOT_PAYLOAD_STRUCT = "<II"          # payload_offset, payload_size
ZBOOT_PAYLOAD_OFFSET = 16
ZBOOT_COMPRESS_TYPE_OFFSET = 32
ZBOOT_COMPRESS_TYPE_SIZE = 32


def zstd_decompress(blob):
    return subprocess.run(
        ["zstd", "-d", "-c"], input=blob, stdout=subprocess.PIPE, check=True
    ).stdout


DECOMPRESSORS = {
    "gzip": gzip.decompress,
    "xzkern": lzma.decompress,
    "lzma": lambda blob: lzma.decompress(blob, format=lzma.FORMAT_ALONE),
    "zstd22": zstd_decompress,
}


def is_raw_arm64_image(blob):
    return blob[ARM64_MAGIC_OFFSET:ARM64_MAGIC_OFFSET + 4] == ARM64_IMAGE_MAGIC


def is_zboot(blob):
    return (
        blob[:2] == b"MZ"
        and blob[ZBOOT_MAGIC_OFFSET:ZBOOT_MAGIC_OFFSET + 4] == ZBOOT_MAGIC
    )


def unwrap_zboot(blob):
    offset, size = struct.unpack_from(ZBOOT_PAYLOAD_STRUCT, blob, ZBOOT_PAYLOAD_OFFSET)
    end = offset + size
    if end > len(blob):
        raise SystemExit(f"extract-kernel: zboot payload runs past end of file ({end} > {len(blob)})")

    raw = blob[ZBOOT_COMPRESS_TYPE_OFFSET:ZBOOT_COMPRESS_TYPE_OFFSET + ZBOOT_COMPRESS_TYPE_SIZE]
    compression = raw.split(b"\x00")[0].decode("ascii", "replace")
    decompress = DECOMPRESSORS.get(compression)
    if decompress is None:
        raise SystemExit(
            f"extract-kernel: zboot uses '{compression}', which this script cannot decompress"
        )
    return decompress(blob[offset:end]), f"EFI zboot ({compression})"


def extract(source):
    blob = source.read_bytes()

    if is_raw_arm64_image(blob):
        return blob, "raw arm64 Image"
    if is_zboot(blob):
        return unwrap_zboot(blob)
    if blob[:2] == b"\x1f\x8b":
        return gzip.decompress(blob), "gzip"
    if blob[:2] == b"MZ":
        # An amd64 bzImage is also PE, and Virtualization.framework boots it as is.
        return blob, "PE image, passed through"

    raise SystemExit(f"extract-kernel: unrecognised kernel format in {source}")


def main(argv):
    if len(argv) != 3:
        raise SystemExit("usage: extract-kernel.py VMLINUZ OUTPUT")
    source, destination = Path(argv[1]), Path(argv[2])
    payload, kind = extract(source)
    if not is_raw_arm64_image(payload) and payload[:2] != b"MZ":
        print(f"extract-kernel: warning: {kind} did not yield a recognisable kernel", file=sys.stderr)
    destination.write_bytes(payload)
    print(f"extract-kernel: {source.name} -> {destination} ({kind}, {len(payload)} bytes)")


if __name__ == "__main__":
    main(sys.argv)
