// Artifacts in the console (artifacts.md §8.1, §9, §11): the transcript marker, how an entry renders, and paths inside a revision.

/** One revision's file, as the manifest lists it. */
export interface ArtifactManifestFile {
  path: string
  sha256: string
  bytes: number
  mediaType: string
}

export interface ArtifactRevisionSummary {
  number: number
  entry: string
  entryMediaType: string
  fileCount: number
  totalBytes: number
  producedBy: { agentId: string; name: string }
  producedInSessionId: string
  createdAt: string
}

export type ArtifactVisibility = 'private' | 'org' | 'external' | 'editors'

/** `GET /artifacts/:artifactId`; revisions are the ready ones, newest first. */
export interface ArtifactDto {
  id: string
  title: string
  audience: { visibility: ArtifactVisibility; externalProvider: string | null; editorsAgentId: string | null }
  owner: { userId: string | null; displayName: string | null; email: string | null; platform: string | null } | null
  viewerIsOwner: boolean
  originSessionId: string | null
  latestRevision: number
  createdAt: string
  updatedAt: string
  revisions: ArtifactRevisionSummary[]
}

/** One row of `GET /sessions/:sessionId/artifacts`: the artifact with its latest ready revision. */
export interface SessionArtifactDto extends Omit<ArtifactDto, 'revisions'> {
  latest: ArtifactRevisionSummary
}

/** A page of a session's artifacts, most recently updated first; it may hold fewer than asked for while `nextCursor` names more. */
export interface SessionArtifactPageDto {
  artifacts: SessionArtifactDto[]
  nextCursor: string | null
}

/** What the caller may do with a listed artifact (artifacts.md §6.3); `revokeShares` is also the right to delete. */
export interface ArtifactPermissions {
  rename: boolean
  changeAudience: boolean
  sharePublic: boolean
  revokeShares: boolean
}

/** One row of `GET /orgs/:orgId/artifacts`, the Artifacts page (artifacts.md §11.5). */
export interface OrgArtifactDto extends SessionArtifactDto {
  kind: ArtifactKind
  shared: { any: boolean; public: boolean }
  /** Whether the originating session still exists and the caller can open it. */
  originSessionVisible: boolean
  permissions: ArtifactPermissions
}

/** A page of the organization's artifacts; a `type` filter can return a short or empty page while `nextCursor` names more. */
export interface OrgArtifactPageDto {
  artifacts: OrgArtifactDto[]
  nextCursor: string | null
}

/** The Artifacts page's filters as `listArtifacts` takes them. */
export interface ArtifactListFilters {
  scope?: 'mine' | 'org'
  agentId?: string
  type?: ArtifactKind
  publiclyShared?: boolean
}

/** `GET /artifacts/:artifactId/revisions/:revision`. */
export interface ArtifactRevisionDto extends ArtifactRevisionSummary {
  artifactId: string
  latestRevision: number
  manifest: { entry: string; files: ArtifactManifestFile[] }
}

/** `GET /artifacts/:artifactId/revisions/:revision/file`: a short-lived GET signed as an `octet-stream` attachment. */
export interface ArtifactFileUrlDto extends ArtifactManifestFile {
  url: string
  expiresAt: string
}

/** Who a share link admits (artifacts.md §8.3): anyone holding it, or signed-in members of the artifact's organization. */
export type ArtifactShareAudience = 'public' | 'org'

/** One share as its managers list it; the token itself is never listed, only its tail. */
export interface ArtifactShareDto {
  id: string
  artifactId: string
  revision: number
  audience: ArtifactShareAudience
  /** The token's last characters behind an ellipsis, to tell links apart. */
  displayTail: string
  createdBy: { userId: string | null; displayName: string | null; email: string | null; platform: string | null }
  createdAt: string
  updatedAt: string
  revokedAt: string | null
}

/** One active `public` share as organization owners moderate it, with its artifact's metadata only (artifacts.md §6.3). */
export interface OrgArtifactShareDto extends ArtifactShareDto {
  artifact: { id: string; title: string; owner: ArtifactDto['owner']; viewerCanView: boolean }
}

export interface OrgArtifactSharePageDto {
  shares: OrgArtifactShareDto[]
  nextCursor: string | null
}

/** `POST /artifacts/:artifactId/shares`: the only answer that carries the token, so the link can be copied only now. */
export interface CreatedArtifactShareDto extends ArtifactShareDto {
  token: string
  /** `/share/<token>` on the console origin. */
  linkPath: string
  link: string | null
}

/** `POST /artifact-shares/read`: what a share link shows; no session, owner or newer revision. */
export interface SharedArtifactDto {
  artifactId: string
  title: string
  audience: ArtifactShareAudience
  organization: { name: string }
  sharedAt: string
  revision: Pick<
    ArtifactRevisionDto,
    'number' | 'entry' | 'entryMediaType' | 'fileCount' | 'totalBytes' | 'createdAt' | 'manifest'
  >
}

export interface ArtifactMarker {
  artifactId: string
  revision: number
  title: string
}

// Mirror of protocol's parseArtifactMarker (frames/artifact.ts is not a bundler-safe leaf); artifact.test.ts pins it.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const MARKER_RE = /(?:^|\n)\[artifact: ([0-9a-f-]{36}) r([1-9]\d{0,8}) ("(?:[^"\\\n]|\\.)*")\]$/

/** The marker on a row's last line and the caption before it, or null when the row ends in none. */
export function parseArtifactMarker(text: string): { caption: string; artifact: ArtifactMarker } | null {
  const match = MARKER_RE.exec(text)
  if (!match) return null
  const [whole, artifactId, revision, quoted] = match as unknown as [string, string, string, string]
  if (!UUID_RE.test(artifactId)) return null
  let title: unknown
  try {
    title = JSON.parse(quoted)
  } catch {
    return null
  }
  if (typeof title !== 'string') return null
  const caption = text.slice(0, text.length - whole.length)
  return { caption, artifact: { artifactId, revision: Number(revision), title } }
}

/** The distinct markers in these texts as one string, which changes only when a new card or revision lands in the transcript. */
export function artifactMarkerKey(texts: Iterable<string>): string {
  const seen = new Set<string>()
  for (const text of texts) {
    if (!text.includes('[artifact: ')) continue
    const marker = parseArtifactMarker(text)?.artifact
    if (marker) seen.add(`${marker.artifactId}:${marker.revision}`)
  }
  return [...seen].sort().join(',')
}

/** The console path of one artifact, pinned to a revision when one is given (artifacts.md §8.2). */
export function artifactPath(artifactId: string, revision?: number): string {
  const base = `/artifacts/${encodeURIComponent(artifactId)}`
  return revision === undefined ? base : `${base}?revision=${revision}`
}

/** The revision a `?revision=` value asks for, or undefined when it names none. */
export function requestedRevision(value: string | null): number | undefined {
  if (!value || !/^[1-9]\d{0,8}$/.test(value)) return undefined
  return Number(value)
}

/** The revision a viewer shows for an asked one: that revision while kept, else the latest kept, with the asked one as `missing`. */
export function shownRevision(
  artifact: Pick<ArtifactDto, 'revisions' | 'latestRevision'>,
  asked: number | undefined
): { shown: number; missing?: number } {
  if (asked !== undefined && artifact.revisions.some((r) => r.number === asked)) return { shown: asked }
  const shown = artifact.revisions[0]?.number ?? artifact.latestRevision
  return asked === undefined ? { shown } : { shown, missing: asked }
}

/** Whether a string has the shape of an artifact id. */
export function isArtifactId(value: string): boolean {
  return UUID_RE.test(value)
}

/** How an entry opens (artifacts.md §9), which also picks the card's icon. */
export type ArtifactKind = 'page' | 'document' | 'image' | 'pdf' | 'code' | 'other'

const TEXT_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/ecmascript',
  'application/typescript',
  'application/x-sh',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/sql',
  'application/x-ndjson'
])
const MARKDOWN_RE = /\.(md|markdown)$/i

export function artifactKind(mediaType: string, path: string): ArtifactKind {
  const type = mediaType.toLowerCase().split(';')[0]!.trim()
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'page'
  if (type === 'text/markdown' || type === 'text/x-markdown' || MARKDOWN_RE.test(path)) return 'document'
  if (type.startsWith('image/')) return 'image'
  if (type === 'application/pdf') return 'pdf'
  if (type.startsWith('text/') || TEXT_TYPES.has(type) || type.endsWith('+json') || type.endsWith('+xml')) return 'code'
  return 'other'
}

export const ARTIFACT_KIND_ICON: Record<ArtifactKind, string> = {
  page: 'app-window',
  document: 'file-text',
  image: 'image',
  pdf: 'book-open',
  code: 'file-code',
  other: 'file'
}

/** The last segment of a manifest path, the name a single-file download saves under. */
export function artifactFileName(path: string): string {
  return path.split('/').pop() || path
}

/** A zip's file name from the artifact title: characters file systems refuse become `-`. */
export function artifactZipName(title: string): string {
  const base = title
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 120)
    .trim()
  return `${base || 'artifact'}.zip`
}

/** A reference inside an entry resolved to a manifest path beside it, or null for an absolute, external or escaping one. */
export function resolveArtifactRef(entry: string, ref: string): string | null {
  const bare = ref.split(/[?#]/, 1)[0] ?? ''
  if (!bare || bare.startsWith('/') || bare.startsWith('\\') || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return null
  let decoded: string
  try {
    decoded = decodeURIComponent(bare)
  } catch {
    return null
  }
  const segments = entry.split('/').slice(0, -1)
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (!segments.length) return null
      segments.pop()
    } else segments.push(segment)
  }
  return segments.length ? segments.join('/') : null
}

const MD_INLINE_IMAGE_RE = /!\[(?:[^\]\\\n]|\\.)*\]\(\s*(?:<([^>\n]+)>|([^\s)]+))/g
const MD_DEFINITION_RE = /^ {0,3}\[[^\]\n]+\]:\s*(?:<([^>\n]+)>|(\S+))/gm

/** The sources a Markdown text's images may name: inline images and reference definitions, which the renderer confirms. */
export function markdownImageRefs(markdown: string): string[] {
  const refs = new Set<string>()
  for (const re of [MD_INLINE_IMAGE_RE, MD_DEFINITION_RE])
    for (const match of markdown.matchAll(re)) refs.add((match[1] ?? match[2])!)
  return [...refs]
}

/** The CP's refusal on a deployment that does not offer artifacts, told apart from a 404 by its code (artifacts.md §12). */
export const ARTIFACTS_NOT_ENABLED = 'ARTIFACTS_NOT_ENABLED'

/** The content domain revisions render under, published only while the deployment offers artifacts. */
export function artifactsContentDomain(): string | undefined {
  const domain =
    typeof window === 'undefined' ? process.env.ARTIFACTS_CONTENT_DOMAIN : window.__AC_ENV?.ARTIFACTS_CONTENT_DOMAIN
  return domain || undefined
}
