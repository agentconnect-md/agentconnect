/** `POST /sessions/:id/shared-images/:attachmentId/original` — the console's resolve of a shared image's original. */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent, DEFAULT_DAEMON_CAPABILITIES } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import { NoConnection } from '../../src/orchestrator/outbound.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { createSharedImageService } from '../../src/file-transfer/shared-image.js'
import type { DaemonLiveness } from '../../src/ports.js'
import {
  WEBCHAT_IMAGES_FEATURE,
  type SharedImageResolveOk,
  type SharedImageResolveReq
} from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const SESSION = '50505050-5555-4555-8555-555555555555'
const ATTACHMENT = '70707070-7777-4777-8777-777777777777'
const URL_PATH = `${ORG}/sessions/${SESSION}/shared-images/${ATTACHMENT}/original`

const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const READY: SharedImageResolveOk = {
  original: {
    kind: 'cache',
    attachmentId: ATTACHMENT,
    mimeType: 'image/png',
    bytes: 5,
    sha256: 'a'.repeat(64),
    status: 'ready'
  },
  download: { url: 'https://store.example.test/g', expiresAt: '2026-10-10T00:30:00.000Z' }
}

class SpyControl {
  calls: Array<{ daemonId: string; orgId: string; req: SharedImageResolveReq }> = []
  constructor(private readonly answer: () => Promise<SharedImageResolveOk>) {}
  async sharedImageResolve(daemonId: string, orgId: string, req: SharedImageResolveReq): Promise<SharedImageResolveOk> {
    this.calls.push({ daemonId, orgId, req })
    return await this.answer()
  }
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function seed(features: string[] = [WEBCHAT_IMAGES_FEATURE]): Promise<void> {
  await seedDaemon(prisma, DAEMON, { capabilities: { ...DEFAULT_DAEMON_CAPABILITIES, features } })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
  await prisma.sessionMeta.create({
    data: {
      id: SESSION,
      agentId: AGENT,
      daemonId: DAEMON,
      orgId: DEFAULT_ORG_ID,
      platform: 'webchat',
      channel: 'conv-1',
      phase: 'start',
      lastActivityAt: new Date('2026-10-10T00:00:00.000Z')
    }
  })
}

function app(spy: SpyControl): HttpApp {
  return buildHttpApp(prisma, undefined, LIVE, spy as unknown as ControlSender, {
    sharedImages: createSharedImageService({ control: spy })
  })
}

describe('POST /sessions/:id/shared-images/:attachmentId/original', () => {
  it('asks the recording daemon under a fresh resolve ticket and returns its answer', async () => {
    await seed()
    const spy = new SpyControl(async () => READY)
    running = app(spy)
    const res = await running.app.inject({ method: 'POST', url: URL_PATH })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual(READY)
    expect(spy.calls).toEqual([
      {
        daemonId: DAEMON,
        orgId: DEFAULT_ORG_ID,
        req: { agentId: AGENT, sessionId: SESSION, attachmentId: ATTACHMENT, resolveId: expect.any(String) }
      }
    ])
  })

  it('409s when the daemon predates shared images, without sending it the frame', async () => {
    await seed([])
    const spy = new SpyControl(async () => READY)
    running = app(spy)
    const res = await running.app.inject({ method: 'POST', url: URL_PATH })
    expect(res.statusCode).toBe(409)
    expect(res.json()).toMatchObject({ code: 'DAEMON_FEATURE_MISSING' })
    expect(spy.calls).toEqual([])
  })

  it('404s for an unknown session, an attachment the daemon does not hold, and a malformed id', async () => {
    const spy = new SpyControl(async () => {
      throw new ProtocolError('NO_SESSION', 'no such shared image')
    })
    running = app(spy)
    expect((await running.app.inject({ method: 'POST', url: URL_PATH })).statusCode).toBe(404)
    await running.close()
    await seed()
    running = app(spy)
    expect((await running.app.inject({ method: 'POST', url: URL_PATH })).statusCode).toBe(404)
    const bad = await running.app.inject({ method: 'POST', url: `${ORG}/sessions/${SESSION}/shared-images/x/original` })
    expect(bad.statusCode).toBe(400)
  })

  it('503s when the holding daemon is unreachable', async () => {
    await seed()
    running = app(
      new SpyControl(async () => {
        throw new NoConnection(DAEMON)
      })
    )
    expect((await running.app.inject({ method: 'POST', url: URL_PATH })).statusCode).toBe(503)
  })
})
