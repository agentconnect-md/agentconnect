/**
 * Canonical-selection resolution for the pinned skills CLI (#371).
 *
 * The audited CLI matches `-s` selections against each discovered skill's
 * SKILL.md frontmatter `name` (compared case-insensitively, otherwise
 * verbatim), yet installs the matched bundle under a sanitized leaf directory
 * derived from that name. AgentConnect wire selections are restricted to
 * canonical leaf names, and the console offers skill directory names — so a
 * source whose frontmatter name is not already canonical (`name: Grill Me`
 * inside `skills/grill-me/`) could never be selected: passing the canonical
 * name through verbatim makes the CLI answer "No matching skills found".
 *
 * Resolve every canonical selection against the daemon's private source
 * snapshot to the frontmatter name the CLI will actually match, and return the
 * exact leaf set that invocation must produce so the installer keeps its
 * exact-output receipt check.
 */
import { promises as fsp } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parseSkillManifest } from './local-skill-inventory.js'

// Frontmatter lives at the head of SKILL.md; reading more cannot change the
// parsed name and only inflates work on an oversized manifest.
const MAX_MANIFEST_HEAD_BYTES = 64 * 1024
const MAX_LISTED_AVAILABLE = 32

/** The leaf directory skills@1.5.21 installs a matched skill into — an exact
 * mirror of its `sanitizeName`. Revalidate against the pinned CLI source when
 * bumping PINNED_SKILLS_CLI_VERSION. */
export function skillInstallLeaf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._]+/g, '-')
      .replace(/^[.\-]+|[.\-]+$/g, '')
      .substring(0, 255) || 'unnamed-skill'
  )
}

/** Selections reach the CLI as `-s <value>` argv entries (execFile, never a
 * shell) and are compared case-insensitively to frontmatter names. Refuse
 * anything option-shaped or outside printable ASCII rather than quoting. */
export function isSafeCliSelection(value: string): boolean {
  return value.length > 0 && value.length <= 255 && !value.startsWith('-') && /^[\x20-\x7e]+$/.test(value)
}

export interface SnapshotFileRef {
  /** `/`-separated path relative to the snapshot root. */
  path: string
}

export interface ResolvedSkillSelections {
  /** Frontmatter names to pass as `-s`, ordered like the input selections. */
  cliSelections: string[]
  /** The exact CLI-derived leaf directory names those selections must
   * produce, ordered like the input selections. */
  expectedLeaves: string[]
}

interface SelectionCandidate {
  name: string
  leaf: string
  directoryLeaf?: string
}

/**
 * Map wire-canonical selections onto the snapshot's skills. A selection
 * matches a skill when it equals the skill's install leaf (the sanitized
 * frontmatter name) or the sanitized name of the directory holding SKILL.md
 * (what the console's source scan offers). Throws when a selection matches
 * nothing, matches more than one distinct skill name, collides with another
 * selection, or resolves to a name that cannot ride the CLI argv safely.
 */
export async function resolveSkillSelections(
  sourceName: string,
  snapshotDir: string,
  files: readonly SnapshotFileRef[],
  selections: readonly string[]
): Promise<ResolvedSkillSelections> {
  if (selections.length === 0) return { cliSelections: [], expectedLeaves: [] }

  const candidates: SelectionCandidate[] = []
  for (const file of files) {
    if (file.path !== 'SKILL.md' && !file.path.endsWith('/SKILL.md')) continue
    const head = await readHead(join(snapshotDir, ...file.path.split('/')), MAX_MANIFEST_HEAD_BYTES)
    const name = parseSkillManifest(head).name
    if (!name) continue // the CLI refuses to install a nameless skill
    const directory = dirname(file.path)
    candidates.push({
      name,
      leaf: skillInstallLeaf(name),
      ...(directory === '.' ? {} : { directoryLeaf: skillInstallLeaf(basename(directory)) })
    })
  }

  const cliSelections: string[] = []
  const expectedLeaves: string[] = []
  const selectionByName = new Map<string, string>()
  for (const selection of selections) {
    const matched = candidates.filter(
      (candidate) => candidate.leaf === selection || candidate.directoryLeaf === selection
    )
    const names = [...new Set(matched.map((candidate) => candidate.name))]
    if (names.length === 0) {
      const available = [...new Set(candidates.map((candidate) => candidate.leaf))].sort()
      throw new Error(
        `skill "${selection}" was not found in source "${sourceName}"` +
          (available.length > 0 ? ` (available: ${available.slice(0, MAX_LISTED_AVAILABLE).join(', ')})` : '')
      )
    }
    if (names.length > 1) {
      throw new Error(`skill selection "${selection}" matches more than one skill in source "${sourceName}"`)
    }
    const name = names[0]!
    const previous = selectionByName.get(name)
    if (previous !== undefined) {
      throw new Error(
        `skill selections "${previous}" and "${selection}" resolve to the same skill in source "${sourceName}"`
      )
    }
    if (!isSafeCliSelection(name)) {
      throw new Error(`skill "${selection}" in source "${sourceName}" has a name the skills CLI cannot select safely`)
    }
    selectionByName.set(name, selection)
    cliSelections.push(name)
    expectedLeaves.push(matched[0]!.leaf)
  }
  return { cliSelections, expectedLeaves }
}

/** Bounded head read of a daemon-private snapshot file (the snapshot is fresh,
 * 0o700, and symlink-free by construction, so no adversarial-race hardening). */
async function readHead(path: string, maxBytes: number): Promise<string> {
  const handle = await fsp.open(path, 'r')
  try {
    const body = Buffer.alloc(maxBytes)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    return body.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}
