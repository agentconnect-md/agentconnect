import { describe, expect, it } from 'vitest'
import {
  MAX_WORKSPACE_DOWNLOAD_BYTES as PROTOCOL_MAX_DOWNLOAD,
  WORKSPACE_UPLOADS_DIR as PROTOCOL_UPLOADS_DIR
} from '@agentconnect.md/protocol'
import {
  MAX_WORKSPACE_DOWNLOAD_BYTES,
  sessionFileDownload,
  sharedFileMarker,
  WORKSPACE_UPLOADS_DIR
} from './shared-file'

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

describe('sessionFileDownload', () => {
  it('mirrors the download route’s own uploads directory and ceiling', () => {
    expect(WORKSPACE_UPLOADS_DIR).toBe(PROTOCOL_UPLOADS_DIR)
    expect(MAX_WORKSPACE_DOWNLOAD_BYTES).toBe(PROTOCOL_MAX_DOWNLOAD)
  })

  const share = (path: string, sha = SHA) => `done\n[shared: ${path} (image/gif, 9 bytes, sha256:${sha})]`

  it('names an upload by its path alone', () => {
    expect(sessionFileDownload('uploads/a.png', 's1', [])).toEqual({ sessionId: 's1' })
    expect(sessionFileDownload('uploads/', 's1', [])).toBeNull()
  })

  it('names a shared file by the digest of its latest share in that session', () => {
    const rows = [
      { text: share('out/anim.gif', '0000000000000000'), sessionId: 's1' },
      { text: share('out/anim.gif'), sessionId: 's1' },
      { text: share('out/anim.gif', 'ffffffffffffffff'), sessionId: 's2' }
    ]
    expect(sessionFileDownload('out/anim.gif', 's1', rows)).toEqual({ sessionId: 's1', sha256: SHA })
  })

  it('refuses a file no share in that session names, or a session it cannot address', () => {
    const rows = [{ text: share('out/anim.gif'), sessionId: 's2' }]
    expect(sessionFileDownload('out/anim.gif', 's1', rows)).toBeNull()
    expect(sessionFileDownload('src/index.ts', 's2', rows)).toBeNull()
    expect(sessionFileDownload('uploads/a.png', undefined, [])).toBeNull()
  })
})
