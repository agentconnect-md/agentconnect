import { describe, it, expect, vi } from 'vitest'

// The byte POST of Slack's external upload goes to a reserved URL that is NOT a Slack API
// endpoint, so it leaves through undici directly rather than through the Web API client.
const undici = vi.hoisted(() => ({ fetch: vi.fn(async () => ({ ok: true, status: 200 })) }))
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
      conn.uploadFile('C1', { bytes, name: 'shot.png' }, 'from telegram', '111.1', {
        username: 'Scout',
        icon_url: 'https://example.test/a.png'
      })
    ).resolves.toEqual({ fileId: 'F1' })

    expect(getUploadURLExternal).toHaveBeenCalledWith({ filename: 'shot.png', length: bytes.byteLength })
    expect(undici.fetch).toHaveBeenCalledWith(
      'https://files.slack.com/upload/v1/x',
      expect.objectContaining({ method: 'POST' })
    )
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
    ).resolves.toEqual({ fileId: 'F1' })
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

    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toBeUndefined()
    expect(completeUploadExternal).not.toHaveBeenCalled()
  })

  it('reports failure instead of throwing into the send path', async () => {
    const conn = connWith({
      getUploadURLExternal: async () => {
        throw new Error('slack down')
      },
      completeUploadExternal: async () => ({ files: [] })
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toBeUndefined()
  })
})
