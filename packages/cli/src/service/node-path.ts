import { realpathSync } from 'node:fs'

// Homebrew installs a formula under `<prefix>/Cellar/<formula>/<version>` and deletes that directory on upgrade.
const CELLAR = /^(.+)\/Cellar\/([^/]+)\/[^/]+\/(.+)$/

/** The alias of a Node executable that outlives a package upgrade, or the path itself when none resolves to the same file. */
export function stableNodePath(execPath: string, realpath: (path: string) => string = realpathSync): string {
  const match = CELLAR.exec(execPath)
  if (!match) return execPath
  const alias = `${match[1]}/opt/${match[2]}/${match[3]}`
  try {
    return realpath(alias) === realpath(execPath) ? alias : execPath
  } catch {
    return execPath
  }
}
