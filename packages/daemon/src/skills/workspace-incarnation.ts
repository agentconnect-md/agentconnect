import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'

/** The keys a workspace's skill ledger is kept under: the directory itself (path, inode), so a later launch over the same directory finds its receipts and a replaced directory starts clean. */
export async function workspaceIncarnationOf(dir: string): Promise<{ incarnation: string; deviceIncarnation: string }> {
  const stat = await lstat(dir, { bigint: true })
  if (!stat.isDirectory()) throw new Error('skill workspace root is unsafe')
  const path = await realpath(dir)
  const key = (identity: string[]) => `workspace:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
  // No device: a reboot can renumber a Btrfs subvolume's under unchanged files. The key that held it lets its ledger be adopted.
  return {
    incarnation: key([path, String(stat.ino)]),
    deviceIncarnation: key([path, String(stat.dev), String(stat.ino)])
  }
}

/** The ledger key for installs into `cwd` below a workspace whose identity is `incarnation`. */
export function cwdWorkspaceIncarnation(incarnation: string, cwd: string): string {
  return `workspace:${createHash('sha256')
    .update(JSON.stringify([incarnation, cwd]))
    .digest('hex')}`
}
