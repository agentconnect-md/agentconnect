import { describe, expect, it } from 'vitest'
import { clipboardImageFile } from './webchat-image'

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
