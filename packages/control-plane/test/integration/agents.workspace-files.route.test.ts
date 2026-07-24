/**
 * Scratch workspace file edits stay daemon-local: the CP authorizes the agent
 * manager, verifies scratch mode, and proxies one exclusive create or optimistic
 * whole-file replacement.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { WorkspaceWriteOk, WorkspaceWriteReq } from '@agentconnect.md/protocol'
import { prisma } from '../setup.db.js'
import { seedAgent, seedDaemon } from '../fixtures/seed.js'
import { buildHttpApp, type HttpApp } from '../fakes/build-http.js'
import type { ControlSender } from '../../src/orchestrator/outbound.js'
import type { DaemonLiveness } from '../../src/ports.js'
import { ProtocolError } from '../../src/domain/errors.js'
import { PgUserRepo } from '../../src/persistence/repositories/user.repo.js'
import { DEFAULT_ORG_ID } from '../../prisma/seed.js'

const ORG = `/api/v1/orgs/${DEFAULT_ORG_ID}`
const DAEMON = 'd1d1d1d1-dddd-4ddd-8ddd-dddddddddddd'
const AGENT = 'a1a1a1a1-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MTIME = '2026-07-25T00:00:00.000Z'
const CAPABILITIES = {
  platforms: ['slack'],
  runtimes: ['claude'],
  acp: true,
  features: ['workspace-file-edit-v1']
}
const LIVE: DaemonLiveness = {
  get: (id) => (id === DAEMON ? { state: 'READY', reachable: true, sessionEpoch: 1 } : undefined)
}

const opened: HttpApp[] = []
afterEach(async () => {
  await Promise.all(opened.splice(0).map((app) => app.close()))
})

class WorkspaceWriteSpy {
  calls: Array<{ daemonId: string; req: WorkspaceWriteReq }> = []

  async workspaceWrite(daemonId: string, req: WorkspaceWriteReq): Promise<WorkspaceWriteOk> {
    this.calls.push({ daemonId, req })
    return { agentId: req.agentId, path: req.path, size: 8, mtime: '2026-07-25T00:01:00.000Z' }
  }
}

async function seedScratch(): Promise<void> {
  await seedDaemon(prisma, DAEMON, { capabilities: CAPABILITIES })
  await seedAgent(prisma, AGENT, { daemonId: DAEMON })
}

function app(control: WorkspaceWriteSpy, userId?: string): HttpApp {
  const running = buildHttpApp(
    prisma,
    userId ? { DEFAULT_OWNER_ID: userId } : undefined,
    LIVE,
    control as unknown as ControlSender
  )
  opened.push(running)
  return running
}

describe('PUT /agents/:id/workspace/file', () => {
  it('proxies an optimistic replacement without storing content', async () => {
    await seedScratch()
    const control = new WorkspaceWriteSpy()
    const running = app(control)

    const response = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/workspace/file?path=notes/todo.md`,
      payload: { content: '# After\n', ifMatchMtime: MTIME }
    })

    expect(response.statusCode).toBe(200)
    expect(control.calls[0]).toMatchObject({
      daemonId: DAEMON,
      req: { agentId: AGENT, path: 'notes/todo.md', ifMatchMtime: MTIME }
    })
    expect(Buffer.from(control.calls[0]!.req.contentBase64, 'base64').toString('utf8')).toBe('# After\n')
  })

  it('keeps GitHub workspaces read-only and rejects a viewer before daemon I/O', async () => {
    await seedDaemon(prisma, DAEMON, { capabilities: CAPABILITIES })
    await seedAgent(prisma, AGENT, { daemonId: DAEMON, gitRepo: 'https://github.com/acme/repo' })
    const control = new WorkspaceWriteSpy()

    const github = await app(control).app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/workspace/file?path=README.md`,
      payload: { content: 'changed', ifMatchMtime: MTIME }
    })
    expect(github.statusCode).toBe(400)

    const users = new PgUserRepo(prisma)
    const email = `workspace-viewer-${randomUUID()}@acme.dev`
    const { userId } = await users.provisionOidcUser({
      oidcSubject: `workspace-viewer-${randomUUID()}`,
      email,
      emailVerified: true
    })
    await users.addMemberByEmail(DEFAULT_ORG_ID, email, 'viewer')
    await prisma.agent.update({ where: { id: AGENT }, data: { workspaceMode: 'scratch', gitRepo: null } })

    const viewer = await app(control, userId).app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/workspace/file?path=README.md`,
      payload: { content: 'changed', ifMatchMtime: MTIME }
    })
    expect(viewer.statusCode).toBe(403)
    expect(control.calls).toHaveLength(0)
  })

  it('maps a stale daemon write to HTTP 409', async () => {
    await seedScratch()
    const control = new WorkspaceWriteSpy()
    control.workspaceWrite = async () => {
      throw new ProtocolError('CONFLICT', 'the workspace file changed; reload and retry')
    }
    const running = app(control)

    const res = await running.app.inject({
      method: 'PUT',
      url: `${ORG}/agents/${AGENT}/workspace/file?path=notes.md`,
      payload: { content: 'stale', ifMatchMtime: MTIME }
    })
    expect(res.statusCode).toBe(409)
  })
})
