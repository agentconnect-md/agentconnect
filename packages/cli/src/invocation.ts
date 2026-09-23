/** How the operator ran this CLI, so a suggested command pastes back as-is: bare bin, npx, or `node <entry>`. */
import { existsSync, realpathSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { commandSelector, shellArg } from './service/instance.js'
import { CLI_VERSION } from './version.js'

const PACKAGE = '@agentconnect.md/cli'
const BIN = 'agentconnect'

let invocation = BIN

export interface InvocationFacts {
  cliEntry: string
  version: string
  /** The operator's PATH — the pre-sudo snapshot when elevated, since sudo replaces it. */
  path: string | undefined
  platform: NodeJS.Platform
  realpath?: (p: string) => string | undefined
}

function safeRealpath(p: string): string | undefined {
  try {
    return realpathSync(p)
  } catch {
    return undefined
  }
}

/** The PATH `agentconnect` that resolves to this very file, if any — another install would run a different CLI. */
function globalBinIsThis(f: InvocationFacts): boolean {
  const real = f.realpath ?? safeRealpath
  const self = real(f.cliEntry)
  for (const dir of (f.path ?? '').split(delimiter)) {
    if (!dir) continue
    // Windows shims are `.cmd` wrappers, not links to the entry, so presence is all that can be checked.
    if (f.platform === 'win32') {
      if (existsSync(join(dir, `${BIN}.cmd`))) return true
      continue
    }
    const found = real(join(dir, BIN))
    if (found !== undefined) return found === self
  }
  return false
}

export function detectInvocation(f: InvocationFacts): string {
  if (/[\\/]_npx[\\/]/.test(f.cliEntry)) {
    const tag = f.version.includes('-rc.') ? '@rc' : ''
    return `npx -y ${PACKAGE}${tag}`
  }
  if (globalBinIsThis(f)) return BIN
  return `node ${shellArg(f.cliEntry)}`
}

/** Called once at startup; tests and library callers keep the plain `agentconnect` default. */
export function setInvocation(f: Omit<InvocationFacts, 'version'> & { version?: string }): void {
  invocation = detectInvocation({ ...f, version: f.version ?? CLI_VERSION })
}

/** The command to suggest for `target`: the invocation plus the selector that addresses it. */
export function cliCommand(target: { root?: string; instance?: string } = {}): string {
  return `${invocation}${commandSelector(target)}`
}
