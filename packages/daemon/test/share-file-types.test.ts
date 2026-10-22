import { describe, expect, it } from 'vitest'
import { documentMimeType, sharedFileKind } from '../src/mcp/ops/share-file-types.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(16)])

// agent-authored-attachments.md §4: an image is what its bytes say; a document is what its name says.
describe('sharedFileKind', () => {
  it('names and types an image from its bytes, never from the path', () => {
    expect(sharedFileKind('out/chart', PNG)).toEqual({ kind: 'image', name: 'chart.png', mimeType: 'image/png' })
    expect(sharedFileKind('out/photo.pdf', Buffer.from([0xff, 0xd8, 0xff, 0]))).toEqual({
      kind: 'image',
      name: 'photo.jpg',
      mimeType: 'image/jpeg'
    })
  })

  it('posts a GIF as an image typed from its bytes, so a platform can play it rather than flatten it', () => {
    expect(sharedFileKind('anim', Buffer.from('GIF89a......'))).toEqual({
      kind: 'image',
      name: 'anim.gif',
      mimeType: 'image/gif'
    })
  })

  it('keeps a document under the path’s own file name, typed by its extension', () => {
    expect(sharedFileKind('outputs/Q3 report.PDF', Buffer.from('%PDF-1.4'))).toEqual({
      kind: 'document',
      name: 'Q3 report.PDF',
      mimeType: 'application/pdf'
    })
    expect(sharedFileKind('data/rows.csv', Buffer.from('a,b\n1,2\n'))).toMatchObject({
      kind: 'document',
      mimeType: 'text/csv'
    })
  })

  it('labels anything a browser could run, or does not know, as an opaque download', () => {
    expect(sharedFileKind('page.html', Buffer.from('<html>'))).toMatchObject({ mimeType: 'application/octet-stream' })
    expect(sharedFileKind('logo.svg', Buffer.from('<svg xmlns="x"/>'))).toMatchObject({
      kind: 'document',
      mimeType: 'application/octet-stream'
    })
    expect(documentMimeType('build/output')).toBe('application/octet-stream')
  })

  it('drops control characters from the name and never yields an empty one', () => {
    expect(sharedFileKind('out/re\u0000port.txt', Buffer.from('x'))).toMatchObject({ name: 'report.txt' })
    expect(sharedFileKind('out/', Buffer.from('x'))).toMatchObject({ name: 'file' })
  })
})
