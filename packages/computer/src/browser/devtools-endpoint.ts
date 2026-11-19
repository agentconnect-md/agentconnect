// Finds and checks each desktop browser's DevTools endpoint before the daemon reports `devtools` (computer-use.md §3.10, §5.8).
import { statSync, readFileSync } from 'node:fs'
import { request } from 'node:http'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { browserAncestor, listeningSockets, realProc, socketHolders, type ProcFs } from '../form-fill/attribution.js'
import { PORT_FILE, switches } from './devtools-launch.js'
import { profileOwner } from './launcher.js'

/** A browser's endpoint: its loopback port and `/devtools/browser/<uuid>`, which never leaves the daemon. */
export interface DevtoolsEndpoint {
  port: number
  path: string
}

export type EndpointStatus =
  | 'pending'
  | 'ok'
  // Its command line has no switch: it started while the tier was off.
  | 'before the tier'
  | 'not found'
  | 'self-test failed'
  // Its command line carries `--remote-allow-origins`, or another proxy than the forwarder expected.
  | 'refused switches'

export interface DesktopEndpoint {
  desktop: string
  pid: number
  status: EndpointStatus
  // The port the file named, once read; set with `ok` and kept with a failed self-test.
  endpoint?: DevtoolsEndpoint
  // Ports the browser listens on besides its endpoint, such as the `chrome://inspect` checkbox's 9222.
  extra?: number[]
  // With the tier off, the endpoint port this browser was verified on while the tier was on, still listening.
  kept?: number
}

export type SelfTestOutcome = 'refused' | 'accepted' | 'error'

// A browser whose file has not checked out this long after it was seen reports `not found` (it is retried still).
const FIND_MS = 30_000
const POLL_MS = 2000
const HTTP_TIMEOUT_MS = 3000
// An origin no page of Chrome's own front end has: Chrome must refuse its WebSocket handshake (§5.8).
const FOREIGN_ORIGIN = 'https://devtools-self-test.example'
const CLOCK_TICKS = 100

/** The `DevToolsActivePort` text: `<port>\n/devtools/browser/<uuid>`, with no trailing newline. */
export function parsePortFile(text: string): DevtoolsEndpoint | undefined {
  const match = /^(\d{1,5})\n(\/devtools\/browser\/[0-9a-f-]{36})$/.exec(text)
  const port = Number(match?.[1])
  return match && port > 0 && port < 65_536 ? { port, path: match[2]! } : undefined
}

/** When a process started, in epoch milliseconds, from its stat start time and the boot time; undefined when unreadable. */
export function processStartMs(proc: ProcFs, pid: number): number | undefined {
  try {
    const stat = proc.read(`/proc/${pid}/stat`)
    const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19])
    const boot = Number(/^btime (\d+)$/m.exec(proc.read('/proc/stat'))?.[1])
    return Number.isFinite(ticks) && Number.isFinite(boot) ? boot * 1000 + (ticks * 1000) / CLOCK_TICKS : undefined
  } catch {
    return undefined
  }
}

export interface PortFileReader {
  mtimeMs(path: string): number
  read(path: string): string
}

const realFiles: PortFileReader = {
  mtimeMs: (path) => statSync(path).mtimeMs,
  read: (path) => readFileSync(path, 'utf8')
}

/** The endpoint a profile's port file names, only when it was written after `startedMs`: the file outlives its browser. */
export function readPortFile(
  profile: string,
  startedMs: number,
  files: PortFileReader = realFiles
): DevtoolsEndpoint | undefined {
  const path = join(profile, PORT_FILE)
  try {
    // Start times have a tick's resolution, so a file written in the start's own tick still counts.
    if (files.mtimeMs(path) < startedMs - 1000 / CLOCK_TICKS) return undefined
    return parsePortFile(files.read(path))
  } catch {
    return undefined
  }
}

function httpGet(port: number, path: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const req = request({ host: '127.0.0.1', port, path, timeout: HTTP_TIMEOUT_MS }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => (body.length < 65_536 ? (body += chunk) : undefined))
      res.on('end', () => resolve(res.statusCode === 200 ? body : undefined))
      res.on('error', () => resolve(undefined))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(undefined))
    req.end()
  })
}

/** `/json/version`'s `webSocketDebuggerUrl` path on that port; a file whose path differs names another browser. */
export async function versionPath(port: number): Promise<string | undefined> {
  const body = await httpGet(port, '/json/version')
  try {
    const url = (JSON.parse(body ?? '') as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl
    return typeof url === 'string' ? new URL(url).pathname : undefined
  } catch {
    return undefined
  }
}

/** A WebSocket handshake with a foreign `Origin`: 403 is refused, an upgrade or any other answer accepted, no answer an error. */
export function foreignOriginRefused(endpoint: DevtoolsEndpoint, origin = FOREIGN_ORIGIN): Promise<SelfTestOutcome> {
  return new Promise((resolve) => {
    const req = request({
      host: '127.0.0.1',
      port: endpoint.port,
      path: endpoint.path,
      timeout: HTTP_TIMEOUT_MS,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        Origin: origin
      }
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve('accepted')
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode === 403 ? 'refused' : 'accepted')
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve('error'))
    req.end()
  })
}

/** Why a browser's command line is refused, if it is: its own switches, which the launcher's are not to be overridden by. */
export function commandLineProblem(
  cmdline: string,
  proxyPort: number | undefined
): 'before the tier' | 'refused switches' | undefined {
  // Chrome rewrites its title into one space-separated string, so both separators are split on; `-name` counts as `--name`.
  const args = switches(cmdline.split(/[\0 ]+/).filter(Boolean))
  if (!args.some((arg) => arg.startsWith('--remote-debugging-port='))) return 'before the tier'
  if (args.some((arg) => arg.startsWith('--remote-allow-origins'))) return 'refused switches'
  if (proxyPort === undefined) return undefined
  const proxies = args.filter((arg) => arg.startsWith('--proxy-server'))
  const expected = `--proxy-server=http://127.0.0.1:${proxyPort}`
  return proxies.length > 0 &&
    proxies.every((arg) => arg === expected) &&
    !args.some((arg) => /^--no-proxy-server(=|$)/.test(arg))
    ? undefined
    : 'refused switches'
}

/** Every port a desktop's browser (its process or a child) listens on, by the browser's pid. */
export function browserPorts(proc: ProcFs, browsers: ReadonlySet<number>): Map<number, number[]> {
  const listening = new Map<string, number>()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const [inode, port] of listeningSockets(proc.read(table))) listening.set(inode, port)
    } catch {
      // No IPv6, or unreadable.
    }
  }
  const ports = new Map<number, number[]>()
  if (listening.size === 0 || browsers.size === 0) return ports
  for (const [inode, pids] of socketHolders(proc, new Set(listening.keys()))) {
    const browser = pids.map((pid) => browserAncestor(proc, pid)).find((pid) => pid !== undefined && browsers.has(pid))
    const port = listening.get(inode)!
    if (browser !== undefined && !ports.get(browser)?.includes(port))
      ports.set(browser, [...(ports.get(browser) ?? []), port])
  }
  return ports
}

export interface DevtoolsEndpointsOptions {
  // Every desktop's browser profile, read per poll.
  desktops: () => { desktop: string; profile: string }[]
  // The tier is on: endpoints are looked for only then, and all drop when it goes off.
  active: () => boolean
  // The forwarder every tier browser must name as its proxy, a managed pod's or the daemon's own.
  proxyPort: () => number | undefined
  log: (line: string) => void
  // The set of desktops with a checked endpoint changed.
  onChange?: () => void
  proc?: ProcFs
  files?: PortFileReader
  owner?: (profile: string) => number | undefined
  versionPath?: (port: number) => Promise<string | undefined>
  selfTest?: (endpoint: DevtoolsEndpoint) => Promise<SelfTestOutcome>
  now?: () => number
  pollMs?: number
}

interface Tracked {
  pid: number
  seen: number
  status: EndpointStatus
  endpoint?: DevtoolsEndpoint
  // The port it was last verified on, kept after the tier goes off for `doctor`.
  verifiedPort?: number
}

/** Watches each desktop's browser: a new process is checked afresh, one that exits drops its endpoint. */
export class DevtoolsEndpoints {
  private readonly tracked = new Map<string, Tracked>()
  private timer: NodeJS.Timeout | undefined
  private polling: Promise<void> | undefined
  private readonly proc: ProcFs
  private readonly now: () => number

  constructor(private readonly opts: DevtoolsEndpointsOptions) {
    this.proc = opts.proc ?? realProc
    this.now = opts.now ?? Date.now
  }

  start(): void {
    this.timer ??= setInterval(() => void this.poll(), this.opts.pollMs ?? POLL_MS)
    this.timer.unref()
    void this.poll()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  /** The desktops whose browser passed every check, in a stable order. */
  verified(): string[] {
    return [...this.tracked]
      .filter(([, entry]) => entry.status === 'ok')
      .map(([desktop]) => desktop)
      .sort()
  }

  /** The endpoint the child and the viewer will use; never reported or logged. */
  endpoint(desktop: string): DevtoolsEndpoint | undefined {
    const entry = this.tracked.get(desktop)
    return entry?.status === 'ok' ? entry.endpoint : undefined
  }

  /** Each running browser's state, and the ports it listens on besides the endpoint read, for `doctor`. */
  report(): DesktopEndpoint[] {
    const pids = new Set([...this.tracked.values()].map((entry) => entry.pid))
    const ports = pids.size > 0 ? browserPorts(this.proc, pids) : new Map<number, number[]>()
    const active = this.opts.active()
    return [...this.tracked].map(([desktop, entry]) => {
      const extra = (ports.get(entry.pid) ?? []).filter((port) => port !== entry.endpoint?.port)
      // With the tier off, the port it was verified on is the switch's, which stays until the browser restarts.
      const kept = active ? undefined : extra.find((port) => port === entry.verifiedPort)
      // With the tier on, the switch's own port is not known to be the endpoint until the file is read.
      const counted = active && entry.status === 'pending' ? [] : extra.filter((port) => port !== kept)
      return {
        desktop,
        pid: entry.pid,
        status: entry.status,
        ...(entry.endpoint ? { endpoint: entry.endpoint } : {}),
        ...(counted.length > 0 ? { extra: counted } : {}),
        ...(kept !== undefined ? { kept } : {})
      }
    })
  }

  /** One pass over every desktop; overlapping calls share it. */
  poll(): Promise<void> {
    this.polling ??= this.pass().finally(() => (this.polling = undefined))
    return this.polling
  }

  // Running browsers are tracked with the tier off too, so `doctor` can name a port the checkbox opened.
  private async pass(): Promise<void> {
    const before = this.verified().join(',')
    const owner = this.opts.owner ?? ((profile: string) => profileOwner(profile))
    const active = this.opts.active()
    const seen = new Set<string>()
    for (const { desktop, profile } of this.opts.desktops()) {
      const pid = owner(profile)
      if (pid === undefined) continue
      seen.add(desktop)
      let entry = this.tracked.get(desktop)
      if (!entry || entry.pid !== pid) {
        entry = { pid, seen: this.now(), status: 'pending' }
        this.tracked.set(desktop, entry)
      }
      if (!active) {
        entry.status = 'pending'
        delete entry.endpoint
        continue
      }
      if (entry.status !== 'pending' && entry.status !== 'not found') continue
      await this.check(desktop, profile, entry)
    }
    for (const desktop of [...this.tracked.keys()]) if (!seen.has(desktop)) this.tracked.delete(desktop)
    if (this.verified().join(',') !== before) this.opts.onChange?.()
  }

  private async check(desktop: string, profile: string, entry: Tracked): Promise<void> {
    let cmdline: string
    try {
      cmdline = this.proc.read(`/proc/${entry.pid}/cmdline`)
    } catch {
      return
    }
    const problem = commandLineProblem(cmdline, this.opts.proxyPort())
    if (problem) {
      entry.status = problem
      if (problem === 'refused switches')
        this.opts.log(
          `devtools: desktop ${desktop}'s browser carries switches the launcher does not pass; not reported`
        )
      return
    }
    const started = processStartMs(this.proc, entry.pid)
    const endpoint = started === undefined ? undefined : readPortFile(profile, started, this.opts.files)
    const path = endpoint ? await (this.opts.versionPath ?? versionPath)(endpoint.port) : undefined
    if (!endpoint || path !== endpoint.path) {
      if (entry.status === 'pending' && this.now() - entry.seen > FIND_MS) {
        entry.status = 'not found'
        this.opts.log(`devtools: no endpoint found for desktop ${desktop}'s browser`)
      }
      return
    }
    const outcome = await (this.opts.selfTest ?? foreignOriginRefused)(endpoint)
    // No answer is no verdict: the next poll tries again.
    if (outcome === 'error') return
    entry.endpoint = endpoint
    if (outcome === 'refused') {
      entry.status = 'ok'
      entry.verifiedPort = endpoint.port
      this.opts.log(`devtools: desktop ${desktop}'s browser endpoint on port ${endpoint.port} passed its self-test`)
    } else {
      entry.status = 'self-test failed'
      this.opts.log(
        `devtools: desktop ${desktop}'s browser accepted a foreign Origin on port ${endpoint.port}; not reported`
      )
    }
  }
}
