import { userInfo } from 'node:os'
import { basename } from 'node:path'

/**
 * Login-shell exec templates for the service run shell.
 *
 * Under a service manager (systemd `--user`, launchd) the process env is NOT
 * the user's shell env — version-manager PATH entries and profile `export`s
 * are missing. Instead of guessing what the user's environment would be, the
 * run shell launches the daemon THROUGH a fresh interactive login shell that
 * `exec`s the daemon command: the daemon is born with exactly the environment
 * a new terminal would have, and tracks profile edits at every restart.
 *
 * `-l -i` both matter: distro-default `.bashrc`s return early for
 * non-interactive shells, and version managers (nvm & co.) append their PATH
 * exports below that guard — a login-only shell would miss them.
 */

/** The user's login shell, resolvable even where `$SHELL` is unset (service
 *  managers) via the passwd entry. */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SHELL) return env.SHELL
  try {
    return userInfo().shell ?? undefined
  } catch {
    return undefined
  }
}

/** Shells where `sh -c 'exec "$0" "$@"' argv0 args…` passes argv through verbatim. */
const POSIX_FAMILY = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'mksh'])

/**
 * Full spawn argv that runs `cmd` by `exec`-ing it from an interactive login
 * `shell` — pid is preserved, argv crosses the shell without re-quoting.
 * Returns undefined for shells with no safe template (tcsh rejects `-l` with
 * other flags; nushell &c. have different arg semantics) — callers fall back
 * to a direct spawn.
 */
export function shellExecArgv(shell: string, cmd: readonly string[]): string[] | undefined {
  if (process.platform === 'win32' || cmd.length === 0) return undefined
  const name = basename(shell)
  if (POSIX_FAMILY.has(name)) return [shell, '-l', '-i', '-c', 'exec "$0" "$@"', ...cmd]
  // fish: args after -c land in $argv, which expands as a list.
  if (name === 'fish') return [shell, '-l', '-i', '-c', 'exec $argv', ...cmd]
  return undefined
}
