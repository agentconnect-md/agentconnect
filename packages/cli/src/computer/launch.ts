import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { firstPositionalIndex } from '../route.js'

// `agentconnect computer …` manages and runs the computer daemon (computer-use.md §3.1); the CLI never imports it.

export const COMPUTER_COMMAND = 'computer'
export const COMPUTER_BUNDLE = 'agentconnect-computer.mjs'
// The bundle inside a published `@agentconnect.md/computer` version, relative to its version directory.
export const COMPUTER_PACKAGE_ENTRY = `dist/${COMPUTER_BUNDLE}`
export const COMPUTER_APP = 'AgentConnect Computer.app'
export const COMPUTER_APP_BINARY = 'agentconnect-computer'
export const COMPUTER_APP_ID = 'md.agentconnect.computer'
export const COMPUTER_COMMAND_ENV = 'AGENTCONNECT_COMPUTER_COMMAND'
// Tells the daemon which stable entry its service should launch (packages/computer/src/self.ts).
export const COMPUTER_SERVICE_ENTRY_ENV = 'AGENTCONNECT_COMPUTER_SERVICE_ENTRY'

export interface ComputerHost {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  exists: (path: string) => boolean
}

export interface ComputerLaunch {
  command: string
  args: string[]
  /** The version store's `current` entry, which a service installed from this launch should run; absent otherwise. */
  serviceEntry?: string
}

export const hostDefaults = (): ComputerHost => ({
  env: process.env,
  platform: process.platform,
  home: homedir(),
  exists: existsSync
})

// Mirrors `dataDir()` in packages/computer/src/config.ts; keep both in step.
export function computerDataDir(host: Pick<ComputerHost, 'env' | 'platform' | 'home'>): string {
  if (host.env.AGENTCONNECT_COMPUTER_HOME) return host.env.AGENTCONNECT_COMPUTER_HOME
  if (host.platform === 'win32')
    return win32.join(host.env.LOCALAPPDATA ?? win32.join(host.home, 'AppData', 'Local'), 'AgentConnect', 'computer')
  return join(host.home, '.agentconnect', 'computer')
}

const pathJoin = (platform: NodeJS.Platform): ((...parts: string[]) => string) =>
  platform === 'win32' ? win32.join : join

// The version store's active entry: `<data dir>/current/dist/agentconnect-computer.mjs`.
export const storeEntry = (root: string, platform: NodeJS.Platform = process.platform): string =>
  pathJoin(platform)(root, 'current', ...COMPUTER_PACKAGE_ENTRY.split('/'))

// One installed version's entry, for running a version before or after `current` points at it.
export const versionEntry = (root: string, version: string, platform: NodeJS.Platform = process.platform): string =>
  pathJoin(platform)(root, 'versions', version, ...COMPUTER_PACKAGE_ENTRY.split('/'))

// Everything after the `computer` token, verbatim; global CLI options before it stay with the CLI.
export function computerArgv(argv: string[]): string[] {
  const at = firstPositionalIndex(argv)
  if (at === undefined || argv[at] !== COMPUTER_COMMAND) throw new Error(`not a computer invocation: ${argv.join(' ')}`)
  return argv.slice(at + 1)
}

// Where `computer install` puts the macOS app; a copy dragged into /Applications also counts.
export const computerAppBinaries = (home: string): string[] =>
  [join(home, 'Applications'), '/Applications'].map((dir) =>
    join(dir, COMPUTER_APP, 'Contents', 'MacOS', COMPUTER_APP_BINARY)
  )

// The macOS app's Node runtime holds the TCC grants (computer-use.md §3.2.1), so every daemon script runs inside it there.
export function computerAppRunner(host: ComputerHost): string | undefined {
  return host.platform === 'darwin' ? computerAppBinaries(host.home).find((path) => host.exists(path)) : undefined
}

// Candidate entries in order: the dev override, the CLI's version store, the legacy installer's bundle.
export function computerCandidates(host: ComputerHost): string[] {
  const override = host.env.AGENTCONNECT_COMPUTER_ENTRY
  if (override) return [override]
  const root = computerDataDir(host)
  return [storeEntry(root, host.platform), pathJoin(host.platform)(root, 'app', COMPUTER_BUNDLE)]
}

// The process to start for `agentconnect computer <args>`, or a human-readable error naming where it looked.
export function resolveComputerLaunch(
  args: string[],
  host: ComputerHost = hostDefaults(),
  node: string = process.execPath,
  selfCommand = 'agentconnect computer'
): ComputerLaunch {
  const candidates = computerCandidates(host)
  const found = candidates.find((path) => host.exists(path))
  const managed = storeEntry(computerDataDir(host), host.platform)
  if (found) {
    const launch = { command: computerAppRunner(host) ?? node, args: [found, ...args] }
    return found === managed ? { ...launch, serviceEntry: managed } : launch
  }
  if (host.env.AGENTCONNECT_COMPUTER_ENTRY)
    throw new Error(`AGENTCONNECT_COMPUTER_ENTRY points at a missing file: ${host.env.AGENTCONNECT_COMPUTER_ENTRY}`)
  throw new Error(
    `the computer daemon is not installed (looked in ${candidates.join(', ')}). Install it with \`${selfCommand} install\`, or set AGENTCONNECT_COMPUTER_ENTRY to a built ${COMPUTER_BUNDLE}`
  )
}
