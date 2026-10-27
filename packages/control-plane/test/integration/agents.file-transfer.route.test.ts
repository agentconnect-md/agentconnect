// Console file transfer routes: the CP signs the URLs itself and never sees file bytes.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import {
  FILE_TRANSFER_FEATURE,
  WORKSPACE_SESSION_READ_FEATURE,
  WORKSPACE_UPLOAD_BEGIN_FEATURE
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
import {
  FileTransferRefusal,
  type FileTransferService,
  type WorkspaceTransferResult
} from '../../src/file-transfer/service.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd6d6d6d6-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a6a6a6a6-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SHA = Buffer.alloc(32, 7).toString('base64')
const EXPIRES = Date.parse('2026-10-09T12:00:00.000Z')
const OBJECT_HEX = createHash('sha256').update('report').digest('hex')
const OBJECT_SHA = Buffer.from(OBJECT_HEX, 'hex').toString('base64')
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

type Download = Parameters<FileTransferService['workspaceDownload']>[0]

type Reserve = Parameters<FileTransferService['reserveUpload']>[0]
type SignParts = Parameters<FileTransferService['signUploadParts']>[0]
const PART = {
  url: 'https://store.example.test/bucket/key?partNumber=1&uploadId=mp-1',
  headers: { 'content-length': '5' }
}
const COMPLETE = { url: 'https://store.example.test/bucket/key?uploadId=mp-1', headers: {}, expiresAt: EXPIRES }

class TransferSpy implements FileTransferService {
  readonly maxBytes = 1024
  uploads: Reserve[] = []
  signedParts: SignParts[] = []
  downloads: Download[] = []
  statuses: Array<{ agentId: string; operationId: string }> = []
  failure: Error | null = null
  /** When set, a download answers this operation as still uploading. */
  pending: string | null = null

  uploadLimits() {
    return { maxBytes: this.maxBytes }
  }

  async signUploadParts(input: SignParts) {
    this.signedParts.push(input)
    if (this.failure) throw this.failure
    return {
      parts: input.parts.map((p) => ({ ...PART, partNumber: p.partNumber })),
      complete: COMPLETE,
      expiresAt: EXPIRES
    }
  }

  async reserveUpload(input: Reserve) {
    this.uploads.push(input)
    if (this.failure) throw this.failure
    if (input.parts) {
      const parts = [{ ...PART, partNumber: 1 }]
      return {
        uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
        multipartId: 'mp-1',
        parts,
        complete: COMPLETE,
        expiresAt: EXPIRES
      }
    }
    return {
      uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      url: 'https://store.example.test/bucket/key?X-Amz-Signature=sig',
      headers: {
        'content-length': String(input.size),
        'x-amz-checksum-sha256': input.sha256,
        'x-amz-tagging': 'ac-cache=pending'
      },
      expiresAt: EXPIRES
    }
  }

  async workspaceDownload(input: Download): Promise<WorkspaceTransferResult> {
    this.downloads.push(input)
    if (this.failure) throw this.failure
    if (this.pending) return { operationId: this.pending, path: input.path, size: 42 }
    return this.ready(input.path)
  }

  async transferStatus(input: { agentId: string; operationId: string }): Promise<WorkspaceTransferResult> {
    this.statuses.push(input)
    if (this.failure) throw this.failure
    if (this.pending) return { operationId: this.pending, path: 'dist/app.bin', size: 42 }
    return this.ready('dist/app.bin')
  }

  async settleUpload(): Promise<never> {
    throw new Error('unused')
  }

  private ready(path: string) {
    return {
      path,
      size: 42,
      url: 'https://store.example.test/bucket/dl?X-Amz-Signature=sig',
      expiresAt: EXPIRES,
      sha256: OBJECT_SHA,
      cached: false
    }
  }

  async signUpload(): Promise<never> {
    throw new Error('unused')
  }

  async uploadedFile(): Promise<never> {
    throw new Error('unused')
  }
}

function app(transfer?: TransferSpy): HttpApp {
  const running = buildHttpApp(prisma, undefined, LIVE, undefined, transfer ? { fileTransfer: transfer } : {})
  opened.push(running)
  return running
}

async function seedTransferAgent(features: string[] = [FILE_TRANSFER_FEATURE, WORKSPACE_SESSION_READ_FEATURE]) {
  await seedDaemon(prisma, DAEMON, {
    capabilities: { platforms: ['slack'], runtimes: ['claude'], acp: true, features }
  })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON, gitRepo: 'https://github.com/example-org/example-repo' })
}

const upload = { name: 'spec.pdf', mimeType: 'application/pdf', size: 1234, sha256: SHA }

describe('POST /agents/:id/uploads', () => {
  it('signs the declared file and answers the presigned PUT', async () => {
    await seedTransferAgent()
    const transfer = new TransferSpy()
    const res = await app(transfer).app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: upload
    })
    expect(res.statusCode).toBe(200)
    expect(transfer.uploads).toEqual([{ orgId: DEFAULT_ORG_ID, agentId: AGENT, size: 1234, sha256: SHA }])
    expect(res.json()).toMatchObject({
      uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      headers: { 'x-amz-checksum-sha256': SHA },
      expiresAt: new Date(EXPIRES).toISOString()
    })
  })

  it('refuses a deployment without a bucket, a daemon that cannot fetch uploads, and a malformed declaration', async () => {
    await seedTransferAgent([])
    const unconfigured = await app().app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: upload
    })
    expect(unconfigured.statusCode).toBe(409)
    expect(unconfigured.json()).toMatchObject({ code: 'WORKSPACE_TRANSFER_UNAVAILABLE' })

    const transfer = new TransferSpy()
    const running = app(transfer)
    const outdated = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: upload
    })
    expect(outdated.statusCode).toBe(409)
    expect(outdated.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    const badName = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: { ...upload, name: '../agent.json' }
    })
    expect(badName.statusCode).toBe(400)
    expect(transfer.uploads).toHaveLength(0)
  })

  it('reserves a file in parts and answers its first part PUTs and the complete', async () => {
    await seedTransferAgent()
    const transfer = new TransferSpy()
    const parts = { partBytes: 5 * 1024 * 1024, sha256: [SHA, SHA] }
    const res = await app(transfer).app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: { ...upload, size: 6 * 1024 * 1024, parts }
    })
    expect(res.statusCode).toBe(200)
    expect(transfer.uploads).toEqual([
      { orgId: DEFAULT_ORG_ID, agentId: AGENT, size: 6 * 1024 * 1024, sha256: SHA, parts }
    ])
    expect(res.json()).toEqual({
      uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      expiresAt: new Date(EXPIRES).toISOString(),
      multipart: {
        multipartId: 'mp-1',
        parts: [{ ...PART, partNumber: 1 }],
        complete: { url: COMPLETE.url, headers: {} }
      }
    })
  })

  it('signs more parts of a multipart upload for the agent it was reserved for', async () => {
    await seedTransferAgent()
    const transfer = new TransferSpy()
    const running = app(transfer)
    const body = { multipartId: 'mp-1', size: 12, partBytes: 5, parts: [{ partNumber: 3, sha256: SHA }] }
    const uploadId = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b'
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads/${uploadId}/parts`,
      payload: body
    })
    expect(res.statusCode).toBe(200)
    expect(transfer.signedParts).toEqual([{ orgId: DEFAULT_ORG_ID, agentId: AGENT, uploadId, ...body }])
    expect(res.json()).toEqual({
      parts: [{ ...PART, partNumber: 3 }],
      complete: { url: COMPLETE.url, headers: {} },
      expiresAt: new Date(EXPIRES).toISOString()
    })
    const tooMany = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads/${uploadId}/parts`,
      payload: { ...body, parts: Array.from({ length: 101 }, (_, i) => ({ partNumber: i + 1, sha256: SHA })) }
    })
    expect(tooMany.statusCode).toBe(400)
    transfer.failure = new FileTransferRefusal(400, 'WORKSPACE_UPLOAD_INVALID', 'part number must be 1 to 3')
    const invalid = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads/${uploadId}/parts`,
      payload: body
    })
    expect(invalid.statusCode).toBe(400)
    expect(invalid.json()).toMatchObject({ code: 'WORKSPACE_UPLOAD_INVALID' })
  })

  it('answers the signer’s cap refusal with its code', async () => {
    await seedTransferAgent()
    const transfer = new TransferSpy()
    transfer.failure = new FileTransferRefusal(400, 'WORKSPACE_TOO_LARGE', 'a transfer must be 1 byte to 10 bytes')
    const res = await app(transfer).app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: upload
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'WORKSPACE_TOO_LARGE' })
  })
})

describe('POST /agents/:id/workspace/file/transfer', () => {
  it('scopes the primary workspace, or an isolated session’s worktree, to the serving daemon', async () => {
    await seedTransferAgent()
    const isolated = randomUUID()
    await seedSessionMeta(prisma, isolated, AGENT, { daemonId: DAEMON, workspaceIsolation: 'session' })
    const transfer = new TransferSpy()
    const running = app(transfer)
    const primary = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/file/transfer`,
      payload: { path: 'dist/app.tar.gz' }
    })
    expect(primary.statusCode).toBe(200)
    expect(primary.json()).toMatchObject({ path: 'dist/app.tar.gz', size: 42, cached: false })
    const session = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/file/transfer`,
      payload: { path: 'out.log', sessionId: isolated }
    })
    expect(session.statusCode).toBe(200)
    expect(transfer.downloads).toEqual([
      { orgId: DEFAULT_ORG_ID, daemonId: DAEMON, agentId: AGENT, path: 'dist/app.tar.gz', begin: false, poll: false },
      {
        orgId: DEFAULT_ORG_ID,
        daemonId: DAEMON,
        agentId: AGENT,
        sessionId: isolated,
        path: 'out.log',
        begin: false,
        poll: false
      }
    ])
  })

  it('holds a shared file to the digest prefix its marker recorded', async () => {
    await seedTransferAgent()
    const running = app(new TransferSpy())
    const transfer = (sha256: string) =>
      running.app.inject({
        method: 'POST',
        url: `${ORG}/agents/${AGENT}/workspace/file/transfer`,
        payload: { path: 'uploads/report.pdf', sha256 }
      })
    const matching = await transfer(OBJECT_HEX.slice(0, 16).toUpperCase())
    expect(matching.statusCode).toBe(200)
    expect(matching.json()).not.toHaveProperty('sha256')
    const rewritten = await transfer('0'.repeat(16))
    expect(rewritten.statusCode).toBe(409)
    expect(rewritten.json()).toMatchObject({ code: 'WORKSPACE_FILE_CHANGED' })
  })

  it('hides an unknown session and answers the signer’s and the daemon’s refusals with their codes', async () => {
    await seedTransferAgent()
    const transfer = new TransferSpy()
    const running = app(transfer)
    const post = (path: string, sessionId?: string) =>
      running.app.inject({
        method: 'POST',
        url: `${ORG}/agents/${AGENT}/workspace/file/transfer`,
        payload: { path, ...(sessionId ? { sessionId } : {}) }
      })
    const unknown = await post('a.bin', randomUUID())
    expect(unknown.statusCode).toBe(404)
    expect(transfer.downloads).toHaveLength(0)

    transfer.failure = new FileTransferRefusal(404, 'WORKSPACE_NOT_FOUND', 'no such file')
    const missing = await post('gone.bin')
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })

    transfer.failure = ProtocolError.fromFrame({
      code: 'BAD_PAYLOAD',
      message: 'workspace/upload failed: the bucket refused the upload',
      retryable: false,
      details: { reason: 'transfer-failed' }
    })
    const refused = await post('dist/app.bin')
    expect(refused.statusCode).toBe(503)
    expect(refused.json()).toMatchObject({ code: 'WORKSPACE_TRANSFER_FAILED' })
  })
})

describe('begun workspace transfers', () => {
  const OPERATION = '0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c'

  it('begins on a daemon that can, answers 202 to a caller that polls, and serves the operation', async () => {
    await seedTransferAgent([FILE_TRANSFER_FEATURE, WORKSPACE_UPLOAD_BEGIN_FEATURE])
    const transfer = new TransferSpy()
    transfer.pending = OPERATION
    const running = app(transfer)
    const begun = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/file/transfer`,
      payload: { path: 'dist/app.bin', poll: true }
    })
    expect(begun.statusCode).toBe(202)
    expect(begun.json()).toEqual({ operationId: OPERATION, path: 'dist/app.bin', size: 42 })
    expect(transfer.downloads).toEqual([
      { orgId: DEFAULT_ORG_ID, daemonId: DAEMON, agentId: AGENT, path: 'dist/app.bin', begin: true, poll: true }
    ])

    const poll = (query = '') =>
      running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/file/transfer/${OPERATION}${query}` })
    expect((await poll()).statusCode).toBe(202)
    transfer.pending = null
    const done = await poll()
    expect(done.statusCode).toBe(200)
    expect(done.json()).toMatchObject({ path: 'dist/app.bin', size: 42, expiresAt: new Date(EXPIRES).toISOString() })
    expect(done.json()).not.toHaveProperty('sha256')
    expect(transfer.statuses.at(-1)).toEqual({ agentId: AGENT, operationId: OPERATION })
    const changed = await poll(`?sha256=${'0'.repeat(16)}`)
    expect(changed.statusCode).toBe(409)
    expect(changed.json()).toMatchObject({ code: 'WORKSPACE_FILE_CHANGED' })
  })

  it('answers a poll’s refusals and a failed upload with the transfer route’s codes', async () => {
    await seedTransferAgent([FILE_TRANSFER_FEATURE, WORKSPACE_UPLOAD_BEGIN_FEATURE])
    const transfer = new TransferSpy()
    const running = app(transfer)
    const poll = (operationId: string) =>
      running.app.inject({ method: 'GET', url: `${ORG}/agents/${AGENT}/workspace/file/transfer/${operationId}` })
    expect((await poll('not-a-uuid')).statusCode).toBe(400)

    transfer.failure = new FileTransferRefusal(404, 'WORKSPACE_TRANSFER_UNKNOWN', 'no such transfer, or it expired')
    const unknown = await poll(OPERATION)
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toMatchObject({ code: 'WORKSPACE_TRANSFER_UNKNOWN' })

    transfer.failure = ProtocolError.fromFrame({
      code: 'CONFLICT',
      message: 'workspace/upload failed: the file changed while it was copied; retry',
      retryable: false,
      details: { reason: 'stale' }
    })
    const stale = await poll(OPERATION)
    expect(stale.statusCode).toBe(409)
    expect(stale.json()).toMatchObject({ code: 'WORKSPACE_STALE' })

    const unconfigured = await app().app.inject({
      method: 'GET',
      url: `${ORG}/agents/${AGENT}/workspace/file/transfer/${OPERATION}`
    })
    expect(unconfigured.statusCode).toBe(409)
    expect(unconfigured.json()).toMatchObject({ code: 'WORKSPACE_TRANSFER_UNAVAILABLE' })
  })
})
