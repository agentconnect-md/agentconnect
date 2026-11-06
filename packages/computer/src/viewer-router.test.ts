import { describe, expect, it } from 'vitest'
import type { DesktopManager, RunningDesktop } from './linux/desktops.js'
import type { Viewer, ViewerRequest } from './viewer.js'
import { createViewerRouter } from './viewer-router.js'

type LiveViewer = Viewer & { statusChanged(): void }

function fakeViewer(name: string, seen: string[], closed: string[] = []): LiveViewer {
  return {
    api: async (request) => {
      seen.push(`${name} ${request.method} ${request.path}`)
      return { status: 200, headers: {}, body: Buffer.from(name) }
    },
    channelMessage: async () => null,
    handle: async () => undefined,
    disconnectAll: () => undefined,
    close: () => closed.push(name),
    statusChanged: () => undefined
  }
}

function setup() {
  const seen: string[] = []
  const closed: string[] = []
  const created: string[] = []
  const started: string[] = []
  const desktop = { record: { id: 'd1' }, display: ':5', computer: { leaseActivity: () => ({ holder: 'agent-a' }) } }
  const manager = {
    enabled: () => true,
    list: () => [{ id: 'd1', key: 'agent-a', label: 'agent-a', running: true, status: 'busy' }],
    runningDesktops: () => [desktop],
    byId: async (id: string) => {
      started.push(id)
      return id === 'd1' ? desktop : undefined
    },
    touch: () => undefined
  } as unknown as DesktopManager
  const router = createViewerRouter({
    main: fakeViewer('main', seen, closed),
    desktops: () => manager,
    forDesktop: (running: RunningDesktop) => {
      created.push(running.record.id)
      return fakeViewer(running.record.id, seen, closed)
    },
    // `Bearer d2` is a console token for desktop d2 only (§3.9).
    authenticate: (authorization) =>
      authorization === 'Bearer ok'
        ? { client: 'person', control: true }
        : authorization === 'Bearer d2'
          ? { client: 'console:u', control: true, desktop: 'd2' }
          : undefined,
    mainInfo: () => ({ name: 'box', status: 'online', lease: null })
  })
  const call = (path: string, authorization = 'Bearer ok', method = 'GET') =>
    router.api({ method, path, authorization, via: 'local' } satisfies ViewerRequest)
  return { router, call, seen, closed, created, started }
}

describe('viewer router', () => {
  it('lists the main desktop and each agent desktop to an authenticated viewer only', async () => {
    const { call } = setup()
    expect((await call('/view/api/desktops', 'Bearer nope')).status).toBe(401)
    const listed = JSON.parse((await call('/view/api/desktops')).body.toString()) as { desktops: unknown[] }
    expect(listed).toEqual({
      perAgent: true,
      desktops: [
        { id: 'main', label: 'Main desktop', name: 'box', running: true, status: 'online', holder: null },
        { id: 'd1', label: 'agent-a', running: true, status: 'busy', holder: 'agent-a' }
      ]
    })
  })

  it("serves a desktop's API from its own viewer, created once, and the rest from the main one", async () => {
    const { call, seen, created } = setup()
    await call('/view/api/d/d1/status')
    await call('/view/api/d/d1/control', 'Bearer ok', 'POST')
    await call('/view/api/status')
    await call('/view/api/d/main/frame')
    expect(created).toEqual(['d1'])
    expect(seen).toEqual([
      'd1 GET /view/api/status',
      'd1 POST /view/api/control',
      'main GET /view/api/status',
      'main GET /view/api/frame'
    ])
  })

  it('starts no desktop for an unauthenticated caller and answers 404 for an unknown one', async () => {
    const { call, started } = setup()
    expect((await call('/view/api/d/d1/status', 'Bearer nope')).status).toBe(401)
    expect(started).toEqual([])
    expect((await call('/view/api/d/d9/status')).status).toBe(404)
  })

  it("closes a stopped desktop's viewer, and builds a new one when it is opened again", async () => {
    const { router, call, closed, created } = setup()
    await call('/view/api/d/d1/status')
    router.dropDesktop('d1')
    expect(closed).toEqual(['d1'])
    await call('/view/api/d/d1/status')
    expect(created).toEqual(['d1', 'd1'])
  })

  it('opens, and so starts, no desktop but the one a console token names', async () => {
    const { call, started } = setup()
    expect((await call('/view/api/d/d1/status', 'Bearer d2')).status).toBe(401)
    expect(started).toEqual([])
  })
})
