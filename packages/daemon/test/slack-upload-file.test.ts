import { describe, it, expect, vi } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'

const deps = () => ({
  group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
  onMessage: () => {},
  newTraceId: () => 't'
})

function connWith(uploadV2: unknown) {
  const app = {
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client: {
      auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
      chat: { postMessage: async () => ({}), getPermalink: async () => ({ permalink: 'https://x/y' }) },
      files: { uploadV2 },
      assistant: { threads: { setStatus: async () => undefined, setTitle: async () => undefined } }
    },
    start: async () => {},
    stop: async () => {}
  }
  return new SlackConnection(deps() as never, (() => app) as never)
}

const slackError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(code), { data: { error: code, ...extra } })

describe('SlackConnection.uploadFile', () => {
  // Slack is the outlier: its share answers with the FILE, so success carries no messageId and
  // a forward there anchors nothing — see platform-upload-file.test.ts for the other three.
  it('hands the whole external upload to the SDK, with the coordinates that make it a message', async () => {
    // The byte POST is not a Slack API request and its wire shape is undocumented; two live
    // failures came out of reimplementing it, so the transport belongs to `uploadV2` now.
    const uploadV2 = vi.fn(async () => ({ ok: true, files: [{ id: 'F1' }] }))
    const conn = connWith(uploadV2)

    const bytes = Buffer.from('PNGBYTES')
    await expect(
      conn.uploadFile('C1', { bytes, name: 'shot.png' }, 'from telegram', { thread: '111.1' })
    ).resolves.toEqual({ ok: true })

    // channel_id is what turns a hosted file into a message; without it the upload stays
    // private. No `blocks`: the completion step ignores them whenever `initial_comment` is
    // set, so sending both would only look like the caption renders as CommonMark.
    expect(uploadV2).toHaveBeenCalledWith({
      file: bytes,
      filename: 'shot.png',
      channel_id: 'C1',
      thread_ts: '111.1',
      initial_comment: 'from telegram'
    })
  })

  it('omits the anchor and the caption rather than sending them empty', async () => {
    const uploadV2 = vi.fn(async () => ({ ok: true }))
    await connWith(uploadV2).uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })
    expect(uploadV2).toHaveBeenCalledWith({ file: expect.any(Buffer), filename: 'a.png', channel_id: 'C1' })
  })

  it('reports the provider’s own error code, since `platform error` alone is not actionable', async () => {
    const conn = connWith(async () => {
      throw slackError('method_not_supported_for_channel_type')
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'platform_error',
      detail: 'method_not_supported_for_channel_type'
    })
  })

  it('classifies a missing files:write scope, the likeliest first-run failure', async () => {
    // Operator-fixable, so the reason must be distinguishable from a deleted thread root.
    const conn = connWith(async () => {
      throw slackError('missing_scope', { needed: 'files:write' })
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'missing_scope',
      detail: 'missing_scope'
    })
  })

  it('treats the SDK’s own byte-POST rejection as proof that nothing was published', async () => {
    // That step runs before the share, so its failure is one of the few non-API errors that
    // definitely left the conversation untouched — the agent may say so and move on.
    const conn = connWith(async () => {
      throw new Error('Failed to upload file (id:F1, filename: a.png)')
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'platform_error',
      detail: 'Failed to upload file (id:F1, filename: a.png)'
    })
  })

  it('calls any other failure indeterminate, because the share step is one-shot', async () => {
    // `uploadV2` hides WHICH step threw, and a lost response from the completion step may
    // have been accepted. "Nothing was sent" would then be a lie about a file the channel
    // already shows, and would invite the retry that double-posts it.
    const conn = connWith(async () => {
      throw new Error('socket hang up')
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'indeterminate',
      detail: 'socket hang up'
    })
  })
})
