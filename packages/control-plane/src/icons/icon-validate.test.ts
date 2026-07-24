import { describe, it, expect } from 'vitest'
import { sniffIconType, validateIconUpload, MAX_ICON_BYTES, MAX_ICON_DIM } from './icon-validate.js'

// Magic-byte-only fixtures (enough for sniffIconType, which reads just the signature).
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
// "<svg " — a real SVG upload attempt; must be rejected (script vector).
const SVG = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20])

// A minimal but dimension-readable PNG (8-byte sig + IHDR with width/height).
function pngOf(w: number, h: number): Uint8Array {
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a, // signature
    0x00,
    0x00,
    0x00,
    0x0d,
    0x49,
    0x48,
    0x44,
    0x52, // IHDR length + "IHDR"
    (w >>> 24) & 255,
    (w >>> 16) & 255,
    (w >>> 8) & 255,
    w & 255,
    (h >>> 24) & 255,
    (h >>> 16) & 255,
    (h >>> 8) & 255,
    h & 255,
    0x08,
    0x06,
    0x00,
    0x00,
    0x00 // bit depth / color type / …
  ])
}

describe('sniffIconType', () => {
  it('recognizes PNG / JPEG / WebP by magic bytes', () => {
    expect(sniffIconType(PNG_SIG)).toBe('image/png')
    expect(sniffIconType(JPEG)).toBe('image/jpeg')
    expect(sniffIconType(WEBP)).toBe('image/webp')
  })
  it('rejects SVG and other non-raster content', () => {
    expect(sniffIconType(SVG)).toBeNull()
    expect(sniffIconType(new Uint8Array([1, 2, 3]))).toBeNull()
    // WebP with a bad trailer (RIFF but not WEBP) is not accepted
    expect(sniffIconType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull()
  })
})

describe('validateIconUpload', () => {
  it('accepts a within-bounds PNG and returns the sniffed type', () => {
    expect(validateIconUpload(pngOf(256, 256))).toEqual({ ok: true, contentType: 'image/png' })
  })
  it('rejects an SVG with 415 (never trusts the caller Content-Type)', () => {
    const r = validateIconUpload(SVG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(415)
  })
  it('rejects an empty upload with 415', () => {
    const r = validateIconUpload(new Uint8Array([]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(415)
  })
  it('rejects an over-byte-size upload with 413', () => {
    const big = new Uint8Array(MAX_ICON_BYTES + 1)
    big.set(pngOf(16, 16), 0)
    const r = validateIconUpload(big)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(413)
  })
  it('rejects an over-DIMENSION image with 413 (decompression-bomb guard)', () => {
    const r = validateIconUpload(pngOf(MAX_ICON_DIM + 1, 8))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(413)
  })
  it('rejects a valid signature with no readable dimensions', () => {
    // PNG magic but truncated before the IHDR dimensions.
    const r = validateIconUpload(PNG_SIG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(415)
  })
})
