// Starts a desktop's browser on its own profile, fork-merging the other profiles in first (computer-use.md §3.10).
import { spawn, type ChildProcess } from 'node:child_process'
import {
  accessSync,
  closeSync,
  constants,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { cp } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, delimiter, dirname, join, resolve } from 'node:path'
import { callerArgs, devtoolsFlags, isGoogleChrome, prepareProfile, type DevtoolsLaunch } from './devtools-launch.js'
import { BASELINE_FILE, forkMerge, renameBaselineSource, type SourceReport } from './profile-merge.js'

/** The names a browser is started by, in the order the launcher looks for the real one off the image. */
export const BROWSER_NAMES = ['chromium', 'chromium-browser', 'google-chrome-stable', 'google-chrome']
// Google Chrome first on the image only: a person's Chromium master holds `v11` cookies Chrome may not decrypt (§17-20).
const IMAGE_BROWSER_NAMES = ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser']
// Launch flags every desktop browser gets; the profile is always the desktop's own.
const BASE_FLAGS = ['--no-first-run', '--no-default-browser-check', '--hide-crash-restore-bubble']
// Read by Chrome and Chromium after argv, so it would win over the profile and the proxy (§3.8).
const EXTRA_FLAGS_ENV = 'CHROME_EXTRA_FLAGS'
// What a fresh profile holds so Chrome's first-run terms dialog never shows, flag or not (§3.8).
const FIRST_RUN = 'First Run'
const LOCK_STALE_MS = 60_000
const LOCK_WAIT_MS = 30_000
const LOCK_REFRESH_MS = 10_000
// How long a started browser may take to take its profile before the launch lock goes anyway.
const OWN_WAIT_MS = 20_000

/** The computer image sets AGENTCONNECT_COMPUTER_IMAGE=1: Google Chrome on `browser/main`, sandboxed by its container (§3.8). */
export const onImage = (env: NodeJS.ProcessEnv = process.env): boolean => env.AGENTCONNECT_COMPUTER_IMAGE === '1'

/** Chromium's default profile: the master off the image, and what a first start with Chrome copies to `browser/main`. */
export const chromiumProfile = (env: NodeJS.ProcessEnv = process.env): string =>
  join(env.HOME || homedir(), '.config', 'chromium')

/** The main desktop's profile, the master of §3.10; Chrome refuses remote debugging on its default one (§3.8). */
export const mainProfile = (dataDir: string, env: NodeJS.ProcessEnv = process.env): string =>
  onImage(env) ? join(dataDir, 'browser', 'main') : chromiumProfile(env)

/** The order the launcher looks for the real browser in. */
export const browserNames = (env: NodeJS.ProcessEnv = process.env): string[] =>
  onImage(env) ? IMAGE_BROWSER_NAMES : BROWSER_NAMES

/** The image's flags: no sandbox inside the container, the basic password store, and a managed pod's egress (§15.4). */
export function imageFlags(env: NodeJS.ProcessEnv = process.env): string[] {
  if (!onImage(env)) return []
  const flags = ['--no-sandbox', '--password-store=basic']
  const egress = env.AGENTCONNECT_EGRESS_PORT
  // Loopback goes through the forwarder too; the form-fill endpoint alone goes direct, attributed through /proc.
  if (egress)
    flags.push(
      `--proxy-server=http://127.0.0.1:${egress}`,
      `--proxy-bypass-list=<-loopback>;127.0.0.1:${env.FORM_FILL_PORT || '7682'}`,
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'
    )
  return flags
}

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

// What any copy of a profile leaves out: locks, caches and the port file naming the source's live browser.
function copyable(path: string): boolean {
  const name = basename(path)
  return !(
    name.startsWith('Singleton') ||
    // Service workers' scripts stay: their registrations are copied, and a worker without its script never starts.
    (/cache$/i.test(name) && name !== 'ScriptCache') ||
    name === 'Crash Reports' ||
    name === 'DevToolsActivePort'
  )
}

// A fork also leaves out the master's open tabs and its fork baselines.
const seedable = (path: string): boolean =>
  copyable(path) && !['Sessions', 'Session Storage', BASELINE_FILE].includes(basename(path))

const markFirstRun = (profile: string): void => writeFileSync(join(profile, FIRST_RUN), '')

/** Creates a desktop's profile as a copy of the master, so both share Local State and with it the cookie key. */
export function seedProfile(master: string, profile: string): void {
  mkdirSync(dirname(profile), { recursive: true })
  cpSync(master, profile, { recursive: true, preserveTimestamps: true, filter: seedable })
  markFirstRun(profile)
}

/** Moves a desktop's profile to a new directory as a copy that keeps its open tabs; false when there is nothing to move. */
export async function moveProfile(from: string, to: string, forks: string[] = []): Promise<boolean> {
  if (existsSync(to) || !existsSync(from)) return false
  // Copied aside and renamed, so an interrupted copy is started over rather than taken for the profile.
  const partial = `${to}.moving`
  rmSync(partial, { recursive: true, force: true })
  mkdirSync(dirname(to), { recursive: true })
  await cp(from, partial, { recursive: true, preserveTimestamps: true, filter: copyable })
  markFirstRun(partial)
  // Profiles forked from the old one keep their baseline against the new one, so what they deleted stays deleted (§3.10).
  const [before, after] = [realpathSync(from), join(realpathSync(dirname(to)), basename(to))]
  for (const fork of forks.filter((profile) => existsSync(join(profile, BASELINE_FILE)))) {
    const release = await lockProfile(fork)
    try {
      renameBaselineSource(fork, before, after)
    } finally {
      release()
    }
  }
  renameSync(partial, to)
  return true
}

/** Moves a profile under its launch lock, as its next launch would, without starting a browser. */
export async function migrateProfile(options: MoveOptions): Promise<boolean> {
  const release = await lockProfile(options.profile)
  try {
    return await moveUnderLock(options)
  } finally {
    release()
  }
}

export interface MoveOptions {
  profile: string
  // A profile this one replaces: moved here with its open tabs when this one does not exist yet.
  movedFrom?: string
  // Profiles forked from `movedFrom`, whose fork baselines follow it.
  forks?: string[]
  log?: (line: string) => void
}

async function moveUnderLock(options: MoveOptions): Promise<boolean> {
  if (!options.movedFrom || !(await moveProfile(options.movedFrom, options.profile, options.forks))) return false
  options.log?.(`browser profile ${options.movedFrom} copied to ${options.profile} with its open tabs`)
  return true
}

/** The real browser on PATH, skipping the directories that hold the launcher's own wrappers and any wrapper of ours. */
export function findBrowser(
  path = process.env.PATH ?? '',
  skip: string[] = [],
  names = browserNames()
): string | undefined {
  const skipped = new Set(skip.map((dir) => resolve(dir)))
  for (const name of names) {
    for (const dir of path.split(delimiter)) {
      if (!dir || skipped.has(resolve(dir))) continue
      const candidate = join(dir, name)
      try {
        accessSync(candidate, constants.X_OK)
        if (statSync(candidate).isFile() && !isWrapper(candidate)) return candidate
      } catch {
        // Not here.
      }
    }
  }
  return undefined
}

/** The browser the image's entrypoint passes as `--browser`: BROWSER when set and installed, else the launcher's choice. */
export function chosenBrowser(env: NodeJS.ProcessEnv = process.env, skip: string[] = []): string | undefined {
  const name = env.BROWSER
  if (name && name !== 'none') {
    const found = name.includes('/')
      ? findBrowser(dirname(resolve(name)), [], [basename(name)])
      : findBrowser(env.PATH ?? '', skip, [name])
    if (found) return found
  }
  return findBrowser(env.PATH ?? '', skip, browserNames(env))
}

// A desktop's wrapper (§3.10) runs `browser --desktop <id>`; taking it for the browser would start the launcher again.
function isWrapper(path: string): boolean {
  const head = Buffer.alloc(1024)
  const fd = openSync(path, 'r')
  try {
    const text = head.subarray(0, readSync(fd, head, 0, head.length, 0)).toString('latin1')
    return text.startsWith('#!') && text.includes(' browser --desktop ')
  } finally {
    closeSync(fd)
  }
}

export interface LaunchOptions extends MoveOptions {
  // The main desktop's profile a new profile is copied from; absent for the master itself.
  master?: string
  // Profiles to merge in before starting; the target and missing ones are skipped.
  sources: string[]
  browser: string
  args?: string[]
  env?: NodeJS.ProcessEnv
  // The browser tier's state from the daemon (§3.10); absent, the tier is off.
  devtools?: DevtoolsLaunch
  // Whether `browser` is Google Chrome; resolved from its path when absent.
  chrome?: boolean
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
  const chrome = options.chrome ?? isGoogleChrome(options.browser)
  const release = await lockProfile(options.profile)
  try {
    if (profileOwner(options.profile) !== undefined) {
      start(options, chrome).unref()
      return { handedOff: true, reports: [] }
    }
    await moveUnderLock({ ...options, log })
    if (!existsSync(options.profile)) {
      if (options.master && existsSync(options.master)) {
        seedProfile(options.master, options.profile)
        log(`browser profile ${options.profile} created from ${options.master}`)
      } else {
        mkdirSync(options.profile, { recursive: true })
        markFirstRun(options.profile)
      }
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
    // Only where the tier can exist (the image sets `devtools`): a person's own profiles keep their port file and setting.
    if (options.devtools) prepareProfile(options.profile, options.devtools.tier && chrome)
    const child = start(options, chrome)
    // The lock holds until the browser owns the profile, so a second launch hands off instead of merging under it.
    if (!(await owned(options.profile, child))) log(`browser for ${options.profile} did not take its profile`)
    return { handedOff: false, reports, ...(child.pid !== undefined ? { pid: child.pid } : {}) }
  } finally {
    release()
  }
}

function start(options: LaunchOptions, chrome: boolean): ChildProcess {
  const env = { ...(options.env ?? process.env) }
  delete env[EXTRA_FLAGS_ENV]
  // On the image the endpoint, proxy and webdriver switches are the launcher's: Chrome would take a caller's, passed last.
  const { kept, dropped } = onImage(env) ? callerArgs(options.args ?? []) : { kept: options.args ?? [], dropped: [] }
  if (dropped.length > 0) options.log?.(`browser: dropped the caller's switches ${dropped.join(' ')}`)
  const args = [
    `--user-data-dir=${options.profile}`,
    ...BASE_FLAGS,
    ...imageFlags(env),
    ...devtoolsFlags(options.devtools, chrome, env),
    ...kept
  ]
  const child = spawn(options.browser, args, { detached: true, stdio: 'ignore', env })
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
  if (report.skipped !== undefined) return `skipped: ${report.skipped}`
  const c = report.cookies
  return [
    report.firstFork ? 'first fork' : 'since last fork',
    `cookies +${c.inserted} ~${c.updated} -${c.deleted} (kept ${c.kept}, expired ${c.expired})`,
    `localStorage ${report.localStorage.taken.length} origin(s)`,
    `IndexedDB ${report.indexedDb.taken.length} origin(s)`
  ].join(', ')
}

export interface LockTimings {
  staleMs?: number
  waitMs?: number
  refreshMs?: number
}

const launchLockPath = (profile: string): string => `${profile}.launch-lock`

/** A launch holds the profile's lock: from before its browser is spawned until that browser owns the profile. */
export function launchLocked(profile: string, now = Date.now()): boolean {
  try {
    return now - statSync(launchLockPath(profile)).mtimeMs <= LOCK_STALE_MS
  } catch {
    return false
  }
}

/** Two launches for one desktop at once must not both merge; a lock not refreshed for a minute is from a crashed launcher. */
export async function lockProfile(profile: string, timings: LockTimings = {}): Promise<() => void> {
  const { staleMs = LOCK_STALE_MS, waitMs = LOCK_WAIT_MS, refreshMs = LOCK_REFRESH_MS } = timings
  const path = launchLockPath(profile)
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      closeSync(openSync(path, 'wx'))
      // Kept fresh while held, so a long move or merge is never taken for a crashed launcher's and removed under it.
      const refresh = setInterval(() => {
        try {
          utimesSync(path, new Date(), new Date())
        } catch {
          // Released meanwhile.
        }
      }, refreshMs)
      refresh.unref()
      return () => {
        clearInterval(refresh)
        rmSync(path, { force: true })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) rmSync(path, { force: true })
      } catch {
        // Released meanwhile.
      }
      if (Date.now() > deadline) throw new Error(`another browser launch for ${profile} is still running`)
      await new Promise((resolveWait) => setTimeout(resolveWait, 200))
    }
  }
}
