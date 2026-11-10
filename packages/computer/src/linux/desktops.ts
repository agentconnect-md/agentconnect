// Per-agent desktops on Linux: one Xvfb + Xfce + driver + Computer per agent, started on demand (computer-use.md §3.9).
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { closeBrowser, waitForWindowManager } from '../browser/close.js'
import { BROWSER_NAMES, profileOwner } from '../browser/launcher.js'
import { ComputerError, type Computer } from '../computer.js'
import type { DaemonConfig } from '../config.js'
import type { CuaDriver } from '../driver/client.js'
import { which, type DesktopSupport } from './desktops-support.js'

export const DESKTOPS_DIR = 'desktops'
const STATE_FILE = 'state.json'
const SWEEP_MS = 30_000
const START_TIMEOUT_MS = 15_000
// The Xfce parts a desktop runs, window manager first; its session manager is left out, so nothing autostarts there.
const XFCE_BASE = ['xfsettingsd', 'xfwm4']
const XFCE_SHELL = ['xfce4-panel', 'xfdesktop']
const WM_WAIT_MS = 8000
const DESKTOP_FILES = [
  'chromium.desktop',
  'chromium-browser.desktop',
  'google-chrome.desktop',
  'com.google.Chrome.desktop'
]

export interface DesktopRecord {
  id: string
  // An agent id, or `client:<name>` for a local client token.
  key: string
  label: string
  createdAt: string
  lastUsedAt: string
}

export interface DesktopState {
  version: 1
  next: number
  // The daemon's own session bus, where the keyring that decrypts the master profile's cookies lives.
  mainBus?: string
  // The master browser profile every desktop's profile is copied from and merges with.
  master: string
  // The registrant's `shareBrowserLogins` (§3.9); false: each profile is its own, never copied or merged. Absent: on.
  shareBrowserLogins?: boolean
  desktops: Record<string, DesktopRecord>
}

export const desktopsDir = (dataDir: string): string => join(dataDir, DESKTOPS_DIR)
export const desktopDir = (dataDir: string, id: string): string => join(desktopsDir(dataDir), id)
export const desktopProfile = (dataDir: string, id: string): string => join(desktopDir(dataDir, id), 'browser')
const wrapperDir = (dataDir: string, id: string): string => join(desktopDir(dataDir, id), 'bin')

export function loadDesktopState(dataDir: string): DesktopState {
  try {
    const state = JSON.parse(readFileSync(join(desktopsDir(dataDir), STATE_FILE), 'utf8')) as DesktopState
    if (state.version === 1 && state.desktops) return state
  } catch {
    // None yet.
  }
  return { version: 1, next: 1, master: join(homedir(), '.config', 'chromium'), desktops: {} }
}

function saveDesktopState(dataDir: string, state: DesktopState): void {
  mkdirSync(desktopsDir(dataDir), { recursive: true, mode: 0o700 })
  writeFileSync(join(desktopsDir(dataDir), STATE_FILE), JSON.stringify(state, null, 2), { mode: 0o600 })
}

/** What `browser --desktop <id>` launches with: that desktop's profile, and unless logins are not shared, the master and every other profile as a source. */
export function desktopBrowserPlan(
  dataDir: string,
  id: string
): { profile: string; master?: string; sources: string[]; skip: string[]; mainBus?: string } {
  const state = loadDesktopState(dataDir)
  const ids = Object.values(state.desktops).map((record) => record.id)
  if (!ids.includes(id)) throw new Error(`no desktop ${id}`)
  const share = state.shareBrowserLogins !== false
  return {
    profile: desktopProfile(dataDir, id),
    ...(share ? { master: state.master } : {}),
    sources: share
      ? [state.master, ...ids.filter((other) => other !== id).map((other) => desktopProfile(dataDir, other))]
      : [],
    skip: ids.map((other) => wrapperDir(dataDir, other)),
    ...(state.mainBus ? { mainBus: state.mainBus } : {})
  }
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

// Browser names on the desktop's PATH and its .desktop entries all lead to `browser --desktop <id>` (§3.10).
function writeLaunchers(dataDir: string, id: string, self: string[], systemDataDirs: string[]): void {
  const bin = wrapperDir(dataDir, id)
  mkdirSync(bin, { recursive: true })
  const log = join(desktopDir(dataDir, id), 'browser.log')
  const script = `#!/bin/sh\nexec ${self.map(quote).join(' ')} browser --desktop ${quote(id)} -- "$@" >>${quote(log)} 2>&1\n`
  for (const name of [...BROWSER_NAMES, 'x-www-browser']) {
    writeFileSync(join(bin, name), script)
    chmodSync(join(bin, name), 0o755)
  }
  const apps = join(desktopDir(dataDir, id), 'share', 'applications')
  mkdirSync(apps, { recursive: true })
  for (const file of DESKTOP_FILES) {
    const source = systemDataDirs.map((dir) => join(dir, 'applications', file)).find((path) => existsSync(path))
    if (!source) continue
    const entry = readFileSync(source, 'utf8')
      .split('\n')
      .filter((line) => !line.startsWith('TryExec='))
      .map((line) => line.replace(/^Exec=\S+/, `Exec=${join(bin, 'chromium')}`))
      .join('\n')
    writeFileSync(join(apps, file), entry)
  }
}

/** Memory free for one more desktop, in whole GiB: the lesser of the machine's and a container limit's headroom. */
export function memoryGiB(read: (path: string) => string = (path) => readFileSync(path, 'utf8')): number {
  const GiB = 1024 * 1024 * 1024
  const free: number[] = []
  try {
    const match = /^MemAvailable:\s+(\d+) kB/m.exec(read('/proc/meminfo'))
    if (match) free.push(Number(match[1]) * 1024)
  } catch {
    // Not Linux, or no procfs.
  }
  // A pod's /proc/meminfo shows the node; its cgroup (v2) shows the limit the pod is held to.
  try {
    const limit = read('/sys/fs/cgroup/memory.max').trim()
    if (limit !== 'max') free.push(Number(limit) - Number(read('/sys/fs/cgroup/memory.current').trim()))
  } catch {
    // No cgroup v2 limit.
  }
  const least = free.filter((bytes) => Number.isFinite(bytes)).reduce((a, b) => Math.min(a, b), Infinity)
  return least === Infinity ? 1 : Math.max(0, Math.floor(least / GiB))
}

export interface RunningDesktop {
  record: DesktopRecord
  display: string
  env: NodeJS.ProcessEnv
  computer: Computer
  driver: CuaDriver
  // Updated by every call that reaches the desktop; the idle sweep reads it.
  lastActivity: number
  stopping?: boolean
}

interface Started extends RunningDesktop {
  processes: ChildProcess[]
  dbusPid?: number
}

export interface DesktopManagerDeps {
  dataDir: string
  config: DaemonConfig
  support: () => DesktopSupport
  // The daemon command a launcher wrapper runs, e.g. [node, the bundle].
  self: string[]
  build: (desktop: {
    id: string
    // The agent id it serves, or `client:<name>` for a local client token.
    key: string
    label: string
    env: NodeJS.ProcessEnv
    launchBrowser: (app: string) => (() => Promise<string>) | undefined
  }) => { driver: CuaDriver; computer: Computer }
  log: (line: string) => void
  onChange?: () => void
  // A desktop stopped: whatever watched it (its viewer and capture) goes too.
  onStopped?: (id: string) => void
  now?: () => number
  env?: NodeJS.ProcessEnv
}

export class DesktopManager {
  private state: DesktopState
  private readonly running = new Map<string, Started>()
  private readonly starting = new Map<string, Promise<Started>>()
  private readonly stopping = new Map<string, Promise<void>>()
  // Desktops start one at a time: Xfce's panel under load otherwise fails to load its plugins.
  private startQueue: Promise<unknown> = Promise.resolve()
  private readonly now: () => number
  private readonly baseEnv: NodeJS.ProcessEnv
  private sweeper: NodeJS.Timeout | undefined
  private closed = false
  // The owner's pause, applied to every desktop, including ones started while it stands.
  private paused: string | undefined

  constructor(private readonly deps: DesktopManagerDeps) {
    this.now = deps.now ?? Date.now
    this.baseEnv = deps.env ?? process.env
    this.state = loadDesktopState(deps.dataDir)
    if (this.baseEnv.DBUS_SESSION_BUS_ADDRESS) this.state.mainBus = this.baseEnv.DBUS_SESSION_BUS_ADDRESS
    saveDesktopState(deps.dataDir, this.state)
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS)
    this.sweeper.unref()
  }

  /** The registrant's `shareBrowserLogins` (§3.9), kept with the state the browser wrappers read. */
  setShareBrowserLogins(on: boolean): void {
    if ((this.state.shareBrowserLogins !== false) === on) return
    this.state.shareBrowserLogins = on
    saveDesktopState(this.deps.dataDir, this.state)
    this.deps.log(`per-agent desktops: browser logins ${on ? 'shared between desktops' : 'kept apart per desktop'}`)
  }

  /** On when the owner's switch is on and the machine supports it. */
  enabled(): boolean {
    return this.deps.config.perAgentDesktops && this.deps.support().supported
  }

  max(): number {
    // Without a set limit, one more desktop starts while a GiB is free beside the running ones (at least one runs).
    return this.deps.config.maxDesktops ?? Math.max(1, this.running.size + memoryGiB())
  }

  /** A desktop by id for a person in the viewer, started if it is not running; undefined for an unknown id. */
  async byId(id: string): Promise<RunningDesktop | undefined> {
    const record = Object.values(this.state.desktops).find((candidate) => candidate.id === id)
    return record ? this.forKey(record.key, record.label) : undefined
  }

  /** Each desktop's browser profile, resolved: `main` runs the master, an agent desktop its own (form fill, §8). */
  profiles(): { desktop: string; profile: string }[] {
    const real = (path: string): string | undefined => {
      try {
        return realpathSync(path)
      } catch {
        return undefined
      }
    }
    const entries = [
      { desktop: 'main', profile: real(this.state.master) },
      ...Object.values(this.state.desktops).map((record) => ({
        desktop: record.id,
        profile: real(desktopProfile(this.deps.dataDir, record.id))
      }))
    ]
    return entries.filter((entry): entry is { desktop: string; profile: string } => entry.profile !== undefined)
  }

  /** A viewer watching a desktop keeps it, and its browser, from the idle sweep. */
  touch(id: string): void {
    const desktop = this.running.get(id)
    if (desktop) desktop.lastActivity = this.now()
  }

  /** The caller's own desktop, started if it is not running. */
  async forKey(key: string, label: string): Promise<RunningDesktop> {
    if (this.closed || !this.enabled()) throw new ComputerError('unavailable', 'per-agent desktops are off')
    const record = this.recordFor(key, label)
    const running = this.running.get(record.id)
    if (running && !running.stopping) {
      running.lastActivity = this.now()
      return running
    }
    let pending = this.starting.get(record.id)
    if (!pending) {
      const queued = this.startQueue.then(() => this.start(record))
      this.startQueue = queued.catch(() => undefined)
      pending = queued.finally(() => this.starting.delete(record.id))
      this.starting.set(record.id, pending)
    }
    const started = await pending
    // Switched off (or closing) while it started: stopAll stops it, and the caller must not act on it.
    if (this.closed || !this.enabled() || started.stopping || !this.running.has(started.record.id)) {
      throw new ComputerError('unavailable', 'per-agent desktops are off')
    }
    started.lastActivity = this.now()
    return started
  }

  list(): { id: string; key: string; label: string; running: boolean; display?: string; status?: string }[] {
    return Object.values(this.state.desktops).map((record) => {
      const running = this.running.get(record.id)
      return {
        id: record.id,
        key: record.key,
        label: record.label,
        running: Boolean(running),
        ...(running ? { display: running.display, status: running.computer.liveStatus() } : {})
      }
    })
  }

  runningDesktops(): RunningDesktop[] {
    return [...this.running.values()]
  }

  pauseAll(reason: string): void {
    this.paused = reason
    for (const desktop of this.running.values()) desktop.computer.pause(reason)
  }

  resumeAll(): void {
    this.paused = undefined
    for (const desktop of this.running.values()) desktop.computer.resume()
  }

  suspendAll(reason: string): void {
    for (const desktop of this.running.values()) desktop.computer.suspend(reason)
  }

  // Starts already queued or under way finish first (queued ones refuse once switched off), then everything stops.
  async stopAll(reason: string): Promise<void> {
    await Promise.allSettled([...this.starting.values()])
    await Promise.allSettled([...this.running.keys()].map((id) => this.stop(id, reason)))
  }

  close(): Promise<void> {
    this.closed = true
    if (this.sweeper) clearInterval(this.sweeper)
    this.sweeper = undefined
    return this.stopAll('the daemon is stopping')
  }

  private recordFor(key: string, label: string): DesktopRecord {
    const now = new Date(this.now()).toISOString()
    let record = this.state.desktops[key]
    if (!record) {
      record = { id: `d${this.state.next++}`, key, label, createdAt: now, lastUsedAt: now }
      this.state.desktops[key] = record
      this.deps.log(`desktop ${record.id} assigned to ${label}`)
    }
    record.lastUsedAt = now
    record.label = label
    saveDesktopState(this.deps.dataDir, this.state)
    return record
  }

  private async start(record: DesktopRecord): Promise<Started> {
    if (this.closed || !this.enabled()) throw new ComputerError('unavailable', 'per-agent desktops are off')
    await this.makeRoom()
    const { dataDir, config, log } = this.deps
    const prefix = `desktop ${record.id} (${record.label})`
    // Normalized: GNOME's `/usr/share/` next to Xfce's own `/usr/share` left the panel's menu plugin unloaded.
    const systemDataDirs = [
      ...new Set(
        (this.baseEnv.XDG_DATA_DIRS || '/usr/local/share:/usr/share')
          .split(':')
          .map((dir) => dir.replace(/\/+$/, ''))
          .filter((dir) => dir && !/\/(gnome|kde|plasma)$/.test(dir))
      )
    ]
    writeLaunchers(dataDir, record.id, this.deps.self, systemDataDirs)
    const processes: ChildProcess[] = []
    try {
      const { display, xvfb } = await startXvfb(config.desktopSize)
      processes.push(xvfb)
      const env = desktopEnv(this.baseEnv)
      Object.assign(env, {
        DISPLAY: display,
        PATH: `${wrapperDir(dataDir, record.id)}:${this.baseEnv.PATH ?? '/usr/bin:/bin'}`,
        XDG_DATA_DIRS: [join(desktopDir(dataDir, record.id), 'share'), ...systemDataDirs].join(':')
      })
      const bus = startBus(env)
      if (bus.address) env.DBUS_SESSION_BUS_ADDRESS = bus.address
      const run = (part: string): void => {
        if (!which(part, env.PATH)) return
        const child = spawn(part, [], { env, detached: true, stdio: 'ignore' })
        child.on('error', () => undefined)
        processes.push(child)
      }
      XFCE_BASE.forEach(run)
      // The panel waits for a window manager by itself, and racing it under load leaves plugins unloaded.
      if (which('xfwm4', env.PATH) && !(await waitForWindowManager(display, WM_WAIT_MS))) {
        log(`${prefix}: no window manager after ${WM_WAIT_MS} ms`)
      }
      XFCE_SHELL.forEach(run)
      const { driver, computer } = this.deps.build({
        id: record.id,
        key: record.key,
        label: record.label,
        env,
        launchBrowser: (app) =>
          isBrowserName(app)
            ? async () => {
                const child = spawn(join(wrapperDir(dataDir, record.id), 'chromium'), [], {
                  env,
                  detached: true,
                  stdio: 'ignore'
                })
                child.unref()
                return JSON.stringify({ launched: app, via: 'fork-merge launcher', desktop: record.id })
              }
            : undefined
      })
      const size = (await driver.call('get_screen_size', {})).structuredContent ?? {}
      const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      computer.setScreenSize({
        screenWidth: num(size.width),
        screenHeight: num(size.height),
        scale: num(size.scale_factor) || 1
      })
      if (this.paused) computer.pause(this.paused)
      const started: Started = {
        record,
        display,
        env,
        computer,
        driver,
        lastActivity: this.now(),
        processes,
        ...(bus.pid ? { dbusPid: bus.pid } : {})
      }
      this.running.set(record.id, started)
      log(`${prefix} started on ${display}`)
      this.deps.onChange?.()
      return started
    } catch (error) {
      for (const child of processes) killGroup(child)
      throw new ComputerError('unavailable', `${prefix} could not start: ${(error as Error).message}`)
    }
  }

  // At the limit, the least recently used desktop nobody holds makes room; a full machine has no holder or queue (§4.4).
  private async makeRoom(): Promise<void> {
    if (this.running.size < this.max()) return
    const idle = [...this.running.values()]
      .filter((desktop) => !inUse(desktop))
      .sort((a, b) => a.lastActivity - b.lastActivity)[0]
    if (!idle) {
      throw new ComputerError('unavailable', `all ${this.max()} desktops of this computer are in use`, {
        reason: 'desktops_full'
      })
    }
    await this.stop(idle.record.id, 'making room for another agent')
  }

  /** Closes the desktop's browser the way a person would, then its session; concurrent callers wait for the same stop. */
  stop(id: string, reason: string): Promise<void> {
    const pending = this.stopping.get(id)
    if (pending) return pending
    const desktop = this.running.get(id)
    if (!desktop) return Promise.resolve()
    const done = this.teardown(desktop, reason).finally(() => this.stopping.delete(id))
    this.stopping.set(id, done)
    return done
  }

  private async teardown(desktop: Started, reason: string): Promise<void> {
    const id = desktop.record.id
    desktop.stopping = true
    const profile = desktopProfile(this.deps.dataDir, id)
    const outcome = await closeBrowser({ profile, display: desktop.display, log: this.deps.log }).catch(
      (error: Error) => error.message
    )
    desktop.computer.suspend(reason)
    await desktop.driver.close().catch(() => undefined)
    for (const child of desktop.processes.slice(1)) killGroup(child)
    if (desktop.dbusPid) killPid(desktop.dbusPid)
    killGroup(desktop.processes[0]!)
    this.running.delete(id)
    this.deps.onStopped?.(id)
    this.deps.log(`desktop ${id} (${desktop.record.label}) stopped: ${reason}; browser ${outcome}`)
    this.deps.onChange?.()
  }

  // Closes idle browsers, then idle desktops; a held lease counts as activity, so nothing closes mid-turn.
  private async sweep(): Promise<void> {
    const now = this.now()
    for (const desktop of [...this.running.values()]) {
      if (desktop.stopping) continue
      if (inUse(desktop)) desktop.lastActivity = now
      const idle = now - desktop.lastActivity
      if (idle > this.deps.config.desktopIdleMinutes * 60_000) {
        await this.stop(desktop.record.id, `idle for ${this.deps.config.desktopIdleMinutes} min`)
        continue
      }
      const profile = desktopProfile(this.deps.dataDir, desktop.record.id)
      if (idle > this.deps.config.browserIdleMinutes * 60_000 && profileOwner(profile) !== undefined) {
        const outcome = await closeBrowser({ profile, display: desktop.display, log: this.deps.log })
        this.deps.log(`desktop ${desktop.record.id}: idle browser ${outcome}`)
      }
    }
  }
}

// An agent's lease or a person's takeover in the viewer: neither the idle sweep nor making room may stop it.
const inUse = (desktop: RunningDesktop): boolean =>
  desktop.computer.leaseActivity() !== undefined || desktop.computer.liveStatus() === 'human_in_control'

// What names the main session (GNOME, KDE, Wayland) or reaches its services; an agent desktop is its own Xfce session.
const MAIN_SESSION_VARS =
  /^(WAYLAND_DISPLAY|DBUS_SESSION_BUS_ADDRESS|SESSION_MANAGER|DESKTOP_STARTUP_ID|XDG_ACTIVATION_TOKEN|DESKTOP_SESSION|GDMSESSION|XDG_SESSION_(DESKTOP|ID|CLASS)|XDG_SEAT|XDG_VTNR|XDG_MENU_PREFIX|XMODIFIERS|(GTK|QT|CLUTTER|SDL)_IM_MODULE|IM_CONFIG_\w+|GNOME_\w+|KDE_\w+|PLASMA_\w+|GIO_LAUNCHED_DESKTOP_FILE\w*|XAUTHORITY)$/

/** The environment an agent desktop's session and apps start from: the daemon's, minus the main session's identity. */
export function desktopEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(base)) if (!MAIN_SESSION_VARS.test(name)) env[name] = value
  return {
    ...env,
    GDK_BACKEND: 'x11',
    QT_QPA_PLATFORM: 'xcb',
    XDG_SESSION_TYPE: 'x11',
    XDG_CURRENT_DESKTOP: 'XFCE',
    XDG_SESSION_DESKTOP: 'xfce',
    DESKTOP_SESSION: 'xfce',
    XDG_MENU_PREFIX: 'xfce-'
  }
}

export const isBrowserName = (app: string): boolean =>
  /^(chromium|chromium-browser|google-chrome(-stable)?|chrome|google chrome|x-www-browser|browser|web browser)$/i.test(
    app.trim()
  )

// Xvfb picks a free display itself (-displayfd) and writes its number once it accepts clients.
function startXvfb(size: string): Promise<{ display: string; xvfb: ChildProcess }> {
  const xvfb = spawn(
    'Xvfb',
    ['-displayfd', '3', '-screen', '0', `${size}x24`, '-nolisten', 'tcp', '-noreset', '-dpi', '96'],
    { detached: true, stdio: ['ignore', 'ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  xvfb.stderr?.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-400)))
  return new Promise((resolve, reject) => {
    let number = ''
    const timer = setTimeout(() => fail(new Error('Xvfb did not start in time')), START_TIMEOUT_MS)
    const fail = (error: Error): void => {
      clearTimeout(timer)
      killGroup(xvfb)
      reject(error)
    }
    ;(xvfb.stdio[3] as NodeJS.ReadableStream).on('data', (chunk: Buffer) => {
      number += chunk.toString()
      if (!number.includes('\n')) return
      clearTimeout(timer)
      resolve({ display: `:${number.trim()}`, xvfb })
    })
    xvfb.on('error', fail)
    xvfb.on('exit', (code) => fail(new Error(`Xvfb exited (${code}): ${stderr.trim().split('\n').pop() ?? ''}`)))
  })
}

// A session bus of the desktop's own, so its Xfce does not clash with the main session's services.
function startBus(env: NodeJS.ProcessEnv): { address?: string; pid?: number } {
  const result = spawnSync('dbus-launch', ['--sh-syntax'], { env, encoding: 'utf8' })
  const address = /DBUS_SESSION_BUS_ADDRESS='([^']+)'/.exec(result.stdout ?? '')?.[1]
  const pid = Number(/DBUS_SESSION_BUS_PID=(\d+)/.exec(result.stdout ?? '')?.[1])
  return { ...(address ? { address } : {}), ...(pid ? { pid } : {}) }
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return
  try {
    process.kill(-child.pid, 'SIGTERM')
  } catch {
    child.kill('SIGTERM')
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // Gone already.
  }
}
