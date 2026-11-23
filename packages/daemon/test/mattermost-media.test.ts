import type { LookupAddress } from 'node:dns'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MattermostConnection } from '../src/platforms/mattermost/connection.js'
import {
  downloadMattermostFile,
  isLinkLocalOrUnspecifiedAddress,
  makeMattermostLookup,
  mattermostDispositionName,
  mattermostUploadName,
  resolveMattermostFileUrl,
  uploadMattermostMedia,
  validateMattermostServerUrl
} from '../src/platforms/mattermost/media.js'
import { FakeMattermostServer, fakeMmId, quietLog } from './fakes/mattermost-server.js'

const TOKEN = 'mm-media-token-secret'
const SERVER = 'https://mm.example.test/team'
const FILE_ID = fakeMmId('file', 42)
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('sample png bytes')])

const connections: MattermostConnection[] = []

afterEach(async () => {
  for (const conn of connections.splice(0)) await conn.stop()
})

describe('Mattermost media URL pinning & filename sanitization', () => {
  it('pins file URLs strictly to configured serverUrl origin and subpath', () => {
    expect(resolveMattermostFileUrl(SERVER, FILE_ID)?.href).toBe(`${SERVER}/api/v4/files/${FILE_ID}`)
    expect(resolveMattermostFileUrl(SERVER, `${SERVER}/api/v4/files/${FILE_ID}`)?.href).toBe(
      `${SERVER}/api/v4/files/${FILE_ID}`
    )
    expect(resolveMattermostFileUrl(SERVER, `${SERVER}/api/v4/files/${FILE_ID}/thumbnail`)?.href).toBe(
      `${SERVER}/api/v4/files/${FILE_ID}/thumbnail`
    )

    // Wrong origin, wrong scheme, wrong subpath, userinfo, traversal
    for (const bad of [
      `https://evil.example.test/team/api/v4/files/${FILE_ID}`,
      `http://mm.example.test/team/api/v4/files/${FILE_ID}`,
      `https://mm.example.test/other/api/v4/files/${FILE_ID}`,
      `https://user:pass@mm.example.test/team/api/v4/files/${FILE_ID}`,
      `${SERVER}/api/v4/files/../users/me`,
      `${SERVER}/api/v4/files/${FILE_ID}/extra`,
      '../../etc/passwd',
      ''
    ]) {
      expect(resolveMattermostFileUrl(SERVER, bad)).toBeUndefined()
    }
  })

  it('sanitizes Content-Disposition and upload filenames', () => {
    expect(mattermostDispositionName('attachment; filename="report.pdf"')).toBe('report.pdf')
    expect(mattermostDispositionName("attachment; filename*=UTF-8''notes%20v2.txt")).toBe('notes v2.txt')
    expect(mattermostDispositionName('attachment; filename="../../etc/passwd"')).toBe('passwd')
    expect(mattermostDispositionName('attachment; filename=".."')).toBeUndefined()

    const long = mattermostUploadName(`${'报'.repeat(200)}.pdf`)
    expect(Buffer.byteLength(long)).toBeLessThanOrEqual(256)
    expect(long.endsWith('.pdf')).toBe(true)
  })
})

describe('Mattermost media download & 2-step upload', () => {
  it('downloads with Bearer auth and redirect=error, enforcing maxBytes and ignoring non-matching origins', async () => {
    const server = new FakeMattermostServer({ serverUrl: SERVER, botToken: TOKEN })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'files' })
    const up = await server.fetchImpl(`${SERVER}/api/v4/files?channel_id=${ch.id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}` },
      body: (() => {
        const f = new FormData()
        f.append('files', new Blob([new Uint8Array(PNG)], { type: 'image/png' }), 'shot.png')
        return f
      })()
    })
    const { file_infos } = (await up.json()) as { file_infos: { id: string }[] }
    const uploadedId = file_infos[0]!.id

    const fetchSpy = vi.fn(server.fetchImpl)
    const reasons: string[] = []
    const downloaded = await downloadMattermostFile(
      { serverUrl: SERVER, botToken: TOKEN, signal: new AbortController().signal, fetchImpl: fetchSpy },
      `${SERVER}/api/v4/files/${uploadedId}`,
      1024,
      (r) => reasons.push(r)
    )
    expect(downloaded).toEqual({
      bytes: PNG,
      fileName: 'shot.png',
      contentType: 'image/png'
    })
    expect(fetchSpy.mock.calls[0]![1]).toMatchObject({
      redirect: 'error',
      headers: { Authorization: `Bearer ${TOKEN}` }
    })

    // Oversized rejected
    expect(
      await downloadMattermostFile(
        { serverUrl: SERVER, botToken: TOKEN, signal: new AbortController().signal, fetchImpl: fetchSpy },
        uploadedId,
        4,
        (r) => reasons.push(r)
      )
    ).toBeNull()

    // Mismatched origin rejected without calling fetch
    const callsBefore = fetchSpy.mock.calls.length
    expect(
      await downloadMattermostFile(
        { serverUrl: SERVER, botToken: TOKEN, signal: new AbortController().signal, fetchImpl: fetchSpy },
        `https://attacker.example.test/team/api/v4/files/${uploadedId}`,
        1024,
        (r) => reasons.push(r)
      )
    ).toBeNull()
    expect(fetchSpy.mock.calls.length).toBe(callsBefore)
    expect(reasons).toEqual(['size_limit', 'refused_url'])
  })

  it('rejects text/html responses (login redirects) and handles 429 Retry-After on download', async () => {
    const reasons: string[] = []
    let count = 0
    const fetchImpl: typeof fetch = async () => {
      count++
      if (count === 1) return new Response('rate limited', { status: 429, headers: { 'Retry-After': '0' } })
      if (count === 2)
        return new Response(new Uint8Array(PNG), { status: 200, headers: { 'content-type': 'image/png' } })
      return new Response('<html>Login</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    const ok = await downloadMattermostFile(
      {
        serverUrl: SERVER,
        botToken: TOKEN,
        signal: new AbortController().signal,
        fetchImpl,
        sleep: async () => {}
      },
      FILE_ID,
      1024,
      (r) => reasons.push(r)
    )
    expect(ok?.bytes).toEqual(PNG)

    const html = await downloadMattermostFile(
      { serverUrl: SERVER, botToken: TOKEN, signal: new AbortController().signal, fetchImpl },
      FILE_ID,
      1024,
      (r) => reasons.push(r)
    )
    expect(html).toBeNull()
    expect(reasons).toEqual(['unexpected_html'])
  })

  it('performs 2-step upload (POST /api/v4/files?channel_id -> POST /api/v4/posts) via MattermostConnection', async () => {
    const server = new FakeMattermostServer({ serverUrl: SERVER, botToken: TOKEN, maxPostSize: 20 })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'uploads' })
    const conn = new MattermostConnection(
      { serverUrl: SERVER, botToken: TOKEN, integrations: [{ agentId: 'a1', integrationId: 'int-1' }] },
      {
        onMessage: () => {},
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    const rootId = server.addPost({ channel_id: ch.id, user_id: server.botUser.id, message: 'parent' }).id
    const outcome = await conn.uploadFile(
      ch.id,
      { bytes: PNG, name: 'diagram.png', mimeType: 'image/png' },
      'Short caption',
      { thread: rootId },
      { username: 'DiagramBot', agentAuthorId: 'agent-1' }
    )

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error('expected ok outcome')
    expect(outcome.fileIds).toHaveLength(1)
    expect(outcome.messageId).toMatch(/^[a-z0-9]{26}$/)

    const post = server.posts.get(outcome.messageId!)!
    expect(post.root_id).toBe(rootId)
    expect(post.file_ids).toEqual(outcome.fileIds)
    expect(post.message).toBe('Short caption')
    expect(post.props?.override_username).toBe('DiagramBot')

    // Download back through connection + getFileInfo
    const info = await conn.getFileInfo(outcome.fileIds![0]!)
    expect(info).toEqual({
      name: 'diagram.png',
      mimeType: 'image/png',
      sourceUrl: `${SERVER}/api/v4/files/${outcome.fileIds![0]!}`,
      size: PNG.byteLength,
      channels: [ch.id]
    })
    expect(await conn.downloadFile(info!.sourceUrl)).toEqual(PNG)
    expect(await conn.downloadFile(`https://other.example.test/team/api/v4/files/${outcome.fileIds![0]!}`)).toBeNull()
  })

  it('classifies upload failures accurately and returns indeterminate on ambiguous post failure', async () => {
    const tooLarge = await uploadMattermostMedia(
      {
        uploadFiles: async () => {
          throw Object.assign(new Error('Payload Too Large'), { status: 413 })
        },
        createPost: async () => ({ id: 'never' })
      },
      'ch1',
      [{ bytes: PNG, name: 'big.png', mimeType: 'image/png' }]
    )
    expect(tooLarge).toMatchObject({ ok: false, reason: 'too_large' })

    const ambiguous = await uploadMattermostMedia(
      {
        uploadFiles: async () => [{ id: FILE_ID, name: 'a.png' }],
        createPost: async () => {
          throw Object.assign(new Error('timed out'), { maybeDelivered: true })
        }
      },
      'ch1',
      [{ bytes: PNG, name: 'a.png', mimeType: 'image/png' }]
    )
    expect(ambiguous).toEqual({ ok: false, reason: 'indeterminate' })

    const tooMany = await uploadMattermostMedia(
      {
        uploadFiles: async () => [],
        createPost: async () => ({ id: 'never' })
      },
      'ch1',
      Array.from({ length: 11 }, (_, i) => ({ bytes: PNG, name: `f${i}.png`, mimeType: 'image/png' }))
    )
    expect(tooMany).toMatchObject({ ok: false, reason: 'platform_error' })
  })

  it('blocks IMDS/NAT64/multicast vectors unconditionally and gates private IPs when AGENTCONNECT_SUPERVISOR=k8s', async () => {
    for (const bad of [
      '100.100.100.200',
      '192.0.0.192',
      '198.18.0.1',
      '224.0.0.1',
      'fd00:ec2::254',
      'ff02::1',
      '::ffff:0:a9fe:a9fe',
      '64:ff9b::169.254.169.254',
      '64:ff9b:1::100.100.100.200'
    ]) {
      expect(isLinkLocalOrUnspecifiedAddress(bad), bad).toBe(true)
    }

    expect(validateMattermostServerUrl('http://10.0.0.5:8065', { AGENTCONNECT_SUPERVISOR: 'k8s' }).ok).toBe(false)
    expect(
      validateMattermostServerUrl('http://10.0.0.5:8065', {
        AGENTCONNECT_SUPERVISOR: 'k8s',
        MATTERMOST_ALLOW_PRIVATE_NETWORK: 'true'
      }).ok
    ).toBe(true)
    expect(
      validateMattermostServerUrl('http://10.0.0.5:8065', {
        AGENTCONNECT_SUPERVISOR: 'k8s',
        AGENTCONNECT_INTERNAL_ALLOWED_HOSTS: '10.0.0.5'
      }).ok
    ).toBe(true)

    // An entry with a port admits only that port, for an address and for a hostname alike; a bare host admits every port.
    const k8s = (allowed: string) => ({ AGENTCONNECT_SUPERVISOR: 'k8s', MATTERMOST_ALLOWED_HOSTS: allowed })
    expect(validateMattermostServerUrl('http://10.0.0.5:8065', k8s('10.0.0.5:8065')).ok).toBe(true)
    expect(validateMattermostServerUrl('http://10.0.0.5:9200', k8s('10.0.0.5:8065')).ok).toBe(false)
    expect(validateMattermostServerUrl('https://[fd00::7]:8443', k8s('[fd00::7]:8443')).ok).toBe(true)
    expect(validateMattermostServerUrl('https://[fd00::7]', k8s('[fd00::7]:8443')).ok).toBe(false)
    expect(validateMattermostServerUrl('https://mm.internal', k8s('mm.internal:443')).ok).toBe(true)
    expect(validateMattermostServerUrl('http://mm.internal:9200', k8s('mm.internal:443')).ok).toBe(false)
    expect(validateMattermostServerUrl('http://mm.internal:9200', k8s('mm.internal:443,mm.internal')).ok).toBe(true)

    const resolvePrivate = ((_host: string, _opts: unknown, cb: (e: null, a: LookupAddress[]) => void) =>
      cb(null, [{ address: '10.0.0.5', family: 4 }])) as unknown as typeof import('node:dns').lookup
    const ask = (host: string) =>
      new Promise<string>((resolve) =>
        makeMattermostLookup(resolvePrivate)(host, { all: false }, (err, addr) =>
          resolve(err ? 'blocked' : typeof addr === 'string' ? addr : (addr?.[0]?.address ?? ''))
        )
      )

    const prevSupervisor = process.env.AGENTCONNECT_SUPERVISOR
    const prevAllowed = process.env.AGENTCONNECT_INTERNAL_ALLOWED_HOSTS
    try {
      process.env.AGENTCONNECT_SUPERVISOR = 'k8s'
      delete process.env.AGENTCONNECT_INTERNAL_ALLOWED_HOSTS
      expect(await ask('mm.internal')).toBe('blocked')
      process.env.AGENTCONNECT_INTERNAL_ALLOWED_HOSTS = 'mm.internal'
      expect(await ask('mm.internal')).toBe('10.0.0.5')
    } finally {
      if (prevSupervisor === undefined) delete process.env.AGENTCONNECT_SUPERVISOR
      else process.env.AGENTCONNECT_SUPERVISOR = prevSupervisor
      if (prevAllowed === undefined) delete process.env.AGENTCONNECT_INTERNAL_ALLOWED_HOSTS
      else process.env.AGENTCONNECT_INTERNAL_ALLOWED_HOSTS = prevAllowed
    }
  })
})
