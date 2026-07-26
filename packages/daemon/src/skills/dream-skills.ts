/**
 * Accepted dream skills — materializing mined-and-accepted skills where the
 * runtime can actually find them (docs/designs/memory-dreaming.md §7).
 *
 * The canonical copy lives at `<agent-root>/skills/<name>/`, OUTSIDE the
 * workspace, for the same reason memory does: it must survive a workspace reset
 * or re-clone, and it must never be committed into a github-mode repo. But
 * nothing reads that path — runtimes discover skills under the ACP cwd
 * (`.claude/skills` / `.agents/skills`, per `install-skills.ts`). So each
 * session prep copies the canonical set into the runtime's real skill root,
 * exactly as the `npx skills` installer does for configured sources.
 *
 * Deliberately NOT written into `agent.skills`: that array is CP-owned config
 * the next snapshot would overwrite, and a locally-accepted skill is daemon
 * state, not org config.
 */
import { promises as fsp } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { skillsAgentId } from './runtime-agent-map.js'

/** Where an accepted mined skill is kept, under the agent root. */
export const ACCEPTED_SKILLS_DIRNAME = 'skills'

/** Same name discipline as the miner — these become filesystem paths. */
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/** The runtime's project-scope skill root under the ACP cwd. Mirrors
 *  `install-skills.ts`: Claude reads `.claude/skills`, the others `.agents/skills`. */
export function runtimeSkillRoot(runtime: string): string | undefined {
  const agentId = skillsAgentId(runtime)
  if (!agentId) return undefined
  return agentId === 'claude-code' ? '.claude/skills' : '.agents/skills'
}

/**
 * Copy the agent's accepted dream skills into its ACP cwd so the runtime can
 * load them. Best-effort and never throws: a session must still start if this
 * fails. Returns the skill names materialized.
 */
export async function installAcceptedDreamSkills(
  agent: { dir: string; runtime: string },
  acpCwd: string,
  warn?: (msg: string) => void
): Promise<string[]> {
  const source = join(agent.dir, ACCEPTED_SKILLS_DIRNAME)
  let names: string[]
  try {
    names = (await fsp.readdir(source, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && SKILL_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return [] // no accepted skills — the overwhelmingly common case
  }
  if (names.length === 0) return []

  const root = runtimeSkillRoot(agent.runtime)
  if (!root) {
    warn?.(`skills: no skill root known for runtime "${agent.runtime}"; accepted dream skills not installed`)
    return []
  }

  // SECURITY: the workspace is AGENT-WRITABLE and the daemon runs OUTSIDE the
  // agent's sandbox, so a planted `.claude/skills` symlink would otherwise make
  // these recursive rm/cp calls act on a path outside the workspace entirely.
  let verified: VerifiedDir
  try {
    verified = await containedSkillRoot(acpCwd, root)
  } catch (err) {
    warn?.(`skills: refusing to install accepted dream skills — ${(err as Error).message}`)
    return []
  }

  const installed: string[] = []
  try {
    for (const name of names) {
      const destination = join(verified.path, name)
      try {
        // Re-assert the parent's IDENTITY (not just its name) before every
        // mutating step: validating once and then writing by path is a
        // check/use gap — a concurrent process can swap the directory out from
        // under the verified path in between. `verified.handle` pins the inode
        // we approved, so a swap is detected rather than followed.
        await assertStillVerified(verified)
        // The destination itself may be a planted link too; never follow it.
        const existing = await fsp.lstat(destination).catch(() => null)
        if (existing?.isSymbolicLink()) {
          warn?.(`skills: skipping accepted dream skill "${name}" — its target is a symlink`)
          continue
        }
        // Replace rather than merge, so what loads is exactly what was accepted.
        await fsp.rm(destination, { recursive: true, force: true })
        await assertStillVerified(verified)
        await fsp.cp(join(source, name), destination, { recursive: true, dereference: false })
        // …and once more after, so a swap DURING the copy is still reported
        // rather than silently counted as installed.
        await assertStillVerified(verified)
        installed.push(name)
      } catch (err) {
        warn?.(`skills: could not install accepted dream skill "${name}": ${(err as Error).message}`)
      }
    }
  } finally {
    await verified.handle.close().catch(() => {})
  }
  return installed
}

/** The approved skill root: its path plus an OPEN HANDLE pinning the exact inode
 *  we validated, so the identity behind that path can be re-checked later. */
interface VerifiedDir {
  path: string
  handle: FileHandle
  dev: number
  ino: number
}

/** Throw if `path` no longer resolves to the directory we verified — i.e. it was
 *  renamed/replaced (symlink or otherwise) after the check. */
async function assertStillVerified(dir: VerifiedDir): Promise<void> {
  const current = await fsp.lstat(dir.path).catch(() => null)
  if (!current || !current.isDirectory() || current.dev !== dir.dev || current.ino !== dir.ino) {
    throw new Error('the skill root changed while installing; refusing to continue')
  }
}

/** Walk `root` under `acpCwd` one component at a time, creating what is missing
 *  and REJECTING any existing component that is a symlink, then verify the real
 *  path is still inside the real workspace. Throws with a path-free reason. */
async function containedSkillRoot(acpCwd: string, root: string): Promise<VerifiedDir> {
  const realCwd = await fsp.realpath(acpCwd)
  let current = realCwd
  for (const part of root.split('/').filter(Boolean)) {
    const candidate = join(current, part)
    const stat = await fsp.lstat(candidate).catch(() => null)
    if (stat === null) {
      await fsp.mkdir(candidate)
    } else if (stat.isSymbolicLink()) {
      throw new Error(`"${root}" contains a symlink`)
    } else if (!stat.isDirectory()) {
      throw new Error(`"${root}" is not a directory`)
    }
    current = await fsp.realpath(candidate)
    const rel = relative(realCwd, current)
    if (rel !== '' && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel))) {
      throw new Error(`"${root}" resolves outside the workspace`)
    }
  }
  // Hold the directory open for the caller's lifetime: on POSIX an open fd pins
  // the inode, so `assertStillVerified` can tell "same directory" from "same
  // path, different directory".
  const handle = await fsp.open(current)
  const stat = await handle.stat()
  return { path: current, handle, dev: stat.dev, ino: stat.ino }
}
