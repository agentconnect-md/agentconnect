/**
 * An installed skill bundle is published without owner-write (`skill-workspace-mutation-cli.ts`), so a test that
 * edits one first takes the write bit back, as a runtime would, and a temp root that holds one is unlocked before
 * it is removed.
 */
import { chmodSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import { chmod, lstat, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

/** Gives `root` and everything under it owner-write back. */
export async function writableTree(root: string): Promise<void> {
  if (process.platform === 'win32') return
  let stat
  try {
    stat = await lstat(root)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) return
  await chmod(root, stat.mode | 0o200)
  if (!stat.isDirectory()) return
  for (const entry of await readdir(root)) await writableTree(join(root, entry))
}

export function writableTreeSync(root: string): void {
  if (process.platform === 'win32') return
  let stat
  try {
    stat = lstatSync(root)
  } catch {
    return
  }
  if (stat.isSymbolicLink()) return
  chmodSync(root, stat.mode | 0o200)
  if (!stat.isDirectory()) return
  for (const entry of readdirSync(root)) writableTreeSync(join(root, entry))
}

/** `rm -rf` for a temp root that may hold installed skill bundles. */
export function removeTreeSync(root: string): void {
  writableTreeSync(root)
  rmSync(root, { recursive: true, force: true })
}

export async function removeTree(root: string): Promise<void> {
  await writableTree(root)
  await rm(root, { recursive: true, force: true })
}
