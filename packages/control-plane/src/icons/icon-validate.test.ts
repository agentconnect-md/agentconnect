import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { sniffIconType, validateIconUpload, MAX_ICON_BYTES, MAX_ICON_DIM } from './icon-validate.js'

// Magic-byte-only fixtures (enough for sniffIconType, which reads just the signature).
const PNG_SIG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0])
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])
// "<svg " — a real SVG upload attempt; must be rejected (script vector).
const SVG = new Uint8Array([0x3c, 0x73, 0x76, 0x67, 0x20])

function pngOf(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 4, background: '#ffffff' } })
    .png()
    .toBuffer()
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
  it.each(['png', 'jpeg', 'webp'] as const)(
    'accepts a within-bounds %s and returns the sniffed type',
    async (format) => {
      const bytes = await sharp({ create: { width: 256, height: 256, channels: 4, background: '#ffffff' } })
        .toFormat(format)
        .toBuffer()
      expect(await validateIconUpload(bytes)).toEqual({ ok: true, contentType: `image/${format}` })
    }
  )
  it('rejects an SVG with 415 (never trusts the caller Content-Type)', async () => {
    const r = await validateIconUpload(SVG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(415)
  })
  it('rejects an empty upload with 415', async () => {
    const r = await validateIconUpload(new Uint8Array([]))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(415)
  })
  it('rejects an over-byte-size upload with 413', async () => {
    const big = new Uint8Array(MAX_ICON_BYTES + 1)
    big.set(PNG_SIG, 0)
    const r = await validateIconUpload(big)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(413)
  })
  it('rejects an over-DIMENSION image with 413 (decompression-bomb guard)', async () => {
    const r = await validateIconUpload(await pngOf(MAX_ICON_DIM + 1, 8))
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(413)
  })
  it('rejects a valid signature with no readable dimensions', async () => {
    // PNG magic but truncated before the IHDR dimensions.
    const r = await validateIconUpload(PNG_SIG)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(415)
  })
})
