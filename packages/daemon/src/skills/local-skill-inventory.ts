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

import { promises as fsp, type Stats } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { readSkillLedger, skillLedgerLocation } from './skill-install-ledger.js'
import { readBoundedFile } from './skill-source-snapshot.js'
import type { WorkspaceFiles } from '../workspace/workspace-files.js'
import type { ClusterSkillLedger } from '../store/cluster-skill-ledger.js'

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
// Cap the entries INSPECTED (not just accepted): a hostile checkout can fill a
// skill root with decoy files/dirs that never yield a skill, so the loop must
// stop scanning even when it never reaches MAX_SKILLS.
const MAX_SCANNED_ENTRIES = 4096
/** Entries per page when the walk goes through the workspace seam; the protocol's own ceiling. */
const LIST_PAGE = 500

export function originForSourceKey(sourceKey: string): LocalSkillOrigin {
  if (sourceKey.startsWith('dream:')) return 'dream-accepted'
  if (sourceKey.startsWith('managed:')) return 'managed'
  return 'git-source'
}

/** True when `child` resolves to `root` itself or a path beneath it. */
function isWithin(root: string, child: string): boolean {
  return child === root || child.startsWith(root + sep)
}

/**
 * Read a skill directory's SKILL.md metadata head from an untrusted, possibly
 * racing workspace. Returns undefined when the directory is not a skill or is
 * unsafe to read. Defends against:
 *  - a symlinked skill dir escaping to another (same-UID) workspace — the dir is
 *    realpath-confined to `cwdReal`;
 *  - a symlinked / hard-linked / swapped SKILL.md — `readBoundedFile` opens
 *    O_NOFOLLOW and validates the file's identity before/opened/after the read;
 *  - a parent-directory swap between the containment check and the file open —
 *    the skill dir's inode is captured before and re-checked after, discarding
 *    the read if it changed.
 */
async function readSkillManifest(cwdReal: string, skillDir: string): Promise<string | undefined> {
  let dirBefore: Stats
  try {
    dirBefore = await fsp.lstat(skillDir)
    if (!dirBefore.isDirectory()) return undefined // symlinked/other entry
    if (!isWithin(cwdReal, await fsp.realpath(skillDir))) return undefined // escapes the workspace
    const manifestPath = join(skillDir, 'SKILL.md')
    const fileBefore = await fsp.lstat(manifestPath)
    const body = await readBoundedFile(manifestPath, fileBefore, MAX_MANIFEST_BYTES)
    const dirAfter = await fsp.lstat(skillDir)
    // Reject a directory swapped underneath us during the read.
    if (dirBefore.dev !== dirAfter.dev || dirBefore.ino !== dirAfter.ino) return undefined
    return body.toString('utf8')
  } catch {
    return undefined // missing SKILL.md, unsafe link, or a detected race
  }
}

/** Pull `name`/`description` (and the CLI's `metadata.internal` marker) out of
 *  a SKILL.md's leading YAML frontmatter. Tolerant: a repo skill need not match
 *  the daemon's stricter install rules. Also used by selection resolution
 *  (skill-cli-selection.ts), which needs the same fields the pinned skills CLI
 *  reads from a source's SKILL.md. */
export function parseSkillManifest(text: string): { name?: string; description: string | null; internal: boolean } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) return { description: null, internal: false }
  let value: unknown
  try {
    value = parseYaml(match[1]!, { maxAliasCount: 0 })
  } catch {
    return { description: null, internal: false }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { description: null, internal: false }
  const manifest = value as Record<string, unknown>
  const name = typeof manifest.name === 'string' && manifest.name.trim() ? manifest.name.trim() : undefined
  const description =
    typeof manifest.description === 'string' && manifest.description.trim()
      ? manifest.description.trim().slice(0, MAX_DESCRIPTION_CHARS)
      : null
  const metadata = manifest.metadata
  const internal =
    typeof metadata === 'object' &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).internal === true
  return { name, description, internal }
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

  const acc = skillAccumulator(ownedOrigin)
  for (const root of SKILL_ROOTS) {
    let dir
    try {
      // Stream the directory (opendir) rather than readdir: a root with a huge
      // number of entries must not be fully materialized before the caps apply.
      dir = await fsp.opendir(join(cwdReal, root))
    } catch {
      continue // root absent (unmaterialized workspace or runtime doesn't use it)
    }
    try {
      for await (const dirent of dir) {
        if (acc.exhausted()) return acc.done()
        acc.scanned()
        // A symlink entry has isDirectory()===false here (dirent reflects the
        // link, not its target), so this also drops symlinked skill dirs.
        if (!dirent.isDirectory()) continue
        const text = await readSkillManifest(cwdReal, join(cwdReal, root, dirent.name))
        if (text === undefined) continue // no readable SKILL.md / unsafe ⇒ not a skill
        if (acc.add(root, dirent.name, text) === 'full') return acc.done()
      }
    } finally {
      // for-await closes the handle on normal completion; close defensively in
      // case the loop threw before finishing.
      await dir.close().catch(() => undefined)
    }
  }
  return acc.done()
}

/**
 * The caps, the name dedup and the ordering — everything about the RESULT rather than about the
 * traversal. Shared because a sandbox workspace is walked differently (see
 * {@link listSandboxSkills}) and must still answer with a list bounded the same way; a second copy
 * of these rules is how one of the two ends up able to overflow the frame it rides.
 */
interface SkillAccumulator {
  /** Whether a further entry could still be accepted; the traversal stops asking when it cannot. */
  exhausted(): boolean
  /** Count one inspected entry, skill or not — a hostile checkout's decoys bound the scan too. */
  scanned(): void
  add(root: string, dirName: string, manifestText: string): 'added' | 'skipped' | 'full'
  done(): LocalSkillEntry[]
}

function skillAccumulator(ownedOrigin: Map<string, LocalSkillOrigin>): SkillAccumulator {
  const entries: LocalSkillEntry[] = []
  // A skill can exist under more than one root (e.g. installed into one and
  // mirrored/committed in another). The harness resolves a skill by name, so
  // surface each name once; a ledger-known origin wins over an incidental repo
  // copy of the same name.
  const byName = new Map<string, number>()
  let totalBytes = 0
  let scannedCount = 0
  return {
    exhausted: () => entries.length >= MAX_SKILLS || scannedCount >= MAX_SCANNED_ENTRIES,
    scanned: () => {
      scannedCount += 1
    },
    add(root, dirName, manifestText) {
      const manifest = parseSkillManifest(manifestText)
      const relPath = `${root}/${dirName}`
      const entry: LocalSkillEntry = {
        name: manifest.name ?? dirName,
        description: manifest.description,
        origin: ownedOrigin.get(relPath) ?? 'repo',
        path: relPath
      }
      const existing = byName.get(entry.name)
      if (existing !== undefined) {
        // Same name under a second root: keep one, preferring a ledger-known
        // origin over an incidental `repo` copy. Not a new entry, so the count
        // and byte budget are unaffected.
        if (entries[existing]!.origin === 'repo' && entry.origin !== 'repo') entries[existing] = entry
        return 'skipped'
      }
      // Keep the whole response under the control-frame limit; stop cleanly
      // rather than return an oversized payload the receiver would reject.
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1
      if (totalBytes + size > MAX_TOTAL_BYTES) return 'full'
      totalBytes += size
      byName.set(entry.name, entries.length)
      entries.push(entry)
      return 'added'
    },
    done() {
      entries.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      return entries
    }
  }
}

/**
 * The same inventory for a workspace on a sandbox pod's volume, walked through the workspace file
 * seam instead of this process's filesystem.
 *
 * A separate traversal rather than a shared one, and the reason is the hardening: the local scan
 * STREAMS its dirents so a checkout with a million entries in `.claude/skills` is never fully
 * materialized, and no channel can stream a directory — the seam answers in pages. What the seam
 * does give it, by construction, is every containment property the local walk hand-rolls
 * (realpath confinement, a final-component symlink refused, a bounded read), so the difference
 * stays traversal-shaped and does not reopen a safety question.
 *
 * Cluster origins come only from durable receipts that the shim verifies against the live tree.
 */
export async function listSandboxSkills(
  files: WorkspaceFiles,
  root: string,
  agentId: string,
  ledger?: ClusterSkillLedger,
  verifyRoots?: (roots: ClusterSkillLedger['roots']) => Promise<boolean[]>
): Promise<LocalSkillEntry[]> {
  const owned = new Map<string, LocalSkillOrigin>()
  const roots = ledger?.roots ?? []
  const verified = verifyRoots ? await verifyRoots(roots).catch(() => roots.map(() => false)) : roots.map(() => false)
  for (const [index, entry] of roots.entries()) {
    if (verified[index]) {
      owned.set(
        entry.path,
        entry.sourceKind === 'managed' ? 'managed' : entry.sourceKind === 'dream' ? 'dream-accepted' : 'git-source'
      )
    }
  }
  const acc = skillAccumulator(owned)
  for (const skillRoot of SKILL_ROOTS) {
    let cursor: string | undefined
    do {
      let page
      try {
        page = await files.list(root, { agentId, path: skillRoot, limit: LIST_PAGE, ...(cursor ? { cursor } : {}) })
      } catch {
        break // the root is absent, or unreadable in a way the seam refused — not a skill root
      }
      if (!page.exists) break
      for (const entry of page.entries) {
        if (acc.exhausted()) return acc.done()
        acc.scanned()
        // `dir` only: the seam reports a symlinked entry as `symlink`, so this drops the same
        // entries the local walk's `isDirectory()` does.
        if (entry.type !== 'dir') continue
        let manifest
        try {
          manifest = await files.read(root, {
            agentId,
            path: `${skillRoot}/${entry.name}/SKILL.md`,
            offset: 0,
            limit: MAX_MANIFEST_BYTES
          })
        } catch {
          continue // refused (a symlinked SKILL.md, a path that escaped) ⇒ not a skill
        }
        // No content means no readable manifest: absent, a directory, or binary.
        if (!manifest.exists || manifest.encoding !== 'utf8' || manifest.content === undefined) continue
        if (acc.add(skillRoot, entry.name, manifest.content) === 'full') return acc.done()
      }
      cursor = page.nextCursor
    } while (cursor !== undefined)
  }
  return acc.done()
}
