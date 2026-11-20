import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  FILE_TRANSFER_FEATURE as PROTOCOL_TRANSFER_FEATURE,
  MAX_WORKSPACE_DOWNLOAD_BYTES as PROTOCOL_MAX_DOWNLOAD,
  WEBCHAT_FILES_MAX as PROTOCOL_FILES_MAX,
  WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES as PROTOCOL_TEXT_THRESHOLD,
  SESSION_FILE_PREFIX as PROTOCOL_FILE_PREFIX,
  SessionFileArea as PROTOCOL_FILE_AREA,
  parseSessionFileName as protocolParseSessionFileName
} from '@agentconnect.md/protocol'
import {
  deploymentFileTransfer,
  FILE_TRANSFER_FEATURE,
  MAX_WORKSPACE_DOWNLOAD_BYTES,
  parseSessionFileName,
  SESSION_FILE_AREAS,
  SESSION_FILE_PREFIX,
  sharedFileMarker,
  transferCapable,
  viaTransfer,
  WEBCHAT_FILES_MAX,
  WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES
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

  it('names a session files area apart from the checkout', () => {
    const parsed = sharedFileMarker(
      `the report\n[shared: files:outputs/q3/report.pdf (application/pdf, 1234 bytes, sha256:${SHA})]`
    )
    expect(parsed?.file).toEqual({
      path: 'q3/report.pdf',
      root: 'outputs',
      name: 'report.pdf',
      mimeType: 'application/pdf',
      bytes: 1234,
      sha256: SHA
    })
    const escape = sharedFileMarker(`[shared: files:uploads/../x.pdf (application/pdf, 1 bytes, sha256:${SHA})]`)
    expect(escape?.file).toMatchObject({ path: null, root: 'uploads' })
    // An unknown area is an ordinary checkout path, as an older console reads every `files:` name.
    expect(
      sharedFileMarker(`[shared: files:other/x.pdf (application/pdf, 1 bytes, sha256:${SHA})]`)?.file
    ).not.toHaveProperty('root')
  })

  it('splits a files: name exactly as the protocol does', () => {
    for (const name of [
      'files:outputs/a/b.pdf',
      'files:uploads',
      'files:outputs/',
      'files:other/x',
      'outputs/x',
      'files:'
    ]) {
      expect(parseSessionFileName(name), name).toEqual(protocolParseSessionFileName(name))
    }
  })

  it('reads only a well-formed marker at the end of the row', () => {
    expect(sharedFileMarker('an ordinary reply')).toBeNull()
    expect(sharedFileMarker(`[shared: a.png (image/png, 1 bytes, sha256:${SHA})]\nand then more`)).toBeNull()
    expect(sharedFileMarker('[shared: a.png (image/png, 1 bytes, sha256:nothex)]')).toBeNull()
    expect(sharedFileMarker('see [shared: a.png (image/png, 1 bytes, sha256:1a2b3c4d5e6f7a8b)]')).toBeNull()
  })
})

describe('shared-file constants', () => {
  it('mirrors the protocol’s download and transfer constants', () => {
    expect(SESSION_FILE_PREFIX).toBe(PROTOCOL_FILE_PREFIX)
    expect(SESSION_FILE_AREAS).toEqual(PROTOCOL_FILE_AREA.options)
    expect(MAX_WORKSPACE_DOWNLOAD_BYTES).toBe(PROTOCOL_MAX_DOWNLOAD)
    expect(WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES).toBe(PROTOCOL_TEXT_THRESHOLD)
    expect(FILE_TRANSFER_FEATURE).toBe(PROTOCOL_TRANSFER_FEATURE)
    expect(WEBCHAT_FILES_MAX).toBe(PROTOCOL_FILES_MAX)
  })
})

describe('viaTransfer', () => {
  it('sends binary and large text through the object store only when the daemon has one', () => {
    expect(viaTransfer({ size: 10, encoding: 'none' }, true)).toBe(true)
    expect(viaTransfer({ size: WORKSPACE_TRANSFER_TEXT_THRESHOLD_BYTES + 1, encoding: 'utf8' }, true)).toBe(true)
    expect(viaTransfer({ size: 10, encoding: 'utf8' }, true)).toBe(false)
    expect(viaTransfer({ size: 10, encoding: 'none' }, false)).toBe(false)
  })
})

describe('transferCapable', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('needs both the deployment’s transfer bucket and a daemon that speaks control-plane-signed transfers', () => {
    vi.stubEnv('FILE_TRANSFER_MAX_BYTES', '')
    expect(deploymentFileTransfer()).toBeUndefined()
    expect(transferCapable([FILE_TRANSFER_FEATURE])).toBe(false)

    vi.stubEnv('FILE_TRANSFER_MAX_BYTES', String(512 * 1024 * 1024))
    expect(deploymentFileTransfer()).toEqual({ maxBytes: 512 * 1024 * 1024 })
    expect(transferCapable([FILE_TRANSFER_FEATURE])).toBe(true)
    expect(transferCapable(['file-transfer-v1'])).toBe(false)
    expect(transferCapable(undefined)).toBe(false)

    vi.stubEnv('FILE_TRANSFER_MAX_BYTES', 'lots')
    expect(deploymentFileTransfer()).toBeUndefined()
  })
})
