import { createServer, type Server } from 'node:http'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

// Pool-member readiness (#1043): a member's process is up long before it has registered with the
// CP and learned from a sandbox what the runtime image provides, so without a signal the
// deployment side can only guess at the gap with a fixed minReadySeconds.

/** Why a member is not servable; `ready` is the only servable value. */
export type ReadinessReason = 'ready' | 'draining' | 'starting' | 'control-plane-unregistered' | 'runtime-probe-pending'

export interface ReadinessInputs {
  /** `start()` returned. False from the first instruction of the process, before anything is dialled. */
  startupComplete: boolean
  /** The CP connection is authenticated AND this daemon's registration was acknowledged. */
  cpRegistered: boolean
  /** The install-wide sandbox runtime probe returned, so the member advertises what it can launch. */
  runtimeProbed: boolean
  /** SIGTERM drain has started: in-flight turns keep running, but no new traffic may arrive. */
  draining: boolean
}

export interface ReadinessState {
  ready: boolean
  reason: ReadinessReason
}

/** The single readiness predicate both sinks are derived from. */
export function readinessState(inputs: ReadinessInputs): ReadinessState {
  // Draining wins over everything: a draining member is still registered and still probed, and the
  // point of the signal at SIGTERM is that neither makes it servable any more.
  if (inputs.draining) return { ready: false, reason: 'draining' }
  // Answered before the daemon has done anything at all: startup blocks on the CP registry, and a
  // marker left on a mounted path by the previous container must not read as ready meanwhile.
  if (!inputs.startupComplete) return { ready: false, reason: 'starting' }
  if (!inputs.cpRegistered) return { ready: false, reason: 'control-plane-unregistered' }
  if (!inputs.runtimeProbed) return { ready: false, reason: 'runtime-probe-pending' }
  return { ready: true, reason: 'ready' }
}

/** The one path the HTTP sink answers on; anything else is a 404, not a health surface. */
export const READINESS_HTTP_PATH = '/readyz'

/** Where the file sink lands unless `AC_READINESS_FILE` names somewhere else. */
export const DEFAULT_READINESS_FILE = '/var/run/agentconnect/ready'

/** How often the file sink is reconciled with the predicate, between explicit refreshes. */
const DEFAULT_SYNC_INTERVAL_MS = 1000

export interface ReadinessSinks {
  /** HTTP port; undefined leaves the endpoint off, which is the default. */
  port?: number
  /** Readiness file path; empty disables the file sink. */
  filePath?: string
}

/** Read the two sink knobs off the environment. An unusable port is reported, not guessed at. */
export function readinessSinksFromEnv(
  env: NodeJS.ProcessEnv,
  warn: (message: string) => void = () => {}
): ReadinessSinks {
  const raw = env.AC_READINESS_PORT?.trim()
  let port: number | undefined
  if (raw) {
    const parsed = Number(raw)
    if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 65535) port = parsed
    else warn('readiness: AC_READINESS_PORT is not a port number — HTTP readiness stays off')
  }
  const configured = env.AC_READINESS_FILE
  const filePath = configured === undefined ? DEFAULT_READINESS_FILE : configured.trim()
  return { ...(port !== undefined ? { port } : {}), ...(filePath ? { filePath } : {}) }
}

export interface ReadinessGateOptions extends ReadinessSinks {
  /** The live predicate; evaluated per HTTP request and per file sync, never cached. */
  state: () => ReadinessState
  host?: string
  syncIntervalMs?: number
  log: { info: (message: string) => void; warn: (message: string) => void }
}

/**
 * Publishes {@link readinessState} on the two sinks a Kubernetes probe can read: a tiny HTTP
 * endpoint (`httpGet`) and a file (`exec test -f`). Both re-evaluate the same closure, so a pod
 * configured either way gets one answer with two spellings.
 */
export class ReadinessGate {
  private server?: Server
  private timer?: NodeJS.Timeout
  private filePresent = false
  private fileFailed = false
  private port?: number

  constructor(private readonly opts: ReadinessGateOptions) {}

  async start(): Promise<void> {
    // A file left by a previous container in this pod would read as ready before this process has
    // proved anything, so the sink starts from a known-absent state.
    this.clearFile()
    if (this.opts.port !== undefined) await this.startHttp(this.opts.port)
    this.timer = setInterval(() => this.syncFile(), this.opts.syncIntervalMs ?? DEFAULT_SYNC_INTERVAL_MS)
    this.timer.unref()
    this.syncFile()
  }

  /** Reconcile the file sink now — called at transitions so SIGTERM does not wait for a tick. */
  refresh(): void {
    this.syncFile()
  }

  /** The bound HTTP port, or undefined when the endpoint is off. */
  listeningPort(): number | undefined {
    return this.port
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.clearFile()
    const server = this.server
    this.server = undefined
    this.port = undefined
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async startHttp(port: number): Promise<void> {
    const server = createServer((req, res) => {
      if ((req.url ?? '').split('?', 1)[0] !== READINESS_HTTP_PATH) {
        res.statusCode = 404
        res.end()
        return
      }
      const state = this.opts.state()
      res.statusCode = state.ready ? 200 : 503
      res.setHeader('content-type', 'application/json')
      res.setHeader('cache-control', 'no-store')
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify(state))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, this.opts.host ?? '0.0.0.0', () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    this.server = server
    this.port = (server.address() as { port: number }).port
    this.opts.log.info(`readiness: listening on ${this.opts.host ?? '0.0.0.0'}:${this.port}${READINESS_HTTP_PATH}`)
  }

  private syncFile(): void {
    const path = this.opts.filePath
    if (!path || this.fileFailed) return
    const state = this.opts.state()
    if (state.ready === this.filePresent) return
    if (!state.ready) {
      this.clearFile()
      return
    }
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, `${state.reason}\n`)
      this.filePresent = true
      this.opts.log.info(`readiness: ready — wrote ${path}`)
    } catch (error) {
      // One warning, then the sink is off: an unwritable path is a deployment that probes over
      // HTTP, not a reason to log once a second forever.
      this.fileFailed = true
      this.opts.log.warn(`readiness: cannot write ${path} — file readiness is off (${(error as Error).message})`)
    }
  }

  private clearFile(): void {
    const path = this.opts.filePath
    if (!path || this.fileFailed) return
    try {
      rmSync(path, { force: true })
    } catch (error) {
      this.opts.log.warn(`readiness: cannot remove ${path} (${(error as Error).message})`)
    }
    this.filePresent = false
  }
}
