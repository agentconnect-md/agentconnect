#!/usr/bin/env python3
"""Run with: python3 scripts/guest/test_extract_kernel.py"""
import gzip
import importlib.util
import lzma
import struct
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "extract_kernel", Path(__file__).with_name("extract-kernel.py")
)
extract_kernel = importlib.util.module_from_spec(spec)
spec.loader.exec_module(extract_kernel)


def raw_arm64_image(payload=b"kernel bytes"):
    blob = bytearray(0x40 + len(payload))
    blob[0x38:0x3C] = b"ARM\x64"
    blob[0x40:] = payload
    return bytes(blob)


def zboot_image(payload, compression, header_size=64):
    """Mirrors struct linux_efi_zboot_header."""
    blob = bytearray(header_size)
    blob[0:2] = b"MZ"
    blob[12:16] = b"zimg"
    struct.pack_into("<II", blob, 16, header_size, len(payload))
    blob[32:32 + len(compression)] = compression
    return bytes(blob) + payload


class ExtractTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)

    def write(self, blob, name="vmlinuz"):
        path = Path(self.directory.name) / name
        path.write_bytes(blob)
        return path

    def test_raw_arm64_image_passes_through(self):
        blob = raw_arm64_image()
        payload, kind = extract_kernel.extract(self.write(blob))
        self.assertEqual(payload, blob)
        self.assertEqual(kind, "raw arm64 Image")

    def test_gzip_is_decompressed(self):
        inner = raw_arm64_image(b"compressed kernel")
        payload, kind = extract_kernel.extract(self.write(gzip.compress(inner)))
        self.assertEqual(payload, inner)
        self.assertEqual(kind, "gzip")

    def test_pe_without_zboot_magic_passes_through(self):
        blob = b"MZ" + b"\x00" * 512
        payload, kind = extract_kernel.extract(self.write(blob))
        self.assertEqual(payload, blob)
        self.assertEqual(kind, "PE image, passed through")

    def test_zboot_gzip_is_unwrapped(self):
        inner = raw_arm64_image(b"zboot payload")
        blob = zboot_image(gzip.compress(inner), b"gzip")
        payload, kind = extract_kernel.extract(self.write(blob))
        self.assertEqual(payload, inner)
        self.assertEqual(kind, "EFI zboot (gzip)")

    def test_zboot_xz_is_unwrapped(self):
        inner = raw_arm64_image(b"xz payload")
        blob = zboot_image(lzma.compress(inner), b"xzkern")
        payload, kind = extract_kernel.extract(self.write(blob))
        self.assertEqual(payload, inner)

    def test_zboot_with_unsupported_compression_is_rejected(self):
        blob = zboot_image(b"whatever", b"lzo")
        with self.assertRaises(SystemExit) as caught:
            extract_kernel.extract(self.write(blob))
        self.assertIn("lzo", str(caught.exception))

    def test_zboot_with_payload_past_end_is_rejected(self):
        blob = bytearray(zboot_image(gzip.compress(b"x"), b"gzip"))
        struct.pack_into("<II", blob, 16, 64, 1 << 20)
        with self.assertRaises(SystemExit) as caught:
            extract_kernel.extract(self.write(bytes(blob)))
        self.assertIn("past end", str(caught.exception))

    def test_unknown_format_is_rejected(self):
        with self.assertRaises(SystemExit):
            extract_kernel.extract(self.write(b"not a kernel at all" * 8))

    def test_magic_must_be_at_the_right_offset(self):
        self.assertFalse(extract_kernel.is_raw_arm64_image(b"ARM\x64" + b"\x00" * 128))
        self.assertTrue(extract_kernel.is_raw_arm64_image(raw_arm64_image()))

    def test_main_writes_output(self):
        source = self.write(gzip.compress(raw_arm64_image(b"payload")))
        destination = Path(self.directory.name) / "kernel"
        extract_kernel.main(["extract-kernel.py", str(source), str(destination)])
        self.assertEqual(destination.read_bytes(), raw_arm64_image(b"payload"))

    def test_main_rejects_wrong_arity(self):
        with self.assertRaises(SystemExit):
            extract_kernel.main(["extract-kernel.py"])


if __name__ == "__main__":
    unittest.main()
