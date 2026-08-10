import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cliEntryPointer } from '../paths.js'

export interface UpgradeLog {
  info(message: string): void
  error(message: string): void
}

/** Resolve the stable CLI entry that owns the daemon version store. */
export function readCliEntry(root: string): string | undefined {
  try {
    const entry = readFileSync(cliEntryPointer(root), 'utf8').trim()
    return entry && existsSync(entry) ? entry : undefined
  } catch {
    return undefined
  }
}

/** Install and atomically activate one CP-selected daemon version. */
export async function runCliUpgrade(
  cliEntry: string,
  targetVersion: string,
  root: string,
  log: UpgradeLog
): Promise<boolean> {
  log.info(`cp: installing daemon ${targetVersion} via ${cliEntry}`)
  return await new Promise<boolean>((resolve) => {
    const child = spawn(process.execPath, [cliEntry, 'upgrade', '--to', targetVersion, '--root', root], {
      stdio: 'inherit'
    })
    child.on('exit', (code) => {
      if (code === 0) log.info(`cp: daemon ${targetVersion} installed and activated`)
      else log.error(`cp: CLI upgrade exited ${code ?? 'via signal'}`)
      resolve(code === 0)
    })
    child.on('error', (err) => {
      log.error(`cp: could not launch CLI upgrade: ${err.message}`)
      resolve(false)
    })
  })
}
