// Console file transfer routes: the CP signs the URLs itself and never sees file bytes.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { FILE_TRANSFER_FEATURE, WORKSPACE_SESSION_READ_FEATURE } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { FileTransferRefusal, type FileTransferService } from '../../src/file-transfer/service.js'
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

class TransferSpy implements FileTransferService {
  readonly maxBytes = 1024
  uploads: Array<{ orgId: string; size: number; sha256: string }> = []
  downloads: Download[] = []
  failure: Error | null = null

  async reserveUpload(input: { orgId: string; size: number; sha256: string }) {
    this.uploads.push(input)
    if (this.failure) throw this.failure
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

  async workspaceDownload(input: Download) {
    this.downloads.push(input)
    if (this.failure) throw this.failure
    return {
      path: input.path,
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
    expect(transfer.uploads).toEqual([{ orgId: DEFAULT_ORG_ID, size: 1234, sha256: SHA }])
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
      { orgId: DEFAULT_ORG_ID, daemonId: DAEMON, agentId: AGENT, path: 'dist/app.tar.gz' },
      { orgId: DEFAULT_ORG_ID, daemonId: DAEMON, agentId: AGENT, sessionId: isolated, path: 'out.log' }
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
