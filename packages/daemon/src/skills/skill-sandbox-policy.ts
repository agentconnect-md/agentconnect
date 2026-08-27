import { constants, existsSync, lstatSync, promises as fsp, readdirSync } from 'node:fs'
import { join } from 'node:path'

const REQUIREMENT_MARKER = 'sandbox-required-v1'

export interface SkillSandboxAgentState {
  dir?: string
  skills?: readonly unknown[]
  managedSkills?: readonly unknown[]
}

/** Detect executable authority left by a rolling upgrade. Current daemon boot
 * establishes this same-UID boundary unconditionally before every real ACP
 * child: an unconfined sibling could otherwise forge the accepted registry,
 * ownership ledger, or installed bytes before the first source is enabled. The
 * durable marker preserves that invariant across restarts and older layouts. */
export function skillSandboxRequirementPresent(daemonRoot: string, agents: readonly SkillSandboxAgentState[]): boolean {
  if (agents.some((agent) => (agent.skills?.length ?? 0) > 0 || (agent.managedSkills?.length ?? 0) > 0)) return true

  const stateDir = join(daemonRoot, 'skill-installs')
  if (pathExistsOrUnsafe(join(stateDir, REQUIREMENT_MARKER))) return true

  // Rolling upgrade: a pre-marker v3 ledger is still executable authority. Any
  // entry is enough to fail closed; the strict ledger reader diagnoses corrupt
  // contents later instead of letting an unconfined sibling run first.
  try {
    const ledgerDir = join(stateDir, 'workspace-skills')
    if (existsSync(ledgerDir) && readdirSync(ledgerDir).length > 0) return true
  } catch {
    return true
  }

  return agents.some(
    (agent) => agent.dir !== undefined && pathExistsOrUnsafe(join(agent.dir, 'skills', 'accepted-skills.json'))
  )
}

export async function persistSkillSandboxRequirement(daemonRoot: string): Promise<void> {
  const stateDir = join(daemonRoot, 'skill-installs')
  try {
    await fsp.mkdir(stateDir, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const state = await fsp.lstat(stateDir)
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('skill sandbox state directory is unsafe')
  if (typeof process.geteuid === 'function' && state.uid !== process.geteuid()) {
    throw new Error('skill sandbox state directory has another owner')
  }
  await fsp.chmod(stateDir, 0o700)

  const marker = join(stateDir, REQUIREMENT_MARKER)
  try {
    const handle = await fsp.open(
      marker,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      await handle.writeFile('1\n')
      await handle.sync()
    } finally {
      await handle.close()
    }
    // No POSIX directory-fsync primitive on Windows — the marker's own sync above is all we get.
    if (process.platform !== 'win32') {
      const directory = await fsp.open(stateDir, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }

  const stat = await fsp.lstat(marker)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 2) {
    throw new Error('skill sandbox requirement marker is unsafe')
  }
  if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) {
    throw new Error('skill sandbox requirement marker has another owner')
  }
  await fsp.chmod(marker, 0o600)
}

function pathExistsOrUnsafe(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}
