import { existsSync, realpathSync } from 'node:fs'
import { delimiter, dirname, join } from 'node:path'
import { home } from './probe.js'

/** Append the launching Node's bin dir (and its symlink-resolved twin) so npx/npm resolve under a minimal service PATH, never shadowing the user's node. */
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
  env.PATH = [...current, ...missing].join(delimiter)
}

/** Vendor installer bin dirs that only shell profiles put on PATH, keyed by runtime id. */
export const RUNTIME_INSTALL_BIN_DIRS: Record<string, (env: NodeJS.ProcessEnv) => string[]> = {
  'muse-acp': (env) => [
    env.MUSE_INSTALL_DIR ||
      (process.platform === 'win32'
        ? join(env.LOCALAPPDATA || join(home(env), 'AppData', 'Local'), 'Programs', 'muse')
        : join(home(env), '.local', 'bin'))
  ],
  // Kimi Code CLI's install script drops `kimi` in $KIMI_CODE_HOME/bin (default ~/.kimi-code/bin).
  kimi: (env) => [join(env.KIMI_CODE_HOME || join(home(env), '.kimi-code'), 'bin')]
}

/** Append existing vendor install bin dirs so a service's PATH snapshot still probes and launches them. */
export function ensureRuntimeInstallDirsOnPath(env: NodeJS.ProcessEnv = process.env): void {
  const current = (env.PATH ?? '').split(delimiter).filter(Boolean)
  const missing = [...new Set(Object.values(RUNTIME_INSTALL_BIN_DIRS).flatMap((dirs) => dirs(env)))].filter(
    (d) => !current.includes(d) && existsSync(d)
  )
  if (missing.length === 0) return
  env.PATH = [...current, ...missing].join(delimiter)
}
