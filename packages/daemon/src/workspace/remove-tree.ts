import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { chmod, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * `rm -rf` for a tree that may hold directories without owner-write: an installed skill bundle is
 * published that way (shared-skills.md §8), and nothing under one can be unlinked until its directory
 * is writable again. The plain removal runs first; only a permission refusal pays for the walk.
 */
export function removeTreeSync(path: string, options?: { maxRetries?: number; retryDelay?: number }): void {
  try {
    rmSync(path, { recursive: true, force: true, ...options })
  } catch (error) {
    if (!permissionRefused(error)) throw error
    writableDirectoriesSync(path)
    rmSync(path, { recursive: true, force: true, ...options })
  }
}

export async function removeTree(path: string): Promise<void> {
  try {
    await rm(path, { recursive: true, force: true })
  } catch (error) {
    if (!permissionRefused(error)) throw error
    await writableDirectories(path)
    await rm(path, { recursive: true, force: true })
  }
}

// A refused unlink surfaces as the refusal itself, or as the parent the removal then cannot empty.
function permissionRefused(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOTEMPTY'
}

function writableDirectoriesSync(path: string): void {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return
  }
  if (!stat.isDirectory()) return
  chmodSync(path, stat.mode | 0o200)
  for (const entry of readdirSync(path)) writableDirectoriesSync(join(path, entry))
}

async function writableDirectories(path: string): Promise<void> {
  let stat
  try {
    stat = await lstat(path)
  } catch {
    return
  }
  if (!stat.isDirectory()) return
  await chmod(path, stat.mode | 0o200)
  for (const entry of await readdir(path)) await writableDirectories(join(path, entry))
}
