import { describe, it, expect, vi } from 'vitest'

// The byte POST goes to a reserved URL that is NOT a Slack API endpoint, so it leaves
// through undici directly rather than through the Web API client.
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

const sharedAt =
  (ts: string, channel = 'C1', visibility = 'public') =>
  async () => ({
    file: { shares: { [visibility]: { [channel]: [{ ts }] } } }
  })

const reserved = async () => ({ upload_url: 'https://files.slack.com/upload/v1/x', file_id: 'F1' })

function connWith(files: Record<string, unknown>) {
  const app = {
    message() {},
    event() {},
    action() {},
    shortcut() {},
    client: {
      auth: { test: async () => ({ user_id: 'U1', team_id: 'T123' }) },
      chat: { postMessage: async () => ({}), getPermalink: async () => ({ permalink: 'https://x/y' }) },
      files: {
        getUploadURLExternal: reserved,
        completeUploadExternal: async () => ({ files: [{ id: 'F1' }] }),
        uploadV2: async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }),
        info: sharedAt('1700000000.000100'),
        ...files
      },
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
  it('shares under the agent’s own identity, the only way a file post can carry one', async () => {
    // `chat.postMessage` cannot attach a file, so the upload's completion IS the message —
    // and `username`/`icon_url` on that call are the only identity it will ever accept.
    const completeUploadExternal = vi.fn(async () => ({ files: [{ id: 'F1' }] }))
    const getUploadURLExternal = vi.fn(reserved)
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
      // The share's own ts, read back from files.info — see the anchoring test below.
    ).resolves.toEqual({ ok: true, messageId: '1700000000.000100' })

    expect(getUploadURLExternal).toHaveBeenCalledWith({ filename: 'shot.png', length: bytes.byteLength })
    // channel_id is what turns a hosted file into a message; without it the upload stays
    // private. No `blocks`: this method ignores them whenever `initial_comment` is set.
    expect(completeUploadExternal).toHaveBeenCalledWith({
      files: [{ id: 'F1', title: 'shot.png' }],
      channel_id: 'C1',
      thread_ts: '111.1',
      initial_comment: 'from telegram',
      username: 'Scout',
      icon_url: 'https://example.test/a.png'
    })
  })

  it('sends the reserved URL the bot token and a part named `body`, as Slack’s own SDK does', async () => {
    // Every field here is copied rather than chosen: two live shares were refused with HTTP
    // 500 for differing, and the token is the one that reads most like it should be optional.
    await connWith({}).uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })
    const [url, init] = undici.fetch.mock.calls.at(-1) as [string, { body: FormData; headers: Record<string, string> }]
    expect(url).toBe('https://files.slack.com/upload/v1/x')
    expect(init.headers.Authorization).toBe('Bearer xoxb-a')
    expect(init.body.has('body')).toBe(true)
    expect(init.body.has('file')).toBe(false)
  })

  it('falls back to the SDK transport when the byte POST is refused, without double posting', async () => {
    // That step runs BEFORE anything reaches the conversation, which is the whole reason a
    // retry is safe here and nowhere else in this flow.
    undici.fetch.mockResolvedValueOnce({ ok: false, status: 500 })
    const completeUploadExternal = vi.fn(async () => ({ files: [{ id: 'F1' }] }))
    const uploadV2 = vi.fn(async () => ({ ok: true, files: [{ ok: true, files: [{ id: 'F9' }] }] }))
    const conn = connWith({ completeUploadExternal, uploadV2, info: sharedAt('1700000000.000900') })

    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi')).resolves.toEqual({
      ok: true,
      messageId: '1700000000.000900'
    })
    expect(uploadV2).toHaveBeenCalledOnce()
    expect(completeUploadExternal).not.toHaveBeenCalled()
  })

  it('shares under the app identity when ANY decorated attempt is definitely refused', async () => {
    // username/icon_url are documented for this method but absent from the SDK's argument
    // type, so a rejection is not necessarily the scope — it can be the arguments.
    const completeUploadExternal = vi.fn(async (a: Record<string, unknown>) => {
      if (a.username) throw slackError('invalid_arguments')
      return { files: [{ id: 'F1' }] }
    })
    const conn = connWith({ completeUploadExternal })
    await expect(
      conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi', undefined, { username: 'Scout' })
    ).resolves.toMatchObject({ ok: true })
    expect(completeUploadExternal).toHaveBeenCalledTimes(2)
    expect(completeUploadExternal.mock.calls[1]![0]).not.toHaveProperty('username')
  })

  it('does NOT retry a completion Slack answered with a partial-success code', async () => {
    // Slack documents `internal_error`/`fatal_error` as possibly raised AFTER some aspect of
    // the operation succeeded, so a provider code is not by itself proof of a refusal — the
    // share may be visible already, and a second completion would publish it twice.
    for (const code of ['internal_error', 'fatal_error']) {
      const completeUploadExternal = vi.fn(async () => {
        throw slackError(code)
      })
      const conn = connWith({ completeUploadExternal })
      await expect(
        conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi', undefined, { username: 'Scout' })
      ).resolves.toEqual({ ok: false, reason: 'indeterminate', detail: code })
      expect(completeUploadExternal).toHaveBeenCalledOnce()
    }
  })

  it('does NOT retry a refusal the decoration cannot have caused, even before publication', async () => {
    // `not_in_channel` precedes publication, so retrying would be safe — but undecorated it
    // fails identically, spending a call and replacing the real error with its echo.
    const completeUploadExternal = vi.fn(async () => {
      throw slackError('not_in_channel')
    })
    const conn = connWith({ completeUploadExternal })
    await expect(
      conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi', undefined, { username: 'Scout' })
    ).resolves.toMatchObject({ ok: false, detail: 'not_in_channel' })
    expect(completeUploadExternal).toHaveBeenCalledOnce()
  })

  it('does NOT retry a completion whose outcome Slack never confirmed', async () => {
    // It is one-shot: a transport failure may have been ACCEPTED with its response lost, so a
    // second call could double-post and "nothing was sent" could be a lie.
    const completeUploadExternal = vi.fn(async () => {
      throw new Error('socket hang up')
    })
    const conn = connWith({ completeUploadExternal })
    await expect(
      conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' }, 'hi', undefined, { username: 'Scout' })
    ).resolves.toEqual({ ok: false, reason: 'indeterminate', detail: 'socket hang up' })
    expect(completeUploadExternal).toHaveBeenCalledOnce()
  })

  it('anchors the file post on the share’s real ts, so a reply under it wakes the agent', async () => {
    // The completion answers with the FILE, not the message, so without this read the share
    // has no timestamp — and a post the daemon cannot name is not a thread root it
    // recognizes, which is why replying under a shared image woke nobody while replying under
    // a forwarded TEXT message (a chat.postMessage, which returns its ts) always worked.
    const info = vi.fn(sharedAt('1700000000.000200', 'C9'))
    await expect(connWith({ info }).uploadFile('C9', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: true,
      messageId: '1700000000.000200'
    })
    expect(info).toHaveBeenCalledWith({ file: 'F1' })
  })

  it('reads the share ts out of the private arm too, since a DM files it there', async () => {
    const conn = connWith({ info: sharedAt('1700000000.000300', 'D2', 'private') })
    await expect(conn.uploadFile('D2', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: true,
      messageId: '1700000000.000300'
    })
  })

  it('still reports success when the ts cannot be read, since the file already landed', async () => {
    // Anchoring is bookkeeping ON TOP of a delivery that already happened.
    const conn = connWith({
      info: async () => {
        throw new Error('ratelimited')
      }
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({ ok: true })
  })

  it('classifies a missing files:write scope, the likeliest first-run failure', async () => {
    // Operator-fixable, so the reason must be distinguishable from a deleted thread root.
    const conn = connWith({
      getUploadURLExternal: async () => {
        throw slackError('missing_scope', { needed: 'files:write' })
      }
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'missing_scope',
      detail: 'missing_scope'
    })
  })

  it('reports the provider’s own error code, since `platform error` alone is not actionable', async () => {
    const conn = connWith({
      getUploadURLExternal: async () => {
        throw slackError('method_not_supported_for_channel_type')
      }
    })
    await expect(conn.uploadFile('C1', { bytes: Buffer.from('x'), name: 'a.png' })).resolves.toEqual({
      ok: false,
      reason: 'platform_error',
      detail: 'method_not_supported_for_channel_type'
    })
  })
})
