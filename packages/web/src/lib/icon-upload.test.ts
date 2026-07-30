import { afterEach, describe, expect, it, vi } from 'vitest'
import { resizeImageToIconBlob } from './icon-upload'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('resizeImageToIconBlob', () => {
  it('normalizes a WebP upload to a Discord-compatible PNG', async () => {
    const bitmap = { width: 512, height: 256, close: vi.fn() }
    const drawImage = vi.fn()
    const toBlob = vi.fn((callback: BlobCallback, type?: string) => {
      callback(new Blob(['png'], { type }))
    })
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => ({ drawImage })),
      toBlob
    }
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => bitmap)
    )
    vi.stubGlobal('document', { createElement: vi.fn(() => canvas) })

    const source = new File(['webp'], 'agent.webp', { type: 'image/webp' })
    const result = await resizeImageToIconBlob(source)

    expect(createImageBitmap).toHaveBeenCalledWith(source)
    expect(canvas.width).toBe(256)
    expect(canvas.height).toBe(256)
    expect(drawImage).toHaveBeenCalledWith(bitmap, 128, 0, 256, 256, 0, 0, 256, 256)
    expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png')
    expect(result.type).toBe('image/png')
    expect(bitmap.close).toHaveBeenCalledOnce()
  })
})
