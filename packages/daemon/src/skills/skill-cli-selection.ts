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
 * snapshot to the frontmatter name the CLI will actually match, then expand
 * the set with same-source skills the selected bodies invoke by slash
 * reference (skill collections publish thin alias skills whose whole body is
 * e.g. "Run a `/grilling` session." — installing the alias without its target
 * yields a broken skill). Return the exact leaf set that invocation must
 * produce so the installer keeps its exact-output receipt check.
 *
 * The candidate universe mirrors skills@1.5.21 discovery exactly — manifest
 * validity (name AND description, not `metadata.internal`), the root-manifest
 * early return, the known container/harness/plugin search paths with their
 * one-grandchild deepening, the committed skills-lock.json exclusion, and the
 * recursive fallback that runs only when the normal pass finds nothing. A
 * wider universe would let manifests the CLI ignores poison the ambiguity
 * checks or the dependency closure. Revalidate this mirror against the pinned
 * CLI source when bumping PINNED_SKILLS_CLI_VERSION.
 */
import { promises as fsp } from 'node:fs'
import { basename, join, posix } from 'node:path'
import { parseSkillManifest } from './local-skill-inventory.js'

// Aligned with Git snapshot per-file admission (GIT_SKILL_SOURCE_SNAPSHOT_LIMITS
// .maxFileBytes) so every SKILL.md the snapshot admitted — and the CLI's own
// full-file parser will read — is parsed in full here too.
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_LOCK_BYTES = 1024 * 1024
const MAX_LISTED_AVAILABLE = 32
// Matches the wire-level cap on explicit selections per source.
const MAX_RESOLVED_SELECTIONS = 64
// A dependency reference is a slash-invocation token at a word boundary, e.g.
// "Run a `/grilling` session." Only tokens naming another skill in the SAME
// source count; anything else (URL paths, /tmp, ...) is plain text.
const SLASH_REFERENCE = /(?:^|[\s`'"(])\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})/g
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/

// skills@1.5.21 discovery constants, verbatim.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__'])
const FALLBACK_MAX_DEPTH = 5
const SKILL_CONTAINER_DIRS = ['skills', 'skills/.curated', 'skills/.experimental', 'skills/.system']
const AGENT_PROJECT_SKILL_DIRS = [
  '.agents/skills',
  '.claude/skills',
  '.cline/skills',
  '.codebuddy/skills',
  '.codex/skills',
  '.commandcode/skills',
  '.continue/skills',
  '.github/skills',
  '.goose/skills',
  '.grok/skills',
  '.iflow/skills',
  '.junie/skills',
  '.kilocode/skills',
  '.kimchi/skills',
  '.kiro/skills',
  '.mux/skills',
  '.neovate/skills',
  '.opencode/skills',
  '.openhands/skills',
  '.pi/skills',
  '.qoder/skills',
  '.roo/skills',
  '.trae/skills',
  '.windsurf/skills',
  '.zcode/skills',
  '.zencoder/skills'
]

/** The leaf directory skills@1.5.21 installs a matched skill into — an exact
 * mirror of its `sanitizeName`. */
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
  size: number
}

export interface ResolvedSkillSelections {
  /** Frontmatter names to pass as `-s`: the explicit selections first (input
   * order), then any slash-referenced same-source dependencies. */
  cliSelections: string[]
  /** The exact CLI-derived leaf directory names those selections must
   * produce, ordered like `cliSelections`. */
  expectedLeaves: string[]
}

interface SelectionCandidate {
  /** Snapshot-relative SKILL.md path — the candidate's identity. */
  path: string
  name: string
  leaf: string
  directoryLeaf?: string
  /** Prompt body (frontmatter stripped) for slash references. */
  body: string
}

interface SnapshotTree {
  /** Directories holding a SKILL.md, '' for the snapshot root. */
  skillDirs: Set<string>
  /** Immediate child directory names per directory ('' for the root). */
  childDirs: Map<string, Set<string>>
  fileSizes: Map<string, number>
}

/**
 * Map wire-canonical selections onto the skills the pinned CLI can discover
 * in the snapshot. A selection matches a skill when it equals the skill's
 * install leaf (the sanitized frontmatter name) or the sanitized name of the
 * directory holding SKILL.md (what the console's source scan offers); the
 * matched set is then closed over same-source slash references. Throws when a
 * selection matches nothing, a selection or reference matches more than one
 * distinct skill name, two selections collide, a resolved name cannot ride
 * the CLI argv safely, or the resolved frontmatter name does not uniquely
 * (case-insensitively) identify one discoverable skill — the CLI selects by
 * that name alone, so a shared name could install a sibling skill while
 * still producing the expected leaf.
 */
export async function resolveSkillSelections(
  sourceName: string,
  snapshotDir: string,
  files: readonly SnapshotFileRef[],
  selections: readonly string[]
): Promise<ResolvedSkillSelections> {
  if (selections.length === 0) return { cliSelections: [], expectedLeaves: [] }

  const candidates = await discoverCliCandidates(snapshotDir, files)
  const byKey = new Map<string, SelectionCandidate[]>()
  const byLowerName = new Map<string, SelectionCandidate[]>()
  for (const candidate of candidates) {
    for (const key of new Set([candidate.leaf, candidate.directoryLeaf])) {
      if (key === undefined) continue
      const list = byKey.get(key)
      if (list) list.push(candidate)
      else byKey.set(key, [candidate])
    }
    const lower = candidate.name.toLowerCase()
    const list = byLowerName.get(lower)
    if (list) list.push(candidate)
    else byLowerName.set(lower, [candidate])
  }

  const cliSelections: string[] = []
  const expectedLeaves: string[] = []
  const selectionByName = new Map<string, string>()
  const pendingBodies: SelectionCandidate[] = []
  const admit = (candidate: SelectionCandidate, label: string): void => {
    if (selectionByName.size >= MAX_RESOLVED_SELECTIONS) {
      throw new Error(`source "${sourceName}" resolves to too many skills after dependency expansion`)
    }
    if (!isSafeCliSelection(candidate.name)) {
      throw new Error(`skill ${label} in source "${sourceName}" has a name the skills CLI cannot select safely`)
    }
    // The emitted `-s` value must uniquely identify this candidate: the CLI
    // matches frontmatter names case-insensitively and de-duplicates exact
    // names by discovery order, so a shared name can silently install a
    // SIBLING skill while producing the expected leaf. Fail closed instead.
    const sharingName = (byLowerName.get(candidate.name.toLowerCase()) ?? []).filter(
      (other) => other.path !== candidate.path
    )
    if (sharingName.length > 0) {
      throw new Error(
        `skill ${label} in source "${sourceName}" resolves to CLI name "${candidate.name}", ` +
          `which does not uniquely identify one skill (also declared by ${sharingName[0]!.path})`
      )
    }
    selectionByName.set(candidate.name, label)
    cliSelections.push(candidate.name)
    expectedLeaves.push(candidate.leaf)
    pendingBodies.push(candidate)
  }

  for (const selection of selections) {
    const matched = byKey.get(selection) ?? []
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
    const previous = selectionByName.get(names[0]!)
    if (previous !== undefined) {
      throw new Error(
        `skill selections ${previous} and "${selection}" resolve to the same skill in source "${sourceName}"`
      )
    }
    admit(matched[0]!, `"${selection}"`)
  }

  // Close the selection over same-source slash references, e.g. grill-me's
  // whole body being "Run a `/grilling` session." (#371). A token matching
  // nothing in this source is plain text and ignored; a token matching more
  // than one skill stays fail-closed like an explicit selection would.
  while (pendingBodies.length > 0) {
    const referrer = pendingBodies.shift()!
    const seenTokens = new Set<string>()
    for (const match of referrer.body.matchAll(SLASH_REFERENCE)) {
      const token = match[1]!.toLowerCase()
      if (seenTokens.has(token)) continue
      seenTokens.add(token)
      const matched = byKey.get(token) ?? []
      const names = [...new Set(matched.map((candidate) => candidate.name))]
      if (names.length === 0) continue // plain text, not a same-source skill
      if (names.some((name) => selectionByName.has(name))) continue // already satisfied
      if (names.length > 1) {
        throw new Error(
          `skill "${referrer.name}" reference "/${token}" matches more than one skill in source "${sourceName}"`
        )
      }
      admit(matched[0]!, `"/${token}" (referenced by "${referrer.name}")`)
    }
  }

  return { cliSelections, expectedLeaves }
}

/** Enumerate the skills skills@1.5.21 `add` would discover in the snapshot,
 * mirroring its `discoverSkills`: a valid root manifest wins alone; otherwise
 * the known container/harness/plugin paths are searched one grandchild deep;
 * the recursive fallback (depth ≤ 5, SKIP_DIRS-pruned) runs only when that
 * finds nothing. Candidates keep per-directory identity — the CLI's
 * first-wins name de-duplication is deliberately NOT applied, so duplicate
 * names surface as a fail-closed admission error instead of installing
 * whichever sibling the CLI happened to discover first. */
async function discoverCliCandidates(
  snapshotDir: string,
  files: readonly SnapshotFileRef[]
): Promise<SelectionCandidate[]> {
  const tree = buildSnapshotTree(files)
  const lockedNames = await readCommittedLockNames(snapshotDir, tree)
  const cache = new Map<string, SelectionCandidate | null>()
  const candidateAt = async (dir: string): Promise<SelectionCandidate | null> => {
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    const path = dir === '' ? 'SKILL.md' : `${dir}/SKILL.md`
    const text = await readBounded(
      join(snapshotDir, ...path.split('/')),
      Math.min(tree.fileSizes.get(path) ?? 0, MAX_MANIFEST_BYTES)
    )
    const manifest = parseSkillManifest(text)
    let candidate: SelectionCandidate | null = null
    // The CLI requires BOTH name and description and skips internal skills;
    // an incomplete manifest is invisible to it and must stay invisible here.
    if (manifest.name && manifest.description !== null && !manifest.internal) {
      candidate = {
        path,
        name: manifest.name,
        leaf: skillInstallLeaf(manifest.name),
        ...(dir === '' ? {} : { directoryLeaf: skillInstallLeaf(basename(dir)) }),
        body: text.replace(FRONTMATTER, '')
      }
      if (isCommittedLockedInstall(dir, candidate.name, lockedNames)) candidate = null
    }
    cache.set(dir, candidate)
    return candidate
  }

  // 1. A valid root manifest is the whole source (the CLI returns early).
  if (tree.skillDirs.has('')) {
    const root = await candidateAt('')
    if (root) return [root]
  }

  // 2. Priority paths: root children (shallow), then containers one
  //    grandchild deep. A child that HAS a SKILL.md — valid or not — is never
  //    deepened further, exactly like the CLI's tryAddSkillAt short-circuit.
  const found = new Map<string, SelectionCandidate>()
  const tryAdd = async (dir: string): Promise<boolean> => {
    if (!tree.skillDirs.has(dir)) return false
    const candidate = await candidateAt(dir)
    if (candidate && !found.has(dir)) found.set(dir, candidate)
    return true
  }
  // Plugin containers are pushed after the CLI builds its deep-container set,
  // so they are searched one level only — mirror that.
  const priority: Array<{ container: string; deep: boolean }> = [
    { container: '', deep: false },
    ...SKILL_CONTAINER_DIRS.map((container) => ({ container, deep: true })),
    ...AGENT_PROJECT_SKILL_DIRS.map((container) => ({ container, deep: true })),
    ...(await readPluginSkillDirs(snapshotDir, tree)).map((container) => ({ container, deep: false }))
  ]
  for (const { container, deep } of priority) {
    for (const child of tree.childDirs.get(container) ?? []) {
      const childDir = container === '' ? child : `${container}/${child}`
      if ((await tryAdd(childDir)) || !deep) continue
      if (SKIP_DIRS.has(child)) continue
      for (const grand of tree.childDirs.get(childDir) ?? []) {
        if (SKIP_DIRS.has(grand)) continue
        await tryAdd(`${childDir}/${grand}`)
      }
    }
  }
  if (found.size > 0) return [...found.values()]

  // 3. Recursive fallback, only when the normal pass found nothing.
  for (const dir of [...tree.skillDirs].sort()) {
    if (dir === '') continue // parsed (and rejected) in step 1
    const segments = dir.split('/')
    if (segments.length > FALLBACK_MAX_DEPTH || segments.some((segment) => SKIP_DIRS.has(segment))) continue
    const candidate = await candidateAt(dir)
    if (candidate) found.set(dir, candidate)
  }
  return [...found.values()]
}

function buildSnapshotTree(files: readonly SnapshotFileRef[]): SnapshotTree {
  const tree: SnapshotTree = { skillDirs: new Set(), childDirs: new Map(), fileSizes: new Map() }
  for (const file of files) {
    tree.fileSizes.set(file.path, file.size)
    const parts = file.path.split('/')
    if (parts.at(-1) === 'SKILL.md') tree.skillDirs.add(parts.slice(0, -1).join('/'))
    for (let index = 0; index < parts.length - 1; index++) {
      const parent = parts.slice(0, index).join('/')
      let children = tree.childDirs.get(parent)
      if (!children) {
        children = new Set()
        tree.childDirs.set(parent, children)
      }
      children.add(parts[index]!)
    }
  }
  return tree
}

/** Names from a committed root skills-lock.json — the CLI treats matching
 * skills under harness directories as already-installed and skips them. */
async function readCommittedLockNames(snapshotDir: string, tree: SnapshotTree): Promise<Set<string>> {
  const size = tree.fileSizes.get('skills-lock.json')
  if (size === undefined || size > MAX_LOCK_BYTES) return new Set()
  try {
    const parsed = JSON.parse(await readBounded(join(snapshotDir, 'skills-lock.json'), size)) as {
      skills?: unknown
    }
    if (!parsed.skills || typeof parsed.skills !== 'object' || Array.isArray(parsed.skills)) return new Set()
    return new Set(Object.keys(parsed.skills).map(normalizeCliSkillName))
  } catch {
    return new Set()
  }
}

/** Mirror of the CLI's normalizeSkillName used for lockfile comparisons. */
function normalizeCliSkillName(name: string): string {
  return name.toLowerCase().replace(/[\s_]+/g, '-')
}

function isCommittedLockedInstall(dir: string, name: string, lockedNames: Set<string>): boolean {
  if (lockedNames.size === 0) return false
  if (!AGENT_PROJECT_SKILL_DIRS.some((prefix) => dir === prefix || dir.startsWith(`${prefix}/`))) return false
  return lockedNames.has(normalizeCliSkillName(name)) || lockedNames.has(normalizeCliSkillName(basename(dir)))
}

/** Additional search containers declared by committed `.claude-plugin`
 * manifests, mirroring the CLI's getPluginSkillPaths (including its
 * `./`-prefixed relative-path requirement and containment checks). */
async function readPluginSkillDirs(snapshotDir: string, tree: SnapshotTree): Promise<string[]> {
  const dirs: string[] = []
  const contained = (path: string): string | undefined => {
    const normalized = posix.normalize(path)
    if (normalized.startsWith('..') || posix.isAbsolute(normalized)) return undefined
    return normalized === '.' ? '' : normalized
  }
  const addPluginSkillDirs = (pluginBase: string, skills: unknown): void => {
    const base = contained(pluginBase)
    if (base === undefined) return
    if (Array.isArray(skills)) {
      for (const skillPath of skills) {
        if (typeof skillPath !== 'string' || !skillPath.startsWith('./')) continue
        const skillDir = contained(posix.dirname(posix.join(base, skillPath)))
        if (skillDir !== undefined) dirs.push(skillDir)
      }
    }
    dirs.push(base === '' ? 'skills' : `${base}/skills`)
  }
  const readManifest = async (path: string): Promise<unknown> => {
    const size = tree.fileSizes.get(path)
    if (size === undefined || size > MAX_LOCK_BYTES) return undefined
    try {
      return JSON.parse(await readBounded(join(snapshotDir, ...path.split('/')), size))
    } catch {
      return undefined
    }
  }
  const marketplace = (await readManifest('.claude-plugin/marketplace.json')) as
    { metadata?: { pluginRoot?: unknown }; plugins?: unknown } | undefined
  if (marketplace) {
    const pluginRoot = marketplace.metadata?.pluginRoot
    if (pluginRoot === undefined || (typeof pluginRoot === 'string' && pluginRoot.startsWith('./'))) {
      for (const plugin of Array.isArray(marketplace.plugins) ? marketplace.plugins : []) {
        if (!plugin || typeof plugin !== 'object') continue
        const { source, skills } = plugin as { source?: unknown; skills?: unknown }
        if (source !== undefined && (typeof source !== 'string' || !source.startsWith('./'))) continue
        addPluginSkillDirs(posix.join((pluginRoot as string | undefined) ?? '.', (source as string) ?? '.'), skills)
      }
    }
  }
  const pluginManifest = (await readManifest('.claude-plugin/plugin.json')) as { skills?: unknown } | undefined
  if (pluginManifest) addPluginSkillDirs('.', pluginManifest.skills)
  return dirs
}

/** Bounded read of a daemon-private snapshot file (the snapshot is fresh,
 * 0o700, and symlink-free by construction, so no adversarial-race hardening). */
async function readBounded(path: string, maxBytes: number): Promise<string> {
  if (maxBytes <= 0) return ''
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
