// Starts a desktop's Chromium on its own profile, fork-merging the other profiles in first (computer-use.md §3.10).
import { spawn, type ChildProcess } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync
} from 'node:fs'
import { hostname } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { BASELINE_FILE, forkMerge, type SourceReport } from './profile-merge.js'

/** The names a browser is started by, in the order the launcher looks for the real one. */
export const BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']
// Launch flags every desktop browser gets; the profile is always the desktop's own.
const BASE_FLAGS = ['--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble']
const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 30_000
// How long a started browser may take to take its profile before the launch lock goes anyway.
const OWN_WAIT_MS = 20_000

/** The process holding a profile, from its SingletonLock link (`<host>-<pid>`), if that process is alive here. */
export function profileOwner(profile: string, host = hostname()): number | undefined {
  let target: string
  try {
    target = readlinkSync(join(profile, 'SingletonLock'))
  } catch {
    return undefined
  }
  const match = /^(.*)-(\d+)$/.exec(target)
  if (!match || match[1] !== host) return undefined
  const pid = Number(match[2])
  try {
    process.kill(pid, 0)
    return pid
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM' ? pid : undefined
  }
}

// What a new profile leaves out of the master's copy: locks, caches, the master's open tabs and its fork baselines.
function seedable(path: string): boolean {
  const name = basename(path)
  return !(
    name.startsWith('Singleton') ||
    // Service workers' scripts stay: their registrations are copied, and a worker without its script never starts.
    (/cache$/i.test(name) && name !== 'ScriptCache') ||
    name === 'Crash Reports' ||
    name === 'Sessions' ||
    name === 'Session Storage' ||
    name === BASELINE_FILE
  )
}

/** Creates a desktop's profile as a copy of the master, so both share Local State and with it the cookie key. */
export function seedProfile(master: string, profile: string): void {
  mkdirSync(dirname(profile), { recursive: true })
  cpSync(master, profile, { recursive: true, preserveTimestamps: true, filter: seedable })
}

/** The real browser on PATH, skipping the directories that hold the launcher's own wrappers. */
export function findBrowser(path = process.env.PATH ?? '', skip: string[] = []): string | undefined {
  const skipped = new Set(skip.map((dir) => resolve(dir)))
  for (const name of BROWSER_NAMES) {
    for (const dir of path.split(delimiter)) {
      if (!dir || skipped.has(resolve(dir))) continue
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        if (statSync(candidate).isFile()) return candidate
      } catch {
        // Not here.
      }
    }
  }
  return undefined
}

export interface LaunchOptions {
  profile: string
  // The main desktop's profile a new profile is copied from; absent for the master itself.
  master?: string
  // Profiles to merge in before starting; the target and missing ones are skipped.
  sources: string[]
  browser: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

export interface LaunchResult {
  // The profile's browser was already running and got the request; nothing was merged.
  handedOff: boolean
  reports: SourceReport[]
  pid?: number
}

/** Hands the request to the profile's running browser, or seeds, fork-merges and starts one. */
export async function launchBrowser(options: LaunchOptions): Promise<LaunchResult> {
  const log = options.log ?? (() => undefined)
  const release = await lockProfile(options.profile)
  try {
    if (profileOwner(options.profile) !== undefined) {
      start(options).unref()
      return { handedOff: true, reports: [] }
    }
    if (!existsSync(options.profile)) {
      if (options.master && existsSync(options.master)) {
        seedProfile(options.master, options.profile)
        log(`browser profile ${options.profile} created from ${options.master}`)
      } else mkdirSync(options.profile, { recursive: true })
    }
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      rmSync(join(options.profile, name), { force: true })
    }
    const self = realpathSync(options.profile)
    const sources = options.sources.filter(
      (source) => existsSync(join(source, 'Default')) && realpathSync(source) !== self
    )
    const reports = await forkMerge(options.profile, sources)
    for (const report of reports) log(`browser fork-merge from ${report.source}: ${summarize(report)}`)
    const child = start(options)
    // The lock holds until the browser owns the profile, so a second launch hands off instead of merging under it.
    if (!(await owned(options.profile, child))) log(`browser for ${options.profile} did not take its profile`)
    return { handedOff: false, reports, ...(child.pid !== undefined ? { pid: child.pid } : {}) }
  } finally {
    release()
  }
}

function start(options: LaunchOptions): ChildProcess {
  const child = spawn(options.browser, [`--user-data-dir=${options.profile}`, ...BASE_FLAGS, ...(options.args ?? [])], {
    detached: true,
    stdio: 'ignore',
    env: options.env ?? process.env
  })
  child.on('error', () => undefined)
  return child
}

// True once some live process holds the profile; false when the browser failed to start, exited, or ran out of time.
async function owned(profile: string, child: ChildProcess): Promise<boolean> {
  let ended = false
  const end = (): void => void (ended = true)
  child.once('error', end).once('exit', end)
  try {
    const deadline = Date.now() + OWN_WAIT_MS
    for (;;) {
      if (profileOwner(profile) !== undefined) return true
      if (ended || Date.now() > deadline) return false
      await new Promise((resolveWait) => setTimeout(resolveWait, 100))
    }
  } finally {
    child.off('error', end).off('exit', end)
    child.unref()
  }
}

export function summarize(report: SourceReport): string {
  const c = report.cookies
  return [
    report.firstFork ? 'first fork' : 'since last fork',
    `cookies +${c.inserted} ~${c.updated} -${c.deleted} (kept ${c.kept}, expired ${c.expired})`,
    `localStorage ${report.localStorage.taken.length} origin(s)`,
    `IndexedDB ${report.indexedDb.taken.length} origin(s)`
  ].join(', ')
}

// Two launches for one desktop at once must not both merge; a lock older than a minute is from a crashed launcher.
async function lockProfile(profile: string): Promise<() => void> {
  const path = `${profile}.launch-lock`
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'))
      return () => rmSync(path, { force: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(path).mtimeMs > LOCK_STALE_MS) rmSync(path, { force: true })
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) throw new Error(`another browser launch for ${profile} is still running`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 200))
    }
  }
}
