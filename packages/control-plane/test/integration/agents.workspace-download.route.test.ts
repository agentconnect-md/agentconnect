/**
 * `GET /agents/:id/workspace/file/download` — a session file's original bytes. The CP authorizes
 * the agent AND the session, admits only an upload or a digest-named share, assembles the daemon's
 * byte slices within the download ceiling, and stores nothing.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import {
  MAX_WORKSPACE_DOWNLOAD_BYTES,
  WORKSPACE_FILE_DOWNLOAD_FEATURE,
  WORKSPACE_SESSION_READ_FEATURE
} from '@agentconnect.md/protocol'
import type { WorkspaceReadContent, WorkspaceReadReq } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID, DEFAULT_OWNER_ID } from '../../prisma/seed.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd5d5d5d5-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a5a5a5a5-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MTIME = '2026-09-30T00:00:00.000Z'
const FEATURES = [WORKSPACE_FILE_DOWNLOAD_FEATURE, WORKSPACE_SESSION_READ_FEATURE]
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

/** A daemon answering byte reads from an in-memory workspace, recording every forwarded REQ. */
class ByteReadSpy {
  calls: WorkspaceReadReq[] = []
  files = new Map<string, Buffer>()
  /** Set to make every read fail the way a daemon `error` frame would. */
  failure: Error | null = null

  async workspaceRead(_daemonId: string, req: WorkspaceReadReq): Promise<WorkspaceReadContent> {
    this.calls.push(req)
    if (this.failure) throw this.failure
    const file = this.files.get(req.path)
    if (!file) return { agentId: req.agentId, path: req.path, exists: false }
    const slice = file.subarray(req.offset, req.offset + req.limit)
    const nextOffset = req.offset + slice.byteLength
    return {
      agentId: req.agentId,
      path: req.path,
      exists: true,
      type: 'file',
      size: file.byteLength,
      mtime: MTIME,
      encoding: 'base64',
      content: slice.toString('base64'),
      offset: req.offset,
      nextOffset,
      truncated: nextOffset < file.byteLength
    }
  }
}

function app(control: ByteReadSpy, userId?: string): HttpApp {
  const running = buildHttpApp(
    prisma,
    userId ? { DEFAULT_OWNER_ID: userId } : undefined,
    LIVE,
    control as unknown as ControlSender
  )
  opened.push(running)
  return running
}

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@example.test`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

async function seedDownloadAgent(features: string[] = FEATURES): Promise<void> {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features }
  })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, gitRepo: 'https://github.com/example-org/example-repo' })
}

async function seedSession(opts: Parameters<typeof seedSessionMeta>[3] = {}): Promise<string> {
  const id = randomUUID()
  await seedSessionMeta(prisma, id, AGENT, { daemonId: DAEMON, ...opts })
  return id
}

const url = (sessionId: string, path: string, sha256?: string) =>
  `${ORG}/agents/${AGENT}/workspace/file/download?sessionId=${sessionId}&path=${encodeURIComponent(path)}${
    sha256 ? `&sha256=${sha256}` : ''
  }`

describe('GET /agents/:id/workspace/file/download', () => {
  it('returns an upload’s exact bytes as an attachment, read from the shared checkout in slices', async () => {
    await seedDownloadAgent()
    const session = await seedSession()
    const control = new ByteReadSpy()
    // Two full slices and a tail, with bytes the text read would have refused as binary.
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(140_000, 0), Buffer.from([0xff, 0xfe])])
    control.files.set('uploads/spec.pdf', pdf)

    const res = await app(control).app.inject({ method: 'GET', url: url(session, 'uploads/spec.pdf') })
    expect(res.statusCode).toBe(200)
    expect(res.rawPayload.equals(pdf)).toBe(true)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe(`attachment; filename="spec.pdf"; filename*=UTF-8''spec.pdf`)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toBe('private, no-store')
    // A shared session's files live in the agent's checkout, so no worktree is named.
    expect(control.calls.map((req) => req.offset)).toEqual([0, 65_536, 131_072])
    expect(control.calls[0]).toEqual({
      agentId: AGENT,
      path: 'uploads/spec.pdf',
      offset: 0,
      limit: 65_536,
      encoding: 'base64'
    })
  })

  it('reads an isolated session’s own worktree', async () => {
    await seedDownloadAgent()
    const session = await seedSession({ workspaceIsolation: 'session' })
    const control = new ByteReadSpy()
    control.files.set('uploads/notes.txt', Buffer.from('hello'))

    const res = await app(control).app.inject({ method: 'GET', url: url(session, 'uploads/notes.txt') })
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('hello')
    expect(control.calls[0]).toMatchObject({ sessionId: session, path: 'uploads/notes.txt' })
  })

  it('serves a shared file only by the digest its marker recorded, and only while the bytes still match', async () => {
    await seedDownloadAgent()
    const session = await seedSession()
    const control = new ByteReadSpy()
    const chart = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    control.files.set('out/chart.png', chart)
    const digest = createHash('sha256').update(chart).digest('hex').slice(0, 16)
    const running = app(control)

    const unnamed = await running.app.inject({ method: 'GET', url: url(session, 'out/chart.png') })
    expect(unnamed.statusCode).toBe(400)
    expect(unnamed.json()).toMatchObject({ code: 'WORKSPACE_NOT_A_SESSION_FILE' })
    expect(control.calls).toHaveLength(0)

    const shared = await running.app.inject({ method: 'GET', url: url(session, 'out/chart.png', digest) })
    expect(shared.statusCode).toBe(200)
    expect(shared.rawPayload.equals(chart)).toBe(true)
    expect(shared.headers['content-type']).toBe('image/png')

    control.files.set('out/chart.png', Buffer.from('overwritten since'))
    const changed = await running.app.inject({ method: 'GET', url: url(session, 'out/chart.png', digest) })
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ code: 'WORKSPACE_FILE_CHANGED' })
  })

  it('fences paths before any daemon I/O and keeps the daemon’s own containment refusals', async () => {
    await seedDownloadAgent()
    const session = await seedSession()
    const control = new ByteReadSpy()
    const running = app(control)

    for (const path of ['uploads/../agent.json', '/uploads/x', 'uploads\\x', 'uploads']) {
      const res = await running.app.inject({ method: 'GET', url: url(session, path) })
      expect(res.statusCode, path).toBe(400)
    }
    expect(control.calls).toHaveLength(0)

    // A symlink out of the workspace is the daemon's refusal to make; it arrives as a reasoned error frame.
    control.failure = ProtocolError.fromFrame({
      code: 'BAD_PAYLOAD',
      message: 'workspace/read failed: path resolves outside the workspace root',
      retryable: false,
      details: { reason: 'path-escape' }
    })
    const escape = await running.app.inject({ method: 'GET', url: url(session, 'uploads/link') })
    expect(escape.statusCode).toBe(400)
    expect(escape.json()).toMatchObject({ code: 'WORKSPACE_PATH_ESCAPE' })
  })

  it('refuses a missing file, and one over the ceiling after reading only its first slice', async () => {
    await seedDownloadAgent()
    const session = await seedSession()
    const control = new ByteReadSpy()
    control.files.set('uploads/huge.zip', Buffer.alloc(MAX_WORKSPACE_DOWNLOAD_BYTES + 1))
    const running = app(control)

    const missing = await running.app.inject({ method: 'GET', url: url(session, 'uploads/gone.pdf') })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'WORKSPACE_FILE_NOT_FOUND' })

    const huge = await running.app.inject({ method: 'GET', url: url(session, 'uploads/huge.zip') })
    expect(huge.statusCode).toBe(413)
    expect(huge.json()).toMatchObject({ code: 'WORKSPACE_FILE_TOO_LARGE' })
    expect(control.calls.filter((req) => req.path === 'uploads/huge.zip')).toHaveLength(1)
  })

  it('hides another member’s private session, a restricted agent, a foreign agent and a purged session', async () => {
    await seedDownloadAgent()
    const mine = await makeUser(`download-mine-${randomUUID()}`, 'collaborator')
    const theirs = await makeUser(`download-theirs-${randomUUID()}`, 'collaborator')
    const privateSession = await seedSession({ visibility: 'private', ownerIdentity: `user:${theirs}` })
    const purged = await seedSession()
    await prisma.sessionMeta.update({
      where: { id: purged },
      data: { contentPurgedAt: new Date(), contentPurgedReason: 'retention' }
    })
    const control = new ByteReadSpy()
    control.files.set('uploads/a.txt', Buffer.from('a'))

    const hidden = await app(control, mine).app.inject({ method: 'GET', url: url(privateSession, 'uploads/a.txt') })
    expect(hidden.statusCode).toBe(404)
    expect(hidden.json()).toMatchObject({ message: 'session not found' })
    const gone = await app(control).app.inject({ method: 'GET', url: url(purged, 'uploads/a.txt') })
    expect(gone.statusCode).toBe(404)
    expect(control.calls).toHaveLength(0)

    const owner = await app(control, theirs).app.inject({ method: 'GET', url: url(privateSession, 'uploads/a.txt') })
    expect(owner.statusCode).toBe(200)

    await prisma.agent.update({
      where: { id: AGENT },
      data: { visibility: 'restricted', sharedWith: [DEFAULT_OWNER_ID] }
    })
    const restricted = await app(control, mine).app.inject({ method: 'GET', url: url(privateSession, 'uploads/a.txt') })
    expect(restricted.statusCode).toBe(404)
    expect(restricted.json()).toMatchObject({ message: 'agent not found' })

    const foreignOrg = `org-foreign-${randomUUID().slice(0, 8)}`
    const foreignAgent = randomUUID()
    await prisma.org.create({ data: { id: foreignOrg, slug: foreignOrg } })
    await prisma.agent.create({
      data: { id: foreignAgent, orgId: foreignOrg, name: 'foreign-bot', runtime: 'claude', daemonId: null }
    })
    const crossOrg = await app(control).app.inject({
      method: 'GET',
      url: `${ORG}/agents/${foreignAgent}/workspace/file/download?sessionId=${purged}&path=uploads%2Fa.txt`
    })
    expect(crossOrg.statusCode).toBe(404)
    expect(control.calls).toHaveLength(1)
  })

  it('answers version skew with 409: a daemon without byte reads, or a sandbox that predates them', async () => {
    await seedDownloadAgent([WORKSPACE_SESSION_READ_FEATURE])
    const session = await seedSession()
    const control = new ByteReadSpy()
    control.files.set('uploads/a.txt', Buffer.from('a'))

    const oldDaemon = await app(control).app.inject({ method: 'GET', url: url(session, 'uploads/a.txt') })
    expect(oldDaemon.statusCode).toBe(409)
    expect(oldDaemon.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(control.calls).toHaveLength(0)

    await prisma.daemon.update({
      where: { id: DAEMON },
      data: { capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features: FEATURES } }
    })
    control.failure = ProtocolError.fromFrame({
      code: 'BAD_PAYLOAD',
      message: 'workspace/read failed: this agent’s sandbox predates file downloads',
      retryable: false,
      details: { reason: 'sandbox-outdated' }
    })
    const oldSandbox = await app(control).app.inject({ method: 'GET', url: url(session, 'uploads/a.txt') })
    expect(oldSandbox.statusCode).toBe(409)
    expect(oldSandbox.json()).toMatchObject({ code: 'WORKSPACE_SANDBOX_OUTDATED' })
  })
})
