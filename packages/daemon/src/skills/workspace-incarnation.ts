import { createHash } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'

/** The key a workspace's skill ledger is kept under: the directory itself (path, device, inode), so a later launch over the same directory finds its receipts and a replaced directory starts clean. */
export async function workspaceIncarnationOf(dir: string): Promise<string> {
  const stat = await lstat(dir, { bigint: true })
  if (!stat.isDirectory()) throw new Error('skill workspace root is unsafe')
  const identity = [await realpath(dir), String(stat.dev), String(stat.ino)]
  return `workspace:${createHash('sha256').update(JSON.stringify(identity)).digest('hex')}`
}
