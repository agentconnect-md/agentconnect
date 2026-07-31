import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

function canonicalModuleArgument(argument: string): { argument: string; path: string } | undefined {
  const equals = argument.indexOf('=')
  const prefix = equals > 0 ? argument.slice(0, equals + 1) : ''
  const raw = prefix ? argument.slice(equals + 1) : argument
  let path: string
  let fileUrl = false
  try {
    if (raw.startsWith('file:')) {
      path = fileURLToPath(raw)
      fileUrl = true
    } else {
      if (!isAbsolute(raw)) return undefined
      path = raw
    }
  } catch {
    return undefined
  }
  if (!existsSync(path)) return undefined
  const real = realpathSync(path)
  return { argument: `${prefix}${fileUrl ? pathToFileURL(real).href : real}`, path: real }
}

/** Keep daemon-generated Node helper commands usable when their tsx/loader
 * arguments point through a version-manager symlink below the hidden HOME. */
export function canonicalNodeExecArgv(argv: readonly string[] = process.execArgv): string[] {
  return argv.map((argument) => canonicalModuleArgument(argument)?.argument ?? argument)
}

/** Existing module files referenced by the current Node launch. These are
 * daemon-owned inputs to the trusted code-root resolver, never agent argv. */
export function nodeExecArgvModuleEntries(argv: readonly string[] = process.execArgv): string[] {
  return [...new Set(argv.flatMap((argument) => canonicalModuleArgument(argument)?.path ?? []))]
}
