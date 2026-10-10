import { decodeRaster, encodeToFit, MAX_DECODED_PIXELS, PREVIEW_MAX_EDGE, renderSvg } from './raster.js'
import { rasterHeader, type SharedImageMime } from './sniff.js'
import { checkStaticSvg } from './svg-safety.js'

// One preview preparation, run inside the worker so decoding stays within its memory and time limits.

export type PreviewFailureReason =
  'not-image' | 'gif' | 'animated' | 'corrupt' | 'too-many-pixels' | 'unsafe-svg' | 'timeout' | 'busy' | 'no-fit'

export type PreviewJobInput = { bytes: Uint8Array; mime: SharedImageMime; maxPreviewBytes: number }

export type PreviewJobResult =
  | {
      ok: true
      preview: { mimeType: SharedImageMime; data: Uint8Array; width?: number; height?: number }
      inline: boolean
    }
  | { ok: false; reason: PreviewFailureReason; detail?: string }

const message = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 200)

export async function runPreviewJob(input: PreviewJobInput): Promise<PreviewJobResult> {
  const bytes = Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength)
  const fits = bytes.byteLength <= input.maxPreviewBytes
  if (input.mime === 'image/svg+xml') {
    const svg = checkStaticSvg(bytes)
    if (!svg.ok) return { ok: false, reason: 'unsafe-svg', detail: svg.detail }
    // A small SVG travels as itself; it is only ever rendered as an image resource.
    if (fits) return { ok: true, inline: true, preview: { mimeType: 'image/svg+xml', data: input.bytes, ...svg } }
    let rendered
    try {
      rendered = await renderSvg(bytes, PREVIEW_MAX_EDGE)
    } catch (err) {
      return { ok: false, reason: 'corrupt', detail: `SVG could not be rendered: ${message(err)}` }
    }
    return fitted(rendered, input.maxPreviewBytes)
  }
  const header = rasterHeader(bytes, input.mime)
  if (!header.ok) return { ok: false, reason: 'corrupt', detail: header.detail }
  if (header.animated) return { ok: false, reason: 'animated', detail: 'animated images are not supported' }
  if (header.width * header.height > MAX_DECODED_PIXELS) {
    return {
      ok: false,
      reason: 'too-many-pixels',
      detail: `${header.width}x${header.height} exceeds ${MAX_DECODED_PIXELS / 1_000_000} megapixels`
    }
  }
  let decoded
  try {
    decoded = await decodeRaster(bytes, input.mime)
  } catch (err) {
    return { ok: false, reason: 'corrupt', detail: message(err) }
  }
  if (decoded.width !== header.width || decoded.height !== header.height)
    return { ok: false, reason: 'corrupt', detail: 'decoded size does not match the header' }
  // A validated original that fits is sent unchanged, never re-encoded.
  if (fits)
    return {
      ok: true,
      inline: true,
      preview: { mimeType: input.mime, data: input.bytes, width: header.width, height: header.height }
    }
  return fitted(decoded, input.maxPreviewBytes)
}

function fitted(img: Parameters<typeof encodeToFit>[0], maxBytes: number): PreviewJobResult {
  const encoded = encodeToFit(img, maxBytes)
  if (!encoded) return { ok: false, reason: 'no-fit', detail: `no preview fits ${maxBytes} bytes` }
  return {
    ok: true,
    inline: false,
    preview: {
      mimeType: encoded.mimeType,
      data: new Uint8Array(encoded.data.buffer, encoded.data.byteOffset, encoded.data.byteLength),
      width: encoded.width,
      height: encoded.height
    }
  }
}
