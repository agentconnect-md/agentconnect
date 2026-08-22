import { describe, it, expect, vi } from 'vitest'

// The byte POST of Slack's external upload goes to a reserved URL that is NOT a Slack API
// endpoint, so it leaves through undici directly rather than through the Web API client.
type FakeFetchResponse = { ok: boolean; status: number; body?: { cancel: () => Promise<void> } }
const undici = vi.hoisted(() => ({
  fetch: vi.fn<(url: string, init?: Record<string, unknown>) => Promise<FakeFetchResponse>>(async () => ({
    ok: true,
    status: 200
  }))
}))
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: undici.fetch
}))

const { SlackConnection } = await import('../src/slack/connection.js')

const deps = () => ({
  group: { appToken: 'xapp-1', botToken: 'xoxb-a', integrations: [] },
  onMessage: () => {},
  newTraceId: () => 't'
})

function fakeApp(files: Record<string, unknown>) {
  return {
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client: {
      auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
      chat: { postMessage: async () => ({}), getPermalink: async () => ({ permalink: 'https://x/y' }) },
      files,
      assistant: { threads: { setStatus: async () => undefined, setTitle: async () => undefined } }
    },
    start: async () => {},
    stop: async () => {}
  }
}

function connWith(files: Record<string, unknown>) {
  return new SlackConnection(deps() as never, (() => fakeApp(files)) as never)
}

describe('SlackConnection.uploadFile', () => {
  // Slack is the outlier: its share answers with the FILE, so success carries no messageId and
  // a forward there anchors nothing — see platform-upload-file.test.ts for the other three.
  it('reserves a URL, POSTs the bytes, and shares the file as the message', async () => {
    const getUploadURLExternal = vi.fn(async () => ({
      upload_url: 'https://files.slack.com/upload/v1/x',
      file_id: 'F1'
    }))
    const completeUploadExternal = vi.fn(async () => ({ files: [{ id: 'F1' }] }))
    const conn = connWith({ getUploadURLExternal, completeUploadExternal })

    const bytes = Buffer.from('PNGBYTES')
    await expect(
      conn.uploadFile(
        'C1',
        { bytes, name: 'shot.png' },
        'from telegram',
        { thread: '111.1' },
        {
          username: 'Scout',
          icon_url: 'https://example.test/a.png'
        }
      )
    ).resolves.toEqual({ ok: true })

    expect(getUploadURLExternal).toHaveBeenCalledWith({ filename: 'shot.png', length: bytes.byteLength })
    expect(undici.fetch).toHaveBeenCalledWith(
      'https://files.slack.com/upload/v1/x',
      expect.objectContaining({ method: 'POST' })
    )
    // The multipart part must be named `body`, the name Slack's own SDK sends. Anything
    // else — `file`, say — is answered with HTTP 500 by the reserved upload URL.
    const posted = undici.fetch.mock.calls[0]![1] as { body: FormData }
    expect(posted.body.has('body')).toBe(true)
    expect(posted.body.has('file')).toBe(false)
    // channel_id is what turns a hosted file into a message; without it the upload stays
    // private. The caption rides as initial_comment, and the agent keeps its own identity.
    expect(completeUploadExternal).toHaveBeenCalledWith({
      files: [{ id: 'F1', title: 'shot.png' }],
      channel_id: 'C1',
      thread_ts: '111.1',
      // No `blocks`: this method ignores them whenever `initial_comment` is set, so sending
      // both would only look like the caption renders as CommonMark. It does not — see the
      // note on the trade in `uploadFile`.
      initial_comment: 'from telegram',
      username: 'Scout',
      icon_url: 'https://example.test/a.png'
    })
  })

  it('shares under the app identity when ANY decorated attempt is refused, not only a missing scope', async () => {
    // username/icon_url are documented for this method but absent from the SDK's argument
    // type, so a rejection is not necessarily the scope — it can be the arguments. The file
    // must land either way; the agent's name on it is the part we are willing to lose.
    const completeUploadExternal = vi.fn(async (a: Record<string, unknown>) => {
      if (a.username) throw Object.assign(new Error('invalid_arguments'), { data: { error: 'invalid_arguments' } })
      return { files: [{ id: 'F1' }] }
    })
    const conn = connWith({
      getUploadURLExternal: async () => ({ upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F1' }),
      completeUploadExternal
    })
    await expect(
      conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi', undefined, { username: 'Scout' })
    ).resolves.toEqual({ ok: true })
    expect(completeUploadExternal).toHaveBeenCalledTimes(2)
    expect(completeUploadExternal.mock.calls[1]![0]).not.toHaveProperty('username')
  })

  it('does NOT retry a completion whose outcome Slack never confirmed, and calls it indeterminate', async () => {
    // completeUploadExternal is one-shot: a transport failure may have been ACCEPTED with its
    // response lost, so a second call could double-post and "nothing was sent" could be a lie
    // about a file the channel already shows.
    const completeUploadExternal = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const conn = connWith({
      getUploadURLExternal: async () => ({ upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F1' }),
      completeUploadExternal
    })
    await expect(
      conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi', undefined, { username: 'Scout' })
    ).resolves.toEqual({ ok: false, reason: 'indeterminate', detail: 'socket hang up' })
    expect(completeUploadExternal).toHaveBeenCalledOnce()
  })

  it('reports the provider’s own error code, since `platform error` alone is not actionable', async () => {
    const conn = connWith({
      getUploadURLExternal: async () => {
        throw Object.assign(new Error('nope'), { data: { error: 'method_not_supported_for_channel_type' } })
      },
      completeUploadExternal: async () => ({ files: [] })
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'platform_error',
      detail: 'method_not_supported_for_channel_type'
    })
  })

  it('shares under the app identity when chat:write.customize is missing', async () => {
    const completeUploadExternal = vi.fn(async (a: Record<string, unknown>) => {
      if (a.username)
        throw Object.assign(new Error('missing_scope'), {
          data: { error: 'missing_scope', needed: 'chat:write.customize' }
        })
      return { files: [{ id: 'F1' }] }
    })
    const conn = connWith({
      getUploadURLExternal: async () => ({ upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F1' }),
      completeUploadExternal
    })

    await expect(
      conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi', undefined, { username: 'Scout' })
    ).resolves.toEqual({ ok: true })
    expect(completeUploadExternal).toHaveBeenCalledTimes(2)
    expect(completeUploadExternal.mock.calls[1]![0]).not.toHaveProperty('username')
  })

  it('bounds the byte POST and drains its body, so neither can wedge the send queue', async () => {
    // The body matters as much as the signal: an unread one keeps the request in flight, and
    // the graceful agent close waits for exactly that — outside the signal's reach.
    const cancel = vi.fn(async () => {})
    undici.fetch.mockResolvedValueOnce({ ok: true, status: 200, body: { cancel } })
    const conn = connWith({
      getUploadURLExternal: async () => ({ upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F1' }),
      completeUploadExternal: async () => ({ files: [{ id: 'F1' }] })
    })
    await conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })
    expect(undici.fetch.mock.calls[0]![1]).toMatchObject({ signal: expect.any(AbortSignal) })
    expect(cancel).toHaveBeenCalledOnce()
  })

  it('gives up without sharing when the reservation returns no upload url', async () => {
    const completeUploadExternal = vi.fn(async () => ({ files: [] }))
    const conn = connWith({ getUploadURLExternal: async () => ({}), completeUploadExternal })

    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'platform_error'
    })
    expect(completeUploadExternal).not.toHaveBeenCalled()
  })

  it('classifies failures instead of throwing into the send path', async () => {
    const conn = connWith({
      getUploadURLExternal: async () => {
        throw new Error('slack down')
      },
      completeUploadExternal: async () => ({ files: [] })
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'platform_error',
      detail: 'slack down'
    })
  })

  it('classifies a missing files:write scope, the likeliest first-run failure', async () => {
    // Operator-fixable, so the reason must be distinguishable from a deleted thread root.
    const conn = connWith({
      getUploadURLExternal: async () => {
        throw Object.assign(new Error('missing_scope'), { data: { error: 'missing_scope', needed: 'files:write' } })
      },
      completeUploadExternal: async () => ({ files: [] })
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'missing_scope',
      detail: 'missing_scope'
    })
  })
})
