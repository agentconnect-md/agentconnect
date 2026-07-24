/**
 * Agent memory dreaming routes (docs/designs/memory-dreaming.md §10) — the CP
 * relays the dream lifecycle + staged-output review to the owning daemon and
 * persists nothing (body-locality). Managed-provider only; lifecycle mutations
 * are edit-gated (viewers get 403 and the daemon is never contacted).
 *
 * Driven with `app.inject`, a spy `ControlSender`, and a liveness override.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { prisma } from '../setup.db.js'
import { seedDaemon, seedAgent } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import { ControlSender } from '../../src/orchestrator/outbound.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { PgUserRepo } from '../../src/persistence/index.js'
import type { OrgMemberRole } from '../../src/persistence/ports.js'
import type { DaemonLiveness } from '../../src/ports.js'
import type {
  DreamStartReq,
  DreamCancelReq,
  DreamListReq,
  DreamGetReq,
  DreamAdoptReq,
  DreamDiscardReq,
  DreamFilesReq,
  DreamFileReadReq,
  DreamInfo,
  DreamState,
  DreamListPage,
  DreamFilesPage,
  DreamFileReadContent
} from '@agentconnect.md/protocol'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd0d0d0d0-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a0a0a0a0-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

let running: HttpApp | undefined
afterEach(async () => {
  await running?.close()
  running = undefined
})

async function makeUser(sub: string, role: OrgMemberRole): Promise<string> {
  const users = new PgUserRepo(prisma)
  const email = `${sub}@acme.dev`
  const { userId } = await users.provisionOidcUser({ oidcSubject: sub, email, emailVerified: true })
  await users.addMemberByEmail(DEFAULT_ORG_ID, email, role)
  return userId
}

const dream = (over: Partial<DreamInfo> = {}): DreamInfo => ({
  dreamId: 'drm-1',
  agentId: AGENT,
  status: 'pending',
  trigger: 'manual',
  sessionIds: ['s1'],
  snapshotDigest: 'sha256:abc',
  createdAt: '2026-07-24T00:00:00.000Z',
  ...over
})

/** A ControlSender spy recording every dream call and answering canned data. */
class SpyControl {
  startCalls: DreamStartReq[] = []
  cancelCalls: DreamCancelReq[] = []
  listCalls: DreamListReq[] = []
  getCalls: DreamGetReq[] = []
  adoptCalls: DreamAdoptReq[] = []
  discardCalls: DreamDiscardReq[] = []
  filesCalls: DreamFilesReq[] = []
  fileCalls: DreamFileReadReq[] = []
  async dreamStart(_d: string, req: DreamStartReq): Promise<DreamState> {
    this.startCalls.push(req)
    return { dream: dream({ instructions: req.instructions }) }
  }
  async dreamCancel(_d: string, req: DreamCancelReq): Promise<DreamState> {
    this.cancelCalls.push(req)
    return { dream: dream({ status: 'canceled', endedAt: '2026-07-24T00:01:00.000Z' }) }
  }
  async dreamList(_d: string, req: DreamListReq): Promise<DreamListPage> {
    this.listCalls.push(req)
    return { agentId: AGENT, dreams: [dream({ status: 'completed' })] }
  }
  async dreamGet(_d: string, req: DreamGetReq): Promise<DreamState> {
    this.getCalls.push(req)
    return { dream: dream({ status: 'completed' }) }
  }
  async dreamAdopt(_d: string, req: DreamAdoptReq): Promise<DreamState> {
    this.adoptCalls.push(req)
    return { dream: dream({ status: 'adopted', endedAt: '2026-07-24T00:02:00.000Z' }) }
  }
  async dreamDiscard(_d: string, req: DreamDiscardReq): Promise<DreamState> {
    this.discardCalls.push(req)
    return { dream: dream({ status: 'discarded', endedAt: '2026-07-24T00:03:00.000Z' }) }
  }
  async dreamFiles(_d: string, req: DreamFilesReq): Promise<DreamFilesPage> {
    this.filesCalls.push(req)
    return {
      agentId: AGENT,
      dreamId: req.dreamId,
      exists: true,
      entries: [{ name: 'MEMORY.md', size: 12, mtime: '2026-07-24T00:00:00.000Z' }]
    }
  }
  async dreamFileRead(_d: string, req: DreamFileReadReq): Promise<DreamFileReadContent> {
    this.fileCalls.push(req)
    return {
      agentId: AGENT,
      dreamId: req.dreamId,
      path: req.path,
      exists: true,
      size: 12,
      mtime: '2026-07-24T00:00:00.000Z',
      content: '# Memory\n',
      offset: 0,
      nextOffset: 9,
      truncated: false
    }
  }
}

describe('memory dreaming routes — proxy + managed guard', () => {
  it('starts a dream and forwards per-run overrides', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = new SpyControl()
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/memory/dreams`,
      payload: { sessionWindow: 10, instructions: 'focus on prefs' }
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ dreamId: 'drm-1', status: 'pending', instructions: 'focus on prefs' })
    expect(s.startCalls[0]).toMatchObject({ agentId: AGENT, trigger: 'manual', sessionWindow: 10 })
  })

  it('lists, gets, and reviews staged files', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = new SpyControl()
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    expect((await running.app.inject({ url: `${ORG}/agents/${AGENT}/memory/dreams` })).json()).toMatchObject({
      dreams: [{ dreamId: 'drm-1', status: 'completed' }]
    })
    expect((await running.app.inject({ url: `${ORG}/agents/${AGENT}/memory/dreams/drm-1` })).json()).toMatchObject({
      status: 'completed'
    })
    expect(
      (await running.app.inject({ url: `${ORG}/agents/${AGENT}/memory/dreams/drm-1/files` })).json()
    ).toMatchObject({ exists: true, files: [{ name: 'MEMORY.md' }] })
    const file = await running.app.inject({ url: `${ORG}/agents/${AGENT}/memory/dreams/drm-1/file?path=MEMORY.md` })
    expect(file.json()).toMatchObject({ exists: true, content: '# Memory\n', nextOffset: 9 })
    expect(s.fileCalls[0]).toMatchObject({ path: 'MEMORY.md', offset: 0, limit: 65536 })
  })

  it('adopts (forwarding force) and discards', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = new SpyControl()
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)

    const adopt = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/memory/dreams/drm-1/adopt`,
      payload: { force: true }
    })
    expect(adopt.json()).toMatchObject({ status: 'adopted' })
    expect(s.adoptCalls[0]).toMatchObject({ dreamId: 'drm-1', force: true })

    const discard = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/memory/dreams/drm-1/discard`,
      payload: {}
    })
    expect(discard.json()).toMatchObject({ status: 'discarded' })
  })

  it('maps a daemon CONFLICT (fence / wrong state) to 409', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    const s = {
      async dreamAdopt(): Promise<DreamState> {
        throw new ProtocolError('CONFLICT', 'the live store changed since this dream was snapshotted')
      }
    }
    running = buildHttpApp(prisma, undefined, LIVE, s as unknown as ControlSender)
    const res = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${AGENT}/memory/dreams/drm-1/adopt`,
      payload: {}
    })
    expect(res.statusCode).toBe(409)
  })

  it('400s a non-managed provider and 503s an unplaced agent', async () => {
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON })
    await prisma.agent.update({
      where: { id: AGENT },
      data: { runtimeOverrides: { memory: { provider: 'native' } } }
    })
    running = buildHttpApp(prisma, undefined, LIVE, new SpyControl() as unknown as ControlSender)
    const nonManaged = await running.app.inject({ url: `${ORG}/agents/${AGENT}/memory/dreams` })
    expect(nonManaged.statusCode).toBe(400)
    await running.close()

    const OTHER = 'b0b0b0b0-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    await seedAgent(prisma, OTHER) // unplaced (no daemon)
    running = buildHttpApp(prisma, undefined, LIVE, new SpyControl() as unknown as ControlSender)
    const unplaced = await running.app.inject({
      method: 'POST',
      url: `${ORG}/agents/${OTHER}/memory/dreams`,
      payload: {}
    })
    expect(unplaced.statusCode).toBe(503)
  })
})

describe('memory dreaming routes — edit gate (viewer 403)', () => {
  it('rejects a viewer on every lifecycle mutation without contacting the daemon; reads still pass', async () => {
    const viewer = await makeUser('dream-viewer', 'viewer')
    await seedDaemon(prisma, DAEMON)
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, visibility: 'restricted', sharedWith: [viewer] })
    const s = new SpyControl()
    running = buildHttpApp(prisma, { DEFAULT_OWNER_ID: viewer }, LIVE, s as unknown as ControlSender)

    const mutations: Array<[string, string]> = [
      ['POST', `${ORG}/agents/${AGENT}/memory/dreams`],
      ['POST', `${ORG}/agents/${AGENT}/memory/dreams/drm-1/cancel`],
      ['POST', `${ORG}/agents/${AGENT}/memory/dreams/drm-1/adopt`],
      ['POST', `${ORG}/agents/${AGENT}/memory/dreams/drm-1/discard`]
    ]
    for (const [method, url] of mutations) {
      const res = await running.app.inject({ method: method as 'POST', url, payload: {} })
      expect(res.statusCode, `${method} ${url}`).toBe(403)
    }
    // The viewer-read-only invariant: no mutation reached the daemon.
    expect(s.startCalls).toHaveLength(0)
    expect(s.cancelCalls).toHaveLength(0)
    expect(s.adoptCalls).toHaveLength(0)
    expect(s.discardCalls).toHaveLength(0)

    // A viewer can still read (list/get), which do not require edit rights.
    expect((await running.app.inject({ url: `${ORG}/agents/${AGENT}/memory/dreams` })).statusCode).toBe(200)
    expect(s.listCalls).toHaveLength(1)
  })
})
