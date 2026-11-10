// What a provider's own CLI reads in a proxied session on this machine (azure-devops-integration.md §6.4), from its credential module's `cli` member.
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join, posix } from 'node:path'
import { codeHostCredentials, type CodeHostCli } from '../codehost/credentials.js'
import type { Config } from '../config/config-schema.js'

/** The parent of every CLI state directory under a private HOME. */
export const CLI_STATE_DIR = '.agentconnect-cli'

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** A real directory at `path`, made when missing; a link in its place fails the start, as a linked runtime HOME does. */
function realDirectory(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return
  }
  if (stat.isSymbolicLink() || !stat.isDirectory())
    throw new Error(`runtime HOME path is not a real directory: ${path}`)
}

/** The CLIs of `providers` that declare one, each once. */
function clisOf(providers: Iterable<string>): CodeHostCli[] {
  const clis = new Set<CodeHostCli>()
  for (const provider of providers) {
    const cli = codeHostCredentials(provider)?.cli
    if (cli) clis.add(cli)
  }
  return [...clis]
}

function stateLeaf(provider: string, hostKey: string): string {
  return `${provider}-${createHash('sha256').update(hostKey).digest('hex').slice(0, 8)}`
}

/** A fresh, empty directory of one host's own for a provider CLI's state, under `home`: a confined session's goes with its directory. */
export function freshCliStateDir(home: string, provider: string, hostKey: string): string {
  const root = join(home, CLI_STATE_DIR)
  realDirectory(home)
  realDirectory(root)
  const dir = join(root, stateLeaf(provider, hostKey))
  // A link left at the leaf is removed itself, never followed.
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { mode: 0o700 })
  return dir
}

/** At boot no host runs, so every CLI state directory under `home` is a stopped host's; best effort, and never through a linked HOME. */
export function reclaimCliStateDirs(home: string): void {
  try {
    if (lstatSync(home).isDirectory()) rmSync(join(home, CLI_STATE_DIR), { recursive: true, force: true })
  } catch {
    // The next start empties its own directory anyway.
  }
}

/** A remote CLI's environment and state directories, prepared through the launch's existing materialize channel. */
export function codeHostCliLaunch(opts: {
  providers: Iterable<string>
  placeholder: string
  root: string
  hostKey: string
  own: (name: string) => boolean
}): { env: Record<string, string>; clearDirs: string[] } {
  const env: Record<string, string> = {}
  const clearDirs: string[] = []
  for (const provider of new Set(opts.providers)) {
    const cli = codeHostCredentials(provider)?.cli
    if (!cli) continue
    const stateDir = posix.join(opts.root, CLI_STATE_DIR, stateLeaf(provider, opts.hostKey))
    clearDirs.push(stateDir)
    const vars = cli.env({
      placeholder: opts.placeholder,
      stateDir
    })
    for (const [name, value] of Object.entries(vars)) if (!opts.own(name)) env[name] = value
  }
  return { env, clearDirs }
}

/** The CLI variables of each of `providers` that has a CLI, a fresh state directory each; one the session's own env sets is left to it. */
export function codeHostCliEnv(opts: {
  providers: Iterable<string>
  placeholder: string
  /** The host's private HOME, which a confined session's directory holds. */
  home: string
  hostKey: string
  config: Pick<Config, 'azureDevOps'>
  /** Whether the session's own env already sets a variable, which then wins as an agent's own token always has. */
  own: (name: string) => boolean
}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const provider of new Set(opts.providers)) {
    const cli = codeHostCredentials(provider)?.cli
    if (!cli) continue
    const extensionDir = cli.extensionDir(opts.config)
    const vars = cli.env({
      placeholder: opts.placeholder,
      stateDir: freshCliStateDir(opts.home, provider, opts.hostKey),
      ...(isDirectory(extensionDir) ? { extensionDir } : {})
    })
    for (const [name, value] of Object.entries(vars)) if (!opts.own(name)) out[name] = value
  }
  return out
}

/** What an OS sandbox reads of these providers' CLIs: each command, and each extension directory that exists. */
export function codeHostCliReads(
  providers: Iterable<string>,
  config: Pick<Config, 'azureDevOps'>
): { commands: string[]; paths: string[] } {
  const clis = clisOf(providers)
  return {
    commands: clis.map((cli) => cli.command),
    paths: clis.map((cli) => cli.extensionDir(config)).filter(isDirectory)
  }
}
