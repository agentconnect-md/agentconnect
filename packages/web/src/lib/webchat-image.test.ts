import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardImageFile, prepareWebchatImage } from './webchat-image'

function clipboardData(
  items: Array<Pick<DataTransferItem, 'kind' | 'type' | 'getAsFile'>>,
  files: File[] = []
): Pick<DataTransfer, 'items' | 'files'> {
  return {
    items: items as unknown as DataTransferItemList,
    files: files as unknown as FileList
  }
}

describe('clipboardImageFile', () => {
  it('returns a pasted image without treating ordinary clipboard content as an attachment', () => {
    const image = { name: 'pasted.png', type: 'image/png' } as File
    expect(
      clipboardImageFile(
        clipboardData([
          { kind: 'string', type: 'text/plain', getAsFile: () => null },
          { kind: 'file', type: image.type, getAsFile: () => image }
        ])
      )
    ).toBe(image)
    expect(clipboardImageFile(clipboardData([{ kind: 'string', type: 'text/plain', getAsFile: () => null }]))).toBe(
      undefined
    )
  })
})

afterEach(() => vi.unstubAllGlobals())
it('preserves the legacy image budget and honors a smaller explicit AHP budget', async () => {
  const bitmap = { width: 100, height: 100, close: vi.fn() }
  vi.stubGlobal('createImageBitmap', vi.fn().mockResolvedValue(bitmap))
  const sizes = [2000, 2000, 500]
  const toBlob = vi.fn((callback: (blob: Blob) => void) => callback(new Blob(['x'.repeat(sizes.shift()!)])))
  vi.stubGlobal('document', {
    createElement: () => ({ getContext: () => ({ clearRect: vi.fn(), drawImage: vi.fn() }), toBlob })
  })
  vi.stubGlobal(
    'FileReader',
    class {
      result = 'data:image/webp;base64,YQ=='
      onload?: () => void
      readAsDataURL() {
        this.onload?.()
      }
    }
  )
  const file = new File(['original'], 'picture.png', { type: 'image/png' })
  await prepareWebchatImage(file)
  expect(toBlob).toHaveBeenCalledTimes(1)
  await prepareWebchatImage(file, 1000)
  expect(toBlob).toHaveBeenCalledTimes(3)
  expect(bitmap.close).toHaveBeenCalledTimes(2)
})
