import { describe, expect, it } from 'vitest'
import { sharedFileMarker } from './shared-file'

const SHA = '1a2b3c4d5e6f7a8b'

describe('sharedFileMarker', () => {
  it('splits the caption from the file the trailing marker names', () => {
    expect(
      sharedFileMarker(`revenue by week\n[shared: out/chart.png (image/png, 48213 bytes, sha256:${SHA})]`)
    ).toEqual({
      caption: 'revenue by week',
      file: { path: 'out/chart.png', name: 'chart.png', mimeType: 'image/png', bytes: 48213, sha256: SHA }
    })
    expect(sharedFileMarker(`[shared: chart.webp (image/webp, 12 bytes, sha256:${SHA})]`)?.caption).toBe('')
  })

  it('keeps a name with spaces and parentheses whole', () => {
    const parsed = sharedFileMarker(`[shared: out/plot (final) v2.png (image/png, 9 bytes, sha256:${SHA})]`)
    expect(parsed?.file).toMatchObject({ path: 'out/plot (final) v2.png', name: 'plot (final) v2.png' })
  })

  it('normalizes the path a download names, and names none it could not reach', () => {
    const pathOf = (raw: string) => {
      const parsed = sharedFileMarker(`[shared: ${raw} (image/png, 1 bytes, sha256:${SHA})]`)
      return parsed ? parsed.file.path : 'no marker'
    }
    expect(pathOf('./out//chart.png')).toBe('out/chart.png')
    expect(pathOf('/tmp/chart.png')).toBeNull()
    expect(pathOf('../chart.png')).toBeNull()
    expect(pathOf('out\\chart.png')).toBeNull()
  })

  it('reads only a well-formed marker at the end of the row', () => {
    expect(sharedFileMarker('an ordinary reply')).toBeNull()
    expect(sharedFileMarker(`[shared: a.png (image/png, 1 bytes, sha256:${SHA})]\nand then more`)).toBeNull()
    expect(sharedFileMarker('[shared: a.png (image/png, 1 bytes, sha256:nothex)]')).toBeNull()
    expect(sharedFileMarker('see [shared: a.png (image/png, 1 bytes, sha256:1a2b3c4d5e6f7a8b)]')).toBeNull()
  })
})
