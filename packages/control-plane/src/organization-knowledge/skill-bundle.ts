import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import { strToU8, zipSync, type Zippable } from 'fflate'
import { parse as parseYaml } from 'yaml'
import type { SkillBundleTextFile } from '@agentconnect.md/protocol'

export const MAX_MANAGED_SKILL_FILES = 64
export const MAX_MANAGED_SKILL_EXPANDED_BYTES = 4 * 1024 * 1024
export const MAX_MANAGED_SKILL_ARCHIVE_BYTES = 512 * 1024
export const MAX_MANAGED_SKILL_FILE_BYTES = 512 * 1024
export const MAX_MANAGED_SKILL_COMPRESSION_RATIO = 200

const SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
const ZIP_MTIME = new Date('1980-01-01T00:00:00.000Z')
const ZIP_EOCD_SIGNATURE = 0x06054b50
const ZIP_CENTRAL_SIGNATURE = 0x02014b50

export class SkillBundleValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillBundleValidationError'
  }
}

export interface PackagedSkillBundle {
  archive: Uint8Array<ArrayBuffer>
  digest: string
  compressedBytes: number
  expandedBytes: number
  fileCount: number
  description: string
  manifest: {
    name: string
    description: string
    files: { path: string; bytes: number; digest: string }[]
  }
}

function digest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function validatePath(raw: string): string {
  const path = raw.normalize('NFC')
  if (path !== raw) throw new SkillBundleValidationError(`file path must use NFC normalization: ${raw}`)
  if (
    path.length === 0 ||
    Buffer.byteLength(path, 'utf8') > 256 ||
    path.includes('\0') ||
    path.includes('\\') ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    path.endsWith('/') ||
    posix.normalize(path) !== path
  ) {
    throw new SkillBundleValidationError(`unsafe skill file path: ${raw}`)
  }
  const segments = path.split('/')
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment === '.' || segment === '..' || Buffer.byteLength(segment, 'utf8') > 128
    )
  ) {
    throw new SkillBundleValidationError(`unsafe skill file path: ${raw}`)
  }
  return path
}

function decode(file: SkillBundleTextFile): Uint8Array<ArrayBuffer> {
  if (file.encoding === 'utf8') return strToU8(file.content)
  if (
    file.content.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.content)
  ) {
    throw new SkillBundleValidationError(`invalid base64 content for ${file.path}`)
  }
  const decoded = Buffer.from(file.content, 'base64')
  if (decoded.toString('base64') !== file.content) {
    throw new SkillBundleValidationError(`non-canonical base64 content for ${file.path}`)
  }
  const copy = new Uint8Array(decoded.byteLength)
  copy.set(decoded)
  return copy
}

function manifestFromSkillMd(skillMd: Uint8Array): { name: string; description: string } {
  const text = Buffer.from(skillMd).toString('utf8')
  if (text.includes('\uFFFD')) throw new SkillBundleValidationError('SKILL.md must be valid UTF-8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  if (!match) throw new SkillBundleValidationError('SKILL.md must begin with YAML frontmatter')
  let value: unknown
  try {
    value = parseYaml(match[1]!, { maxAliasCount: 0 })
  } catch {
    throw new SkillBundleValidationError('SKILL.md frontmatter is invalid YAML')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SkillBundleValidationError('SKILL.md frontmatter must be a mapping')
  }
  const row = value as Record<string, unknown>
  if (typeof row.name !== 'string' || !SKILL_NAME_RE.test(row.name)) {
    throw new SkillBundleValidationError('SKILL.md name must be lowercase kebab-case (1-63 characters)')
  }
  if (typeof row.description !== 'string' || !row.description.trim() || row.description.length > 1024) {
    throw new SkillBundleValidationError('SKILL.md description must be a non-empty string (max 1024 characters)')
  }
  return { name: row.name, description: row.description.trim() }
}

/** Sum the actual compressed entry payloads in the deterministic ZIP we just
 * produced. The daemon applies its bomb ratio to this denominator too; using
 * the whole archive here would count headers and let centrally-approved
 * bundles fail forever at the daemon trust boundary. */
function compressedPayloadBytes(archive: Uint8Array): number {
  const view = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength)
  const searchStart = Math.max(0, view.length - 65_557)
  let eocd = -1
  for (let offset = view.length - 22; offset >= searchStart; offset -= 1) {
    if (view.readUInt32LE(offset) === ZIP_EOCD_SIGNATURE) {
      eocd = offset
      break
    }
  }
  if (eocd < 0 || eocd + 22 > view.length) throw new SkillBundleValidationError('generated skill archive is invalid')
  const entryCount = view.readUInt16LE(eocd + 10)
  let cursor = view.readUInt32LE(eocd + 16)
  let compressed = 0
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > eocd || view.readUInt32LE(cursor) !== ZIP_CENTRAL_SIGNATURE) {
      throw new SkillBundleValidationError('generated skill archive is invalid')
    }
    compressed += view.readUInt32LE(cursor + 20)
    cursor += 46 + view.readUInt16LE(cursor + 28) + view.readUInt16LE(cursor + 30) + view.readUInt16LE(cursor + 32)
  }
  if (cursor !== eocd) throw new SkillBundleValidationError('generated skill archive is invalid')
  return compressed
}

/** Validate a model-proposed complete Agent Skills directory and package it as
 * the official `.skill` shape: one root directory containing SKILL.md plus any
 * scripts/references/assets. Input files are regular files only, so symlinks and
 * special entries cannot enter the archive. */
export function packageSkillBundle(files: readonly SkillBundleTextFile[], expectedName?: string): PackagedSkillBundle {
  if (files.length === 0 || files.length > MAX_MANAGED_SKILL_FILES) {
    throw new SkillBundleValidationError(`skill bundle must contain 1-${MAX_MANAGED_SKILL_FILES} files`)
  }

  const decoded = new Map<string, Uint8Array<ArrayBuffer>>()
  const folded = new Set<string>()
  let expandedBytes = 0
  for (const input of files) {
    const path = validatePath(input.path)
    const key = path.toLocaleLowerCase('en-US')
    if (folded.has(key)) throw new SkillBundleValidationError(`duplicate skill file path: ${path}`)
    folded.add(key)
    const bytes = decode(input)
    if (bytes.byteLength > MAX_MANAGED_SKILL_FILE_BYTES) {
      throw new SkillBundleValidationError(`skill file exceeds ${MAX_MANAGED_SKILL_FILE_BYTES} bytes: ${path}`)
    }
    expandedBytes += bytes.byteLength
    if (expandedBytes > MAX_MANAGED_SKILL_EXPANDED_BYTES) {
      throw new SkillBundleValidationError(`skill bundle exceeds ${MAX_MANAGED_SKILL_EXPANDED_BYTES} expanded bytes`)
    }
    decoded.set(path, bytes)
  }

  for (const path of decoded.keys()) {
    const segments = path.split('/')
    for (let end = 1; end < segments.length; end += 1) {
      const ancestor = segments.slice(0, end).join('/')
      if (folded.has(ancestor.toLocaleLowerCase('en-US'))) {
        throw new SkillBundleValidationError(`skill file path collides with a parent file: ${path}`)
      }
    }
  }

  const skillMd = decoded.get('SKILL.md')
  if (!skillMd) throw new SkillBundleValidationError('skill bundle must contain root SKILL.md')
  const metadata = manifestFromSkillMd(skillMd)
  if (expectedName !== undefined && metadata.name !== expectedName) {
    throw new SkillBundleValidationError(`SKILL.md name must match suggestion title (${expectedName})`)
  }

  const ordered = [...decoded.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const archiveInput: Zippable = {}
  for (const [path, bytes] of ordered) {
    const executable = path.startsWith('scripts/')
    archiveInput[`${metadata.name}/${path}`] = [
      bytes,
      { level: 6, mtime: ZIP_MTIME, os: 3, attrs: (executable ? 0o100755 : 0o100644) << 16 }
    ]
  }
  const rawArchive = zipSync(archiveInput, { level: 6 })
  if (rawArchive.byteLength > MAX_MANAGED_SKILL_ARCHIVE_BYTES) {
    throw new SkillBundleValidationError(`skill archive exceeds ${MAX_MANAGED_SKILL_ARCHIVE_BYTES} compressed bytes`)
  }
  const compressedPayload = compressedPayloadBytes(rawArchive)
  if (expandedBytes > 64 * 1024 && expandedBytes > compressedPayload * MAX_MANAGED_SKILL_COMPRESSION_RATIO) {
    throw new SkillBundleValidationError('skill archive has a suspicious compression ratio')
  }
  const archive = new Uint8Array(rawArchive.byteLength)
  archive.set(rawArchive)
  const manifest = {
    ...metadata,
    files: ordered.map(([path, bytes]) => ({ path, bytes: bytes.byteLength, digest: digest(bytes) }))
  }
  return {
    archive,
    digest: digest(archive),
    compressedBytes: archive.byteLength,
    expandedBytes,
    fileCount: ordered.length,
    description: metadata.description,
    manifest
  }
}
