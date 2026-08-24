import { spawn } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { join, posix } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { workspaceGitOriginOf, type AgentSkillEntry } from '@agentconnect.md/protocol'
import { extract as extractTar, list as listTar, type ReadEntry } from 'tar'
import { authorizeWorkspaceGitUrl } from '../workspace/git-origin-policy.js'
import { cloneGitEnv, workspaceGitEnvBase } from '../workspace/git-injection.js'
import { TLS_TRUST_ENV } from '../config/tls-trust-env.js'

const GITHUB_SHORTHAND = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/
const GITHUB_TREE = /^\/([^/]+)\/([^/]+)\/tree\/([^/]+)(?:\/(.*))?$/
const SCP_SOURCE = /^([\w.-]+)@([\w.-]+):(.+)$/
const SAFE_REF = /^[^\0\r\n]{1,256}$/
const GITHUB_REPOSITORY_COMPONENT = /^[A-Za-z0-9_.-]+$/
const COMMIT_SHA = /^[a-f0-9]{40}$/i
const GITHUB_API_VERSION = '2022-11-28'
const MAX_ARCHIVE_LOCATION_BYTES = 8 * 1024
const MAX_CREDENTIAL_OUTPUT_BYTES = 16 * 1024
const MAX_REPOSITORY_METADATA_BYTES = 128 * 1024

export interface GitSkillArchiveLimits {
  maxCompressedBytes: number
  maxTarBytes: number
  maxEntries: number
  maxFileBytes: number
  maxTotalFileBytes: number
  maxDepth: number
  maxPathBytes: number
}

export const DEFAULT_GIT_SKILL_ARCHIVE_LIMITS: Readonly<GitSkillArchiveLimits> = {
  // These cover the installer's existing 64 MiB / 8192-entry Git snapshot
  // ceiling plus tar headers and incompressible gzip overhead.
  maxCompressedBytes: 80 * 1024 * 1024,
  maxTarBytes: 80 * 1024 * 1024,
  maxEntries: 8_192,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalFileBytes: 64 * 1024 * 1024,
  maxDepth: 64,
  maxPathBytes: 1_024
}

export interface GitSkillCredential {
  username: string
  password: string
}

export interface GitSkillCredentialRequest {
  agentId: string
  cloneUrl: string
  privateHome: string
  repositoryPath: string
  signal: AbortSignal
}

export type GitSkillCredentialProvider = (request: GitSkillCredentialRequest) => Promise<GitSkillCredential>

export interface ParsedGitSkillSource {
  cloneUrl: string
  ref?: string
  subDir?: string
}

function githubSshRepositoryPath(source: string): string | undefined {
  const scp = SCP_SOURCE.exec(source)
  if (scp) {
    if (scp[1] !== 'git') return undefined
    const path = scp[3]!
    // scp's leading slash and tilde forms have server-side path semantics that
    // are not equivalent to GitHub's HTTPS owner/repository path.
    return path.startsWith('/') || path.startsWith('~') ? undefined : path
  }

  const url = new URL(source)
  if (url.username !== 'git') return undefined
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return undefined
  const path = url.pathname.slice(1)
  return path && !path.startsWith('~') ? path : undefined
}

/** Resolve the canonical repository identity used for acquisition. Both the
 * tenant-provided transport and a canonicalized transport must pass the
 * daemon's shared origin policy.
 * GitHub's standard SSH/scp spellings name the same owner/repository as HTTPS,
 * so prefer HTTPS there to use the daemon's scoped GitHub credential helper.
 * If an operator allows SSH but not HTTPS, preserve SSH and forward no helper
 * capability instead of silently widening that policy. */
export function resolveAuthorizedGitSkillCloneUrl(input: string): string {
  const authorized = authorizeWorkspaceGitUrl(input)
  if (workspaceGitOriginOf(authorized) !== 'ssh://github.com') return authorized

  const repositoryPath = githubSshRepositoryPath(authorized)
  if (!repositoryPath) return authorized
  try {
    return authorizeWorkspaceGitUrl(`https://github.com/${repositoryPath}`)
  } catch {
    return authorized
  }
}

function safeSubDir(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined
  if (
    value.includes('\\') ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /^[A-Za-z]:/.test(value) ||
    posix.normalize(value) !== value ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new Error('skill source contains an unsafe subdirectory')
  }
  return value
}

/** Normalize the protocol's shorthand / GitHub tree forms into a clone target.
 * This is source acquisition only: skill discovery and harness layout remain
 * entirely owned by the pinned skills CLI. */
export function parseGitSkillSource(entry: AgentSkillEntry): ParsedGitSkillSource {
  const shorthand = GITHUB_SHORTHAND.exec(entry.source)
  if (shorthand) {
    if (entry.ref && !SAFE_REF.test(entry.ref)) throw new Error('skill source contains an unsafe ref')
    const subDir = safeSubDir(entry.subDir)
    return {
      cloneUrl: authorizeWorkspaceGitUrl(
        `https://github.com/${shorthand[1]}/${shorthand[2]!.replace(/\.git$/i, '')}.git`
      ),
      ...(entry.ref ? { ref: entry.ref } : {}),
      ...(subDir ? { subDir } : {})
    }
  }

  let ref = entry.ref
  let subDir = entry.subDir
  let cloneInput = authorizeWorkspaceGitUrl(entry.source)
  // GitHub's browser-only /tree/<ref>/<path> form is not itself cloneable.
  // The raw form has already passed the shared exact-origin policy; the
  // rewritten clone target is authorized again below.
  if (workspaceGitOriginOf(cloneInput) === 'https://github.com') {
    try {
      const url = new URL(cloneInput)
      const tree = GITHUB_TREE.exec(decodeURIComponent(url.pathname))
      if (tree) {
        url.pathname = `/${tree[1]}/${tree[2]!.replace(/\.git$/i, '')}.git`
        cloneInput = url.toString()
        ref ??= tree[3]
        subDir ??= tree[4]
      }
    } catch {
      throw new Error('skill source contains malformed URL encoding')
    }
  }
  if (ref && !SAFE_REF.test(ref)) throw new Error('skill source contains an unsafe ref')
  const normalizedSubDir = safeSubDir(subDir)
  return {
    cloneUrl: authorizeWorkspaceGitUrl(cloneInput),
    ...(ref ? { ref } : {}),
    ...(normalizedSubDir ? { subDir: normalizedSubDir } : {})
  }
}

export function buildSkillGitAcquisitionEnv(opts: {
  agentId: string
  cloneUrl: string
  privateHome: string
  useGitCredential: boolean
}): Record<string, string> {
  const configured = {
    ...workspaceGitEnvBase(opts.cloneUrl),
    ...(opts.useGitCredential && workspaceGitOriginOf(opts.cloneUrl) === 'https://github.com'
      ? cloneGitEnv(opts.agentId, opts.cloneUrl)
      : {})
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: opts.privateHome,
    TMPDIR: join(opts.privateHome, 'tmp'),
    GIT_TERMINAL_PROMPT: '0'
  }
  for (const [key, value] of Object.entries(configured)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (
      upper.startsWith('GIT_') ||
      upper.startsWith('AC_GITCRED_') ||
      TLS_TRUST_ENV.includes(upper as (typeof TLS_TRUST_ENV)[number]) ||
      upper === 'LANG' ||
      upper === 'LC_ALL'
    ) {
      env[key] = value
    }
  }
  // Never let a source or host config turn acquisition into a local-file or
  // helper-protocol read. URL-scoped credential helpers still work over HTTPS.
  env.GIT_ALLOW_PROTOCOL = 'https:ssh'
  return env
}

function githubRepository(cloneUrl: string): { owner: string; repo: string; path: string } {
  if (workspaceGitOriginOf(cloneUrl) !== 'https://github.com') {
    throw new Error('skill Git acquisition supports only canonical GitHub HTTPS sources')
  }
  const url = new URL(cloneUrl)
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) {
    throw new Error('skill GitHub source must identify exactly owner/repository')
  }
  let parts: string[]
  try {
    parts = url.pathname.slice(1).split('/').map(decodeURIComponent)
  } catch {
    throw new Error('skill GitHub source contains malformed URL encoding')
  }
  if (parts.length !== 2) throw new Error('skill GitHub source must identify exactly owner/repository')
  const owner = parts[0]!
  const repo = parts[1]!.replace(/\.git$/i, '')
  if (!GITHUB_REPOSITORY_COMPONENT.test(owner) || !GITHUB_REPOSITORY_COMPONENT.test(repo)) {
    throw new Error('skill GitHub source contains an invalid owner or repository')
  }
  return { owner, repo, path: `${owner}/${repo}` }
}

/** Admission contract for the bounded acquisition implementation. Accepted
 * inputs may use GitHub shorthand/tree/HTTPS or standard GitHub SSH/scp, but
 * the final network authority must re-authorize as exact GitHub HTTPS and the
 * path must be exactly owner/repository. Other operator-authorized Git origins
 * deliberately fail closed until they have an equivalently bounded transport. */
export function resolveBoundedGitSkillSource(entry: AgentSkillEntry): ParsedGitSkillSource {
  const parsed = parseGitSkillSource(entry)
  const source = { ...parsed, cloneUrl: resolveAuthorizedGitSkillCloneUrl(parsed.cloneUrl) }
  githubRepository(source.cloneUrl)
  return source
}

function mergedArchiveLimits(overrides: Partial<GitSkillArchiveLimits> = {}): GitSkillArchiveLimits {
  const limits = { ...DEFAULT_GIT_SKILL_ARCHIVE_LIMITS, ...overrides }
  for (const name of Object.keys(DEFAULT_GIT_SKILL_ARCHIVE_LIMITS) as (keyof GitSkillArchiveLimits)[]) {
    const value = limits[name]
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`skill Git archive ${name} must be positive`)
    if (value > DEFAULT_GIT_SKILL_ARCHIVE_LIMITS[name]) {
      throw new Error(`skill Git archive ${name} may not exceed the daemon ceiling`)
    }
  }
  return limits
}

function parseCredentialOutput(output: Buffer): GitSkillCredential {
  const fields = new Map<string, string>()
  for (const line of output.toString('utf8').split('\n')) {
    const separator = line.indexOf('=')
    if (separator > 0) fields.set(line.slice(0, separator), line.slice(separator + 1).replace(/\r$/, ''))
  }
  const username = fields.get('username') ?? ''
  const password = fields.get('password') ?? ''
  if (
    !username ||
    !password ||
    username.length > 256 ||
    password.length > 8 * 1024 ||
    /[\0\r\n]/.test(username) ||
    /[\0\r\n]/.test(password)
  ) {
    throw new Error('skill GitHub credential helper returned an invalid response')
  }
  return { username, password }
}

/** Ask only the daemon-configured, GitHub URL-scoped helper. Stdout is bounded
 * and never included in errors because it carries the short-lived token. */
export async function loadScopedGitSkillCredential(request: GitSkillCredentialRequest): Promise<GitSkillCredential> {
  const env = buildSkillGitAcquisitionEnv({
    agentId: request.agentId,
    cloneUrl: request.cloneUrl,
    privateHome: request.privateHome,
    useGitCredential: true
  })
  return await new Promise<GitSkillCredential>((resolve, reject) => {
    let child
    try {
      child = spawn('git', ['credential', 'fill'], {
        env,
        signal: request.signal,
        stdio: ['pipe', 'pipe', 'pipe']
      })
    } catch {
      reject(new Error('skill GitHub credential helper could not start'))
      return
    }

    const stdout: Buffer[] = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const wipeStdout = () => {
      for (const chunk of stdout) chunk.fill(0)
      stdout.length = 0
    }
    const fail = (message: string) => {
      if (settled) return
      settled = true
      wipeStdout()
      child.kill()
      reject(new Error(message))
    }
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) {
        chunk.fill(0)
        return
      }
      stdoutBytes += chunk.length
      if (stdoutBytes > MAX_CREDENTIAL_OUTPUT_BYTES) {
        chunk.fill(0)
        return fail('skill GitHub credential helper output exceeded limit')
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length
      chunk.fill(0)
      if (stderrBytes > MAX_CREDENTIAL_OUTPUT_BYTES) fail('skill GitHub credential helper output exceeded limit')
    })
    child.on('error', () => fail('skill GitHub credential helper failed'))
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) return fail('skill GitHub credentials are unavailable')
      const output = Buffer.concat(stdout, stdoutBytes)
      try {
        const credential = parseCredentialOutput(output)
        settled = true
        resolve(credential)
      } catch {
        fail('skill GitHub credential helper returned an invalid response')
      } finally {
        output.fill(0)
        wipeStdout()
      }
    })
    child.stdin.on('error', () => fail('skill GitHub credential helper failed'))
    child.stdin.end(`protocol=https\nhost=github.com\npath=${request.repositoryPath}.git\n\n`, 'utf8')
  })
}

async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function fetchWithRedirectPolicy(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  init: RequestInit,
  redirect: 'error' | 'manual',
  label: string
): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, redirect })
  } catch {
    throw new Error(`${label} request failed`)
  }
}

async function readBoundedBody(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardResponse(response)
    throw new Error(`${label} exceeded the byte limit`)
  }
  if (!response.body) throw new Error(`${label} returned no body`)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} exceeded the byte limit`)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} exceeded the byte limit`) throw error
    throw new Error(`${label} response body failed`)
  }
}

async function* bufferChunks(buffer: Buffer, signal: AbortSignal): AsyncGenerator<Buffer> {
  const chunkSize = 64 * 1024
  for (let offset = 0; offset < buffer.length; offset += chunkSize) {
    signal.throwIfAborted()
    yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.length))
  }
}

async function* boundedResponseChunks(
  response: Response,
  maxBytes: number,
  signal: AbortSignal
): AsyncGenerator<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardResponse(response)
    throw new Error('skill GitHub archive exceeded the compressed byte limit')
  }
  if (!response.body) throw new Error('skill GitHub archive returned no body')

  const reader = response.body.getReader()
  let total = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) return
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error('skill GitHub archive exceeded the compressed byte limit')
      }
      yield Buffer.from(value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function downloadAndGunzipBounded(
  response: Response,
  compressedLimit: number,
  tarLimit: number,
  signal: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.length
      if (total > tarLimit) return callback(new Error('skill GitHub archive exceeded the uncompressed byte limit'))
      chunks.push(Buffer.from(chunk))
      callback()
    }
  })
  try {
    await pipeline(Readable.from(boundedResponseChunks(response, compressedLimit, signal)), createGunzip(), sink, {
      signal
    })
  } catch (error) {
    if (signal.aborted) throw error
    if (
      error instanceof Error &&
      (error.message === 'skill GitHub archive exceeded the compressed byte limit' ||
        error.message === 'skill GitHub archive exceeded the uncompressed byte limit')
    ) {
      throw error
    }
    throw new Error('skill GitHub archive is not a valid gzip stream')
  }
  return Buffer.concat(chunks, total)
}

interface SeenArchivePath {
  type: 'directory' | 'file'
}

interface ArchiveValidationState {
  root?: string
  entries: number
  files: number
  totalFileBytes: number
  seen: Map<string, SeenArchivePath>
  ancestors: Set<string>
  inventory: Map<string, SeenArchivePath['type']>
  /** Symlink/hardlink entries admitted for SKIPPING only — never extracted.
   * Whether each one is actually tolerable (outside every skill directory) is
   * decided after the full inventory is known. */
  skippedLinks: Set<string>
}

function archiveCollisionComponent(value: string): string {
  return value.normalize('NFKC').toLowerCase().replaceAll('\u00df', 'ss').replaceAll('\u03c2', '\u03c3')
}

function registerArchivePath(state: ArchiveValidationState, key: string, type: SeenArchivePath['type']): void {
  if (state.seen.has(key)) throw new Error('skill GitHub archive contains a normalized path collision')
  const parts = key.split('/')
  for (let index = 1; index < parts.length; index++) {
    const ancestor = parts.slice(0, index).join('/')
    if (state.seen.get(ancestor)?.type === 'file') {
      throw new Error('skill GitHub archive contains a file/ancestor collision')
    }
    state.ancestors.add(ancestor)
  }
  if (type === 'file' && state.ancestors.has(key))
    throw new Error('skill GitHub archive contains a file/ancestor collision')
  state.seen.set(key, { type })
}

function countArchiveEntry(state: ArchiveValidationState, limits: GitSkillArchiveLimits): void {
  state.entries += 1
  if (state.entries > limits.maxEntries) throw new Error('skill GitHub archive contains too many entries')
}

function validateArchiveEntry(entry: ReadEntry, state: ArchiveValidationState, limits: GitSkillArchiveLimits): void {
  countArchiveEntry(state, limits)
  // Git can only record files, directories, and symlinks (hardlinks can appear
  // in tar re-encodings of identical blobs). Repositories routinely carry
  // repo-level links like AGENTS.md -> CLAUDE.md that are unrelated to any
  // skill, so link entries are admitted here for skipping — never extraction —
  // and rejected after the full inventory is known if one sits inside a skill
  // directory (see rejectLinksInsideSkills). Anything else stays fatal.
  const linkLike = entry.type === 'SymbolicLink' || entry.type === 'Link'
  if (!linkLike && entry.type !== 'File' && entry.type !== 'Directory') {
    throw new Error('skill GitHub archive contains a link or special entry')
  }

  let path = entry.path
  if (entry.type === 'Directory') path = path.replace(/\/$/, '')
  if (
    !path ||
    path.includes('\\') ||
    path.includes('\0') ||
    path.includes('\uFFFD') ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    path.startsWith('/') ||
    /^[A-Za-z]:/.test(path) ||
    posix.normalize(path) !== path
  ) {
    throw new Error('skill GitHub archive contains an unsafe path')
  }
  const parts = path.split('/')
  if (
    parts.some(
      (part) =>
        !part || part === '.' || part === '..' || part !== part.normalize('NFC') || Buffer.byteLength(part) > 255
    )
  ) {
    throw new Error('skill GitHub archive contains an unsafe path')
  }
  state.root ??= parts[0]
  if (parts[0] !== state.root) throw new Error('skill GitHub archive contains multiple roots')

  const relative = parts.slice(1)
  if (relative.length === 0) {
    if (entry.type !== 'Directory' || entry.size !== 0) {
      throw new Error('skill GitHub archive has an invalid root entry')
    }
    if (state.inventory.has(path)) throw new Error('skill GitHub archive contains a duplicate path')
    state.inventory.set(path, 'directory')
    return
  }
  if (relative.length > limits.maxDepth) throw new Error('skill GitHub archive exceeds the depth limit')
  const relativePath = relative.join('/')
  if (Buffer.byteLength(relativePath) > limits.maxPathBytes) {
    throw new Error('skill GitHub archive contains an oversized path')
  }

  if (linkLike) {
    state.skippedLinks.add(path)
    return
  }
  const type = entry.type === 'Directory' ? 'directory' : 'file'
  if (state.inventory.has(path)) throw new Error('skill GitHub archive contains a duplicate path')
  state.inventory.set(path, type)

  const collisionKey = relative.map(archiveCollisionComponent).join('/')
  registerArchivePath(state, collisionKey, type)
  if (type === 'directory') {
    if (entry.size !== 0) throw new Error('skill GitHub archive contains an invalid directory')
    return
  }

  if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.maxFileBytes) {
    throw new Error('skill GitHub archive contains an oversized file')
  }
  state.files += 1
  state.totalFileBytes += entry.size
  if (!Number.isSafeInteger(state.totalFileBytes) || state.totalFileBytes > limits.maxTotalFileBytes) {
    throw new Error('skill GitHub archive exceeds the total file byte limit')
  }
}

/** A skipped link is tolerable only OUTSIDE every skill directory (any
 * directory holding a SKILL.md, recursively): the installed bundles then
 * cannot silently diverge from the upstream skill content. A link inside a
 * skill stays fail-closed — such a skill is uninstallable through AgentConnect
 * anyway (the snapshot and CLI-cell layers both refuse links). */
function rejectLinksInsideSkills(state: ArchiveValidationState): void {
  if (state.skippedLinks.size === 0) return
  const skillDirs = [...state.inventory.keys()]
    .filter((path) => path.endsWith('/SKILL.md'))
    .map((path) => path.slice(0, -'/SKILL.md'.length))
  for (const link of state.skippedLinks) {
    if (skillDirs.some((dir) => link.startsWith(`${dir}/`))) {
      throw new Error('skill GitHub archive contains a link or special entry inside a skill directory')
    }
  }
}

async function validateAndExtractArchive(
  tarBody: Buffer,
  destination: string,
  limits: GitSkillArchiveLimits,
  signal: AbortSignal
) {
  const state: ArchiveValidationState = {
    entries: 0,
    files: 0,
    totalFileBytes: 0,
    seen: new Map(),
    ancestors: new Set(),
    inventory: new Map(),
    skippedLinks: new Set()
  }
  let validationError: Error | undefined
  const parser = listTar({
    gzip: false,
    strict: true,
    maxMetaEntrySize: limits.maxFileBytes,
    onReadEntry: (entry) => {
      try {
        validateArchiveEntry(entry, state, limits)
      } catch (error) {
        validationError = error instanceof Error ? error : new Error('skill GitHub archive contains an invalid entry')
        throw validationError
      }
    }
  })
  parser.on('ignoredEntry', () => {
    validationError ??= new Error('skill GitHub archive contains a link or special entry')
    parser.abort(validationError)
  })
  parser.on('meta', () => {
    try {
      countArchiveEntry(state, limits)
    } catch (error) {
      validationError = error instanceof Error ? error : new Error('skill GitHub archive contains too many entries')
      parser.abort(validationError)
    }
  })
  try {
    await pipeline(Readable.from(bufferChunks(tarBody, signal)), parser, { signal })
  } catch (error) {
    if (validationError) throw validationError
    if (error instanceof Error && error.message.startsWith('skill GitHub archive')) throw error
    if (signal.aborted) throw error
    throw new Error('skill GitHub archive is not a valid tar stream')
  }
  if (!state.root || state.files === 0) throw new Error('skill GitHub archive contains no files')
  rejectLinksInsideSkills(state)

  const remaining = new Map(state.inventory)
  let extractionError: Error | undefined
  const extractor = extractTar({
    cwd: destination,
    gzip: false,
    strict: true,
    strip: 1,
    maxDepth: limits.maxDepth + 1,
    maxMetaEntrySize: limits.maxFileBytes,
    preservePaths: false,
    preserveOwner: false,
    noMtime: true,
    chmod: true,
    // Also constrains directories that tar creates implicitly for archives
    // that omit explicit Directory entries.
    processUmask: 0o077,
    dmode: 0o700,
    fmode: 0o600,
    filter: (_path, entry) => {
      if (!('type' in entry) || (entry.type !== 'File' && entry.type !== 'Directory')) {
        // Validated links are skipped without being materialized.
        if ('type' in entry && (entry.type === 'SymbolicLink' || entry.type === 'Link')) {
          if (state.skippedLinks.has(entry.path)) return false
        }
        extractionError = new Error('skill GitHub archive extraction inventory changed')
        return false
      }
      const path = entry.type === 'Directory' ? entry.path.replace(/\/$/, '') : entry.path
      const type = entry.type === 'Directory' ? 'directory' : 'file'
      if (remaining.get(path) !== type) {
        extractionError = new Error('skill GitHub archive extraction inventory changed')
        return false
      }
      remaining.delete(path)
      entry.mode = type === 'directory' ? 0o700 : 0o600
      return true
    }
  })
  extractor.on('ignoredEntry', (entry) => {
    if (state.skippedLinks.has(entry.path)) return
    extractionError ??= new Error('skill GitHub archive extraction inventory changed')
    extractor.abort(extractionError)
  })
  try {
    await pipeline(Readable.from(bufferChunks(tarBody, signal)), extractor, { signal })
  } catch (error) {
    if (extractionError) throw extractionError
    if (signal.aborted) throw error
    throw new Error('skill GitHub archive extraction failed')
  }
  if (remaining.size !== 0) throw new Error('skill GitHub archive extraction inventory changed')
}

function archiveLocation(
  value: string | null,
  repository: { owner: string; repo: string },
  expectedCommit: string
): { url: URL; resolvedCommit: string } {
  if (!value || Buffer.byteLength(value) > MAX_ARCHIVE_LOCATION_BYTES) {
    throw new Error('skill GitHub archive returned an invalid location')
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('skill GitHub archive returned an invalid location')
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase().replace(/\.+$/, '') !== 'codeload.github.com' ||
    url.port ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error('skill GitHub archive returned a disallowed location')
  }

  let parts: string[]
  try {
    if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) {
      throw new Error('invalid path')
    }
    parts = url.pathname.slice(1).split('/').map(decodeURIComponent)
  } catch {
    throw new Error('skill GitHub archive returned an invalid location')
  }
  const [owner, repo, format, resolvedCommit] = parts
  if (
    parts.length !== 4 ||
    owner?.toLowerCase() !== repository.owner.toLowerCase() ||
    repo?.toLowerCase() !== repository.repo.toLowerCase() ||
    (format !== 'tar.gz' && format !== 'legacy.tar.gz') ||
    !resolvedCommit ||
    !COMMIT_SHA.test(resolvedCommit) ||
    resolvedCommit.toLowerCase() !== expectedCommit.toLowerCase()
  ) {
    throw new Error('skill GitHub archive returned a mismatched location')
  }
  return { url, resolvedCommit: resolvedCommit.toLowerCase() }
}

interface GitHubApiState {
  token?: string
  credentialAttempted: boolean
}

async function githubApiRequest(opts: {
  url: URL
  cloneUrl: string
  repositoryPath: string
  agentId: string
  privateHome: string
  useGitCredential: boolean
  signal: AbortSignal
  fetchImpl: typeof globalThis.fetch
  credentialProvider: GitSkillCredentialProvider
  state: GitHubApiState
  accept: string
  redirect: 'error' | 'manual'
}): Promise<Response> {
  const request = async () =>
    await fetchWithRedirectPolicy(
      opts.fetchImpl,
      opts.url,
      {
        method: 'GET',
        signal: opts.signal,
        headers: {
          accept: opts.accept,
          'accept-encoding': 'identity',
          'user-agent': 'agentconnect-daemon',
          'x-github-api-version': GITHUB_API_VERSION,
          ...(opts.state.token ? { authorization: `Bearer ${opts.state.token}` } : {})
        }
      },
      opts.redirect,
      'skill GitHub API'
    )

  let response = await request()
  if (
    opts.useGitCredential &&
    !opts.state.token &&
    !opts.state.credentialAttempted &&
    (response.status === 401 || response.status === 403 || response.status === 404)
  ) {
    opts.state.credentialAttempted = true
    await discardResponse(response)
    let credential: GitSkillCredential
    try {
      credential = await opts.credentialProvider({
        agentId: opts.agentId,
        cloneUrl: opts.cloneUrl,
        privateHome: opts.privateHome,
        repositoryPath: opts.repositoryPath,
        signal: opts.signal
      })
    } catch {
      throw new Error('skill GitHub credentials are unavailable')
    }
    if (!credential.password || credential.password.length > 8 * 1024 || /[\0\r\n]/.test(credential.password)) {
      throw new Error('skill GitHub credential helper returned an invalid response')
    }
    opts.state.token = credential.password
    response = await request()
  }
  return response
}

export interface AcquireGitSkillOptions {
  destination: string
  agentId: string
  useGitCredential: boolean
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
  credentialProvider?: GitSkillCredentialProvider
  archiveLimits?: Partial<GitSkillArchiveLimits>
}

/** Acquire one Git source as a private, commit-pinned repository snapshot and
 * return the selected local tree. The caller snapshots that tree before the CLI
 * sees it. */
export async function acquireGitSkillSource(
  entry: AgentSkillEntry,
  opts: AcquireGitSkillOptions
): Promise<{ sourceDir: string; resolvedCommit: string; source: ParsedGitSkillSource }> {
  // This final daemon boundary applies both the operator-owned exact-origin
  // policy and the narrower transport contract required for bounded archives.
  const source = resolveBoundedGitSkillSource(entry)
  const github = githubRepository(source.cloneUrl)
  const limits = mergedArchiveLimits(opts.archiveLimits)
  const repository = join(opts.destination, 'repository')
  const privateHome = join(opts.destination, 'home')
  await fsp.mkdir(join(privateHome, 'tmp'), { recursive: true, mode: 0o700 })
  await fsp.mkdir(repository, { recursive: false, mode: 0o700 })

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
  try {
    const fetchImpl = opts.fetch ?? globalThis.fetch
    const credentialProvider = opts.credentialProvider ?? loadScopedGitSkillCredential
    const apiState: GitHubApiState = { credentialAttempted: false }
    const commonApiOptions = {
      cloneUrl: source.cloneUrl,
      repositoryPath: github.path,
      agentId: opts.agentId,
      privateHome,
      // A scoped credential may raise GitHub's API rate limit or resolve the
      // exact numeric identity, but metadata below still rejects private repos.
      // Crucially, credential fallback happens on the numeric endpoint before
      // any potentially captured owner/name is queried.
      useGitCredential: opts.useGitCredential,
      signal: controller.signal,
      fetchImpl,
      credentialProvider,
      state: apiState
    }

    const verifyRepositoryIdentity = async (): Promise<void> => {
      const identityResponse = await githubApiRequest({
        ...commonApiOptions,
        url: new URL(`https://api.github.com/repositories/${entry.githubRepoId}`),
        accept: 'application/vnd.github+json',
        redirect: 'error'
      })
      if (identityResponse.status !== 200) {
        const status = identityResponse.status
        await discardResponse(identityResponse)
        throw new Error(`skill GitHub repository identity lookup failed with status ${status}`)
      }

      const raw = (
        await readBoundedBody(
          identityResponse,
          MAX_REPOSITORY_METADATA_BYTES,
          'skill GitHub repository identity lookup'
        )
      ).toString('utf8')
      let metadata: unknown
      try {
        // JSON.parse rounds sufficiently large numeric GitHub ids. Preserve
        // every object `id` token as a decimal string before parsing so the
        // comparison remains exact even beyond Number.MAX_SAFE_INTEGER.
        metadata = JSON.parse(raw.replace(/("id"\s*:\s*)([1-9]\d*)/g, '$1"$2"'))
      } catch {
        throw new Error('skill GitHub repository identity lookup returned invalid metadata')
      }
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        throw new Error('skill GitHub repository identity lookup returned invalid metadata')
      }
      const record = metadata as Record<string, unknown>
      if (
        record.id !== entry.githubRepoId ||
        typeof record.full_name !== 'string' ||
        record.full_name.toLowerCase() !== github.path.toLowerCase()
      ) {
        throw new Error('skill GitHub repository identity does not match the configured source')
      }
      if (record.private !== false) {
        throw new Error('private skill sources are not supported')
      }
    }

    // The numeric endpoint cannot be captured by a replacement at the old
    // owner/name. Fence both name-based operations: if the original repository
    // was deleted or renamed at either boundary, acquisition fails closed.
    await verifyRepositoryIdentity()

    const requestedRef = source.ref ?? 'HEAD'
    const commitUrl = new URL(
      `https://api.github.com/repos/${github.owner}/${github.repo}/commits/${encodeURIComponent(requestedRef)}`
    )
    const commitResponse = await githubApiRequest({
      ...commonApiOptions,
      url: commitUrl,
      accept: 'application/vnd.github.sha',
      redirect: 'error'
    })
    if (commitResponse.status !== 200) {
      const status = commitResponse.status
      await discardResponse(commitResponse)
      throw new Error(`skill GitHub commit resolution failed with status ${status}`)
    }
    const resolvedCommit = (await readBoundedBody(commitResponse, 128, 'skill GitHub commit resolution'))
      .toString('utf8')
      .trim()
    if (!COMMIT_SHA.test(resolvedCommit)) throw new Error('skill GitHub commit resolution returned an invalid SHA')

    await verifyRepositoryIdentity()

    const archiveApiUrl = new URL(
      `https://api.github.com/repos/${github.owner}/${github.repo}/tarball/${resolvedCommit}`
    )
    const archiveApiResponse = await githubApiRequest({
      ...commonApiOptions,
      url: archiveApiUrl,
      accept: 'application/vnd.github+json',
      redirect: 'manual'
    })
    if (archiveApiResponse.status !== 302) {
      const status = archiveApiResponse.status
      await discardResponse(archiveApiResponse)
      throw new Error(`skill GitHub archive lookup failed with status ${status}`)
    }
    const { url: codeloadUrl } = archiveLocation(archiveApiResponse.headers.get('location'), github, resolvedCommit)
    await discardResponse(archiveApiResponse)
    apiState.token = undefined

    // The archive URL may carry GitHub's short-lived private-download query.
    // It is sent only to the exact validated codeload host, never logged, and
    // the longer-lived installation token is deliberately not forwarded.
    const archiveResponse = await fetchWithRedirectPolicy(
      fetchImpl,
      codeloadUrl,
      {
        method: 'GET',
        signal: controller.signal,
        headers: {
          accept: 'application/x-gzip',
          'accept-encoding': 'identity',
          'user-agent': 'agentconnect-daemon'
        }
      },
      'error',
      'skill GitHub codeload'
    )
    if (archiveResponse.status !== 200) {
      const status = archiveResponse.status
      await discardResponse(archiveResponse)
      throw new Error(`skill GitHub codeload failed with status ${status}`)
    }
    const tarBody = await downloadAndGunzipBounded(
      archiveResponse,
      limits.maxCompressedBytes,
      limits.maxTarBytes,
      controller.signal
    )
    await validateAndExtractArchive(tarBody, repository, limits, controller.signal)

    return {
      sourceDir: source.subDir ? join(repository, ...source.subDir.split('/')) : repository,
      resolvedCommit,
      source
    }
  } finally {
    clearTimeout(timer)
  }
}
