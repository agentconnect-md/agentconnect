import { chmodSync, lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs'
import { dirname } from 'node:path'
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

// Create the bundle staging directory at shim start and tighten it to 0700.
export function prepareBundleStaging(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertPrivateDirectory(dir, lstatSync(dir))
  chmodSync(dir, 0o700)
}

// Refuse a bundle target unless the staging dir is private and the file is a new direct child of it, by realpath.
export function assertBundleTarget(stagingDir: string, file: string): void {
  let stats: Stats
  try {
    stats = lstatSync(stagingDir)
  } catch {
    throw new ExecRefusedError(`bundle staging directory is missing: ${stagingDir}`)
  }
  assertPrivateDirectory(stagingDir, stats)
  if ((stats.mode & 0o077) !== 0) throw new ExecRefusedError(`bundle staging is not mode 0700: ${stagingDir}`)
  let parent: string
  let staging: string
  try {
    parent = realpathSync(dirname(file))
    staging = realpathSync(stagingDir)
  } catch {
    throw new ExecRefusedError(`bundle file parent or staging directory does not resolve: ${file}`)
  }
  if (parent !== staging) {
    throw new ExecRefusedError(`bundle file escapes the staging directory: ${file}`)
  }
  try {
    lstatSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new ExecRefusedError(`bundle file cannot be checked: ${file}`)
  }
  throw new ExecRefusedError(`bundle file already exists: ${file}`)
}
