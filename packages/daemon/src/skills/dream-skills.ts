/**
 * Accepted dream skills (docs/designs/memory-dreaming.md §7).
 *
 * Accepting a mined skill stores it at `<agent-root>/skills/<name>/` — a
 * DAEMON-OWNED path outside the workspace, so it survives a workspace reset or
 * re-clone and is never committed into a github-mode repo, exactly like memory.
 *
 * ─── Why nothing here installs it into the workspace ────────────────────────
 *
 * Runtimes discover skills in project-scope directories under the ACP cwd
 * (`.claude/skills` / `.agents/skills`). That cwd is AGENT-WRITABLE, and both
 * the daemon and the `npx skills` installer run OUTSIDE the agent's sandbox
 * with daemon authority. Any materialization there resolves a pathname whose
 * parent the agent can replace with a symlink, so a daemon-authority recursive
 * copy/remove can be redirected to an arbitrary host path. Node exposes no
 * `openat` family, so re-validating the path cannot close that race portably:
 * checking again only makes an escape *detectable* after the write.
 *
 * Delegating to the existing installer does not help either — process
 * indirection changes who performs the write, not its authority or its
 * pathname containment, and that installer does its own path-based
 * reconciliation removal.
 *
 * So acceptance deliberately stops at the daemon-owned copy. Making an accepted
 * skill visible to the runtime needs a containment-safe materialization step
 * (a hardened installer, or execution under a filesystem sandbox that cannot
 * follow workspace links to host paths) and is tracked as follow-up alongside
 * the CP/console wiring this feature still needs.
 */
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'

/** Where an accepted mined skill is stored, under the agent root. */
export const ACCEPTED_SKILLS_DIRNAME = 'skills'

/** Same name discipline as the miner — these are filesystem paths. */
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

/**
 * Names of the skills this agent has accepted. Read-only: the console shows
 * these so acceptance is never a silent no-op, and no caller writes anywhere
 * the agent can influence. Never throws.
 */
export async function acceptedDreamSkillNames(agent: { dir: string }): Promise<string[]> {
  try {
    return (
      (await fsp.readdir(join(agent.dir, ACCEPTED_SKILLS_DIRNAME), { withFileTypes: true }))
        // A symlink here would be a path we hand onward, so it is never listed.
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && SKILL_DIR_RE.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    )
  } catch {
    return []
  }
}
