import { realpathSync } from 'node:fs'
import { delimiter, dirname } from 'node:path'

/**
 * Ensure the directory of the Node binary running this process is on `PATH`.
 *
 * When the daemon runs under an OS service manager (systemd `--user`, launchd)
 * the process env is NOT the user's login shell env — version-manager PATH
 * entries (nvm/fnm/volta/asdf/…) are missing, so `npx`/`npm` are unresolvable
 * even though the service unit launches the daemon with that very Node binary.
 * That breaks every npx-distributed ACP runtime: the availability probe
 * (`isCommandAvailable('npx')`) fails and the runtime is reported as not
 * installed on this host.
 *
 * `npx`/`npm` ship next to `node` in every distribution (version managers,
 * Homebrew, distro packages, Windows), so prepending `dirname(process.execPath)`
 * — and its symlink-resolved twin — restores them without assuming anything
 * about how the user installed Node. No-op when the dirs are already present.
 */
export function ensureNodeBinOnPath(env: NodeJS.ProcessEnv = process.env): void {
  const dirs = [dirname(process.execPath)]
  try {
    const real = dirname(realpathSync(process.execPath))
    if (!dirs.includes(real)) dirs.push(real)
  } catch {
    // unreadable executable path — the literal dir alone still helps
  }
  const current = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const missing = dirs.filter((d) => !current.includes(d))
  if (missing.length === 0) return
  env.PATH = [...missing, ...current].join(delimiter)
}
