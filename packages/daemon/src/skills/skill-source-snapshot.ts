import { createHash } from 'node:crypto'
import { constants, promises as fsp, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'

export interface SkillSourceSnapshotLimits {
  maxFiles: number
  maxTotalBytes: number
  maxFileBytes: number
  /** Includes files and directories, but not the source root itself. */
  maxEntries: number
  maxDepth: number
  maxPathBytes: number
}

export const DEFAULT_SKILL_SOURCE_SNAPSHOT_LIMITS: Readonly<SkillSourceSnapshotLimits> = {
  maxFiles: 64,
  maxTotalBytes: 4 * 1024 * 1024,
  maxFileBytes: 512 * 1024,
  maxEntries: 256,
  maxDepth: 32,
  maxPathBytes: 1024
}

/** A Git source is a whole collection repo — skills plus docs, tests and tooling — not one bundle. */
export const GIT_SKILL_SOURCE_SNAPSHOT_LIMITS: Readonly<SkillSourceSnapshotLimits> = {
  maxFiles: 16_384,
  maxTotalBytes: 1024 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxEntries: 65_536,
  maxDepth: 64,
  maxPathBytes: 1024
}

export interface SkillSourceSnapshotOptions {
  limits?: Partial<SkillSourceSnapshotLimits>
}

export interface SkillSourceSnapshotFile {
  /** NFC-normalized path relative to the snapshot root, always `/` separated. */
  path: string
  size: number
  /** Source permissions normalized to either 0644 or 0755. */
  mode: number
  sha256: string
}

export interface SkillSourceSnapshot {
  /** Canonically path-sorted file manifest. */
  files: SkillSourceSnapshotFile[]
  fileCount: number
  totalBytes: number
  /** Digest of the canonical manifest; independent of source root and mtimes. */
  sha256: string
}

export class SkillSourceSnapshotError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillSourceSnapshotError'
  }
}

interface CapturedFile {
  manifest: SkillSourceSnapshotFile
  /** Absent when the caller only wants descriptors — see {@link inspectLocalSkillSource}. */
  body?: Buffer
}

interface CapturedTree {
  directories: string[]
  files: CapturedFile[]
  totalBytes: number
}

interface SeenPath {
  path: string
  type: 'directory' | 'file'
}

const utf8 = new TextDecoder('utf-8', { fatal: true })
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

function isErrno(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === code
}

function pathCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function mergeLimits(overrides: Partial<SkillSourceSnapshotLimits> = {}): SkillSourceSnapshotLimits {
  const limits = { ...DEFAULT_SKILL_SOURCE_SNAPSHOT_LIMITS, ...overrides }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new SkillSourceSnapshotError(`${name} must be a positive integer`)
    }
  }
  return limits
}

function normalizedComponent(name: string): string {
  const normalized = name.normalize('NFC')
  if (
    normalized.length === 0 ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.includes('/') ||
    normalized.includes('\\') ||
    CONTROL_RE.test(normalized)
  ) {
    throw new SkillSourceSnapshotError('skill source contains an unsafe path component')
  }
  return normalized
}

/**
 * A conservative cross-platform collision key. NFKC catches compatibility
 * spellings that can collapse on another filesystem; lower-casing plus the two
 * multi-character/special folds covers the cases JavaScript's Unicode lowercase
 * operation does not represent directly.
 */
function collisionComponent(name: string): string {
  const folded = name.normalize('NFKC').toLowerCase().replaceAll('\u00df', 'ss').replaceAll('\u03c2', '\u03c3')
  if (folded === '.' || folded === '..' || folded.includes('/') || folded.includes('\\')) {
    throw new SkillSourceSnapshotError('skill source path becomes unsafe after Unicode normalization')
  }
  return folded
}

function portablePath(parts: string[]): string {
  return parts.join('/')
}

function identityMatches(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino
}

function metadataMatches(left: Stats, right: Stats): boolean {
  return (
    identityMatches(left, right) &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function assertRegularUnlinkedFile(stat: Stats, label: string): void {
  if (!stat.isFile()) throw new SkillSourceSnapshotError(`${label} is a link or special file`)
  // Some filesystems cannot report a useful link count, but every reliable
  // nlink > 1 result means the source aliases mutable storage outside this tree.
  if (Number.isFinite(stat.nlink) && stat.nlink > 1) {
    throw new SkillSourceSnapshotError(`${label} is hard-linked`)
  }
}

function assertExpectedRealPath(actual: string, expected: string): void {
  if (resolve(actual) !== resolve(expected)) {
    throw new SkillSourceSnapshotError('skill source path resolves through a link')
  }
}

function isAtOrBelow(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

function registerPath(seen: Map<string, SeenPath>, key: string, entry: SeenPath): void {
  const prior = seen.get(key)
  if (prior) {
    throw new SkillSourceSnapshotError(
      `skill source has a case-folded or Unicode-normalized path collision: ${prior.path} and ${entry.path}`
    )
  }

  const parts = key.split('/')
  for (let index = 1; index < parts.length; index += 1) {
    const ancestor = seen.get(parts.slice(0, index).join('/'))
    if (ancestor?.type === 'file') {
      throw new SkillSourceSnapshotError(
        `skill source has a normalized file/ancestor collision: ${ancestor.path} and ${entry.path}`
      )
    }
  }
  if (entry.type === 'file') {
    for (const [seenKey, descendant] of seen) {
      if (seenKey.startsWith(`${key}/`)) {
        throw new SkillSourceSnapshotError(
          `skill source has a normalized file/ancestor collision: ${entry.path} and ${descendant.path}`
        )
      }
    }
  }
  seen.set(key, entry)
}

export async function readBoundedFile(path: string, before: Stats, maxBytes: number): Promise<Buffer> {
  assertRegularUnlinkedFile(before, 'skill source entry')
  if (before.size > maxBytes) throw new SkillSourceSnapshotError('skill source contains an oversized file')

  let handle
  try {
    handle = await fsp.open(path, READ_FLAGS)
  } catch (error) {
    throw new SkillSourceSnapshotError(
      `skill source file could not be opened without following links: ${error instanceof Error ? error.message : ''}`
    )
  }

  try {
    const opened = await handle.stat()
    assertRegularUnlinkedFile(opened, 'skill source entry')
    if (!identityMatches(before, opened)) throw new SkillSourceSnapshotError('skill source changed during snapshot')
    if (opened.size > maxBytes) throw new SkillSourceSnapshotError('skill source contains an oversized file')

    const body = Buffer.alloc(opened.size)
    let offset = 0
    while (offset < body.length) {
      const { bytesRead } = await handle.read(body, offset, body.length - offset, offset)
      if (bytesRead === 0) throw new SkillSourceSnapshotError('skill source changed during snapshot')
      offset += bytesRead
    }
    const probe = Buffer.alloc(1)
    if ((await handle.read(probe, 0, 1, offset)).bytesRead !== 0) {
      throw new SkillSourceSnapshotError('skill source changed during snapshot')
    }

    const after = await handle.stat()
    assertRegularUnlinkedFile(after, 'skill source entry')
    if (!metadataMatches(opened, after) || after.size !== body.length) {
      throw new SkillSourceSnapshotError('skill source changed during snapshot')
    }
    return body
  } finally {
    await handle.close()
  }
}

async function readDirectoryNames(path: string): Promise<string[]> {
  let encoded: Buffer[]
  try {
    encoded = await fsp.readdir(path, { encoding: 'buffer' })
  } catch (error) {
    throw new SkillSourceSnapshotError(
      `skill source directory could not be read: ${error instanceof Error ? error.message : ''}`
    )
  }
  return encoded
    .map((name) => {
      try {
        return utf8.decode(name)
      } catch {
        throw new SkillSourceSnapshotError('skill source contains a non-UTF-8 path')
      }
    })
    .sort((left, right) => pathCompare(left.normalize('NFC'), right.normalize('NFC')) || pathCompare(left, right))
}

async function captureSource(
  sourceDir: string,
  limits: SkillSourceSnapshotLimits,
  retainBodies = true
): Promise<CapturedTree> {
  const source = resolve(sourceDir)
  let rootBefore: Stats
  try {
    rootBefore = await fsp.lstat(source)
  } catch (error) {
    throw new SkillSourceSnapshotError(
      `skill source root could not be read: ${error instanceof Error ? error.message : ''}`
    )
  }
  if (!rootBefore.isDirectory()) {
    throw new SkillSourceSnapshotError('skill source root is a symlink or non-directory')
  }

  const sourceReal = await fsp.realpath(source)
  const seen = new Map<string, SeenPath>()
  const directories: string[] = []
  const files: CapturedFile[] = []
  let entryCount = 0
  let totalBytes = 0
  let hasSkillManifest = false

  const walk = async (absoluteDir: string, rawParts: string[], outputParts: string[], depth: number): Promise<void> => {
    if (depth > limits.maxDepth) throw new SkillSourceSnapshotError('skill source exceeds its depth limit')
    const directoryBefore = await fsp.lstat(absoluteDir)
    if (!directoryBefore.isDirectory()) {
      throw new SkillSourceSnapshotError('skill source contains a symlink or special entry')
    }
    assertExpectedRealPath(await fsp.realpath(absoluteDir), join(sourceReal, ...rawParts))

    for (const rawName of await readDirectoryNames(absoluteDir)) {
      entryCount += 1
      if (entryCount > limits.maxEntries) throw new SkillSourceSnapshotError('skill source has too many entries')

      const outputName = normalizedComponent(rawName)
      const nextRawParts = [...rawParts, rawName]
      const nextOutputParts = [...outputParts, outputName]
      const outputPath = portablePath(nextOutputParts)
      if (Buffer.byteLength(outputPath, 'utf8') > limits.maxPathBytes) {
        throw new SkillSourceSnapshotError('skill source contains an oversized path')
      }

      const absolute = join(absoluteDir, rawName)
      const stat = await fsp.lstat(absolute)
      if (!stat.isDirectory() && !stat.isFile()) {
        throw new SkillSourceSnapshotError(`skill source entry ${outputPath} is a link or special file`)
      }
      assertExpectedRealPath(await fsp.realpath(absolute), join(sourceReal, ...nextRawParts))
      const key = portablePath(nextRawParts.map(collisionComponent))

      if (stat.isDirectory()) {
        registerPath(seen, key, { path: outputPath, type: 'directory' })
        directories.push(outputPath)
        await walk(absolute, nextRawParts, nextOutputParts, depth + 1)
        continue
      }
      assertRegularUnlinkedFile(stat, `skill source entry ${outputPath}`)
      registerPath(seen, key, { path: outputPath, type: 'file' })
      if (files.length >= limits.maxFiles) throw new SkillSourceSnapshotError('skill source has too many files')

      const body = await readBoundedFile(absolute, stat, limits.maxFileBytes)
      totalBytes += body.length
      if (totalBytes > limits.maxTotalBytes) throw new SkillSourceSnapshotError('skill source exceeds its byte limit')
      if (outputName === 'SKILL.md') hasSkillManifest = true

      files.push({
        ...(retainBodies ? { body } : {}),
        manifest: {
          path: outputPath,
          size: body.length,
          mode: stat.mode & 0o111 ? 0o755 : 0o644,
          sha256: `sha256:${createHash('sha256').update(body).digest('hex')}`
        }
      })
    }

    const directoryAfter = await fsp.lstat(absoluteDir)
    if (
      !directoryAfter.isDirectory() ||
      !identityMatches(directoryBefore, directoryAfter) ||
      directoryBefore.mtimeMs !== directoryAfter.mtimeMs ||
      directoryBefore.ctimeMs !== directoryAfter.ctimeMs
    ) {
      throw new SkillSourceSnapshotError('skill source changed during snapshot')
    }
  }

  await walk(source, [], [], 0)
  const rootAfter = await fsp.lstat(source)
  if (!rootAfter.isDirectory() || !identityMatches(rootBefore, rootAfter)) {
    throw new SkillSourceSnapshotError('skill source changed during snapshot')
  }
  if (!hasSkillManifest) throw new SkillSourceSnapshotError('skill source contains no SKILL.md')

  directories.sort((left, right) => left.split('/').length - right.split('/').length || pathCompare(left, right))
  files.sort((left, right) => pathCompare(left.manifest.path, right.manifest.path))
  return { directories, files, totalBytes }
}

async function privateFreshDestination(destinationDir: string, sourceReal: string): Promise<string> {
  const destination = resolve(destinationDir)
  const parent = dirname(destination)
  let parentStat: Stats
  try {
    parentStat = await fsp.lstat(parent)
  } catch (error) {
    throw new SkillSourceSnapshotError(
      `snapshot destination parent could not be read: ${error instanceof Error ? error.message : ''}`
    )
  }
  if (!parentStat.isDirectory()) {
    throw new SkillSourceSnapshotError('snapshot destination parent is a symlink or non-directory')
  }
  if (process.platform !== 'win32' && (parentStat.mode & 0o777) !== 0o700) {
    throw new SkillSourceSnapshotError('snapshot destination parent must have mode 0700')
  }
  if (typeof process.geteuid === 'function' && parentStat.uid !== process.geteuid()) {
    throw new SkillSourceSnapshotError('snapshot destination parent is not owned by the daemon user')
  }

  const realParent = await fsp.realpath(parent)
  const target = join(realParent, basename(destination))
  if (isAtOrBelow(sourceReal, target)) {
    throw new SkillSourceSnapshotError('snapshot destination must not be inside the skill source')
  }
  try {
    await fsp.lstat(target)
    throw new SkillSourceSnapshotError('snapshot destination must be fresh')
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error
  }
  return target
}

function canonicalManifestDigest(files: SkillSourceSnapshotFile[]): string {
  const canonical = JSON.stringify(files)
  return `sha256:${createHash('sha256').update('agentconnect-skill-source-snapshot-v1\0').update(canonical).digest('hex')}`
}

/** Inspect an existing bundle with the same descriptor/no-follow walker used
 * for snapshot creation, without writing a second copy. This is used for live
 * receipt verification, where pathname-based recursive readFile would be both
 * unbounded and vulnerable to file/symlink replacement races. */
export async function inspectLocalSkillSource(
  sourceDir: string,
  options: SkillSourceSnapshotOptions = {}
): Promise<SkillSourceSnapshot> {
  const tree = await captureSource(resolve(sourceDir), mergeLimits(options.limits), false)
  const files = tree.files.map(({ manifest }) => ({ ...manifest }))
  return {
    files,
    fileCount: files.length,
    totalBytes: tree.totalBytes,
    sha256: canonicalManifestDigest(files)
  }
}

async function writeCapturedTree(tree: CapturedTree, destination: string): Promise<void> {
  let created = false
  try {
    await fsp.mkdir(destination, { mode: 0o700 })
    created = true
    await fsp.chmod(destination, 0o700)

    for (const directory of tree.directories) {
      const path = join(destination, ...directory.split('/'))
      await fsp.mkdir(path, { mode: 0o700 })
      await fsp.chmod(path, 0o700)
    }
    for (const file of tree.files) {
      const path = join(destination, ...file.manifest.path.split('/'))
      const handle = await fsp.open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        file.manifest.mode
      )
      try {
        if (!file.body) throw new SkillSourceSnapshotError('skill source snapshot captured no body to write')
        await handle.writeFile(file.body)
        await handle.chmod(file.manifest.mode)
        await handle.sync()
      } finally {
        await handle.close()
      }
    }
    if (process.platform !== 'win32') {
      for (const directory of [...tree.directories].sort((a, b) => b.length - a.length)) {
        const handle = await fsp.open(join(destination, ...directory.split('/')), constants.O_RDONLY)
        try {
          await handle.sync()
        } finally {
          await handle.close()
        }
      }
      const root = await fsp.open(destination, constants.O_RDONLY)
      try {
        await root.sync()
      } finally {
        await root.close()
      }
    }
  } catch (error) {
    if (created) {
      try {
        await fsp.rm(destination, { recursive: true, force: true })
      } catch (rollbackError) {
        throw new SkillSourceSnapshotError(
          `skill source snapshot failed and rollback also failed: ${
            rollbackError instanceof Error ? rollbackError.message : ''
          }`
        )
      }
    }
    if (error instanceof SkillSourceSnapshotError) throw error
    throw new SkillSourceSnapshotError(
      `skill source snapshot could not be written: ${error instanceof Error ? error.message : ''}`
    )
  }
}

/**
 * Copy an untrusted local skill collection into a private daemon-owned staging
 * directory. The complete source is captured and validated before destination
 * creation, so a validation failure cannot leave a partial snapshot behind.
 */
export async function snapshotLocalSkillSource(
  sourceDir: string,
  destinationDir: string,
  options: SkillSourceSnapshotOptions = {}
): Promise<SkillSourceSnapshot> {
  const limits = mergeLimits(options.limits)
  const source = resolve(sourceDir)
  const tree = await captureSource(source, limits)
  const sourceReal = await fsp.realpath(source)
  const destination = await privateFreshDestination(destinationDir, sourceReal)
  await writeCapturedTree(tree, destination)

  const files = tree.files.map(({ manifest }) => ({ ...manifest }))
  return {
    files,
    fileCount: files.length,
    totalBytes: tree.totalBytes,
    sha256: canonicalManifestDigest(files)
  }
}
