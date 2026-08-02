/**
 * Daemon-owned cache for centrally accepted immutable `.skill` ZIP revisions.
 *
 * The CP authorizes each read against the requesting agent. Archives are fetched
 * in bounded chunks, checked against the digest in AgentSpec, inspected before
 * inflation, and extracted into a private directory with ordinary files only.
 * A verified matching cache works while the CP is offline; a miss degrades to a
 * warning so session startup remains available without silently installing
 * unverified content.
 */
import { createHash, randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import { basename, dirname, join, posix } from 'node:path'
import { unzipSync, type UnzipFileInfo } from 'fflate'
import { parse as parseYaml } from 'yaml'
import type { ManagedSkillChunk, ManagedSkillEntry } from '@agentconnect.md/protocol'
import type { LocalSkillSource } from './install-skills.js'

const MAX_ARCHIVE_BYTES = 512 * 1024
const MAX_EXPANDED_BYTES = 4 * 1024 * 1024
const MAX_FILES = 64
const MAX_FILE_BYTES = 512 * 1024
const MAX_COMPRESSION_RATIO = 200
const MAX_PATH_BYTES = 256
const CHUNK_BYTES = 128 * 1024
const METADATA_FILE = 'metadata.json'
const ARCHIVE_FILE = 'bundle.skill'
const CONTENT_DIR = 'content'
const EOCD_SIGNATURE = 0x06054b50
const CENTRAL_SIGNATURE = 0x02014b50
const LOCAL_SIGNATURE = 0x04034b50
const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/

interface CachedMetadata {
  version: 1
  id: string
  revision: number
  name: string
  digest: string
  size: number
}

interface CentralEntry {
  name: string
  compressedSize: number
  originalSize: number
  compression: number
  directory: boolean
}

interface LocalRange {
  start: number
  end: number
}

export interface ManagedSkillCacheDeps {
  read: (req: {
    requesterAgentId: string
    managedSkillId: string
    revision: number
    offset: number
    limit: number
  }) => Promise<ManagedSkillChunk>
  warn?: (message: string) => void
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function canonicalBase64(value: string): Buffer {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('managed skill chunk is not canonical base64')
  }
  const decoded = Buffer.from(value, 'base64')
  if (decoded.toString('base64') !== value) throw new Error('managed skill chunk is not canonical base64')
  return decoded
}

function decodeUtf8(bytes: Uint8Array): string {
  const text = Buffer.from(bytes).toString('utf8')
  if (text.includes('\uFFFD')) throw new Error('managed skill archive contains a non-UTF-8 path')
  return text
}

function validateArchivePath(raw: string, expectedRoot: string): { relative: string; directory: boolean } {
  const directory = raw.endsWith('/')
  const path = directory ? raw.slice(0, -1) : raw
  if (
    path.length === 0 ||
    Buffer.byteLength(path, 'utf8') > MAX_PATH_BYTES + expectedRoot.length + 1 ||
    path.normalize('NFC') !== path ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    posix.normalize(path) !== path
  ) {
    throw new Error('managed skill archive contains an unsafe path')
  }
  const parts = path.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.length > 128)) {
    throw new Error('managed skill archive contains an unsafe path')
  }
  if (parts[0] !== expectedRoot || parts.length < 2) {
    throw new Error('managed skill archive must contain exactly one expected root directory')
  }
  const relative = parts.slice(1).join('/')
  if (Buffer.byteLength(relative, 'utf8') > MAX_PATH_BYTES) {
    throw new Error('managed skill archive path exceeds its size cap')
  }
  return { relative, directory }
}

function validateSkillManifest(bytes: Uint8Array, expectedName: string): void {
  const text = Buffer.from(bytes).toString('utf8')
  if (text.includes('\uFFFD')) throw new Error('managed skill SKILL.md must be valid UTF-8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new Error('managed skill SKILL.md must begin with YAML frontmatter')
  let value: unknown
  try {
    value = parseYaml(match[1]!, { maxAliasCount: 0 })
  } catch {
    throw new Error('managed skill SKILL.md frontmatter is invalid YAML')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('managed skill SKILL.md frontmatter must be a mapping')
  }
  const manifest = value as Record<string, unknown>
  if (typeof manifest.name !== 'string' || !SKILL_NAME_RE.test(manifest.name) || manifest.name !== expectedName) {
    throw new Error('managed skill SKILL.md name does not match its enabled bundle')
  }
  if (typeof manifest.description !== 'string' || !manifest.description.trim() || manifest.description.length > 1024) {
    throw new Error('managed skill SKILL.md description is invalid')
  }
}

/** Inspect central + local headers before inflation. In particular, a Unix
 * symlink entry is rejected instead of being interpreted, even though the
 * extractor below only ever writes ordinary files. */
function inspectZip(archive: Uint8Array, expectedRoot: string): Map<string, CentralEntry> {
  const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const searchStart = Math.max(0, view.length - 65_557)
  let eocd = -1
  for (let offset = view.length - 22; offset >= searchStart; offset -= 1) {
    if (view.readUInt32LE(offset) === EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0 || eocd + 22 > view.length) throw new Error('managed skill archive has no valid ZIP directory')
  const disk = view.readUInt16LE(eocd + 4)
  const centralDisk = view.readUInt16LE(eocd + 6)
  const entriesOnDisk = view.readUInt16LE(eocd + 8)
  const entryCount = view.readUInt16LE(eocd + 10)
  const centralSize = view.readUInt32LE(eocd + 12)
  const centralOffset = view.readUInt32LE(eocd + 16)
  const commentLength = view.readUInt16LE(eocd + 20)
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    entryCount > MAX_FILES ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff ||
    eocd + 22 + commentLength !== view.length ||
    centralOffset + centralSize !== eocd
  ) {
    throw new Error('managed skill archive uses an unsupported ZIP layout')
  }

  const entries = new Map<string, CentralEntry>()
  const paths = new Map<string, boolean>()
  let files = 0
  let expanded = 0
  let compressed = 0
  const localRanges: LocalRange[] = []
  let cursor = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || view.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error('managed skill archive has a malformed central directory')
    }
    const versionMadeBy = view.readUInt16LE(cursor + 4)
    const flags = view.readUInt16LE(cursor + 8)
    const compression = view.readUInt16LE(cursor + 10)
    const crc = view.readUInt32LE(cursor + 16)
    const compressedSize = view.readUInt32LE(cursor + 20)
    const originalSize = view.readUInt32LE(cursor + 24)
    const nameLength = view.readUInt16LE(cursor + 28)
    const extraLength = view.readUInt16LE(cursor + 30)
    const entryCommentLength = view.readUInt16LE(cursor + 32)
    const startDisk = view.readUInt16LE(cursor + 34)
    const externalAttrs = view.readUInt32LE(cursor + 38)
    const localOffset = view.readUInt32LE(cursor + 42)
    const end = cursor + 46 + nameLength + extraLength + entryCommentLength
    if (end > eocd || startDisk !== 0 || flags & 0x9 || ![0, 8].includes(compression)) {
      throw new Error('managed skill archive contains an unsupported entry')
    }
    const name = decodeUtf8(view.subarray(cursor + 46, cursor + 46 + nameLength))
    const validated = validateArchivePath(name, expectedRoot)
    const unixMode = versionMadeBy >>> 8 === 3 ? externalAttrs >>> 16 : 0
    const unixType = unixMode & 0o170000
    if (unixType === 0o120000 || (unixType !== 0 && unixType !== 0o100000 && unixType !== 0o040000)) {
      throw new Error('managed skill archive contains a symbolic link or special entry')
    }
    if ((validated.directory && unixType === 0o100000) || (!validated.directory && unixType === 0o040000)) {
      throw new Error('managed skill archive entry type does not match its path')
    }
    const key = validated.relative.toLocaleLowerCase('en-US')
    if (paths.has(key)) throw new Error('managed skill archive contains colliding paths')
    for (const [existing, existingDirectory] of paths) {
      if (
        (!existingDirectory && key.startsWith(`${existing}/`)) ||
        (!validated.directory && existing.startsWith(`${key}/`))
      ) {
        throw new Error('managed skill archive contains a file/directory path collision')
      }
    }
    paths.set(key, validated.directory)

    if (localOffset + 30 > centralOffset || view.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error('managed skill archive has a malformed local entry')
    }
    const localFlags = view.readUInt16LE(localOffset + 6)
    const localCompression = view.readUInt16LE(localOffset + 8)
    const localCrc = view.readUInt32LE(localOffset + 14)
    const localCompressedSize = view.readUInt32LE(localOffset + 18)
    const localOriginalSize = view.readUInt32LE(localOffset + 22)
    const localNameLength = view.readUInt16LE(localOffset + 26)
    const localExtraLength = view.readUInt16LE(localOffset + 28)
    const localNameEnd = localOffset + 30 + localNameLength
    const dataStart = localNameEnd + localExtraLength
    const dataEnd = dataStart + compressedSize
    if (
      dataEnd > centralOffset ||
      localFlags !== flags ||
      localCompression !== compression ||
      localCrc !== crc ||
      localCompressedSize !== compressedSize ||
      localOriginalSize !== originalSize ||
      decodeUtf8(view.subarray(localOffset + 30, localNameEnd)) !== name
    ) {
      throw new Error('managed skill archive local entry disagrees with its central directory')
    }
    localRanges.push({ start: localOffset, end: dataEnd })

    if (!validated.directory) {
      files += 1
      expanded += originalSize
      compressed += compressedSize
      if (originalSize > MAX_FILE_BYTES) {
        throw new Error('managed skill archive contains a file over its size cap')
      }
      if (files > MAX_FILES || expanded > MAX_EXPANDED_BYTES) {
        throw new Error('managed skill archive exceeds its expanded size cap')
      }
    }
    entries.set(name, { name, compressedSize, originalSize, compression, directory: validated.directory })
    cursor = end
  }
  if (cursor !== eocd || !entries.has(`${expectedRoot}/SKILL.md`)) {
    throw new Error('managed skill archive is missing its root SKILL.md')
  }
  localRanges.sort((a, b) => a.start - b.start)
  for (let index = 1; index < localRanges.length; index += 1) {
    if (localRanges[index]!.start < localRanges[index - 1]!.end) {
      throw new Error('managed skill archive contains overlapping local entries')
    }
  }
  if (expanded > 64 * 1024 && expanded > compressed * MAX_COMPRESSION_RATIO) {
    throw new Error('managed skill archive has a suspicious compression ratio')
  }
  return entries
}

function extractZip(archive: Uint8Array, expectedRoot: string): Map<string, Uint8Array> {
  const inspected = inspectZip(archive, expectedRoot)
  const extracted = unzipSync(archive, {
    filter: (info: UnzipFileInfo) => {
      const entry = inspected.get(info.name)
      if (
        !entry ||
        entry.compressedSize !== info.size ||
        entry.originalSize !== info.originalSize ||
        entry.compression !== info.compression
      ) {
        throw new Error('managed skill archive metadata changed during extraction')
      }
      return !entry.directory
    }
  })
  const out = new Map<string, Uint8Array>()
  for (const [name, bytes] of Object.entries(extracted)) {
    const { relative, directory } = validateArchivePath(name, expectedRoot)
    if (directory) continue
    const expected = inspected.get(name)
    if (!expected || bytes.byteLength !== expected.originalSize) {
      throw new Error('managed skill archive expanded to an unexpected size')
    }
    out.set(relative, bytes)
  }
  const skillMd = out.get('SKILL.md')
  if (!skillMd || out.size > MAX_FILES) throw new Error('managed skill archive is incomplete')
  // The CP validates this before acceptance, and the daemon repeats it at its
  // own trust boundary before an immutable bundle can steer a runtime.
  validateSkillManifest(skillMd, expectedRoot)
  return out
}

async function readSmallJson(path: string): Promise<unknown> {
  const stat = await fsp.lstat(path)
  if (!stat.isFile() || stat.size > 4096) throw new Error('managed skill cache metadata is invalid')
  return JSON.parse(await fsp.readFile(path, 'utf8'))
}

function metadataMatches(value: unknown, binding: ManagedSkillEntry, archiveSize?: number): value is CachedMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Partial<CachedMetadata>
  return (
    row.version === 1 &&
    row.id === binding.id &&
    row.revision === binding.revision &&
    row.name === binding.name &&
    row.digest === binding.digest &&
    typeof row.size === 'number' &&
    row.size >= 0 &&
    row.size <= MAX_ARCHIVE_BYTES &&
    (archiveSize === undefined || row.size === archiveSize)
  )
}

export class ManagedSkillCache {
  private readonly inFlight = new Map<string, Promise<string>>()

  constructor(
    private readonly root: string,
    private readonly deps: ManagedSkillCacheDeps
  ) {}

  async resolve(agent: { id: string; managedSkills: ManagedSkillEntry[] }): Promise<LocalSkillSource[]> {
    const resolved: LocalSkillSource[] = []
    for (const binding of agent.managedSkills) {
      try {
        resolved.push({
          kind: 'managed',
          key: `managed:${binding.id}:${binding.revision}:${binding.digest}`,
          name: binding.name,
          sourceDir: await this.ensure(agent.id, binding),
          contentDigest: binding.digest
        })
      } catch (err) {
        this.deps.warn?.(
          `skills: managed skill "${binding.name}" revision ${binding.revision} unavailable; skipping (${err instanceof Error ? err.message : 'unknown error'})`
        )
      }
    }
    return resolved
  }

  private cacheDir(binding: ManagedSkillEntry): string {
    const digest = binding.digest.slice('sha256:'.length)
    return join(this.root, binding.id, `${binding.revision}-${digest}`)
  }

  private ensure(agentId: string, binding: ManagedSkillEntry): Promise<string> {
    const dir = this.cacheDir(binding)
    const existing = this.inFlight.get(dir)
    if (existing) return existing
    const pending = this.ensureOnce(agentId, binding, dir).finally(() => this.inFlight.delete(dir))
    this.inFlight.set(dir, pending)
    return pending
  }

  private async ensureOnce(agentId: string, binding: ManagedSkillEntry, dir: string): Promise<string> {
    const cached = await this.cachedArchive(binding, dir)
    // Re-publish every verified cache hit. The archive digest is authoritative;
    // the extracted tree sits on disk and may have been modified after a prior
    // resolve, so merely checking that SKILL.md still exists would preserve a
    // tampered script indefinitely while offline.
    if (cached) return this.publish(binding, dir, cached)

    const archive = await this.download(agentId, binding)
    return this.publish(binding, dir, archive)
  }

  private async cachedArchive(binding: ManagedSkillEntry, dir: string): Promise<Uint8Array | null> {
    try {
      const archivePath = join(dir, ARCHIVE_FILE)
      const archiveStat = await fsp.lstat(archivePath)
      if (!archiveStat.isFile() || archiveStat.isSymbolicLink() || archiveStat.size > MAX_ARCHIVE_BYTES) return null
      const metadata = await readSmallJson(join(dir, METADATA_FILE))
      if (!metadataMatches(metadata, binding, archiveStat.size)) return null
      const archive = await fsp.readFile(archivePath)
      if (sha256(archive) !== binding.digest) return null
      inspectZip(archive, binding.name)
      return archive
    } catch {
      return null
    }
  }

  private async download(agentId: string, binding: ManagedSkillEntry): Promise<Uint8Array> {
    const chunks: Buffer[] = []
    let offset = 0
    let size: number | undefined
    while (size === undefined || offset < size) {
      const chunk = await this.deps.read({
        requesterAgentId: agentId,
        managedSkillId: binding.id,
        revision: binding.revision,
        offset,
        limit: CHUNK_BYTES
      })
      if (
        chunk.managedSkillId !== binding.id ||
        chunk.revision !== binding.revision ||
        chunk.digest !== binding.digest ||
        chunk.offset !== offset ||
        chunk.size > MAX_ARCHIVE_BYTES ||
        (size !== undefined && chunk.size !== size)
      ) {
        throw new Error('control plane returned mismatched managed skill metadata')
      }
      size ??= chunk.size
      const bytes = canonicalBase64(chunk.data)
      if (
        bytes.byteLength > CHUNK_BYTES ||
        chunk.nextOffset !== offset + bytes.byteLength ||
        chunk.nextOffset > size ||
        chunk.truncated !== chunk.nextOffset < size ||
        (offset < size && bytes.byteLength === 0)
      ) {
        throw new Error('control plane returned an invalid managed skill chunk')
      }
      chunks.push(bytes)
      offset = chunk.nextOffset
    }
    const archive = Buffer.concat(chunks)
    if (archive.byteLength !== size || sha256(archive) !== binding.digest) {
      throw new Error('managed skill archive digest verification failed')
    }
    inspectZip(archive, binding.name)
    return archive
  }

  private async publish(binding: ManagedSkillEntry, dir: string, archive: Uint8Array): Promise<string> {
    if (archive.byteLength > MAX_ARCHIVE_BYTES || sha256(archive) !== binding.digest) {
      throw new Error('managed skill archive digest verification failed')
    }
    const files = extractZip(archive, binding.name)
    const parent = dirname(dir)
    await fsp.mkdir(parent, { recursive: true, mode: 0o700 })
    await fsp.chmod(this.root, 0o700).catch(() => undefined)
    const temp = join(parent, `.${basename(dir)}.${randomUUID()}`)
    const old = join(parent, `.${basename(dir)}.old.${randomUUID()}`)
    try {
      await fsp.mkdir(join(temp, CONTENT_DIR, binding.name), { recursive: true, mode: 0o700 })
      await fsp.writeFile(join(temp, ARCHIVE_FILE), archive, { mode: 0o600 })
      for (const [relative, bytes] of files) {
        const target = join(temp, CONTENT_DIR, binding.name, ...relative.split('/'))
        await fsp.mkdir(dirname(target), { recursive: true, mode: 0o700 })
        await fsp.writeFile(target, bytes, { mode: relative.startsWith('scripts/') ? 0o700 : 0o600 })
      }
      const metadata: CachedMetadata = {
        version: 1,
        id: binding.id,
        revision: binding.revision,
        name: binding.name,
        digest: binding.digest,
        size: archive.byteLength
      }
      await fsp.writeFile(join(temp, METADATA_FILE), `${JSON.stringify(metadata)}\n`, { mode: 0o600 })
      let movedOld = false
      try {
        await fsp.rename(dir, old)
        movedOld = true
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
      try {
        await fsp.rename(temp, dir)
      } catch (err) {
        if (movedOld) await fsp.rename(old, dir).catch(() => undefined)
        throw err
      }
      if (movedOld) await fsp.rm(old, { recursive: true, force: true }).catch(() => undefined)
      return join(dir, CONTENT_DIR, binding.name)
    } finally {
      await fsp.rm(temp, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
