// The publish side of artifacts.md §5.3–§5.4: walk a fenced path, check the protocol's rules and limits, hash every file.
import { createHash } from 'node:crypto'
import {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MAX_FILES,
  ArtifactManifest,
  artifactPathFoldKey,
  artifactPathProblem,
  artifactRevisionLimitProblem,
  formatArtifactBytes,
  type ArtifactManifestFile
} from '@agentconnect.md/protocol'
import type { WorkspaceFsKind } from '../workspace/workspace-fs.js'
import { DOCUMENT_MIME_TYPES } from '../mcp/ops/share-file-types.js'

/** One resolved, fenced path: `''` is the path itself, anything else a `/`-joined path below it. */
export interface ArtifactSourceTree {
  /** What sits there, never following a link: a symlink or special file is `other`. */
  stat(rel: string): Promise<WorkspaceFsKind>
  readdir(rel: string): Promise<string[]>
  /** A bounded regular-file read; undefined when it is gone or not a regular file. Throws when the sandbox is unreachable. */
  read(rel: string, maxBytes: number): Promise<{ bytes: Buffer } | { tooLarge: number } | undefined>
}

/** A refusal the tool reports to the agent as written. */
export class ArtifactToolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactToolError'
  }
}

/** One file of the manifest and where it is read from. */
export interface ArtifactSourceFile extends ArtifactManifestFile {
  /** The tree-relative path the bytes are read from; `''` for a single-file source. */
  rel: string
}

export interface BuiltArtifactManifest {
  manifest: ArtifactManifest
  files: ArtifactSourceFile[]
  /** Directories the fence keeps out (`.git`), as tree-relative paths. */
  skipped: string[]
}

// The types the console opens by (artifacts.md §9); anything else is an opaque download.
const WEB_MEDIA_TYPES: Record<string, string> = {
  html: 'text/html',
  htm: 'text/html',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  map: 'application/json',
  markdown: 'text/markdown',
  tsv: 'text/tab-separated-values',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  webm: 'video/webm',
  log: 'text/plain'
}

// Source the console highlights; served as plain text so a browser never runs it outside the sandboxed page.
const SOURCE_EXTENSIONS = new Set(
  'ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh sql toml ini cfg conf lua r scala dart vue svelte'.split(
    ' '
  )
)

/** A manifest file's media type, by extension through a small allowlist; `application/octet-stream` otherwise. */
export function artifactMediaType(path: string): string {
  const ext = /\.([A-Za-z0-9]{1,10})$/.exec(path)?.[1]?.toLowerCase()
  if (!ext) return 'application/octet-stream'
  if (SOURCE_EXTENSIONS.has(ext)) return 'text/plain'
  return WEB_MEDIA_TYPES[ext] ?? DOCUMENT_MIME_TYPES[ext] ?? 'application/octet-stream'
}

const isGitDir = (name: string): boolean => name.toLowerCase() === '.git'
const join = (dir: string, name: string): string => (dir === '' ? name : `${dir}/${name}`)
const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** Every regular file below a directory, sorted; a link or special file is refused by name, `.git` left out. */
async function walk(tree: ArtifactSourceTree, label: string): Promise<{ files: string[]; skipped: string[] }> {
  const files: string[] = []
  const skipped: string[] = []
  const visit = async (dir: string): Promise<void> => {
    const names = (await tree.readdir(dir)).sort()
    for (const name of names) {
      const rel = join(dir, name)
      if (isGitDir(name)) {
        skipped.push(rel)
        continue
      }
      const kind = await tree.stat(rel)
      if (kind === 'missing') continue
      if (kind === 'other')
        throw new ArtifactToolError(
          `publishArtifact: "${label}/${rel}" is a symbolic link or special file — publish only regular files and directories.`
        )
      if (kind === 'dir') {
        await visit(rel)
        continue
      }
      files.push(rel)
      if (files.length > ARTIFACT_MAX_FILES)
        throw new ArtifactToolError(
          `publishArtifact: "${label}" holds more than ${ARTIFACT_MAX_FILES} files; an artifact revision holds at most ${ARTIFACT_MAX_FILES}. Nothing was uploaded.`
        )
    }
  }
  await visit('')
  return { files, skipped }
}

/** The basename of a path in either separator, for a single-file manifest. */
function baseName(label: string): string {
  return label.split(/[\\/]/).filter(Boolean).pop() ?? label
}

/** Resolve the source, check §5.4 and §10.2 before any upload, and hash every file, one at a time. */
export async function buildArtifactManifest(
  tree: ArtifactSourceTree,
  opts: { label: string; entry?: string; maxFileBytes: number }
): Promise<BuiltArtifactManifest> {
  const { label } = opts
  const kind = await tree.stat('')
  if (kind === 'missing') throw new ArtifactToolError(`publishArtifact: no file or directory at "${label}".`)
  if (kind === 'other')
    throw new ArtifactToolError(
      `publishArtifact: "${label}" is a symbolic link or special file — publish only regular files and directories.`
    )

  let entries: { rel: string; path: string }[]
  let skipped: string[] = []
  if (kind === 'file') {
    entries = [{ rel: '', path: baseName(label) }]
  } else {
    const walked = await walk(tree, label)
    skipped = walked.skipped
    if (walked.files.length === 0) throw new ArtifactToolError(`publishArtifact: "${label}" holds no files to publish.`)
    entries = walked.files.map((rel) => ({ rel, path: rel }))
  }

  // Path rules and fold collisions, before reading a byte.
  const folded = new Map<string, string>()
  for (const { path } of entries) {
    const problem = artifactPathProblem(path)
    if (problem) throw new ArtifactToolError(`publishArtifact: "${path}" cannot be published: ${problem}.`)
    const key = artifactPathFoldKey(path)
    const clash = folded.get(key)
    if (clash !== undefined)
      throw new ArtifactToolError(
        `publishArtifact: "${path}" and "${clash}" differ only in letter case or Unicode form; rename one of them.`
      )
    folded.set(key, path)
  }

  const entry = pickEntry(entries, opts.entry, kind === 'dir', label)

  const files: ArtifactSourceFile[] = []
  let total = 0
  for (const { rel, path } of entries) {
    const budget = Math.min(opts.maxFileBytes, ARTIFACT_MAX_BYTES - total)
    const read = await tree.read(rel, Math.max(budget, 0))
    if (!read) throw new ArtifactToolError(`publishArtifact: "${path}" could not be read as a regular file.`)
    if ('tooLarge' in read) throw tooLarge(path, read.tooLarge, total, opts.maxFileBytes)
    const bytes = read.bytes.byteLength
    if (bytes === 0) throw new ArtifactToolError(`publishArtifact: "${path}" is empty — remove it or give it content.`)
    total += bytes
    files.push({ rel, path, sha256: sha256Hex(read.bytes), bytes, mediaType: artifactMediaType(path) })
  }

  const manifest = { entry, files: files.map(({ rel: _rel, ...file }) => file) }
  const checked = ArtifactManifest.safeParse(manifest)
  if (!checked.success)
    throw new ArtifactToolError(`publishArtifact: ${checked.error.issues[0]?.message ?? 'the manifest is invalid'}.`)
  const over = artifactRevisionLimitProblem(checked.data)
  if (over) throw new ArtifactToolError(`publishArtifact: ${over.message}; nothing was uploaded.`)
  return { manifest: checked.data, files, skipped }
}

function pickEntry(entries: { path: string }[], given: string | undefined, isDir: boolean, label: string): string {
  if (given === undefined) {
    if (entries.length === 1) return entries[0]!.path
    const index = entries.find((e) => /^index\.html?$/i.test(e.path))
    throw new ArtifactToolError(
      `publishArtifact: "${label}" holds ${entries.length} files; name the one that opens first as \`entry\`` +
        (index ? ` (for example "${index.path}").` : '.')
    )
  }
  const wanted = given.replace(/^\.\//, '')
  if (entries.some((e) => e.path === wanted)) return wanted
  if (!isDir && entries[0]) return entries[0].path
  throw new ArtifactToolError(
    `publishArtifact: the entry "${given}" is not one of the files in "${label}"; give its path relative to that directory.`
  )
}

function tooLarge(path: string, size: number, total: number, maxFileBytes: number): ArtifactToolError {
  if (size > maxFileBytes && maxFileBytes < ARTIFACT_MAX_BYTES)
    return new ArtifactToolError(
      `publishArtifact: "${path}" is ${size} bytes, over this deployment's ${maxFileBytes}-byte limit per file.`
    )
  const max = formatArtifactBytes(ARTIFACT_MAX_BYTES)
  return new ArtifactToolError(
    `publishArtifact: the files add up to more than ${max} (${total + size} bytes at "${path}"); an artifact revision holds at most ${max}. Nothing was uploaded.`
  )
}

/** A retry key unique to this turn's publication of exactly this content on this base, so a retried call gets the same revision. */
export function artifactIdempotencyKey(parts: {
  agentId: string
  sessionId: string
  turn: string
  artifactId?: string
  title?: string
  /** The base sent with the update, or `replace`; absent when neither travels (artifacts.md §5.6). */
  base?: number | 'replace'
  manifest: ArtifactManifest
}): string {
  const files = [...parts.manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  const digest = createHash('sha256')
    .update(
      JSON.stringify([
        parts.agentId,
        parts.sessionId,
        parts.turn,
        parts.artifactId ?? null,
        parts.title ?? null,
        parts.manifest.entry,
        files.map((f) => [f.path, f.sha256, f.bytes, f.mediaType]),
        ...(parts.base !== undefined ? [parts.base] : [])
      ])
    )
    .digest('hex')
  return `pub-${digest.slice(0, 48)}`
}

/** The `outputs/` directory a fetch lands in: the title made safe, the id's first block and the revision, so no two revisions share one. */
export function artifactDirName(title: string, artifactId: string, revision: number): string {
  const safe = title
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._ -]+/gu, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+/, '')
  const slug = Array.from(safe)
    .slice(0, 60)
    .join('')
    .replace(/[-.]+$/, '')
  const id = `${artifactId.slice(0, 8)}-r${revision}`
  return slug ? `${slug}-${id}` : `artifact-${id}`
}
