/** Accepted Dream skills are immutable, digest-addressed local sources. The
 * atomically replaced index chooses the active revision for each name; workspace
 * publication still goes through the unified pinned skills CLI. */
import { randomUUID } from 'node:crypto'
import { constants, promises as fsp, type Stats } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { LocalSkillSource } from './install-skills.js'
import { inspectLocalSkillSource, snapshotLocalSkillSource } from './skill-source-snapshot.js'

export const ACCEPTED_SKILLS_DIRNAME = 'skills'
const BUNDLES_DIRNAME = '.bundles'
const INDEX_NAME = 'accepted-skills.json'
const INDEX_VERSION = 1
const MAX_ACCEPTED_SKILLS = 64
const MAX_INDEX_BYTES = 64 * 1024
const SKILL_DIR_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const DIGEST_RE = /^sha256:[a-f0-9]{64}$/

interface AcceptedSkillRecord {
  name: string
  directory: string
  digest: string
}

interface AcceptedSkillIndex {
  version: 1
  skills: AcceptedSkillRecord[]
}

function under(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

async function ensureAcceptedRoots(agentDir: string): Promise<{ root: string; bundles: string }> {
  const lexical = resolve(agentDir)
  const before = await fsp.lstat(lexical)
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('accepted skill agent root is unsafe')
  const agentRoot = await fsp.realpath(lexical)
  if (typeof process.geteuid === 'function' && before.uid !== process.geteuid()) {
    throw new Error('accepted skill agent root has another owner')
  }

  const root = join(agentRoot, ACCEPTED_SKILLS_DIRNAME)
  await mkdirPrivate(root)
  const bundles = join(root, BUNDLES_DIRNAME)
  await mkdirPrivate(bundles)
  const after = await fsp.lstat(lexical)
  if (!sameIdentity(before, after) || (await fsp.realpath(lexical)) !== agentRoot) {
    throw new Error('accepted skill agent root changed during preparation')
  }
  return { root, bundles }
}

async function mkdirPrivate(path: string): Promise<void> {
  try {
    await fsp.mkdir(path, { mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  const stat = await fsp.lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('accepted skill registry path is unsafe')
  if (typeof process.geteuid === 'function' && stat.uid !== process.geteuid()) {
    throw new Error('accepted skill registry path has another owner')
  }
  await fsp.chmod(path, 0o700)
}

async function readIndex(root: string): Promise<AcceptedSkillIndex | null> {
  const path = join(root, INDEX_NAME)
  try {
    const before = await fsp.lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_INDEX_BYTES) {
      throw new Error('accepted skill index is not a bounded regular file')
    }
    const handle = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || !sameIdentity(before, opened) || opened.size > MAX_INDEX_BYTES) {
        throw new Error('accepted skill index changed while opening')
      }
      const body = Buffer.alloc(opened.size)
      if ((await handle.read(body, 0, body.length, 0)).bytesRead !== body.length) {
        throw new Error('accepted skill index changed while reading')
      }
      return parseIndex(JSON.parse(body.toString('utf8')) as unknown)
    } finally {
      await handle.close()
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

function parseIndex(value: unknown): AcceptedSkillIndex {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('accepted skill index is invalid')
  const row = value as { version?: unknown; skills?: unknown }
  if (row.version !== INDEX_VERSION || !Array.isArray(row.skills) || row.skills.length > MAX_ACCEPTED_SKILLS) {
    throw new Error('accepted skill index is invalid')
  }
  const names = new Set<string>()
  const directories = new Set<string>()
  const skills = row.skills.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('accepted skill index is invalid')
    const record = entry as AcceptedSkillRecord
    const direct = record.directory === record.name
    const immutable = record.directory === `${BUNDLES_DIRNAME}/${record.name}-${record.digest?.replace('sha256:', '')}`
    if (
      !SKILL_DIR_RE.test(record.name) ||
      !DIGEST_RE.test(record.digest) ||
      (!direct && !immutable) ||
      names.has(record.name) ||
      directories.has(record.directory)
    ) {
      throw new Error('accepted skill index is invalid')
    }
    names.add(record.name)
    directories.add(record.directory)
    return record
  })
  return { version: INDEX_VERSION, skills: skills.sort((a, b) => a.name.localeCompare(b.name)) }
}

async function activeRecords(root: string): Promise<AcceptedSkillRecord[]> {
  // Index absence is empty authority, never permission to scan/adopt sibling
  // directories. An unsandboxed historical ACP child can write the agent tree;
  // auto-enrolling legacy-shaped directories would bypass owner review whenever
  // it deleted this index. Legacy direct directories must be explicitly
  // re-accepted so immutable digest authority is created.
  return (await readIndex(root))?.skills ?? []
}

async function writeIndex(root: string, records: AcceptedSkillRecord[]): Promise<void> {
  const index = parseIndex({ version: INDEX_VERSION, skills: records })
  const body = `${JSON.stringify(index)}\n`
  if (Buffer.byteLength(body) > MAX_INDEX_BYTES) throw new Error('accepted skill index exceeds its size limit')
  const temp = join(root, `.${INDEX_NAME}.${randomUUID()}.tmp`)
  const handle = await fsp.open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  try {
    await handle.writeFile(body)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await fsp.rename(temp, join(root, INDEX_NAME))
  await syncDirectory(root)
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return // no POSIX directory-fsync primitive; the handle open fails with EPERM
  const handle = await fsp.open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

/** Register validated staged bytes as a new immutable accepted-source revision,
 * then atomically publish only the small index. */
export async function publishAcceptedDreamSkill(input: {
  agentDir: string
  sourceDir: string
  name: string
  /** Same-bytes review fence (task #36 Phase B): when set, the digest of the
   *  captured publication snapshot must equal this reviewed digest, else publish
   *  refuses. Checked against the SNAPSHOT (not a separate preflight inspection)
   *  so a concurrent writer cannot swap staged bytes between review and capture —
   *  the digest verified is the digest actually pinned and activated. */
  expectedDigest?: string
}): Promise<{ sourceDir: string; digest: string }> {
  if (!SKILL_DIR_RE.test(input.name)) throw new Error('invalid accepted Dream skill name')
  const { root, bundles } = await ensureAcceptedRoots(input.agentDir)
  const records = await activeRecords(root)
  if (!records.some((entry) => entry.name === input.name) && records.length >= MAX_ACCEPTED_SKILLS) {
    throw new Error('too many accepted Dream skills')
  }
  // Reclaim a bounded set of crash leftovers before admitting another bundle;
  // a corrupt/unbounded registry fails closed for explicit operator cleanup.
  await pruneUnreferencedBundles(root, records)
  const temporary = join(bundles, `.new-${randomUUID()}`)
  const snapshot = await snapshotLocalSkillSource(input.sourceDir, temporary)
  if (input.expectedDigest !== undefined && snapshot.sha256 !== input.expectedDigest) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw new Error('the staged skill changed since it was reviewed; re-review the current skill before accepting')
  }
  const hex = snapshot.sha256.replace('sha256:', '')
  const directory = `${BUNDLES_DIRNAME}/${input.name}-${hex}`
  const target = join(root, ...directory.split('/'))
  let created = false
  try {
    await fsp.rename(temporary, target)
    created = true
    await syncDirectory(bundles)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    // Linux commonly reports ENOTEMPTY, Darwin EEXIST, and Windows EPERM when an identical
    // digest-addressed directory was already published. EPERM is broad on Windows, so it is only
    // read as a collision there — and the digest re-read below is what actually proves it was one.
    const collision = code === 'EEXIST' || code === 'ENOTEMPTY' || (code === 'EPERM' && process.platform === 'win32')
    if (!collision) {
      await fsp.rm(temporary, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    await fsp.rm(temporary, { recursive: true, force: true })
    const existing = await inspectLocalSkillSource(target)
    if (existing.sha256 !== snapshot.sha256) throw new Error('accepted skill digest path contains different bytes')
  }

  const next = records.filter((entry) => entry.name !== input.name)
  next.push({ name: input.name, directory, digest: snapshot.sha256 })
  try {
    await writeIndex(root, next)
  } catch (error) {
    // If rename of the index itself succeeded but its directory fsync failed,
    // the new index may already reference this bundle. Delete only when a
    // bounded strict re-read proves it remains unreferenced.
    if (created) {
      const referenced = await activeRecords(root)
        .then((active) => active.some((entry) => entry.directory === directory))
        .catch(() => true)
      if (!referenced) {
        await fsp.rm(target, { recursive: true, force: true }).catch(() => undefined)
        await syncDirectory(bundles).catch(() => undefined)
      }
    }
    throw error
  }
  await pruneUnreferencedBundles(root, next).catch(() => undefined)
  return { sourceDir: target, digest: snapshot.sha256 }
}

async function pruneUnreferencedBundles(root: string, records: AcceptedSkillRecord[]): Promise<void> {
  const bundles = join(root, BUNDLES_DIRNAME)
  const keep = new Set(
    records.map((record) => record.directory).filter((path) => path.startsWith(`${BUNDLES_DIRNAME}/`))
  )
  let entries = 0
  const directory = await fsp.opendir(bundles)
  for await (const entry of directory) {
    entries += 1
    if (entries > 512) throw new Error('accepted skill bundle registry has too many entries')
    const relativePath = `${BUNDLES_DIRNAME}/${entry.name}`
    if (keep.has(relativePath) || !entry.isDirectory() || entry.isSymbolicLink()) continue
    if (!/^[a-z0-9][a-z0-9-]{0,62}-[a-f0-9]{64}$/.test(entry.name)) continue
    const target = join(bundles, entry.name)
    if (!under(bundles, await fsp.realpath(target))) continue
    await fsp.rm(target, { recursive: true, force: true })
  }
  await syncDirectory(bundles)
}

/** Names accepted for display. Corrupt daemon-private state is treated as no
 * inventory here; session preparation uses the strict source reader below. */
export async function acceptedDreamSkillNames(agent: { dir: string }): Promise<string[]> {
  try {
    const { root } = await ensureAcceptedRoots(agent.dir)
    return (await activeRecords(root)).map((entry) => entry.name)
  } catch {
    return []
  }
}

export async function acceptedDreamSkillSources(agent: { dir: string }): Promise<LocalSkillSource[]> {
  const { root } = await ensureAcceptedRoots(agent.dir)
  const sources: LocalSkillSource[] = []
  for (const entry of await activeRecords(root)) {
    const sourceDir = join(root, ...entry.directory.split('/'))
    const inspected = await inspectLocalSkillSource(sourceDir)
    if (inspected.sha256 !== entry.digest) {
      throw new Error(`accepted Dream skill "${entry.name}" does not match its published digest`)
    }
    sources.push({
      kind: 'dream',
      key: `dream:${entry.name}:${entry.digest}`,
      name: entry.name,
      sourceDir,
      contentDigest: inspected.sha256,
      expectedTreeDigest: inspected.sha256
    })
  }
  return sources
}
