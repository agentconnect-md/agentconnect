import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, win32 } from 'node:path'
import { exitAsChild, type ChildResult } from './delegate.js'
import { firstPositionalIndex } from './route.js'

// `agentconnect desktop …` hands everything to the desktop daemon (computer-use.md §3.1); the CLI never imports it.

export const DESKTOP_COMMAND = 'desktop'
export const DESKTOP_BUNDLE = 'agentconnect-desktop.mjs'
export const DESKTOP_APP = 'AgentConnect Desktop.app'
export const DESKTOP_APP_BINARY = 'agentconnect-desktop'
export const DESKTOP_COMMAND_ENV = 'AGENTCONNECT_DESKTOP_COMMAND'

export interface DesktopHost {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  home: string
  exists: (path: string) => boolean
}

export interface DesktopLaunch {
  command: string
  args: string[]
}

const hostDefaults = (): DesktopHost => ({
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

// Everything after the `desktop` token, verbatim; global CLI options before it stay with the CLI.
export function desktopArgv(argv: string[]): string[] {
  const at = firstPositionalIndex(argv)
  if (at === undefined || argv[at] !== DESKTOP_COMMAND) throw new Error(`not a desktop invocation: ${argv.join(' ')}`)
  return argv.slice(at + 1)
}

const isScript = (path: string): boolean => /\.(c|m)?js$/i.test(path)

const launchOf = (entry: string, args: string[], node: string): DesktopLaunch =>
  isScript(entry) ? { command: node, args: [entry, ...args] } : { command: entry, args }

// Candidate entries in order: the dev override, the macOS app (it owns the TCC grants, §3.2.1), the installed bundle.
export function desktopCandidates(host: DesktopHost): string[] {
  const override = host.env.AGENTCONNECT_DESKTOP_ENTRY
  if (override) return [override]
  const apps =
    host.platform === 'darwin'
      ? [join(host.home, 'Applications'), '/Applications'].map((dir) =>
          join(dir, DESKTOP_APP, 'Contents', 'MacOS', DESKTOP_APP_BINARY)
        )
      : []
  const pathJoin = host.platform === 'win32' ? win32.join : join
  return [...apps, pathJoin(desktopDataDir(host), 'app', DESKTOP_BUNDLE)]
}

// The process to start for `agentconnect desktop <args>`, or a human-readable error naming where it looked.
export function resolveDesktopLaunch(
  args: string[],
  host: DesktopHost = hostDefaults(),
  node: string = process.execPath
): DesktopLaunch {
  const candidates = desktopCandidates(host)
  const found = candidates.find((path) => host.exists(path))
  if (found) return launchOf(found, args, node)
  if (host.env.AGENTCONNECT_DESKTOP_ENTRY)
    throw new Error(`AGENTCONNECT_DESKTOP_ENTRY points at a missing file: ${host.env.AGENTCONNECT_DESKTOP_ENTRY}`)
  throw new Error(
    `the desktop daemon is not installed (looked in ${candidates.join(', ')}). Build it with \`pnpm --filter @agentconnect.md/desktop bundle\` and run the bundle's install script, or set AGENTCONNECT_DESKTOP_ENTRY to its ${DESKTOP_BUNDLE}`
  )
}

// Runs the desktop daemon with inherited stdio and exits as it did; SIGTERM is forwarded, terminal SIGINT already reaches it.
export async function runDesktop(argv: string[], selfCommand: string): Promise<never> {
  const { command, args } = resolveDesktopLaunch(desktopArgv(argv))
  // The desktop daemon names this command, not its development bin, in help and fix hints.
  const env = { ...process.env, [DESKTOP_COMMAND_ENV]: selfCommand }
  const child = spawn(command, args, { stdio: 'inherit', env })
  const done = new Promise<ChildResult>((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
    child.on('error', (err) => {
      console.error(`agentconnect desktop: failed to launch ${command}: ${err.message}`)
      resolve({ code: 1, signal: null })
    })
  })
  const onTerm = (): void => void child.kill('SIGTERM')
  const onInt = (): void => {}
  process.on('SIGTERM', onTerm)
  process.on('SIGINT', onInt)
  const result = await done
  return exitAsChild(result, () => {
    process.removeListener('SIGTERM', onTerm)
    process.removeListener('SIGINT', onInt)
  })
}
