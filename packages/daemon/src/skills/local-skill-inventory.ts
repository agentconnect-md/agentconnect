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
//
// The workspace tree is repository-controlled and untrusted, so the scan is
// hardened against a hostile checkout: every candidate directory is confined to
// the workspace via realpath (a symlink pointing at another same-UID workspace
// is dropped), SKILL.md is opened O_NOFOLLOW, the directory is streamed so a
// pathological entry count cannot be fully materialized, and the result is
// bounded well under the control-frame size limit.

import { constants, promises as fsp } from 'node:fs'
import { join, resolve, sep } from 'node:path'
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
// Bounds on an untrusted workspace: cap how much SKILL.md is read for the
// manifest, how long a surfaced description is, how many skills are returned,
// and the total serialized payload — the response rides a control frame whose
// receiver rejects anything over 256 KiB, so stay comfortably under it.
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_DESCRIPTION_CHARS = 256
const MAX_SKILLS = 256
const MAX_TOTAL_BYTES = 200 * 1024

export function originForSourceKey(sourceKey: string): LocalSkillOrigin {
  if (sourceKey.startsWith('dream:')) return 'dream-accepted'
  if (sourceKey.startsWith('managed:')) return 'managed'
  return 'git-source'
}

/** True when `child` resolves to `root` itself or a path beneath it. */
function isWithin(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep)
}

/** Read at most `MAX_MANIFEST_BYTES` of a SKILL.md WITHOUT following a final
 *  symlink (O_NOFOLLOW): a repo-controlled `SKILL.md → /etc/...` link must not
 *  be read. Undefined when it cannot be read (missing/symlink ⇒ not a skill). */
async function readManifestHead(file: string): Promise<string | undefined> {
  let handle
  try {
    handle = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
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
      ? manifest.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
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
  let cwdReal: string
  try {
    cwdReal = await fsp.realpath(resolve(cwd))
  } catch {
    return [] // workspace path gone / unreadable
  }

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
  let totalBytes = 0
  for (const root of SKILL_ROOTS) {
    let dir
    try {
      // Stream the directory (opendir) rather than readdir: a root with a huge
      // number of entries must not be fully materialized before the cap applies.
      dir = await fsp.opendir(join(cwdReal, root))
    } catch {
      continue // root absent (unmaterialized workspace or runtime doesn't use it)
    }
    try {
      for await (const dirent of dir) {
        if (entries.length >= MAX_SKILLS) return finalize(entries)
        // A symlink entry has isDirectory()===false here (dirent reflects the
        // link, not its target), so this also drops symlinked skill dirs.
        if (!dirent.isDirectory()) continue
        const skillDir = join(cwdReal, root, dirent.name)
        // Confine to the workspace: a symlinked root/dir escaping to another
        // (same-UID) workspace resolves outside cwd and is dropped.
        let real: string
        try {
          real = await fsp.realpath(skillDir)
        } catch {
          continue
        }
        if (!isWithin(cwdReal, real)) continue
        const text = await readManifestHead(join(skillDir, 'SKILL.md'))
        if (text === undefined) continue // no readable SKILL.md ⇒ not a skill directory
        const manifest = parseManifest(text)
        const relPath = `${root}/${dirent.name}`
        const entry: LocalSkillEntry = {
          name: manifest.name ?? dirent.name,
          description: manifest.description,
          origin: ownedOrigin.get(relPath) ?? 'repo',
          path: relPath
        }
        // Keep the whole response under the control-frame limit; stop cleanly
        // rather than return an oversized payload the receiver would reject.
        const size = Buffer.byteLength(JSON.stringify(entry)) + 1
        if (totalBytes + size > MAX_TOTAL_BYTES) return finalize(entries)
        totalBytes += size
        entries.push(entry)
      }
    } finally {
      // for-await closes the handle on normal completion; close defensively in
      // case the loop threw before finishing.
      await dir.close().catch(() => undefined)
    }
  }
  return finalize(entries)
}

function finalize(entries: LocalSkillEntry[]): LocalSkillEntry[] {
  entries.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
  return entries
}
