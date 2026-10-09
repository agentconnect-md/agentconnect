// Console file transfer routes: the CP forwards the scope and proxies only presigned URLs, never file bytes.
import { afterEach, describe, expect, it } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { FILE_TRANSFER_FEATURE, WORKSPACE_SESSION_READ_FEATURE } from '@agentconnect.md/protocol'
import type {
  TransferUploadGrant,
  TransferUploadReq,
  WorkspaceTransferGrant,
  WorkspaceTransferReq
} from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon, seedSessionMeta } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
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

class TransferSpy {
  uploads: TransferUploadReq[] = []
  transfers: WorkspaceTransferReq[] = []
  failure: Error | null = null

  async transferUpload(_daemonId: string, req: TransferUploadReq): Promise<TransferUploadGrant> {
    this.uploads.push(req)
    if (this.failure) throw this.failure
    return {
      uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      url: 'https://store.example.test/bucket/key?X-Amz-Signature=sig',
      headers: {
        'content-length': String(req.size),
        'x-amz-checksum-sha256': req.sha256,
        'x-amz-tagging': 'ac-cache=pending'
      },
      expiresAt: EXPIRES
    }
  }

  async workspaceTransfer(_daemonId: string, req: WorkspaceTransferReq): Promise<WorkspaceTransferGrant> {
    this.transfers.push(req)
    if (this.failure) throw this.failure
    return {
      path: req.path,
      size: 42,
      url: 'https://store.example.test/bucket/dl?X-Amz-Signature=sig',
      expiresAt: EXPIRES,
      sha256: OBJECT_SHA,
      cached: false
    }
  }
}

function app(control: TransferSpy): HttpApp {
  const running = buildHttpApp(prisma, undefined, LIVE, control as unknown as ControlSender)
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
  it('forwards the declared file and answers the presigned PUT', async () => {
    await seedTransferAgent()
    const control = new TransferSpy()
    const res = await app(control).app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: upload
    })
    expect(res.statusCode).toBe(200)
    expect(control.uploads).toEqual([{ agentId: AGENT, ...upload }])
    expect(res.json()).toMatchObject({
      uploadId: '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b',
      headers: { 'x-amz-checksum-sha256': SHA },
      expiresAt: new Date(EXPIRES).toISOString()
    })
  })

  it('refuses a daemon without a bucket before sending anything, and a malformed declaration', async () => {
    await seedTransferAgent([])
    const control = new TransferSpy()
    const running = app(control)
    const missing = await running.app.inject({ method: 'POST', url: `${ORG}/agents/${AGENT}/uploads`, payload: upload })
    expect(missing.statusCode).toBe(409)
    expect(missing.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    const badName = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: { ...upload, name: '../agent.json' }
    })
    expect(badName.statusCode).toBe(400)
    expect(control.uploads).toHaveLength(0)
  })

  it('answers the daemon’s cap refusal with its code', async () => {
    await seedTransferAgent()
    const control = new TransferSpy()
    control.failure = ProtocolError.fromFrame({
      code: 'BAD_PAYLOAD',
      message: 'transfer/upload failed: files over 10 bytes cannot be uploaded',
      retryable: false,
      details: { reason: 'too-large' }
    })
    const res = await app(control).app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/uploads`,
      payload: upload
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toMatchObject({ code: 'WORKSPACE_TOO_LARGE' })
  })
})

describe('POST /agents/:id/workspace/file/transfer', () => {
  it('forwards the primary workspace, or an isolated session’s worktree', async () => {
    await seedTransferAgent()
    const isolated = randomUUID()
    await seedSessionMeta(prisma, isolated, AGENT, { daemonId: DAEMON, workspaceIsolation: 'session' })
    const control = new TransferSpy()
    const running = app(control)
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
    expect(control.transfers).toEqual([
      { agentId: AGENT, path: 'dist/app.tar.gz' },
      { agentId: AGENT, sessionId: isolated, path: 'out.log' }
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

  it('hides an unknown session and maps a missing file to 404', async () => {
    await seedTransferAgent()
    const control = new TransferSpy()
    const running = app(control)
    const unknown = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/file/transfer`,
      payload: { path: 'a.bin', sessionId: randomUUID() }
    })
    expect(unknown.statusCode).toBe(404)
    expect(control.transfers).toHaveLength(0)

    control.failure = ProtocolError.fromFrame({
      code: 'BAD_PAYLOAD',
      message: 'workspace/transfer failed: no such file',
      retryable: false,
      details: { reason: 'not-found' }
    })
    const missing = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/workspace/file/transfer`,
      payload: { path: 'gone.bin' }
    })
    expect(missing.statusCode).toBe(404)
    expect(missing.json()).toMatchObject({ code: 'WORKSPACE_NOT_FOUND' })
  })
})
