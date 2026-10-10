import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { encode as encodeJpeg } from 'jpeg-js'
import { PNG } from 'pngjs'
import { afterEach, describe, expect, it } from 'vitest'
import {
  checkStaticSvg,
  configurePreviewPool,
  prepareSharedImagePreview,
  resetPreviewPool,
  sharedImageName,
  sniffSharedImage
} from '../src/images/index.js'
import { rasterHeader } from '../src/images/sniff.js'
import { fontFamilyName, selectFonts } from '../src/images/fonts.js'

const CAP = 160 * 1024

// Deterministic noise defeats compression, so a modest canvas is already far above the cap.
function rgba(width: number, height: number, alpha: (x: number, y: number) => number): Buffer {
  const data = Buffer.alloc(width * height * 4)
  let seed = 7
  for (let i = 0; i < width * height; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0
    data[i * 4] = seed & 0xff
    data[i * 4 + 1] = (seed >> 8) & 0xff
    data[i * 4 + 2] = (seed >> 16) & 0xff
    data[i * 4 + 3] = alpha(i % width, Math.floor(i / width))
  }
  return data
}

function png(width: number, height: number, alpha = (_x: number, _y: number) => 255): Buffer {
  const img = new PNG({ width, height })
  img.data = rgba(width, height, alpha)
  return PNG.sync.write(img)
}

function jpg(width: number, height: number): Buffer {
  return encodeJpeg({ width, height, data: rgba(width, height, () => 255) }, 90).data
}

function insertChunk(source: Buffer, type: string, body: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + body.length)
  chunk.writeUInt32BE(body.length, 0)
  chunk.write(type, 4, 'latin1')
  body.copy(chunk, 8)
  // CRC is not checked by the header walk, which only needs the chunk layout.
  return Buffer.concat([source.subarray(0, 33), chunk, source.subarray(33)])
}

const svg = (body: string, attrs = 'width="200" height="100"') =>
  Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`)

afterEach(async () => {
  await resetPreviewPool()
})

describe('sniffSharedImage', () => {
  it('detects formats by content, not name', () => {
    expect(sniffSharedImage(png(2, 2))).toBe('image/png')
    expect(sniffSharedImage(jpg(2, 2))).toBe('image/jpeg')
    expect(sniffSharedImage(Buffer.from('GIF89a......'))).toBe('image/gif')
    expect(sniffSharedImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp')
    expect(sniffSharedImage(Buffer.from('﻿<?xml version="1.0"?>\n<!-- c --><svg xmlns="x"/>'))).toBe('image/svg+xml')
    expect(sniffSharedImage(Buffer.from('<html><svg></svg></html>'))).toBeUndefined()
    expect(sniffSharedImage(Buffer.from('plain text'))).toBeUndefined()
  })

  it('names the file from the stem and the sniffed type', () => {
    expect(sharedImageName('out/images/chart.jpeg', 'image/png')).toBe('chart.png')
    expect(sharedImageName('', 'image/svg+xml')).toBe('image.svg')
    expect(sharedImageName('a\u0007b.webp', 'image/webp')).toBe('ab.webp')
  })

  it('reads dimensions and animation from headers', () => {
    expect(rasterHeader(png(3, 5), 'image/png')).toEqual({ ok: true, width: 3, height: 5, animated: false })
    expect(rasterHeader(insertChunk(png(3, 5), 'acTL', Buffer.alloc(8)), 'image/png')).toMatchObject({ animated: true })
    expect(rasterHeader(jpg(7, 4), 'image/jpeg')).toEqual({ ok: true, width: 7, height: 4, animated: false })
    expect(rasterHeader(png(3, 5).subarray(0, 40), 'image/png')).toMatchObject({ ok: false, reason: 'corrupt' })
  })
})

describe('checkStaticSvg', () => {
  it('accepts a self-contained static drawing with internal references and styles', () => {
    const result = checkStaticSvg(
      Buffer.from(
        '<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 300 150">' +
          '<defs><linearGradient id="g"><stop offset="0" stop-color="#f00"/></linearGradient></defs>' +
          '<style><![CDATA[ .a { fill: url(#g); } ]]></style>' +
          '<metadata><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"/></metadata>' +
          '<use xlink:href="#r"/><rect id="r" class="a" width="10" height="10" style="fill:url(\'#g\')"/>' +
          '<text x="1" y="20">图表 &amp; chart &#x4e2d;</text></svg>'
      )
    )
    expect(result).toEqual({ ok: true, width: 300, height: 150 })
  })

  it.each([
    ['DTD', '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>'],
    ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    [
      'prefixed script',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg"><s:script/></svg>'
    ],
    ['event handler', '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'],
    ['foreignObject', '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject/></svg>'],
    ['html namespace', '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns:h="http://www.w3.org/1999/xhtml"/></svg>'],
    ['animation', '<svg xmlns="http://www.w3.org/2000/svg"><rect><animate attributeName="x"/></rect></svg>'],
    ['set', '<svg xmlns="http://www.w3.org/2000/svg"><set attributeName="x"/></svg>'],
    ['external href', '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/a.png"/></svg>'],
    ['data href', '<svg xmlns="http://www.w3.org/2000/svg"><image href="data:image/png;base64,AAAA"/></svg>'],
    ['xlink file', '<svg xmlns="http://www.w3.org/2000/svg"><use xlink:href="other.svg#x"/></svg>'],
    ['css url', '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://example.test/x)}</style></svg>'],
    ['import', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>'],
    ['stylesheet PI', '<?xml-stylesheet href="x.css"?><svg xmlns="http://www.w3.org/2000/svg"/>'],
    ['non-svg root', '<html><svg/></html>'],
    ['unknown element', '<svg xmlns="http://www.w3.org/2000/svg"><blink/></svg>'],
    ['undeclared entity', '<svg xmlns="http://www.w3.org/2000/svg"><text>&nbsp;</text></svg>'],
    ['invalid utf-8', Buffer.concat([Buffer.from('<svg>'), Buffer.from([0xff, 0xfe]), Buffer.from('</svg>')])]
  ])('refuses %s', (_name, source) => {
    expect(checkStaticSvg(Buffer.isBuffer(source) ? source : Buffer.from(source)).ok).toBe(false)
  })
})

describe('prepareSharedImagePreview', () => {
  it('passes a small validated original through byte for byte', async () => {
    const bytes = png(40, 30)
    const result = await prepareSharedImagePreview({ bytes, name: 'out/a.png', maxPreviewBytes: CAP })
    expect(result).toMatchObject({ ok: true, inline: true, original: { mimeType: 'image/png', name: 'a.png' } })
    if (!result.ok) throw new Error('expected ok')
    expect(result.preview.data.equals(bytes)).toBe(true)
    expect(result.preview).toMatchObject({ width: 40, height: 30 })
  })

  it('reduces a large transparent PNG to a PNG within the cap', async () => {
    const bytes = png(1600, 900, (x) => (x < 800 ? 255 : 0))
    expect(bytes.length).toBeGreaterThan(CAP)
    const result = await prepareSharedImagePreview({ bytes, name: 'alpha.png', maxPreviewBytes: CAP })
    if (!result.ok) throw new Error(`expected ok: ${result.detail}`)
    expect(result.inline).toBe(false)
    expect(result.preview.mimeType).toBe('image/png')
    expect(result.preview.data.length).toBeLessThanOrEqual(CAP)
    expect(Math.max(result.preview.width!, result.preview.height!)).toBeLessThanOrEqual(1280)
    expect(result.original).toEqual({ mimeType: 'image/png', name: 'alpha.png' })
    expect(sniffSharedImage(result.preview.data)).toBe('image/png')
  })

  it('reduces a large opaque image to a JPEG within the cap', async () => {
    const bytes = jpg(2000, 1000)
    const result = await prepareSharedImagePreview({ bytes, name: 'photo.jpg', maxPreviewBytes: CAP })
    if (!result.ok) throw new Error(`expected ok: ${result.detail}`)
    expect(result.preview.mimeType).toBe('image/jpeg')
    expect(result.preview.data.length).toBeLessThanOrEqual(CAP)
    expect(result.preview.width! / result.preview.height!).toBeCloseTo(2, 1)
  })

  it('decodes a large WebP original', async () => {
    const { default: encode, init } = (await import('@jsquash/webp/encode.js')) as {
      default: (img: { data: Uint8ClampedArray; width: number; height: number }, opts?: object) => Promise<ArrayBuffer>
      init: (module: WebAssembly.Module) => Promise<unknown>
    }
    // Node 24 has wasm SIMD, so the encoder takes its SIMD build; hand it that module rather than letting it fetch.
    const encoderWasm = createRequire(import.meta.url).resolve('@jsquash/webp/codec/enc/webp_enc_simd.wasm')
    await init(
      await (
        globalThis as unknown as { WebAssembly: { compile(b: Buffer): Promise<WebAssembly.Module> } }
      ).WebAssembly.compile(readFileSync(encoderWasm))
    )
    const raw = rgba(900, 700, () => 255)
    const webp = Buffer.from(
      await encode(
        { data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), width: 900, height: 700 },
        { quality: 95 }
      )
    )
    expect(webp.length).toBeGreaterThan(CAP)
    const result = await prepareSharedImagePreview({ bytes: webp, name: 'w.webp', maxPreviewBytes: CAP })
    if (!result.ok) throw new Error(`expected ok: ${result.detail}`)
    expect(result.original.mimeType).toBe('image/webp')
    expect(result.preview.mimeType).toBe('image/jpeg')
    expect(result.preview.data.length).toBeLessThanOrEqual(CAP)
  })

  it('keeps a small SVG as SVG and rasterizes an oversized one', async () => {
    const small = svg('<rect width="200" height="100" fill="#09c"/>')
    const inline = await prepareSharedImagePreview({ bytes: small, name: 'd.svg', maxPreviewBytes: CAP })
    expect(inline).toMatchObject({
      ok: true,
      inline: true,
      preview: { mimeType: 'image/svg+xml', width: 200, height: 100 }
    })

    const circles = Array.from(
      { length: 4000 },
      (_, i) =>
        `<circle cx="${(i * 37) % 400}" cy="${(i * 53) % 200}" r="${(i % 9) + 1}" fill="#${(i * 2654435).toString(16).slice(-6).padStart(6, '0')}"/>`
    ).join('')
    const big = svg(circles + '<text x="10" y="40" font-size="20">流程图 diagram</text>', 'width="400" height="200"')
    expect(big.length).toBeGreaterThan(CAP)
    const result = await prepareSharedImagePreview({ bytes: big, name: 'flow.svg', maxPreviewBytes: CAP })
    if (!result.ok) throw new Error(`expected ok: ${result.detail}`)
    expect(result.inline).toBe(false)
    expect(result.original).toEqual({ mimeType: 'image/svg+xml', name: 'flow.svg' })
    expect(['image/png', 'image/jpeg']).toContain(result.preview.mimeType)
    expect(result.preview.data.length).toBeLessThanOrEqual(CAP)
  })

  it('refuses gif, animation, unsafe SVG, junk and too many pixels', async () => {
    const run = (bytes: Buffer) => prepareSharedImagePreview({ bytes, name: 'x', maxPreviewBytes: CAP })
    expect(await run(Buffer.from('GIF89a000000'))).toMatchObject({ ok: false, reason: 'gif' })
    expect(await run(Buffer.from('hello'))).toMatchObject({ ok: false, reason: 'not-image' })
    expect(await run(insertChunk(png(4, 4), 'acTL', Buffer.alloc(8)))).toMatchObject({ ok: false, reason: 'animated' })
    expect(await run(svg('<script/>'))).toMatchObject({ ok: false, reason: 'unsafe-svg' })
    // A header claiming 10000x10000 is refused before any pixel buffer exists.
    const huge = png(4, 4)
    huge.writeUInt32BE(10_000, 16)
    huge.writeUInt32BE(10_000, 20)
    expect(await run(huge)).toMatchObject({ ok: false, reason: 'too-many-pixels' })
    const truncated = png(40, 40).subarray(0, 60)
    expect(await run(truncated)).toMatchObject({ ok: false, reason: 'corrupt' })
  })

  it('times out and terminates a job that runs too long', async () => {
    configurePreviewPool({ timeoutMs: 200, jobDelayMs: 5_000 })
    const result = await prepareSharedImagePreview({ bytes: png(4, 4), name: 'x', maxPreviewBytes: CAP })
    expect(result).toMatchObject({ ok: false, reason: 'timeout' })
    configurePreviewPool({ timeoutMs: 30_000, jobDelayMs: 0 })
    expect(await prepareSharedImagePreview({ bytes: png(4, 4), name: 'x', maxPreviewBytes: CAP })).toMatchObject({
      ok: true
    })
  })

  it('honors abort before and during a job', async () => {
    const aborted = AbortSignal.abort()
    expect(
      await prepareSharedImagePreview({ bytes: png(4, 4), name: 'x', maxPreviewBytes: CAP, signal: aborted })
    ).toMatchObject({ ok: false, reason: 'timeout' })
    configurePreviewPool({ jobDelayMs: 5_000 })
    const controller = new AbortController()
    const pending = prepareSharedImagePreview({
      bytes: png(4, 4),
      name: 'x',
      maxPreviewBytes: CAP,
      signal: controller.signal
    })
    setTimeout(() => controller.abort(), 50)
    expect(await pending).toMatchObject({ ok: false, reason: 'timeout' })
  })

  it('reports busy past the queue bound', async () => {
    configurePreviewPool({ maxWorkers: 1, maxQueued: 1, jobDelayMs: 300 })
    const jobs = [0, 1, 2].map(() => prepareSharedImagePreview({ bytes: png(4, 4), name: 'x', maxPreviewBytes: CAP }))
    const results = await Promise.all(jobs)
    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(results.filter((r) => !r.ok && r.reason === 'busy')).toHaveLength(1)
  })
})

describe('raster fonts', () => {
  it('selects within budget and tolerates missing directories', () => {
    expect(selectFonts(['/nonexistent-font-dir'])).toEqual({ buffers: [] })
    const fonts = selectFonts(undefined, 80 * 1024 * 1024)
    const total = fonts.buffers.reduce((n, b) => n + b.byteLength, 0)
    expect(total).toBeLessThanOrEqual(80 * 1024 * 1024)
    if (fonts.buffers.length) expect(fontFamilyName(Buffer.from(fonts.buffers[0]!))).toBeTruthy()
  })
})

describe('svg text rendering', () => {
  it.skipIf(selectFonts().buffers.length === 0)('draws CJK glyphs with the selected system fonts', async () => {
    const { renderSvg } = await import('../src/images/raster.js')
    const img = await renderSvg(svg('<text x="10" y="80" font-size="72">图表</text>'), 200)
    let inked = 0
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i]! > 0) inked++
    expect(inked).toBeGreaterThan(100)
  })
})
