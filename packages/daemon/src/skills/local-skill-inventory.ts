// The skills an agent's harness can actually load from its materialized
// workspace, tagged by where each came from. The console needs one place to see
// this because installs (Git sources, managed bundles, accepted Dream skills)
// AND skills committed in the agent's own repo all land in the same runtime
// skill directories, and only some of those have any other UI surface today.
//
// Provenance is recovered from the skill-install ownership ledger (what the
// daemon installed and from which source); anything present in a skill root but
// absent from the ledger is repo-committed. Reading is best-effort: an
// unreadable ledger degrades every entry to `repo` rather than failing the list.

import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readSkillLedger, skillLedgerLocation } from './skill-install-ledger.js'

export type LocalSkillOrigin = 'dream-accepted' | 'managed' | 'git-source' | 'repo'

export interface LocalSkillEntry {
  /** Skill name from SKILL.md frontmatter, falling back to the directory name. */
  name: string
  /** SKILL.md `description`, or null when absent/unparseable. */
  description: string | null
  origin: LocalSkillOrigin
  /** Path relative to the workspace cwd, e.g. ".claude/skills/deploy". */
  path: string
}

// The runtime skill roots supported harnesses load from (shared-skills.md §6);
// the daemon installs into these and repo-committed skills live here too.
const SKILL_ROOTS = ['.claude/skills', '.agents/skills'] as const
// Bounds on an untrusted workspace: cap the listing and the bytes read per
// SKILL.md so a pathological repo cannot exhaust the daemon on a UI read.
const MAX_SKILLS = 512
const MAX_MANIFEST_BYTES = 64 * 1024

export function originForSourceKey(sourceKey: string): LocalSkillOrigin {
  if (sourceKey.startsWith('dream:')) return 'dream-accepted'
  if (sourceKey.startsWith('managed:')) return 'managed'
  return 'git-source'
}

/** Read at most `MAX_MANIFEST_BYTES` of a file; undefined when it cannot be read
 *  (missing SKILL.md ⇒ the directory is not a skill). */
async function readManifestHead(file: string): Promise<string | undefined> {
  let handle
  try {
    handle = await fsp.open(file, 'r')
  } catch {
    return undefined
  }
  try {
    const buffer = Buffer.alloc(MAX_MANIFEST_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, MAX_MANIFEST_BYTES, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close().catch(() => undefined)
  }
}

/** Pull `name`/`description` out of a SKILL.md's leading YAML frontmatter.
 *  Tolerant: a repo skill need not match the daemon's stricter install rules. */
function parseManifest(text: string): { name?: string; description: string | null } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { description: null }
  let value: unknown
  try {
    value = parseYaml(match[1]!, { maxAliasCount: 0 })
  } catch {
    return { description: null }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { description: null }
  const manifest = value as Record<string, unknown>
  const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : undefined
  const description =
    typeof manifest.description === 'string' && manifest.description.trim()
      ? manifest.description.trim().slice(0, 1024)
      : null
  return { name, description }
}

/**
 * List every skill available in the agent's materialized workspace `cwd`, tagged
 * with its origin. `stateDir` is the daemon-owned skill-install state root used
 * to locate the ownership ledger. Returns [] when the workspace has no skills or
 * has not been materialized (no skill roots present).
 */
export async function listLocalSkills(cwd: string, stateDir: string): Promise<LocalSkillEntry[]> {
  const ownedOrigin = new Map<string, LocalSkillOrigin>()
  try {
    const location = await skillLedgerLocation(cwd, stateDir)
    const ledger = await readSkillLedger(location)
    if (ledger && 'owned' in ledger) {
      for (const bundle of ledger.owned) ownedOrigin.set(bundle.relativeRoot, originForSourceKey(bundle.sourceKey))
    }
  } catch {
    // No or unreadable ledger — treat everything found as repo-committed.
  }

  const entries: LocalSkillEntry[] = []
  for (const root of SKILL_ROOTS) {
    let dirents: import('node:fs').Dirent[]
    try {
      dirents = await fsp.readdir(join(cwd, root), { withFileTypes: true })
    } catch {
      continue // root absent (unmaterialized workspace or runtime doesn't use it)
    }
    for (const dirent of dirents) {
      if (entries.length >= MAX_SKILLS) return finalize(entries)
      if (!dirent.isDirectory() || dirent.isSymbolicLink()) continue
      const relPath = `${root}/${dirent.name}`
      const text = await readManifestHead(join(cwd, root, dirent.name, 'SKILL.md'))
      if (text === undefined) continue // no SKILL.md ⇒ not a skill directory
      const manifest = parseManifest(text)
      entries.push({
        name: manifest.name ?? dirent.name,
        description: manifest.description,
        origin: ownedOrigin.get(relPath) ?? 'repo',
        path: relPath
      })
    }
  }
  return finalize(entries)
}

function finalize(entries: LocalSkillEntry[]): LocalSkillEntry[] {
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return entries
}
