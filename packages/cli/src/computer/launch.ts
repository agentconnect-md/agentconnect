import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { firstPositionalIndex } from '../route.js'

// `agentconnect computer …` manages and runs the computer (desktop) daemon (computer-use.md §3.1); the CLI never imports it.

export const COMPUTER_COMMAND = 'computer'
// The pre-rename spelling, kept as a hidden alias while unreleased installs migrate.
export const COMPUTER_ALIAS = 'desktop'
export const COMPUTER_COMMANDS: ReadonlySet<string> = new Set([COMPUTER_COMMAND, COMPUTER_ALIAS])
export const DESKTOP_BUNDLE = 'agentconnect-desktop.mjs'
// The bundle inside a published `@agentconnect.md/desktop` version, relative to its version directory.
export const DESKTOP_PACKAGE_ENTRY = `dist/${DESKTOP_BUNDLE}`
export const DESKTOP_APP = 'AgentConnect Desktop.app'
export const DESKTOP_APP_BINARY = 'agentconnect-desktop'
export const DESKTOP_COMMAND_ENV = 'AGENTCONNECT_DESKTOP_COMMAND'
// Tells the daemon which stable entry its service should launch (packages/desktop/src/self.ts).
export const DESKTOP_SERVICE_ENTRY_ENV = 'AGENTCONNECT_DESKTOP_SERVICE_ENTRY'

export interface DesktopHost {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  exists: (path: string) => boolean
}

export interface DesktopLaunch {
  command: string
  args: string[]
  /** The version store's `current` entry, which a service installed from this launch should run; absent otherwise. */
  serviceEntry?: string
}

export const hostDefaults = (): DesktopHost => ({
  env: process.env,
  platform: process.platform,
  home: homedir(),
  exists: existsSync
})

// Mirrors `dataDir()` in packages/desktop/src/config.ts; keep both in step.
export function desktopDataDir(host: Pick<DesktopHost, 'env' | 'platform' | 'home'>): string {
  if (host.env.AGENTCONNECT_DESKTOP_HOME) return host.env.AGENTCONNECT_DESKTOP_HOME
  if (host.platform === 'win32')
    return win32.join(host.env.LOCALAPPDATA ?? win32.join(host.home, 'AppData', 'Local'), 'AgentConnect', 'desktop')
  return join(host.home, '.agentconnect', 'desktop')
}

const pathJoin = (platform: NodeJS.Platform): ((...parts: string[]) => string) =>
  platform === 'win32' ? win32.join : join

// The version store's active entry: `<data dir>/current/dist/agentconnect-desktop.mjs`.
export const storeEntry = (root: string, platform: NodeJS.Platform = process.platform): string =>
  pathJoin(platform)(root, 'current', ...DESKTOP_PACKAGE_ENTRY.split('/'))

// One installed version's entry, for running a version before or after `current` points at it.
export const versionEntry = (root: string, version: string, platform: NodeJS.Platform = process.platform): string =>
  pathJoin(platform)(root, 'versions', version, ...DESKTOP_PACKAGE_ENTRY.split('/'))

// Everything after the `computer` (or `desktop`) token, verbatim; global CLI options before it stay with the CLI.
export function computerArgv(argv: string[]): string[] {
  const at = firstPositionalIndex(argv)
  if (at === undefined || !COMPUTER_COMMANDS.has(argv[at]!))
    throw new Error(`not a computer invocation: ${argv.join(' ')}`)
  return argv.slice(at + 1)
}

const isScript = (path: string): boolean => /\.(c|m)?js$/i.test(path)

// Candidate entries in order: the dev override, the macOS app (it owns the TCC grants, §3.2.1), the CLI's version store, the legacy installer's bundle.
export function desktopCandidates(host: DesktopHost): string[] {
  const override = host.env.AGENTCONNECT_DESKTOP_ENTRY
  if (override) return [override]
  const apps =
    host.platform === 'darwin'
      ? [join(host.home, 'Applications'), '/Applications'].map((dir) =>
          join(dir, DESKTOP_APP, 'Contents', 'MacOS', DESKTOP_APP_BINARY)
        )
      : []
  const root = desktopDataDir(host)
  return [...apps, storeEntry(root, host.platform), pathJoin(host.platform)(root, 'app', DESKTOP_BUNDLE)]
}

// The process to start for `agentconnect computer <args>`, or a human-readable error naming where it looked.
export function resolveDesktopLaunch(
  args: string[],
  host: DesktopHost = hostDefaults(),
  node: string = process.execPath,
  selfCommand = 'agentconnect computer'
): DesktopLaunch {
  const candidates = desktopCandidates(host)
  const found = candidates.find((path) => host.exists(path))
  const managed = storeEntry(desktopDataDir(host), host.platform)
  if (found) {
    const launch = isScript(found) ? { command: node, args: [found, ...args] } : { command: found, args }
    return found === managed ? { ...launch, serviceEntry: managed } : launch
  }
  if (host.env.AGENTCONNECT_DESKTOP_ENTRY)
    throw new Error(`AGENTCONNECT_DESKTOP_ENTRY points at a missing file: ${host.env.AGENTCONNECT_DESKTOP_ENTRY}`)
  throw new Error(
    `the computer daemon is not installed (looked in ${candidates.join(', ')}). Install it with \`${selfCommand} install\`, or set AGENTCONNECT_DESKTOP_ENTRY to a built ${DESKTOP_BUNDLE}`
  )
}
