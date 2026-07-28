/**
 * Accepted dream skills (docs/designs/memory-dreaming.md §7) — the canonical
 * copy, at `<agent-root>/skills/<name>/`.
 *
 * Daemon-owned and OUTSIDE the workspace, so an accepted skill survives a
 * workspace reset or re-clone and is never committed into a github-mode repo,
 * exactly like memory. Getting it in front of the runtime is a separate,
 * containment-checked step — see `dream-skill-install.ts`.
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/** Where an accepted mined skill is stored, under the agent root. */
export const ACCEPTED_SKILLS_DIRNAME = 'skills'

/** Same name discipline as the miner — these become filesystem paths. */
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Names of the skills this agent has accepted. A symlink is never listed: the
 * name is handed onward to a copier, so a link here would be a redirect.
 * Never throws — a missing tree is simply "none accepted".
 */
export async function acceptedDreamSkillNames(agent: { dir: string }): Promise<string[]> {
  try {
    return (await fsp.readdir(join(agent.dir, ACCEPTED_SKILLS_DIRNAME), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && SKILL_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}
