import { describe, it, expect, vi } from 'vitest'
import { SlackConnection } from '../src/slack/connection.js'

const deps = () => ({
  group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
  onMessage: () => {},
  newTraceId: () => 't'
})

const sharedAt =
  (ts: string, channel = 'C1', visibility = 'public') =>
  async () => ({
    file: { shares: { [visibility]: { [channel]: [{ ts }] } } }
  })

function connWith(uploadV2: unknown, info: unknown = sharedAt('1700000000.000100')) {
  const app = {
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client: {
      auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
      chat: { postMessage: async () => ({}), getPermalink: async () => ({ permalink: 'https://x/y' }) },
      files: { uploadV2, info },
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
    const uploadV2 = vi.fn(async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }))
    const conn = connWith(uploadV2)

    const bytes = Buffer.from('PNGBYTES')
    await expect(
      conn.uploadFile('C1', { bytes, name: 'shot.png' }, 'from telegram', { thread: '111.1' })
      // The share's own ts, read back from files.info — see the anchoring test below.
    ).resolves.toEqual({ ok: true, messageId: '1700000000.000100' })

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
    const uploadV2 = vi.fn(async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }))
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

  it('anchors the file post on the share’s real ts, so a reply under it wakes the agent', async () => {
    // Slack's completion answers with the FILE, not the message, so without this read the
    // share has no timestamp — and a post the daemon cannot name is not a thread root it
    // recognizes, which is why replying under a shared image used to wake nobody while
    // replying under a forwarded TEXT message (a chat.postMessage, which returns its ts)
    // always worked.
    const info = vi.fn(sharedAt('1700000000.000200', 'C9'))
    const conn = connWith(async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F7' }] }] }), info)
    await expect(conn.uploadFile('C9', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: true,
      messageId: '1700000000.000200'
    })
    expect(info).toHaveBeenCalledWith({ file: 'F7' })
  })

  it('reads the share ts out of the private arm too, since a DM files it there', async () => {
    const conn = connWith(
      async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F7' }] }] }),
      sharedAt('1700000000.000300', 'D2', 'private')
    )
    await expect(conn.uploadFile('D2', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: true,
      messageId: '1700000000.000300'
    })
  })

  it('still reports success when the ts cannot be read, since the file already landed', async () => {
    // Anchoring is bookkeeping ON TOP of a delivery that already happened. Failing the share
    // here would report "nothing was sent" about a file the channel is displaying, and invite
    // the retry that double-posts it.
    const conn = connWith(
      async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F7' }] }] }),
      async () => {
        throw new Error('ratelimited')
      }
    )
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({ ok: true })
  })

  it('calls every non-API failure indeterminate, because the share step is one-shot', async () => {
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

  it('will not call an HTTP failure definite, however early in the upload it happened', async () => {
    // Tempting, since a rejected byte POST runs BEFORE the share and so proves nothing was
    // published — but the SDK raises one `WebAPIHTTPError` for every non-200 across all three
    // steps, so that case is indistinguishable from a lost response to an accepted share.
    const httpError = Object.assign(new Error('An HTTP protocol error occurred: statusCode = 500'), {
      code: 'slack_webapi_http_error',
      statusCode: 500
    })
    const conn = connWith(async () => {
      throw httpError
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toMatchObject({
      ok: false,
      reason: 'indeterminate'
    })
  })
})
