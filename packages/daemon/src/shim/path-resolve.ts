import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join, resolve } from 'node:path'

/**
 * Resolve a command in THIS filesystem, which inside a sandbox is the only one that counts.
 *
 * Deliberately a local implementation rather than an import of the daemon's resolver: that
 * one pulls the runtime registry and curated catalog behind it, and the shim ships as a
 * single self-contained file with nothing but node builtins.
 */
export function resolveCommandInPath(command: string, env: Record<string, string>): string | undefined {
  const executable = (candidate: string): string | undefined => {
    try {
      if (!statSync(candidate).isFile()) return undefined
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      return undefined
    }
  }
  // An absolute or explicitly relative command is a path already, not a PATH lookup.
  if (isAbsolute(command)) return executable(command)
  if (command.startsWith('./') || command.startsWith('../')) return executable(resolve(command))
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const found = executable(join(dir, command))
    if (found) return found
  }
  return undefined
}
