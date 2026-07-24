/**
 * `icons/icon-validate.ts` — server-side validation for uploaded icons.
 *
 * The client resizes/crops on a `<canvas>` and PUTs the bytes, but that is UNTRUSTED
 * (a caller can POST arbitrary bytes straight at the API). So the CP re-checks every
 * upload independently of the client:
 *  1. MAGIC BYTES → accept only raster PNG / JPEG / WebP. **SVG is rejected** (a script
 *     vector; these bytes are served from a public origin). The sniffed type — not the
 *     caller `Content-Type` — is what gets stored and served.
 *  2. DECODED DIMENSIONS → a valid signature says nothing about pixel size; a tiny
 *     compressed payload can declare enormous dimensions (a decompression bomb that
 *     browsers/Slack would allocate when decoding from the store). Parse the header
 *     dimensions and reject anything past a small cap so decode allocation is bounded.
 *
 * (`X-Content-Type-Options: nosniff` is NOT set here — the object is served directly
 *  from the store, bypassing the CP; that header is enforced at the CDN/bucket edge for
 *  `icon/*`. The stored `Content-Type` above still pins each object to an image type.)
 */
import { imageSize } from 'image-size'

/** Hard cap on a stored icon's bytes. The client normalizes to ≤256×256; this backstops it. */
export const MAX_ICON_BYTES = 512 * 1024
/** Hard cap on either decoded dimension (px). The client emits 256²; the headroom
 *  tolerates direct/retina uploads while still bounding a decode-bomb allocation. */
export const MAX_ICON_DIM = 512

export type IconContentType = 'image/png' | 'image/jpeg' | 'image/webp'

/** Sniff the magic bytes → the canonical content-type, or null if unsupported. */
export function sniffIconType(bytes: Uint8Array): IconContentType | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png'
  }
  // JPEG: FF D8 FF
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && // R
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x46 && // F
    bytes[8] === 0x57 && // W
    bytes[9] === 0x45 && // E
    bytes[10] === 0x42 && // B
    bytes[11] === 0x50 // P
  ) {
    return 'image/webp'
  }
  return null
}

export type IconValidation =
  { ok: true; contentType: IconContentType } | { ok: false; status: 413 | 415; message: string }

/** Enforce the byte cap + magic-byte allowlist + decoded-dimension cap. Returns the
 *  sniffed content-type. */
export function validateIconUpload(bytes: Uint8Array): IconValidation {
  if (bytes.length === 0) return { ok: false, status: 415, message: 'empty upload' }
  if (bytes.length > MAX_ICON_BYTES) {
    return { ok: false, status: 413, message: `icon exceeds ${MAX_ICON_BYTES} bytes` }
  }
  const contentType = sniffIconType(bytes)
  if (!contentType) {
    return { ok: false, status: 415, message: 'unsupported image type (allowed: PNG, JPEG, WebP)' }
  }
  // Dimensions from the header — the magic bytes above don't bound pixel size, and an
  // untrusted caller can declare a huge canvas (decompression bomb). Reject unreadable
  // or over-cap images before they land in the public store.
  let dims: { width?: number; height?: number }
  try {
    dims = imageSize(bytes)
  } catch {
    return { ok: false, status: 415, message: 'unreadable image header' }
  }
  if (!dims.width || !dims.height) {
    return { ok: false, status: 415, message: 'image has no readable dimensions' }
  }
  if (dims.width > MAX_ICON_DIM || dims.height > MAX_ICON_DIM) {
    return { ok: false, status: 413, message: `image exceeds ${MAX_ICON_DIM}×${MAX_ICON_DIM} px` }
  }
  return { ok: true, contentType }
}
