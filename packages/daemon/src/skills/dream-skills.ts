/**
 * Accepted dream skills — making mined-and-accepted skills reachable by the
 * runtime (docs/designs/memory-dreaming.md §7).
 *
 * The canonical copy lives at `<agent-root>/skills/<name>/`, OUTSIDE the
 * workspace, for the same reason memory does: it must survive a workspace reset
 * or re-clone, and it must never be committed into a github-mode repo. Nothing
 * reads that path directly — runtimes discover skills under the ACP cwd.
 *
 * SECURITY: the daemon does NOT copy these into the workspace itself. The
 * workspace is agent-writable and the daemon runs OUTSIDE the agent's sandbox,
 * so any daemon-side recursive rm/cp resolving a path under the ACP cwd is
 * racing an adversary who can swap a parent directory for a symlink between the
 * check and the write — a check/use gap Node cannot close portably (there is no
 * `openat` family). Instead each accepted skill is presented to the EXISTING
 * `npx skills` installer as an ordinary local source, so the established,
 * already-hardened installation path does the materialization and this module
 * performs no destructive filesystem work at all.
 *
 * Deliberately NOT persisted into `agent.skills`: that array is CP-owned config
 * the next snapshot would overwrite. These entries are synthesized per session
 * prep, so they are daemon state rather than org config.
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import type { AgentSkillEntry } from '@agentconnect.md/protocol'

/** Where an accepted mined skill is kept, under the agent root. */
export const ACCEPTED_SKILLS_DIRNAME = 'skills'

/** Same name discipline as the miner — these become filesystem paths. */
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/** Label prefix so these are distinguishable from configured sources in logs. */
const SOURCE_LABEL_PREFIX = 'dream:'

/**
 * The agent's accepted dream skills, as local `AgentSkillEntry` sources for
 * `installSkills`. Empty (the overwhelmingly common case) when the agent has
 * accepted none. Never throws: a session must still start if this fails.
 */
export async function acceptedDreamSkillSources(agent: { dir: string }): Promise<AgentSkillEntry[]> {
  const root = join(agent.dir, ACCEPTED_SKILLS_DIRNAME)
  let names: string[]
  try {
    names = (await fsp.readdir(root, { withFileTypes: true }))
      // Only real directories: a symlink planted under the agent root would be
      // handed to the installer as a source, so it never becomes one.
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && SKILL_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return names.map((name) => ({
    name: `${SOURCE_LABEL_PREFIX}${name}`,
    source: join(root, name),
    skills: []
  }))
}
