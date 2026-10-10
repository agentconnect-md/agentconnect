import { decode as decodeJpeg, encode as encodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'
import { imageWasmModule, type WasmModule } from './assets.js'
import { rasterFonts } from './fonts.js'

// Pure decode/resize/encode steps of preview preparation; they run inside the preview worker.

export type Rgba = { width: number; height: number; data: Uint8Array }

export const PREVIEW_MAX_EDGE = 1280
export const MAX_DECODED_PIXELS = 40_000_000
const MIN_EDGE = 32
const JPEG_QUALITIES = [85, 75, 60, 45]
const SHRINK = 0.75

export async function decodeRaster(bytes: Buffer, mime: 'image/png' | 'image/jpeg' | 'image/webp'): Promise<Rgba> {
  if (mime === 'image/png') {
    const png = PNG.sync.read(bytes)
    return {
      width: png.width,
      height: png.height,
      data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length)
    }
  }
  if (mime === 'image/jpeg') {
    const img = decodeJpeg(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_DECODED_PIXELS / 1_000_000,
      maxMemoryUsageInMB: 512
    })
    return { width: img.width, height: img.height, data: img.data }
  }
  return decodeWebp(bytes)
}

let webpDecoder:
  Promise<(data: ArrayBuffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>> | undefined

async function decodeWebp(bytes: Buffer): Promise<Rgba> {
  webpDecoder ??= (async () => {
    const mod = (await import('@jsquash/webp/decode.js')) as {
      init: (module: WasmModule) => Promise<void>
      default: (data: ArrayBuffer) => Promise<{ width: number; height: number; data: Uint8ClampedArray }>
    }
    await mod.init(await imageWasmModule('webpDecoder'))
    return mod.default
  })()
  const decode = await webpDecoder
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  const img = await decode(copy)
  return {
    width: img.width,
    height: img.height,
    data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.length)
  }
}

type ResvgModule = typeof import('@resvg/resvg-wasm')
let resvg: Promise<ResvgModule> | undefined

/** Render a vetted SVG at the preview's longest edge; resvg has no network or file access of its own. */
export async function renderSvg(bytes: Buffer, longestEdge = PREVIEW_MAX_EDGE): Promise<Rgba> {
  resvg ??= (async () => {
    const mod = await import('@resvg/resvg-wasm')
    await mod.initWasm(await imageWasmModule('resvg'))
    return mod
  })()
  const { Resvg } = await resvg
  const fonts = rasterFonts()
  const font = {
    fontBuffers: fonts.buffers,
    ...(fonts.defaultFamily ? { defaultFontFamily: fonts.defaultFamily, sansSerifFamily: fonts.defaultFamily } : {})
  }
  const probe = new Resvg(bytes, { font })
  const landscape = probe.width >= probe.height
  probe.free()
  const instance = new Resvg(bytes, {
    font,
    fitTo: landscape ? { mode: 'width', value: longestEdge } : { mode: 'height', value: longestEdge }
  })
  try {
    const rendered = instance.render()
    const out = { width: rendered.width, height: rendered.height, data: new Uint8Array(rendered.pixels) }
    rendered.free()
    return out
  } finally {
    instance.free()
  }
}

/** Area-average downscale over premultiplied alpha, so transparent edges do not bleed dark fringes. */
export function resizeArea(src: Rgba, width: number, height: number): Rgba {
  if (width === src.width && height === src.height) return src
  const out = new Uint8Array(width * height * 4)
  const sx = src.width / width
  const sy = src.height / height
  const acc = new Float64Array(width * 4)
  const weight = new Float64Array(width)
  for (let y = 0; y < height; y++) {
    acc.fill(0)
    weight.fill(0)
    const y0 = y * sy
    const y1 = Math.min(src.height, y0 + sy)
    for (let yy = Math.floor(y0); yy < y1; yy++) {
      const wy = Math.min(yy + 1, y1) - Math.max(yy, y0)
      const row = yy * src.width * 4
      for (let x = 0; x < width; x++) {
        const x0 = x * sx
        const x1 = Math.min(src.width, x0 + sx)
        for (let xx = Math.floor(x0); xx < x1; xx++) {
          const w = (Math.min(xx + 1, x1) - Math.max(xx, x0)) * wy
          const p = row + xx * 4
          const a = src.data[p + 3]! * w
          acc[x * 4] = acc[x * 4]! + src.data[p]! * a
          acc[x * 4 + 1] = acc[x * 4 + 1]! + src.data[p + 1]! * a
          acc[x * 4 + 2] = acc[x * 4 + 2]! + src.data[p + 2]! * a
          acc[x * 4 + 3] = acc[x * 4 + 3]! + a
          weight[x] = weight[x]! + w
        }
      }
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const alpha = acc[x * 4 + 3]!
      if (alpha > 0) {
        out[o] = Math.round(acc[x * 4]! / alpha)
        out[o + 1] = Math.round(acc[x * 4 + 1]! / alpha)
        out[o + 2] = Math.round(acc[x * 4 + 2]! / alpha)
      }
      out[o + 3] = Math.round(alpha / (weight[x] || 1))
    }
  }
  return { width, height, data: out }
}

export function hasTransparency(img: Rgba): boolean {
  for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! < 255) return true
  return false
}

export type EncodedPreview = { mimeType: 'image/png' | 'image/jpeg'; data: Buffer; width: number; height: number }

/** Shrink and re-encode until the ACTUAL encoded length fits; transparency keeps PNG, opaque content goes JPEG. */
export function encodeToFit(src: Rgba, maxBytes: number, maxEdge = PREVIEW_MAX_EDGE): EncodedPreview | undefined {
  const longest = Math.max(src.width, src.height)
  let scale = Math.min(1, maxEdge / longest)
  const alpha = hasTransparency(src)
  let base = src
  for (;;) {
    const width = Math.max(1, Math.round(src.width * scale))
    const height = Math.max(1, Math.round(src.height * scale))
    // Each step resizes from the previous (already smaller) image, which bounds the work after the first pass.
    base = resizeArea(base, Math.min(width, base.width), Math.min(height, base.height))
    if (alpha) {
      const png = new PNG({ width: base.width, height: base.height, colorType: 6 })
      png.data = Buffer.from(base.data.buffer, base.data.byteOffset, base.data.length)
      const data = PNG.sync.write(png, { colorType: 6, deflateLevel: 9 })
      if (data.length <= maxBytes) return { mimeType: 'image/png', data, width: base.width, height: base.height }
    } else {
      for (const quality of JPEG_QUALITIES) {
        const { data } = encodeJpeg({ width: base.width, height: base.height, data: base.data }, quality)
        if (data.length <= maxBytes) return { mimeType: 'image/jpeg', data, width: base.width, height: base.height }
      }
    }
    if (Math.max(base.width, base.height) <= MIN_EDGE) return undefined
    scale *= SHRINK
  }
}
