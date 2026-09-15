/** Re-execute `install-service` / `uninstall-service` through sudo. Only those two
 *  need root; `up`/`down`/`restart`/`status` stay unprivileged via the polkit rule. */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { isElevated, type ServiceAccount } from './account.js'

export type ElevatedCommand = 'install-service' | 'uninstall-service'

export interface ElevationRequest {
  command: ElevatedCommand
  root: string
  instance?: string
  account: ServiceAccount
  /** Pre-sudo `PATH` snapshot. sudo's `secure_path` replaces `PATH`, so the value
   *  baked into the unit has to travel as an argument rather than through the env. */
  envPath?: string
}

/** The elevated argv is REBUILT from resolved intent rather than rewritten from the
 *  caller's, so no option-parsing quirk can smuggle an extra flag across the sudo
 *  boundary. Both commands take no positionals, which is what makes that possible. */
export function elevatedArgs(req: ElevationRequest): string[] {
  return [
    req.command,
    '--root',
    req.root,
    ...(req.instance ? ['--instance', req.instance] : []),
    '--service-user',
    req.account.user,
    '--service-home',
    req.account.home,
    ...(req.envPath ? ['--service-path', req.envPath] : [])
  ]
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}

/** The command to print when we cannot elevate ourselves — copy-pasteable as-is. */
export function manualSudoCommand(execPath: string, cliEntry: string, req: ElevationRequest): string {
  return ['sudo', '--', execPath, cliEntry, ...elevatedArgs(req)].map(shellQuote).join(' ')
}

export function findOnPath(bin: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (dir && existsSync(join(dir, bin))) return join(dir, bin)
  }
  return undefined
}

export interface ElevateDeps {
  execPath: string
  cliEntry: string
  hasSudo: () => boolean
  /** `sudo -n true` — succeeds when sudo is already authorized without a password. */
  sudoNonInteractiveOk: () => boolean
  /** Runs sudo with the terminal attached so it can prompt; returns its exit code. */
  runSudo: (args: string[]) => number
  isTTY: boolean
  elevated: () => boolean
}

export function defaultElevateDeps(execPath: string, cliEntry: string): ElevateDeps {
  return {
    execPath,
    cliEntry,
    hasSudo: () => findOnPath('sudo') !== undefined,
    sudoNonInteractiveOk: () => spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0,
    // `inherit` is load-bearing: sudo writes its prompt to stderr and reads the
    // password from /dev/tty, so a piped stdio would hang with no visible prompt.
    runSudo: (args) => spawnSync('sudo', args, { stdio: 'inherit' }).status ?? 1,
    isTTY: Boolean(process.stdin.isTTY),
    elevated: isElevated
  }
}

export type ElevationOutcome = { elevated: true } | { elevated: false; code: number }

/** Returns `{ elevated: true }` when this process is already root and should carry on;
 *  otherwise re-runs itself under sudo and returns that child's exit code. */
export function elevate(req: ElevationRequest, deps: ElevateDeps): ElevationOutcome {
  if (deps.elevated()) return { elevated: true }
  const manual = manualSudoCommand(deps.execPath, deps.cliEntry, req)
  if (!deps.hasSudo()) {
    throw new Error(`installing a system service needs root and sudo was not found — run this as root:\n  ${manual}`)
  }
  if (!deps.sudoNonInteractiveOk() && !deps.isTTY) {
    throw new Error(`sudo needs a password and there is no terminal to prompt on — run this from a shell:\n  ${manual}`)
  }
  return { elevated: false, code: deps.runSudo(['--', deps.execPath, deps.cliEntry, ...elevatedArgs(req)]) }
}
