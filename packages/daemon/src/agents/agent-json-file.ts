import { chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const PRIVATE_DIR_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600

function chmodIfNeeded(path: string, target: number | ((current: number) => number)): void {
  try {
    const current = statSync(path).mode & 0o777
    const mode = typeof target === 'function' ? target(current) : target
    if (current !== mode) chmodSync(path, mode)
  } catch (err) {
    if (process.platform !== 'win32') throw err
  }
}

export function ensurePrivateAgentDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIR_MODE })
  chmodIfNeeded(path, PRIVATE_DIR_MODE)
}

/** Tighten a hand-authored or legacy agent.json before reading its secrets. */
export function protectAgentJson(file: string, writable = false): void {
  if (!existsSync(file)) return
  chmodIfNeeded(file, (current) => (writable ? PRIVATE_FILE_MODE : current & 0o700))
}

/** Preserve the existing inode/symlink while enforcing owner-only access. */
export function writeAgentJson(file: string, contents: string): void {
  if (!existsSync(file)) ensurePrivateAgentDirectory(dirname(file))
  protectAgentJson(file, true)
  writeFileSync(file, contents, { encoding: 'utf8', mode: PRIVATE_FILE_MODE })
  protectAgentJson(file, true)
}
