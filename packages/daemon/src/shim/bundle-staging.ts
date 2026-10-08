import { chmodSync, lstatSync, mkdirSync, readdirSync, rmSync, type Stats } from 'node:fs'
import { join } from 'node:path'
import { ExecRefusedError } from '../workspace/git-command-policy.js'

// A real directory (not a symlink), private to this shim's user.
function assertPrivateDirectory(dir: string, stats: Stats): void {
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new ExecRefusedError(`bundle staging is not a real directory: ${dir}`)
  }
  if (typeof process.getuid === 'function' && stats.uid !== process.getuid()) {
    throw new ExecRefusedError(`bundle staging is not owned by the shim user: ${dir}`)
  }
}

// Create the staging dir at shim start, tighten it to 0700, and drop leftovers: handles never survive a shim restart.
export function prepareBundleStaging(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertPrivateDirectory(dir, lstatSync(dir))
  chmodSync(dir, 0o700)
  for (const entry of readdirSync(dir)) rmSync(join(dir, entry), { recursive: true, force: true })
}

// Refuse to stage a bundle unless the directory is still a private 0700 directory of this user.
export function assertBundleStagingPrivate(dir: string): void {
  let stats: Stats
  try {
    stats = lstatSync(dir)
  } catch {
    throw new ExecRefusedError(`bundle staging directory is missing: ${dir}`)
  }
  assertPrivateDirectory(dir, stats)
  if ((stats.mode & 0o077) !== 0) throw new ExecRefusedError(`bundle staging is not mode 0700: ${dir}`)
}
