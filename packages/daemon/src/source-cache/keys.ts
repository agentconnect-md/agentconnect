import { createHash, randomUUID } from 'node:crypto'
import {
  CodeHostExternalId,
  DOT_PATH_SEGMENT_RE,
  isCodeHostProvider,
  normalizeGitCloneUrl
} from '@agentconnect.md/protocol'

// Source Cache key layout (source-cache.md §4); pure, every key is relative to the configured prefix.

export type SourceCacheClass = 'anon' | 'cred'
export type SourceCacheShape = 'blobless' | 'full'
/** An object key under `src/`, built only here so no caller can presign `snapshots/` or a pod-named key. */
export type SourceCacheObjectKey = string & { readonly __sourceCacheObjectKey: true }

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i
const SCP_PARTS_RE = /^([\w.-]+)@([\w.-]+):(.+)$/
const ORG_RE = /^[A-Za-z0-9_-]{1,64}$/
const ANON_REPO_RE = /^[0-9a-f]{64}$/
const CRED_REPO_RE = /^([a-z]+):(0|[1-9]\d*)$/
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHAPES: readonly SourceCacheShape[] = ['blobless', 'full']

export class SourceCacheKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SourceCacheKeyError'
  }
}

function invalid(message: string): never {
  throw new SourceCacheKeyError(message)
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Lower-case a host and drop trailing dots, so `GitHub.com.` and `github.com` are one authority. */
function canonicalHost(host: string): string {
  const lower = host.toLowerCase()
  let end = lower.length
  while (end > 0 && lower.charCodeAt(end - 1) === 0x2e) end--
  return lower.slice(0, end)
}

/** Strip trailing '/' and one trailing '.git' (then any '/' it exposed). */
function canonicalPath(path: string): string {
  const trim = (s: string): string => {
    let end = s.length
    while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end--
    return s.slice(0, end)
  }
  let out = trim(path)
  if (out.toLowerCase().endsWith('.git')) out = trim(out.slice(0, -4))
  let start = 0
  while (start < out.length && out.charCodeAt(start) === 0x2f) start++
  out = out.slice(start)
  if (!out) invalid('source url must name a repository path')
  return out
}

/** The §4 canonical remote URL: credentials, query and fragment stripped, host lower-cased, `.git` removed, standard SSH rewritten to HTTPS. */
export function canonicalSourceUrl(input: string): string {
  const raw = input.trim()
  // Refuse dot segments before WHATWG parsing collapses them (it drops tab/CR/LF and reads '\\' as '/'; ':' covers SCP).
  const pathView = `/${raw
    .split(/[?#]/, 1)[0]!
    .replace(/[\t\n\r]/g, '')
    .replace(/[\\:]/g, '/')}`
  if (DOT_PATH_SEGMENT_RE.test(pathView)) invalid('source url must not contain dot path segments')
  let candidate = raw
  if (SCHEME_RE.test(raw)) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      invalid('source url must be a valid absolute URL')
    }
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    candidate = url.toString()
  }
  let normalized: string
  try {
    normalized = normalizeGitCloneUrl(candidate)
  } catch (err) {
    invalid(`source url is not a remote repository: ${(err as Error).message}`)
  }
  const scp = SCP_PARTS_RE.exec(normalized)
  if (scp && !SCHEME_RE.test(normalized)) {
    return `https://${canonicalHost(scp[2]!)}/${canonicalPath(scp[3]!)}`
  }
  const url = new URL(normalized)
  const host = canonicalHost(url.hostname)
  if (!host) invalid('source url must name a host')
  const path = canonicalPath(url.pathname)
  if (url.protocol === 'https:') return `https://${host}${url.port ? `:${url.port}` : ''}/${path}`
  // ssh: the standard port is the same repository as its HTTPS authority; any other port keeps its own identity.
  if (!url.port || url.port === '22') return `https://${host}/${path}`
  return `ssh://${host}:${url.port}/${path}`
}

/** The `anon` repository id: SHA-256 of the canonical URL. */
export function anonRepoId(url: string): string {
  return sha256Hex(canonicalSourceUrl(url))
}

/** The `cred` repository id: the provider-qualified numeric id (`github:123`). */
export function credRepoId(provider: string, externalId: string): string {
  if (!isCodeHostProvider(provider)) invalid('unknown code-host provider')
  if (!CodeHostExternalId.safeParse(externalId).success) invalid('code-host id must be a decimal number')
  return `${provider}:${externalId}`
}

/** Validate a full ref under `prefix` against a subset of `git check-ref-format`. */
function assertFullRefUnder(ref: string, prefix: 'refs/heads/' | 'refs/tags/', label: string): void {
  if (typeof ref !== 'string' || !ref.startsWith(prefix) || ref.length > 1024)
    invalid(`ref must be a ${prefix}<${label}> name`)
  const name = ref.slice(prefix.length)
  if (!name || name.endsWith('/') || name.endsWith('.') || name.includes('..') || name.includes('@{')) {
    invalid(`ref is not a valid ${label} name`)
  }
  if (name === '@' || /[\u0000- \u007f~^:?*[\\]/.test(name)) invalid(`ref is not a valid ${label} name`)
  for (const component of name.split('/')) {
    if (!component || component.startsWith('.') || component.endsWith('.lock'))
      invalid(`ref is not a valid ${label} name`)
  }
}

/** Validate a branch ref against a subset of `git check-ref-format` and require `refs/heads/`. */
export function assertBranchRef(ref: string): void {
  assertFullRefUnder(ref, 'refs/heads/', 'branch')
}

/** A skill Source's full ref: a branch or a tag (source-cache.md §8). */
export function assertSkillRef(ref: string): void {
  if (typeof ref === 'string' && ref.startsWith('refs/tags/')) assertFullRefUnder(ref, 'refs/tags/', 'tag')
  else assertBranchRef(ref)
}

/** The `refHash` segment: SHA-256 of the full ref name. */
export function refHash(ref: string): string {
  assertBranchRef(ref)
  return sha256Hex(ref)
}

export interface SourceCacheRepoKey {
  org: string
  class: SourceCacheClass
  repo: string
}

function repoPrefix({ org, class: cls, repo }: SourceCacheRepoKey): string {
  if (typeof org !== 'string' || !ORG_RE.test(org)) invalid('org must be 1-64 characters of [A-Za-z0-9_-]')
  if (cls === 'anon') {
    if (!ANON_REPO_RE.test(repo)) invalid('an anon repo id must be a lower-case SHA-256 hex digest')
  } else if (cls === 'cred') {
    const match = CRED_REPO_RE.exec(repo)
    if (!match || !isCodeHostProvider(match[1])) invalid('a cred repo id must be <provider>:<decimal id>')
  } else {
    invalid('class must be anon or cred')
  }
  return `src/${org}/${cls}/${repo}`
}

/** `src/<org>/<class>/<repo>/refs/<refHash>/<shape>/latest`. */
export function pointerKey(input: SourceCacheRepoKey & { ref: string; shape: SourceCacheShape }): SourceCacheObjectKey {
  if (!SHAPES.includes(input.shape)) invalid('shape must be blobless or full')
  return `${repoPrefix(input)}/refs/${refHash(input.ref)}/${input.shape}/latest` as SourceCacheObjectKey
}

/** A skill Source's pointer: the same layout, keyed on its full branch or tag ref, always `blobless` (source-cache.md §4, §8). */
export function skillPointerKey(input: SourceCacheRepoKey & { ref: string }): SourceCacheObjectKey {
  assertSkillRef(input.ref)
  return `${repoPrefix(input)}/refs/${sha256Hex(input.ref)}/blobless/latest` as SourceCacheObjectKey
}

/** `src/<org>/<class>/<repo>/bundles/<uuid>.bundle`. */
export function bundleKey(input: SourceCacheRepoKey & { id: string }): SourceCacheObjectKey {
  if (typeof input.id !== 'string' || !UUID_V4_RE.test(input.id)) invalid('bundle id must be a lower-case v4 UUID')
  return `${repoPrefix(input)}/bundles/${input.id}.bundle` as SourceCacheObjectKey
}

/** A fresh bundle id for `bundleKey`. */
export function newBundleId(): string {
  return randomUUID()
}

const OBJECT_KEY_RE =
  /^src\/[A-Za-z0-9_-]{1,64}\/(?:anon\/[0-9a-f]{64}|cred\/([a-z]+):(?:0|[1-9]\d*))\/(?:refs\/[0-9a-f]{64}\/(?:blobless|full)\/latest|bundles\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.bundle)$/

/** Runtime guard for the presigner: exactly a pointer or bundle key `pointerKey`/`bundleKey` could have built. */
export function isSourceCacheObjectKey(key: unknown): key is SourceCacheObjectKey {
  if (typeof key !== 'string' || key.length > 900) return false
  const match = OBJECT_KEY_RE.exec(key)
  return match !== null && (match[1] === undefined || isCodeHostProvider(match[1]))
}

export type ParsedSourceCacheObjectKey = { orgId: string; repoClass: SourceCacheClass; repoId: string } & (
  { kind: 'pointer'; refHash: string; shape: SourceCacheShape } | { kind: 'bundle'; id: string }
)

const OBJECT_KEY_PARTS_RE =
  /^src\/([^/]+)\/(anon|cred)\/([^/]+)\/(?:refs\/([0-9a-f]{64})\/(blobless|full)\/latest|bundles\/([0-9a-f-]{36})\.bundle)$/

/** Split a key `isSourceCacheObjectKey` accepts into its §4 segments; undefined for any other string. */
export function parseSourceCacheObjectKey(key: unknown): ParsedSourceCacheObjectKey | undefined {
  if (!isSourceCacheObjectKey(key)) return undefined
  const match = OBJECT_KEY_PARTS_RE.exec(key)
  if (!match) return undefined
  const [, orgId, repoClass, repoId, hash, shape, id] = match
  const repo = { orgId: orgId!, repoClass: repoClass as SourceCacheClass, repoId: repoId! }
  if (id !== undefined) return { ...repo, kind: 'bundle', id }
  return { ...repo, kind: 'pointer', refHash: hash!, shape: shape as SourceCacheShape }
}
