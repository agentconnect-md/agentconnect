/**
 * Materialize ACCEPTED dream skills into the runtime's project-scope skill root
 * (docs/designs/memory-dreaming.md §7).
 *
 * The canonical copy of an accepted skill lives at `<agent-root>/skills/<name>/`
 * — daemon-owned, outside the workspace, so it survives a reset or re-clone.
 * Runtimes only discover skills under the ACP cwd, so a copy has to land there
 * too. That cwd is AGENT-WRITABLE, which is the whole problem:
 *
 *   the daemon runs outside the agent's sandbox, so a `.claude/skills` symlink
 *   planted by a previous session turns a daemon-authority copy (or the
 *   reconciling remove) into an arbitrary write/delete anywhere on the host.
 *
 * So every path here goes through `fs/contained-path.ts`: components are walked
 * with `lstat` and a symlink is REFUSED rather than followed, each step is
 * re-checked against the workspace boundary, and files publish through an
 * exclusive temp + rename. Delegating to the `npx skills` installer would NOT
 * have helped — process indirection changes who writes, not the authority or
 * the pathname containment.
 *
 * Non-fatal by contract, like `installSkills`: a refused or broken skill warns
 * and is skipped, never blocking a session from starting.
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { ContainedPathError, containedRemoveDir, containedTarget } from '../fs/contained-path.js'
import { skillsAgentId } from './runtime-agent-map.js'
import { ACCEPTED_SKILLS_DIRNAME, acceptedDreamSkillNames } from './dream-skills.js'

/** Claude reads `.claude/skills`; the other mapped agents read `.agents/skills` —
 *  the same split `install-skills.ts` reconciles over. */
function skillRootFor(runtime: string): string | null {
  const agentId = skillsAgentId(runtime)
  if (!agentId) return null
  return agentId === 'claude-code' ? '.claude/skills' : '.agents/skills'
}

/** Files a mined skill may carry — the miner already validated these names. */
const SKILL_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i
/** Bounded so a broken canonical copy cannot stall session prep. */
const MAX_FILES_PER_SKILL = 24
const MAX_FILE_BYTES = 64 * 1024

/** Records exactly which dirs this pass materialized, so the next pass can
 *  remove the ones no longer wanted WITHOUT touching hand-authored skills or
 *  those `installSkills` owns (it keeps its own separate marker). */
const MARKER_DIR = '.agentconnect'
const MARKER_FILE = 'dream-skills-install.json'

interface Marker {
  installed: string[]
}

/** Only paths this feature could have produced may drive a removal — the marker
 *  is on-disk state an agent can edit, so its entries are untrusted input. */
function isOwnedSkillDir(rel: string): boolean {
  const m = /^(\.claude\/skills|\.agents\/skills)\/([a-z0-9][a-z0-9-]{0,62})$/.exec(rel)
  return m !== null
}

/** The marker is ALSO a daemon-authority write beneath the agent-writable cwd,
 *  so it gets the same no-follow treatment as the skill files — a planted
 *  `.agentconnect` symlink must not redirect it out of the workspace. */
async function readMarker(cwd: string): Promise<Marker> {
  try {
    const target = await containedTarget(cwd, join(cwd, MARKER_DIR), join(cwd, MARKER_DIR, MARKER_FILE), {
      create: false,
      label: 'skill marker'
    })
    if (!target) return { installed: [] }
    const parsed = JSON.parse(await fsp.readFile(target, 'utf8')) as Marker
    return { installed: Array.isArray(parsed.installed) ? parsed.installed.filter(isOwnedSkillDir) : [] }
  } catch {
    // Unreadable, absent, or refused: treat as "nothing recorded". A refusal is
    // reported by the write side, which is where the damage would be.
    return { installed: [] }
  }
}

async function writeMarker(cwd: string, marker: Marker, warn?: (msg: string) => void): Promise<void> {
  try {
    await publish(cwd, join(cwd, MARKER_DIR), join(cwd, MARKER_DIR, MARKER_FILE), Buffer.from(JSON.stringify(marker)))
  } catch (err) {
    // A containment refusal here is a security event, like a refused skill path.
    warn?.(
      err instanceof ContainedPathError
        ? `skills: refused to write the dream-skill marker — ${err.message}`
        : `skills: could not write the dream-skill marker — ${err instanceof Error ? err.message : ''}`
    )
  }
}

/**
 * Serial mutex per CANONICAL cwd. Ownership is a read → reconcile → copy →
 * publish transaction over one marker; two agents prepared concurrently in a
 * shared checkout would otherwise both read the same prior marker, both install,
 * and each overwrite the other's record — leaving one agent's skill on disk with
 * nothing recording it, so no later pass could ever reconcile it away.
 *
 * Keyed by the REAL path so two spellings of the same directory serialize
 * together. In-process only, which matches the scope: one daemon prepares the
 * sessions that share a checkout.
 */
const cwdLocks = new Map<string, Promise<unknown>>()

function withCwdLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = cwdLocks.get(key) ?? Promise.resolve()
  const result = prev.then(fn, fn)
  cwdLocks.set(
    key,
    result.then(
      () => {},
      () => {}
    )
  )
  return result
}

export interface MaterializeResult {
  installed: string[]
  removed: string[]
  errors: Array<{ skill: string; error: string }>
}

/** Copy one already-validated file into `destDir` (already contained). */
async function publish(boundary: string, root: string, destPath: string, body: Buffer): Promise<void> {
  const target = await containedTarget(boundary, root, destPath, { create: true, label: 'skill path' })
  if (!target) throw new ContainedPathError('skill path could not be resolved')
  // Exclusive temp + rename: a reader never sees a partial file, and the
  // random name cannot be pre-created by the agent to redirect the write.
  const temp = join(join(target, '..'), `.agentconnect-skill-${randomUUID()}.tmp`)
  const handle = await fsp.open(temp, 'wx', 0o600)
  try {
    await handle.writeFile(body)
  } finally {
    await handle.close()
  }
  try {
    await fsp.rename(temp, target)
  } catch (err) {
    await fsp.rm(temp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Copy every accepted skill into the runtime's skill root under `acpCwd`.
 * Returns what landed; never throws.
 */
export async function materializeAcceptedDreamSkills(
  agent: { dir: string; runtime: string },
  acpCwd: string,
  opts: { warn?: (msg: string) => void } = {}
): Promise<MaterializeResult> {
  const rootRel = skillRootFor(agent.runtime)
  if (!rootRel) return { installed: [], removed: [], errors: [] } // unmapped runtime
  // Canonical key so `/tmp/x` and `/private/tmp/x` share one lock.
  const key = await fsp.realpath(acpCwd).catch(() => acpCwd)
  return withCwdLock(key, () => materialize(agent, acpCwd, rootRel, opts))
}

async function materialize(
  agent: { dir: string; runtime: string },
  acpCwd: string,
  rootRel: string,
  opts: { warn?: (msg: string) => void }
): Promise<MaterializeResult> {
  const result: MaterializeResult = { installed: [], removed: [], errors: [] }

  const names = await acceptedDreamSkillNames({ dir: agent.dir })
  const skillsRoot = join(acpCwd, ...rootRel.split('/'))

  // RECONCILE FIRST, and even when this agent accepted nothing. A checkout can
  // be shared between agents, so a skill agent A accepted must not still be
  // sitting in the runtime's discovery root when agent B is prepared — that
  // would hand B executable instruction content it never reviewed.
  const desired = new Set(names.map((name) => `${rootRel}/${name}`))
  const prior = await readMarker(acpCwd)
  for (const rel of prior.installed) {
    if (desired.has(rel)) continue
    try {
      await containedRemoveDir(acpCwd, join(acpCwd, ...rel.split('/').slice(0, -1)), join(acpCwd, ...rel.split('/')))
      result.removed.push(rel)
    } catch (err) {
      opts.warn?.(`skills: could not remove stale dream skill "${rel}" — ${err instanceof Error ? err.message : ''}`)
    }
  }
  if (names.length === 0) {
    await writeMarker(acpCwd, { installed: [] }, opts.warn)
    return result
  }

  for (const name of names) {
    const source = join(agent.dir, ACCEPTED_SKILLS_DIRNAME, name)
    const destDir = join(skillsRoot, name)
    try {
      // Replace any prior copy — refusing if the path traverses a link, which
      // is exactly the planted-symlink case.
      await containedRemoveDir(acpCwd, skillsRoot, destDir)

      // Read the canonical (daemon-owned) copy. Symlinks are not followed here
      // either: the accepted tree should only ever contain regular files.
      // The accepted tree is `SKILL.md` plus an optional FLAT `scripts/` dir —
      // exactly what DreamRunner stages. Copying only the top level would report
      // success while silently dropping every reviewed script.
      const files: Array<{ rel: string; abs: string }> = []
      for (const entry of await fsp.readdir(source, { withFileTypes: true })) {
        if (entry.isFile() && !entry.isSymbolicLink() && SKILL_FILE_RE.test(entry.name)) {
          files.push({ rel: entry.name, abs: join(source, entry.name) })
        } else if (entry.isDirectory() && !entry.isSymbolicLink() && entry.name === 'scripts') {
          for (const script of await fsp.readdir(join(source, 'scripts'), { withFileTypes: true })) {
            if (!script.isFile() || script.isSymbolicLink() || !SKILL_FILE_RE.test(script.name)) continue
            files.push({ rel: `scripts/${script.name}`, abs: join(source, 'scripts', script.name) })
          }
        }
      }
      if (!files.some((f) => f.rel === 'SKILL.md')) {
        result.errors.push({ skill: name, error: 'accepted skill has no SKILL.md' })
        continue
      }
      for (const file of files.slice(0, MAX_FILES_PER_SKILL)) {
        const body = await fsp.readFile(file.abs)
        if (body.byteLength > MAX_FILE_BYTES) {
          result.errors.push({ skill: name, error: `${file.rel} exceeds the size cap` })
          continue
        }
        await publish(acpCwd, skillsRoot, join(destDir, ...file.rel.split('/')), body)
      }
      result.installed.push(`${rootRel}/${name}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      result.errors.push({ skill: name, error: message })
      // A containment refusal is a security event, not a routine miss — say so.
      opts.warn?.(
        err instanceof ContainedPathError
          ? `skills: refused to install accepted skill "${name}" — ${message}`
          : `skills: could not install accepted skill "${name}" — ${message}`
      )
    }
  }
  await writeMarker(acpCwd, { installed: result.installed }, opts.warn)
  return result
}
