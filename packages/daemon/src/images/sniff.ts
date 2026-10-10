// Magic-byte sniffing and header-only inspection for shared images (webchat-generated-images.md §5).

export type SharedImageMime = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/svg+xml'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** The shared-image type the bytes declare by content, never by name; GIF is named so callers can refuse it explicitly. */
export function sniffSharedImage(bytes: Buffer): SharedImageMime | 'image/gif' | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
    return 'image/webp'
  const head6 = bytes.toString('latin1', 0, 6)
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'image/gif'
  if (looksLikeSvg(bytes)) return 'image/svg+xml'
  return undefined
}

// A text prefix (optional BOM, XML declaration, comments, whitespace) that reaches an `<svg` start tag.
function looksLikeSvg(bytes: Buffer): boolean {
  let text = bytes.toString('utf8', 0, Math.min(bytes.length, 4096))
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  let rest = text.trimStart()
  for (let i = 0; i < 64; i++) {
    if (rest.startsWith('<?xml')) {
      const end = rest.indexOf('?>')
      if (end < 0) return false
      rest = rest.slice(end + 2).trimStart()
    } else if (rest.startsWith('<!--')) {
      const end = rest.indexOf('-->')
      if (end < 0) return false
      rest = rest.slice(end + 3).trimStart()
    } else if (rest.startsWith('<!DOCTYPE') || rest.startsWith('<!doctype')) {
      // Sniffed as SVG so the safety check can refuse it by name rather than as "not an image".
      return /<svg[\s>/]/.test(rest)
    } else break
  }
  return /^<svg[\s>/]/.test(rest)
}

export type RasterHeader =
  { ok: true; width: number; height: number; animated: boolean } | { ok: false; reason: 'corrupt'; detail: string }

/** Width, height and animation from the container headers alone, before any decoder allocates pixels. */
export function rasterHeader(bytes: Buffer, mime: Exclude<SharedImageMime, 'image/svg+xml'>): RasterHeader {
  try {
    if (mime === 'image/png') return pngHeader(bytes)
    if (mime === 'image/jpeg') return jpegHeader(bytes)
    return webpHeader(bytes)
  } catch (err) {
    return { ok: false, reason: 'corrupt', detail: err instanceof Error ? err.message : String(err) }
  }
}

function pngHeader(bytes: Buffer): RasterHeader {
  if (bytes.length < 33 || bytes.toString('latin1', 12, 16) !== 'IHDR')
    return { ok: false, reason: 'corrupt', detail: 'PNG has no IHDR' }
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  if (!width || !height) return { ok: false, reason: 'corrupt', detail: 'PNG has a zero dimension' }
  let animated = false
  let sawIdat = false
  let sawIend = false
  // Walk the chunk list: APNG declares acTL before the first IDAT, and a complete file ends with IEND.
  for (let off = 8; off + 8 <= bytes.length;) {
    const len = bytes.readUInt32BE(off)
    const type = bytes.toString('latin1', off + 4, off + 8)
    if (off + 12 + len > bytes.length) return { ok: false, reason: 'corrupt', detail: `PNG chunk ${type} is truncated` }
    if (type === 'acTL') animated = true
    if (type === 'IDAT') sawIdat = true
    if (type === 'IEND') {
      sawIend = true
      break
    }
    off += 12 + len
  }
  if (!sawIdat || !sawIend) return { ok: false, reason: 'corrupt', detail: 'PNG is incomplete' }
  return { ok: true, width, height, animated }
}

function jpegHeader(bytes: Buffer): RasterHeader {
  let off = 2
  while (off + 4 <= bytes.length) {
    if (bytes[off] !== 0xff) return { ok: false, reason: 'corrupt', detail: 'JPEG marker expected' }
    const marker = bytes[off + 1]!
    // Fill bytes and standalone markers carry no length.
    if (marker === 0xff) {
      off += 1
      continue
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      off += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const len = bytes.readUInt16BE(off + 2)
    if (len < 2 || off + 2 + len > bytes.length)
      return { ok: false, reason: 'corrupt', detail: 'JPEG segment is truncated' }
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = bytes.readUInt16BE(off + 5)
      const width = bytes.readUInt16BE(off + 7)
      if (!width || !height) return { ok: false, reason: 'corrupt', detail: 'JPEG has a zero dimension' }
      return { ok: true, width, height, animated: false }
    }
    off += 2 + len
  }
  return { ok: false, reason: 'corrupt', detail: 'JPEG has no frame header' }
}

function webpHeader(bytes: Buffer): RasterHeader {
  const riffSize = bytes.readUInt32LE(4)
  if (riffSize + 8 > bytes.length || bytes.length < 30)
    return { ok: false, reason: 'corrupt', detail: 'WebP is truncated' }
  let width = 0
  let height = 0
  let animated = false
  for (let off = 12; off + 8 <= riffSize + 8;) {
    const type = bytes.toString('latin1', off, off + 4)
    const len = bytes.readUInt32LE(off + 4)
    const data = off + 8
    if (data + len > bytes.length) return { ok: false, reason: 'corrupt', detail: `WebP chunk ${type} is truncated` }
    if (type === 'VP8X') {
      if (bytes[data]! & 0x02) animated = true
      width = 1 + bytes.readUIntLE(data + 4, 3)
      height = 1 + bytes.readUIntLE(data + 7, 3)
    } else if (type === 'ANIM' || type === 'ANMF') {
      animated = true
    } else if (type === 'VP8 ' && !width) {
      if (bytes[data + 3] !== 0x9d || bytes[data + 4] !== 0x01 || bytes[data + 5] !== 0x2a)
        return { ok: false, reason: 'corrupt', detail: 'WebP VP8 frame tag is invalid' }
      width = bytes.readUInt16LE(data + 6) & 0x3fff
      height = bytes.readUInt16LE(data + 8) & 0x3fff
    } else if (type === 'VP8L' && !width) {
      if (bytes[data] !== 0x2f) return { ok: false, reason: 'corrupt', detail: 'WebP VP8L signature is invalid' }
      const bits = bytes.readUInt32LE(data + 1)
      width = 1 + (bits & 0x3fff)
      height = 1 + ((bits >> 14) & 0x3fff)
    }
    off = data + len + (len & 1)
  }
  if (!width || !height) return { ok: false, reason: 'corrupt', detail: 'WebP has no image data' }
  return { ok: true, width, height, animated }
}

const EXTENSIONS: Record<SharedImageMime, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/svg+xml': 'svg'
}

/** `<stem>.<ext>` from a model-supplied name and the SNIFFED type, stripped of path and control characters. */
export function sharedImageName(name: string, mime: SharedImageMime): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const stem =
    base
      .replace(/\.[A-Za-z0-9]+$/, '')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .trim()
      .slice(0, 200) || 'image'
  return `${stem}.${EXTENSIONS[mime]}`
}

export function extensionFor(mime: SharedImageMime): string {
  return EXTENSIONS[mime]
}
