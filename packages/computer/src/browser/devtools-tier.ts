// Whether a desktop's browsers get the DevTools endpoint, and what the launcher passes for it (computer-use.md §5.8).
import type { ComputerIsolation, ComputerPolicy } from '@agentconnect.md/protocol/computer'
import { realProc, socketHolders, type ProcFs } from '../form-fill/attribution.js'
import type { Check } from '../setup.js'
import type { DesktopEndpoint } from './devtools-endpoint.js'
import { STATE_WAIT_MS, writeDevtoolsState, type DevtoolsLaunch } from './devtools-launch.js'

const CHECK_MS = 60_000
// Docker's embedded DNS address, 127.0.0.11, as the IPv4 and v4-mapped IPv6 tables spell it.
const DOCKER_DNS = new Set(['0B00007F', '0000000000000000FFFF00000B00007F'])
// TCP in any state and UDP; `/proc/net/unix` stays out: ssh-agent and gpg-agent hold sockets no process shows (measured).
const TABLES = ['tcp', 'tcp6', 'udp', 'udp6']
const NO_GRANT: TierGrant = { granted: false, hideWebdriver: true }

/** Sockets no process this daemon can see holds: another user's process, or another network namespace's tenant. */
export type NamespaceVerdict = { own: true } | { own: false; sockets: string[] } | { own: false; unreadable: true }

interface NamespaceSocket {
  // `tcp 22` or `udp 5353`: the protocol and local port.
  label: string
  dockerDns: boolean
  // The table's local address and its state (`0A` is a TCP listener), as the kernel writes them.
  local: string
  state: string
  tcp: boolean
}

/** Every TCP and UDP socket in the namespace by inode; inode 0 (TIME_WAIT, a socket its process closed) has no holder. */
export function namespaceSockets(proc: ProcFs): Map<string, NamespaceSocket> | undefined {
  const found = new Map<string, NamespaceSocket>()
  let read = false
  for (const table of TABLES) {
    let text: string
    try {
      text = proc.read(`/proc/net/${table}`)
      read = true
    } catch {
      continue
    }
    for (const line of text.split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      const [local, inode] = [columns[1], columns[9]]
      if (!local || !inode || inode === '0') continue
      const [address = '', port = ''] = local.split(':')
      found.set(inode, {
        label: `${table.replace('6', '')} ${Number.parseInt(port, 16)}`,
        dockerDns: DOCKER_DNS.has(address.toUpperCase()),
        local: local.toUpperCase(),
        state: columns[3] ?? '',
        tcp: table.startsWith('tcp')
      })
    }
  }
  return read ? found : undefined
}

/** Docker's DNS listeners now (TCP listening and UDP), when `/etc/resolv.conf` names 127.0.0.11; pinned so a later one counts. */
export function dockerDnsSockets(proc: ProcFs = realProc): Set<string> {
  let conf: string
  try {
    conf = proc.read('/etc/resolv.conf')
  } catch {
    return new Set()
  }
  if (!/^[ \t]*nameserver[ \t]+127\.0\.0\.11[ \t]*$/m.test(conf)) return new Set()
  const sockets = namespaceSockets(proc) ?? new Map<string, NamespaceSocket>()
  const dns = [...sockets].filter(([, socket]) => socket.dockerDns && (!socket.tcp || socket.state === '0A'))
  // A TCP query's connection is accepted on the listener's own address and port, which no other process can bind.
  return new Set(dns.flatMap(([inode, socket]) => (socket.tcp ? [inode, `local:${socket.local}`] : [inode])))
}

/** Own when every socket but the pinned DNS ones belongs to a visible process; a socket gone on a second read is ignored. */
export function namespaceCheck(proc: ProcFs = realProc, exempt: ReadonlySet<string> = new Set()): NamespaceVerdict {
  const first = namespaceSockets(proc)
  if (!first) return { own: false, unreadable: true }
  for (const [inode, socket] of first) {
    if (exempt.has(inode) || (socket.tcp && exempt.has(`local:${socket.local}`))) first.delete(inode)
  }
  const held = socketHolders(proc, new Set(first.keys()))
  const orphans = [...first.keys()].filter((inode) => !held.has(inode))
  if (orphans.length === 0) return { own: true }
  const again = namespaceSockets(proc) ?? new Map<string, NamespaceSocket>()
  const sockets = [...new Set(orphans.filter((inode) => again.has(inode)).map((inode) => again.get(inode)!.label))]
  sockets.sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
  return sockets.length === 0 ? { own: true } : { own: false, sockets }
}

export type TierReason =
  | 'not the image'
  | 'not isolated'
  | 'shared network namespace'
  | 'Google Chrome missing'
  | 'no egress forwarder'
  | 'off by policy'
  | 'waiting for policy'

export type TierVerdict = { on: true } | { on: false; reason: TierReason; detail?: string }

export interface TierInputs {
  image: boolean
  isolation: ComputerIsolation
  // The policy's `browserTier`, or the unregistered daemon's config; undefined until a registered one hears its policy.
  granted: boolean | undefined
  // Read only once the tier is granted, so a desktop without it scans nothing.
  namespace: () => NamespaceVerdict
  chrome: () => boolean
}

const describeNamespace = (verdict: NamespaceVerdict): string | undefined =>
  verdict.own
    ? undefined
    : 'unreadable' in verdict
      ? 'the socket tables cannot be read'
      : `${verdict.sockets.join(', ')} held by a process this daemon cannot inspect (another user's, for example one started with sudo) or outside this container`

/** On only on the image, isolated, granted, in its own network namespace, and with Google Chrome (§5.8). */
export function effectiveTier(inputs: TierInputs): TierVerdict {
  if (!inputs.image) return { on: false, reason: 'not the image' }
  if (inputs.isolation === 'none') return { on: false, reason: 'not isolated' }
  if (inputs.granted === undefined) return { on: false, reason: 'waiting for policy' }
  if (!inputs.granted) return { on: false, reason: 'off by policy' }
  const namespace = inputs.namespace()
  if (!namespace.own) return { on: false, reason: 'shared network namespace', detail: describeNamespace(namespace)! }
  return inputs.chrome() ? { on: true } : { on: false, reason: 'Google Chrome missing' }
}

export interface TierGrant {
  granted: boolean
  hideWebdriver: boolean
}

/** A revoked desktop has none, a registered one its last policy's (none before one arrives), an unregistered one its config's. */
export function tierGrant(source: {
  registered: boolean
  // The channel authority's revoked state, which a run-time `computer/revoke` sets.
  revoked: boolean
  policy: Pick<ComputerPolicy, 'browserTier' | 'browserHideWebdriver'> | undefined
  config: { browserTier: boolean; browserHideWebdriver: boolean }
}): TierGrant | undefined {
  if (source.revoked) return NO_GRANT
  if (source.registered) {
    const { policy } = source
    return policy && { granted: policy.browserTier === true, hideWebdriver: policy.browserHideWebdriver !== false }
  }
  return { granted: source.config.browserTier, hideWebdriver: source.config.browserHideWebdriver }
}

export interface DevtoolsTierOptions {
  dataDir: string
  image: boolean
  isolation: ComputerIsolation
  // Google Chrome is the browser the launcher finds.
  chrome: () => boolean
  // The policy's or the local config's grant; undefined while a registered desktop waits for its first policy.
  grant: () => TierGrant | undefined
  // Whether the grant comes from a Control Plane, which `doctor` names.
  registered: boolean
  // A managed pod's forwarder (AGENTCONNECT_EGRESS_PORT); without one the daemon starts its own while the tier is on.
  egressPort: number | undefined
  // Starts the daemon's own forwarder in direct mode on a free loopback port; returns the port.
  startForwarder: () => Promise<number>
  log: (line: string) => void
  onChange?: () => void
  proc?: ProcFs
  checkMs?: number
  // After this long without a policy, launches stop waiting for one and start with the tier off.
  policyWaitMs?: number
}

/** Decides the tier at start, on a policy and every minute, and writes what the next browser start passes. */
export class DevtoolsTier {
  private current: TierVerdict = { on: false, reason: 'waiting for policy' }
  private written: string | undefined
  private forwarder: number | undefined
  private timer: NodeJS.Timeout | undefined
  private waitTimer: NodeJS.Timeout | undefined
  private waited = false
  private dockerDns: ReadonlySet<string> = new Set()
  private running: Promise<void> | undefined
  private again = false

  constructor(private readonly opts: DevtoolsTierOptions) {}

  get verdict(): TierVerdict {
    return this.current
  }

  get on(): boolean {
    return this.current.on
  }

  /** The daemon's own forwarder's port, once started; it then runs as long as the daemon. */
  get forwarderPort(): number | undefined {
    return this.forwarder
  }

  async start(): Promise<void> {
    // Docker's DNS sockets are pinned at the first check, so one opened later by a sharer is not exempt.
    if (this.opts.image && this.opts.isolation !== 'none') this.dockerDns = dockerDnsSockets(this.opts.proc)
    await this.refresh()
    this.timer ??= setInterval(() => void this.refresh(), this.opts.checkMs ?? CHECK_MS)
    this.timer.unref()
    this.waitTimer ??= setTimeout(() => {
      this.waited = true
      if (this.written === undefined) void this.refresh()
    }, this.opts.policyWaitMs ?? STATE_WAIT_MS)
    this.waitTimer.unref()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.timer = undefined
  }

  /** Evaluates again now; a call during a pass runs once more after it. */
  refresh(): Promise<void> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = (async () => {
      do {
        this.again = false
        await this.evaluate()
      } while (this.again)
    })().finally(() => (this.running = undefined))
    return this.running
  }

  private async evaluate(): Promise<void> {
    const grant = this.opts.grant()
    const verdict = effectiveTier({
      image: this.opts.image,
      isolation: this.opts.isolation,
      granted: grant?.granted,
      namespace: () => namespaceCheck(this.opts.proc, this.dockerDns),
      chrome: this.opts.chrome
    })
    const before = this.current
    this.current = verdict
    if (verdict.on && this.opts.egressPort === undefined && this.forwarder === undefined) {
      try {
        this.forwarder = await this.opts.startForwarder()
      } catch (error) {
        // Never a browser with the endpoint and no forwarder in front of it.
        this.current = { on: false, reason: 'no egress forwarder', detail: (error as Error).message }
      }
    }
    const changed = describe(before) !== describe(this.current)
    if (changed) this.opts.log(`browser tier: ${describe(this.current)}`)
    // Before its first policy a registered desktop writes nothing, so a launch waits, until the wait is over.
    const launch = grant ?? (this.waited ? NO_GRANT : undefined)
    if (launch) this.write(launch)
    if (changed) this.opts.onChange?.()
  }

  private write(grant: TierGrant): void {
    const launch: DevtoolsLaunch = {
      tier: this.current.on,
      hideWebdriver: grant.hideWebdriver,
      ...(this.current.on && this.forwarder !== undefined ? { egressPort: this.forwarder } : {})
    }
    const text = JSON.stringify(launch)
    if (text !== this.written) {
      writeDevtoolsState(this.opts.dataDir, launch)
      this.written = text
    }
  }

  /** `doctor`'s `devtools` check: on, off or unavailable with the reason, and every browser's endpoint. */
  check(endpoints: DesktopEndpoint[]): Check {
    return devtoolsCheck(this.current, endpoints, this.opts.registered)
  }
}

const describe = (verdict: TierVerdict): string =>
  verdict.on ? 'on' : `off (${verdict.reason}${verdict.detail ? `: ${verdict.detail}` : ''})`

const UNAVAILABLE: Partial<Record<TierReason, string>> = {
  'not the image': 'unavailable: not the Computer image',
  'not isolated': 'unavailable: not an isolated Computer',
  'shared network namespace': 'unavailable: the network namespace is not its own',
  'Google Chrome missing': 'unavailable: Google Chrome missing',
  'no egress forwarder': 'unavailable: the egress forwarder did not start'
}

const RANK = { ok: 0, info: 1, warn: 2, fail: 3 } as const
const worst = (a: Check['status'], b: Check['status']): Check['status'] => (RANK[a] >= RANK[b] ? a : b)

/** The `devtools` check from the tier's verdict and the endpoints the daemon read. */
export function devtoolsCheck(verdict: TierVerdict, endpoints: DesktopEndpoint[], registered: boolean): Check {
  const extras = endpoints
    .filter((entry) => entry.extra?.length)
    .map((entry) => `${entry.desktop}'s browser also listens on ${entry.extra!.join(', ')}`)
  const kept = endpoints
    .filter((entry) => entry.kept !== undefined)
    .map(
      (entry) =>
        `${entry.desktop}'s browser still has the endpoint from when the tier was on (port ${entry.kept}); it closes at the browser's next start`
    )
  const extraFix = 'turn off remote debugging at chrome://inspect/#remote-debugging, or restart that browser'
  const withNotes = (check: Check): Check => {
    if (extras.length === 0 && kept.length === 0) return check
    const status = worst(check.status, extras.length > 0 ? 'warn' : 'info')
    const fix = check.fix ?? (extras.length > 0 ? extraFix : undefined)
    return {
      name: 'devtools',
      status,
      detail: [check.detail, ...kept, ...extras].join('; '),
      ...(fix ? { fix } : {})
    }
  }
  if (!verdict.on) {
    const unavailable = UNAVAILABLE[verdict.reason]
    if (verdict.reason === 'shared network namespace')
      return withNotes({
        name: 'devtools',
        status: 'warn',
        detail: `${unavailable!}${verdict.detail ? ` (${verdict.detail})` : ''}`,
        fix: 'stop any process here that runs as another user (sudo, a service user), and run the container in a network namespace of its own: no host networking, no --network container:, no sidecar'
      })
    if (verdict.reason === 'no egress forwarder')
      return withNotes({
        name: 'devtools',
        status: 'warn',
        detail: `${unavailable!} (${verdict.detail ?? 'unknown'})`
      })
    if (verdict.reason === 'Google Chrome missing')
      return withNotes({
        name: 'devtools',
        status: 'warn',
        detail: unavailable!,
        fix: 'use the Computer image, which ships Google Chrome, and leave BROWSER at google-chrome'
      })
    if (unavailable) return withNotes({ name: 'devtools', status: 'info', detail: unavailable })
    if (verdict.reason === 'waiting for policy')
      return withNotes({ name: 'devtools', status: 'info', detail: "off until the Control Plane's policy arrives" })
    return withNotes({
      name: 'devtools',
      status: 'info',
      detail: registered ? 'off by policy' : 'off by policy (browserTier in config.json)'
    })
  }
  if (endpoints.length === 0)
    return withNotes({ name: 'devtools', status: 'ok', detail: 'on: no desktop browser is running' })
  const parts = endpoints.map((entry) => `${entry.desktop}${STATUS_TEXT[entry.status](entry)}`)
  const failed = endpoints.find((entry) => FIXES[entry.status] !== undefined)
  const early = endpoints.some((entry) => entry.status === 'before the tier')
  return withNotes({
    name: 'devtools',
    status: failed ? 'warn' : early ? 'info' : 'ok',
    detail: `on: ${parts.join(', ')}`,
    ...(failed ? { fix: FIXES[failed.status]! } : {})
  })
}

const STATUS_TEXT: Record<DesktopEndpoint['status'], (entry: DesktopEndpoint) => string> = {
  ok: (entry) => ` on port ${entry.endpoint!.port}`,
  pending: () => ' starting',
  'before the tier': () => ': started before the tier turned on, gets the endpoint at its next start',
  'not found': () => ': endpoint not found',
  'self-test failed': () => ': self-test failed',
  'refused switches': () => ': started with switches the launcher does not pass'
}

const FIXES: Partial<Record<DesktopEndpoint['status'], string>> = {
  'not found': 'restart that browser through the launcher (close it; the desktop starts it again)',
  'self-test failed':
    "that browser accepted a foreign Origin: it is not reported; restart it and check Chrome's version",
  'refused switches':
    'that browser carries --remote-allow-origins or another proxy than the forwarder: close it so the launcher starts it again'
}
