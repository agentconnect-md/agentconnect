// Which loopback destinations the egress forwarder refuses (computer-use.md §5.8): the daemon's listeners and desktop browsers' ports.
import { realpathSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { BlockList, isIP } from 'node:net'
import { networkInterfaces } from 'node:os'
import { launchLocked } from './browser/launcher.js'
import {
  browserAncestor,
  listeningSockets,
  openProfile,
  realProc,
  socketHolders,
  type ProcFs
} from './form-fill/attribution.js'

/** Why a loopback destination is refused; the log says it, the page never does. */
export type LoopbackRefusal = 'daemon listener' | 'browser port' | 'browser starting' | 'ports unreadable'

export interface LoopbackGuardOptions {
  // The listeners the daemon names as its own, read per check; its other sockets are found in /proc.
  daemonPorts: () => Iterable<number | undefined>
  // Every desktop's browser profile as the launcher names it, read per check.
  profiles: () => readonly string[]
  proc?: ProcFs
  // This machine's interface addresses, which reach listeners bound to every address.
  interfaces?: () => string[]
  pid?: number
  now?: () => number
}

// A listener held by neither the daemon nor a desktop browser is attributed again after this long.
const UNPROTECTED_TTL_MS = 5_000
const TABLES = ['/proc/net/tcp', '/proc/net/tcp6']

// Every form of this machine's loopback; the BlockList also matches their IPv4-mapped IPv6 forms.
const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
LOOPBACK.addSubnet('0.0.0.0', 8, 'ipv4')
LOOPBACK.addAddress('::1', 'ipv6')
LOOPBACK.addAddress('::', 'ipv6')

const allInterfaces = (): string[] =>
  Object.values(networkInterfaces()).flatMap((entries) => (entries ?? []).map((entry) => entry.address))

const real = (path: string): string => {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

type Listening = Map<string, number>

export class LoopbackGuard {
  private readonly proc: ProcFs
  private readonly pid: number
  private readonly now: () => number
  // Each listening socket's holder, by inode, while it listens.
  private readonly verdicts = new Map<string, { refusal: LoopbackRefusal | undefined; at: number }>()
  private reading: Promise<Listening | undefined> | undefined
  private queued: Promise<Listening | undefined> | undefined

  constructor(private readonly opts: LoopbackGuardOptions) {
    this.proc = opts.proc ?? realProc
    this.pid = opts.pid ?? process.pid
    this.now = opts.now ?? Date.now
  }

  /** True when the address reaches this machine's own listeners: loopback, the unspecified address, or an interface's. */
  isLocal(address: string): boolean {
    const bare = address.replace(/%.*$/, '')
    const family = isIP(bare)
    if (family === 0) return false
    const type = family === 4 ? 'ipv4' : 'ipv6'
    if (LOOPBACK.check(bare, type)) return true
    const own = new BlockList()
    for (const iface of (this.opts.interfaces ?? allInterfaces)()) {
      const ifaceFamily = isIP(iface)
      if (ifaceFamily !== 0) own.addAddress(iface, ifaceFamily === 4 ? 'ipv4' : 'ipv6')
    }
    return own.check(bare, type)
  }

  /** Why a local destination on `port` is refused, from a socket table read after the call; every answer waits for it. */
  async refusal(port: number): Promise<LoopbackRefusal | undefined> {
    const listening = await this.fresh()
    if ([...this.opts.daemonPorts()].includes(port)) return 'daemon listener'
    const profiles = this.opts.profiles()
    if (profiles.some((profile) => launchLocked(profile))) return 'browser starting'
    if (!listening) return 'ports unreadable'
    this.attribute(listening, profiles)
    for (const [inode, listener] of listening) {
      const refusal = listener === port ? this.verdicts.get(inode)?.refusal : undefined
      if (refusal) return refusal
    }
    return undefined
  }

  // A read that starts after the call, shared by every caller that arrives while it waits.
  private fresh(): Promise<Listening | undefined> {
    if (!this.reading) return (this.reading = this.read().finally(() => (this.reading = undefined)))
    this.queued ??= this.reading.then(() => {
      this.queued = undefined
      return this.fresh()
    })
    return this.queued
  }

  // Off the event loop: the kernel walks its whole connection table for each read, empty or not (about 6 ms measured).
  private async read(): Promise<Listening | undefined> {
    const reader = this.opts.proc
    const tables = await Promise.all(
      TABLES.map((path) =>
        (reader ? Promise.resolve().then(() => reader.read(path)) : readFile(path, 'utf8')).then(
          listeningSockets,
          () => undefined
        )
      )
    )
    if (tables.every((table) => table === undefined)) return undefined
    return new Map(tables.flatMap((table) => [...(table ?? [])]))
  }

  // Attributes every new listener, whatever its port, so the first probe of a protected port takes no longer than another.
  private attribute(listening: Listening, profiles: readonly string[]): void {
    for (const inode of this.verdicts.keys()) if (!listening.has(inode)) this.verdicts.delete(inode)
    const now = this.now()
    const unknown = [...listening.keys()].filter((inode) => {
      const verdict = this.verdicts.get(inode)
      return !verdict || (verdict.refusal === undefined && now - verdict.at > UNPROTECTED_TTL_MS)
    })
    if (unknown.length === 0) return
    const holders = socketHolders(this.proc, new Set(unknown))
    const named = profiles.flatMap((profile) => [profile, real(profile)])
    const browsers = new Map<number, boolean>()
    const isDesktopBrowser = (pid: number): boolean => {
      const browser = browserAncestor(this.proc, pid)
      if (browser === undefined) return false
      if (!browsers.has(browser)) browsers.set(browser, this.runsProfile(browser, named))
      return browsers.get(browser)!
    }
    for (const inode of unknown) {
      const pids = holders.get(inode) ?? []
      const refusal = pids.includes(this.pid)
        ? 'daemon listener'
        : pids.some(isDesktopBrowser)
          ? 'browser port'
          : undefined
      this.verdicts.set(inode, { refusal, at: now })
    }
  }

  // Started on a desktop profile, or holding its files open; either is enough to refuse its ports.
  private runsProfile(browser: number, profiles: string[]): boolean {
    if (openProfile(this.proc, browser, profiles) !== undefined) return true
    let cmdline: string
    try {
      cmdline = this.proc.read(`/proc/${browser}/cmdline`)
    } catch {
      return false
    }
    const args = cmdline.split(/[\0 ]/)
    return profiles.some((profile) => args.includes(`--user-data-dir=${profile}`))
  }
}
