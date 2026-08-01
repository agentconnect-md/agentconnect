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
 * exclusive temp + rename. Delegating to the bundled `skills` installer would NOT
 * have helped — process indirection changes who writes, not the authority or
 * the pathname containment.
 *
 * Non-fatal by contract, like `installSkills`: a refused or broken skill warns
 * and is skipped, never blocking a session from starting.
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { dirname, join } from 'node:path'
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

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
/** These are the same hard ceilings enforced when a managed `.skill` archive is
 * accepted. They also fence a daemon-owned Dream skill tree that was corrupted
 * after review. */
const MAX_FILES_PER_SKILL = 64
const MAX_EXPANDED_BYTES_PER_SKILL = 4 * 1024 * 1024
const MAX_FILE_BYTES = 512 * 1024
const MAX_SKILL_PATH_BYTES = 256

/** Records exactly which dirs this pass materialized, so the next pass can
 *  remove the ones no longer wanted WITHOUT touching hand-authored skills or
 *  those `installSkills` owns (it keeps its own separate marker). */
const MARKER_DIR = '.agentconnect'
const MARKER_FILE = 'dream-skills-install.json'
/** The marker is a short list of short paths; anything larger is not ours. */
const MAX_MARKER_BYTES = 64 * 1024

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
    // containedTarget validates the PARENTS and hands back the final name for
    // the caller to judge — so judge it. A symlink here would still be followed
    // outside the workspace, and an unbounded read of an agent-chosen target is
    // a denial-of-service path (a huge or non-terminating file).
    const stat = await fsp.lstat(target)
    if (!stat.isFile()) throw new ContainedPathError('skill marker is not a regular file')
    if (stat.size > MAX_MARKER_BYTES) throw new ContainedPathError('skill marker exceeds its size cap')
    const parsed = JSON.parse(await fsp.readFile(target, 'utf8')) as Marker
    return { installed: Array.isArray(parsed.installed) ? parsed.installed.filter(isOwnedSkillDir) : [] }
  } catch {
    // Unreadable, absent, or refused: treat as "nothing recorded". A refusal is
    // reported by the write side, which is where the damage would be.
    return { installed: [] }
  }
}

async function writeMarker(cwd: string, marker: Marker, warn?: (msg: string) => void): Promise<boolean> {
  try {
    await publish(cwd, join(cwd, MARKER_DIR), join(cwd, MARKER_DIR, MARKER_FILE), Buffer.from(JSON.stringify(marker)))
    return true
  } catch (err) {
    // A containment refusal here is a security event, like a refused skill path.
    warn?.(
      err instanceof ContainedPathError
        ? `skills: refused to write the dream-skill marker — ${err.message}`
        : `skills: could not write the dream-skill marker — ${err instanceof Error ? err.message : ''}`
    )
    return false
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

export interface ManagedSkillMaterializationSource {
  name: string
  sourceDir: string
}

/** Copy one already-validated file into `destDir` (already contained). */
async function publish(boundary: string, root: string, destPath: string, body: Buffer, mode = 0o600): Promise<void> {
  const target = await containedTarget(boundary, root, destPath, { create: true, label: 'skill path' })
  if (!target) throw new ContainedPathError('skill path could not be resolved')
  // Exclusive temp + rename: a reader never sees a partial file, and the
  // random name cannot be pre-created by the agent to redirect the write.
  const temp = join(dirname(target), `.agentconnect-skill-${randomUUID()}.tmp`)
  const handle = await fsp.open(temp, 'wx', mode)
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
  opts: { warn?: (msg: string) => void; managedSkills?: ManagedSkillMaterializationSource[] } = {}
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
  opts: { warn?: (msg: string) => void; managedSkills?: ManagedSkillMaterializationSource[] }
): Promise<MaterializeResult> {
  const result: MaterializeResult = { installed: [], removed: [], errors: [] }

  const dreamNames = await acceptedDreamSkillNames({ dir: agent.dir })
  const sources = new Map<string, string>()
  for (const managed of opts.managedSkills ?? []) {
    if (!SKILL_NAME_RE.test(managed.name)) {
      result.errors.push({ skill: managed.name, error: 'managed skill has an invalid name' })
      continue
    }
    if (sources.has(managed.name)) {
      opts.warn?.(`skills: duplicate managed skill name "${managed.name}"; using the first enabled revision`)
      continue
    }
    sources.set(managed.name, managed.sourceDir)
  }
  for (const name of dreamNames) {
    if (sources.has(name)) {
      opts.warn?.(`skills: accepted agent-local skill "${name}" overrides the managed organization skill`)
    }
    sources.set(name, join(agent.dir, ACCEPTED_SKILLS_DIRNAME, name))
  }
  const names = [...sources.keys()].sort()
  const skillsRoot = join(acpCwd, ...rootRel.split('/'))

  // RECONCILE FIRST, and even when this agent accepted nothing. A checkout can
  // be shared between agents, so a skill agent A accepted must not still be
  // sitting in the runtime's discovery root when agent B is prepared — that
  // would hand B executable instruction content it never reviewed.
  const desired = new Set(names.map((name) => `${rootRel}/${name}`))
  const prior = await readMarker(acpCwd)
  const priorOwned = new Set(prior.installed)
  // Ownership must survive a FAILED removal. If A's removal is refused (its
  // path was replaced by a symlink) while B's succeeds, dropping A from the
  // marker forgets it forever: once A's real directory is restored, no later
  // pass knows to reconcile it, and it stays discoverable to agents that never
  // accepted it. So carry forward every entry we did not actually remove.
  const retained: string[] = []
  for (const rel of prior.installed) {
    if (desired.has(rel)) continue
    try {
      await containedRemoveDir(acpCwd, join(acpCwd, ...rel.split('/').slice(0, -1)), join(acpCwd, ...rel.split('/')))
      result.removed.push(rel)
    } catch (err) {
      retained.push(rel)
      opts.warn?.(`skills: could not remove stale dream skill "${rel}" — ${err instanceof Error ? err.message : ''}`)
    }
  }
  if (names.length === 0) {
    // Only record an empty set if something was actually removed. Writing a
    // marker unconditionally would create a file in EVERY workspace on every
    // prep — pointless for the overwhelmingly common no-accepted-skills case,
    // and a spurious workspace mutation the reconcile watcher can react to.
    if (result.removed.length > 0) await writeMarker(acpCwd, { installed: retained }, opts.warn)
    return result
  }

  // JOURNAL BEFORE MUTATING. If ownership cannot be recorded, installing anyway
  // would leave an untracked skill that no later pass could reconcile away — so
  // fail closed to "no accepted skill" rather than to an untracked one. The
  // journal is a conservative SUPERSET (what may exist after this pass), then
  // narrowed to what actually landed; a crash in between leaves extras
  // recorded, which a later pass simply removes.
  const journal = [...new Set([...retained, ...prior.installed.filter((rel) => desired.has(rel)), ...desired])]
  if (!(await writeMarker(acpCwd, { installed: journal }, opts.warn))) {
    result.errors.push({ skill: '*', error: 'ownership could not be recorded; skills were not installed' })
    return result
  }

  for (const name of names) {
    const source = sources.get(name)!
    const destDir = join(skillsRoot, name)
    const ownedRel = `${rootRel}/${name}`
    try {
      // Replace any prior copy — refusing if the path traverses a link, which
      // is exactly the planted-symlink case.
      await containedRemoveDir(acpCwd, skillsRoot, destDir)

      // Read the canonical (daemon-owned) tree. Full Agent Skills bundles may
      // contain scripts/, references/, assets/, and nested supporting files.
      // Never follow links or special entries, and re-apply the acceptance caps
      // so a corrupted cache/canonical Dream tree cannot become an unbounded copy.
      const files: Array<{ rel: string; abs: string; bytes: number }> = []
      const folded = new Set<string>()
      let expandedBytes = 0
      const sourceStat = await fsp.lstat(source)
      if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
        throw new ContainedPathError('canonical skill root is not a regular directory')
      }
      const visit = async (dir: string, prefix = ''): Promise<void> => {
        const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
        for (const entry of entries) {
          if (entry.isSymbolicLink()) throw new ContainedPathError('canonical skill contains a symbolic link')
          const normalized = entry.name.normalize('NFC')
          if (
            normalized !== entry.name ||
            normalized === '.' ||
            normalized === '..' ||
            normalized.length === 0 ||
            normalized.length > 128 ||
            normalized.includes('\0')
          ) {
            throw new ContainedPathError('canonical skill contains an unsafe file name')
          }
          const rel = prefix ? `${prefix}/${normalized}` : normalized
          if (Buffer.byteLength(rel, 'utf8') > MAX_SKILL_PATH_BYTES) {
            throw new ContainedPathError('canonical skill path exceeds its size cap')
          }
          const abs = join(dir, normalized)
          if (entry.isDirectory()) {
            await visit(abs, rel)
            continue
          }
          if (!entry.isFile()) throw new ContainedPathError('canonical skill contains a special file')
          const key = rel.toLocaleLowerCase('en-US')
          if (folded.has(key)) throw new ContainedPathError('canonical skill contains colliding file paths')
          folded.add(key)
          const stat = await fsp.lstat(abs)
          if (!stat.isFile() || stat.isSymbolicLink()) {
            throw new ContainedPathError('canonical skill changed to a non-regular file')
          }
          if (stat.size > MAX_FILE_BYTES) {
            throw new ContainedPathError('canonical skill contains a file over its size cap')
          }
          expandedBytes += stat.size
          if (files.length >= MAX_FILES_PER_SKILL || expandedBytes > MAX_EXPANDED_BYTES_PER_SKILL) {
            throw new ContainedPathError('canonical skill exceeds its expanded size cap')
          }
          files.push({ rel, abs, bytes: stat.size })
        }
      }
      await visit(source)
      if (!files.some((f) => f.rel === 'SKILL.md')) {
        throw new ContainedPathError('canonical skill has no SKILL.md')
      }
      for (const file of files) {
        const body = await fsp.readFile(file.abs)
        if (body.byteLength !== file.bytes) throw new ContainedPathError('canonical skill changed while copying')
        await publish(
          acpCwd,
          skillsRoot,
          join(destDir, ...file.rel.split('/')),
          body,
          file.rel.startsWith('scripts/') ? 0o700 : 0o600
        )
      }
      result.installed.push(`${rootRel}/${name}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error'
      result.errors.push({ skill: name, error: message })
      await containedRemoveDir(acpCwd, skillsRoot, destDir).catch(() => {})
      // A previously owned desired path remains ours until a later pass proves
      // it was removed. In particular, a planted symlink can make both the
      // replacement and cleanup refuse; dropping it from the final marker would
      // permanently forget executable content once the real directory returns.
      if (priorOwned.has(ownedRel)) retained.push(ownedRel)
      // A containment refusal is a security event, not a routine miss — say so.
      opts.warn?.(
        err instanceof ContainedPathError
          ? `skills: refused to install accepted skill "${name}" — ${message}`
          : `skills: could not install accepted skill "${name}" — ${message}`
      )
    }
  }
  await writeMarker(acpCwd, { installed: [...new Set([...retained, ...result.installed])] }, opts.warn)
  return result
}
