// The viewer for a Computer with per-agent desktops: the main desktop, or the one under /view/api/d/<id> (computer-use.md §3.9).
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DesktopManager, RunningDesktop } from './linux/desktops.js'
import { mayWatch } from './mcp-access.js'
import type { Viewer, ViewerPrincipal, ViewerRequest, ViewerResponse, ViewerVia } from './viewer.js'

type LiveViewer = Viewer & { statusChanged(): void }

const DESKTOP_PATH = /^\/view\/api\/d\/([A-Za-z0-9_-]{1,32})(\/.*)$/
const MAX_BODY_BYTES = 64 * 1024

export interface ViewerRouterOptions {
  main: LiveViewer
  desktops: () => DesktopManager | undefined
  // A viewer of its own (capture, WebRTC, takeover) for a desktop's display and Computer.
  forDesktop: (desktop: RunningDesktop) => LiveViewer
  authenticate: (authorization: string | undefined, via: ViewerVia) => ViewerPrincipal | undefined
  // What the main desktop is called and whether an agent holds it, for the list.
  mainInfo: () => { name: string; status: string; lease: { holder: string } | null }
}

const json = (status: number, body: unknown): ViewerResponse => ({
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: Buffer.from(JSON.stringify(body))
})

export function createViewerRouter(options: ViewerRouterOptions): LiveViewer & { dropDesktop(id: string): void } {
  const viewers = new Map<string, LiveViewer>()

  const list = () => {
    const main = options.mainInfo()
    const manager = options.desktops()
    return {
      perAgent: Boolean(manager?.enabled()),
      desktops: [
        {
          id: 'main',
          label: 'Main desktop',
          name: main.name,
          running: true,
          status: main.status,
          holder: main.lease?.holder ?? null
        },
        ...(manager?.list() ?? []).map((desktop) => {
          const running = manager?.runningDesktops().find((candidate) => candidate.record.id === desktop.id)
          return {
            id: desktop.id,
            label: desktop.label,
            running: desktop.running,
            status: desktop.status ?? 'stopped',
            holder: running?.computer.leaseActivity()?.holder ?? null
          }
        })
      ]
    }
  }

  async function api(request: ViewerRequest): Promise<ViewerResponse> {
    if (request.path === '/view/api/desktops') {
      if (!options.authenticate(request.authorization, request.via)) return json(401, { error: 'unauthorized' })
      return json(200, list())
    }
    const match = DESKTOP_PATH.exec(request.path)
    if (!match || match[1] === 'main') {
      return options.main.api(match ? { ...request, path: `/view/api${match[2]}` } : request)
    }
    // Only a viewer allowed this desktop may start it by opening it (§3.9).
    const id = match[1]!
    const principal = options.authenticate(request.authorization, request.via)
    if (!principal || !mayWatch(principal, id)) return json(401, { error: 'unauthorized' })
    const manager = options.desktops()
    if (!manager?.enabled()) return json(404, { error: 'not_found', message: 'per-agent desktops are off' })
    let desktop: RunningDesktop | undefined
    try {
      desktop = await manager.byId(id)
    } catch (error) {
      return json(503, { error: 'unavailable', message: (error as Error).message })
    }
    if (!desktop) return json(404, { error: 'not_found', message: `no desktop ${id}` })
    // Stopping meanwhile: a viewer kept for it would outlive its display.
    if (desktop.stopping) return json(503, { error: 'unavailable', message: `desktop ${id} is stopping` })
    manager.touch(id)
    let viewer = viewers.get(id)
    if (!viewer) {
      viewer = options.forDesktop(desktop)
      viewers.set(id, viewer)
    }
    return viewer.api({ ...request, path: `/view/api${match[2]}` })
  }

  return {
    api,
    channelMessage: (principal, message) => options.main.channelMessage(principal, message),
    async handle(req: IncomingMessage, res: ServerResponse, path: string) {
      if (!(path === '/view/api/desktops' || DESKTOP_PATH.test(path))) return options.main.handle(req, res, path)
      const chunks: Buffer[] = []
      let size = 0
      if (req.method === 'POST') {
        for await (const chunk of req as AsyncIterable<Buffer>) {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            res.writeHead(400, { 'content-type': 'application/json' })
            return void res.end(JSON.stringify({ error: 'invalid_argument', message: 'request body too large' }))
          }
          chunks.push(chunk)
        }
      }
      const out = await api({
        method: req.method ?? 'GET',
        path,
        authorization: req.headers.authorization,
        via: 'local',
        ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}),
        ...(req.socket.localAddress ? { hostAddress: req.socket.localAddress } : {})
      })
      res.writeHead(out.status, out.headers)
      res.end(out.body)
    },
    disconnectAll(reason) {
      options.main.disconnectAll(reason)
      for (const viewer of viewers.values()) viewer.disconnectAll(reason)
    },
    close() {
      options.main.close()
      for (const viewer of viewers.values()) viewer.close()
      viewers.clear()
    },
    statusChanged() {
      options.main.statusChanged()
      for (const viewer of viewers.values()) viewer.statusChanged()
    },
    dropDesktop(id) {
      const viewer = viewers.get(id)
      if (!viewer) return
      viewers.delete(id)
      viewer.disconnectAll('the desktop stopped')
      viewer.close()
    }
  }
}
