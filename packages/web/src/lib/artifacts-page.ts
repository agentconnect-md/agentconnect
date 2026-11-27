// The Artifacts page (artifacts.md §6.3, §11.5): URL-backed filters, paging, and which row actions the caller gets.
import type {
  ArtifactDto,
  ArtifactKind,
  ArtifactListFilters,
  OrgArtifactDto,
  OrgArtifactShareDto
} from '@/lib/artifact'

export const ARTIFACT_UPDATE_FORBIDDEN = 'ARTIFACT_UPDATE_FORBIDDEN'
export const ARTIFACT_AUDIENCE_FIXED = 'ARTIFACT_AUDIENCE_FIXED'
export const ARTIFACT_CHANGED = 'ARTIFACT_CHANGED'
export const ARTIFACT_DELETE_FORBIDDEN = 'ARTIFACT_DELETE_FORBIDDEN'
export const ARTIFACT_MODERATION_FORBIDDEN = 'ARTIFACT_MODERATION_FORBIDDEN'

/** Mirror of protocol's ARTIFACT_TITLE_MAX (frames/artifact.ts is not a bundler-safe leaf); the test pins it. */
export const ARTIFACT_TITLE_MAX = 200

/** Rows the page asks for at a time, and how many more each "Load more" draws. */
export const ARTIFACTS_PAGE_SIZE = 25

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['page', 'document', 'image', 'pdf', 'code', 'other']

export interface ArtifactsPageFilters {
  scope: 'mine' | 'org'
  agentId: string | null
  type: ArtifactKind | null
  publiclyShared: boolean
}

export type ArtifactsPageTab = 'artifacts' | 'public'

const isKind = (value: string | null): value is ArtifactKind =>
  value !== null && (ARTIFACT_KINDS as readonly string[]).includes(value)

/** The filters a page URL names; anything unrecognised reads as unset. */
export function readArtifactFilters(params: Pick<URLSearchParams, 'get'>): ArtifactsPageFilters {
  const type = params.get('type')
  const agent = params.get('agent')
  return {
    scope: params.get('scope') === 'mine' ? 'mine' : 'org',
    agentId: agent && /^[0-9a-f-]{36}$/i.test(agent) ? agent : null,
    type: isKind(type) ? type : null,
    publiclyShared: params.get('public') === '1'
  }
}

export function readArtifactsTab(params: Pick<URLSearchParams, 'get'>): ArtifactsPageTab {
  return params.get('tab') === 'public' ? 'public' : 'artifacts'
}

/** The page URL's query for these filters and tab; the defaults stay out of it. */
export function artifactsPageQuery(filters: ArtifactsPageFilters, tab: ArtifactsPageTab = 'artifacts'): string {
  const q = new URLSearchParams()
  if (tab === 'public') q.set('tab', 'public')
  if (filters.scope === 'mine') q.set('scope', 'mine')
  if (filters.agentId) q.set('agent', filters.agentId)
  if (filters.type) q.set('type', filters.type)
  if (filters.publiclyShared) q.set('public', '1')
  return q.toString()
}

/** One canonical string per filter set, for the list's cache key; `parseArtifactFilterKey` reads it back. */
export function artifactFilterKey(filters: ArtifactsPageFilters): string {
  return artifactsPageQuery(filters)
}

export function parseArtifactFilterKey(key: string): ArtifactListFilters {
  const filters = readArtifactFilters(new URLSearchParams(key))
  return {
    ...(filters.scope === 'mine' ? { scope: 'mine' as const } : {}),
    ...(filters.agentId ? { agentId: filters.agentId } : {}),
    ...(filters.type ? { type: filters.type } : {}),
    ...(filters.publiclyShared ? { publiclyShared: true } : {})
  }
}

export function artifactFiltersActive(filters: ArtifactsPageFilters): boolean {
  return filters.scope === 'mine' || filters.agentId !== null || filters.type !== null || filters.publiclyShared
}

/** Whether to read the next page by itself: a filtered page can come back short or empty while older rows remain. */
export function followNextPage(read: {
  rows: number
  target: number
  nextCursor: string | null
  failed: boolean
  loading: boolean
}): boolean {
  return !read.failed && !read.loading && read.nextCursor !== null && read.rows < read.target
}

/** Rows of every page, first occurrence kept: a rename moves a row to the top while older pages are still cached. */
export function uniqueRows<T extends { id: string }>(pages: readonly { rows: readonly T[] }[]): T[] {
  const byId = new Map<string, T>()
  for (const page of pages) for (const row of page.rows) if (!byId.has(row.id)) byId.set(row.id, row)
  return [...byId.values()]
}

/** What the Shared column says: an active `public` link, only `org` links, or none. */
export function artifactSharedState(row: Pick<OrgArtifactDto, 'shared'>): 'public' | 'org' | 'none' {
  if (row.shared.public) return 'public'
  return row.shared.any ? 'org' : 'none'
}

/** Who the Owner column names; an artifact without an owner belongs to organization owners (D21). */
export type ArtifactOwnerLabel =
  | { kind: 'you' }
  | { kind: 'orgOwners' }
  | { kind: 'name'; name: string }
  | { kind: 'platform'; platform: string }
  | { kind: 'unknown' }

export function artifactOwnerLabel(owner: ArtifactDto['owner'], viewerIsOwner = false): ArtifactOwnerLabel {
  if (viewerIsOwner) return { kind: 'you' }
  if (!owner) return { kind: 'orgOwners' }
  const name = owner.displayName || owner.email
  if (name) return { kind: 'name', name }
  if (owner.platform) return { kind: 'platform', platform: owner.platform }
  return { kind: 'unknown' }
}

/** The row actions the caller gets; an audience copied from an `external` or `editors` session is `fixed`. */
export interface ArtifactRowActions {
  open: true
  revisions: true
  share: true
  session: boolean
  rename: boolean
  audience: 'allowed' | 'fixed' | 'hidden'
  delete: boolean
}

export function artifactRowActions(
  row: Pick<OrgArtifactDto, 'originSessionVisible' | 'permissions' | 'audience'>
): ArtifactRowActions {
  const { permissions } = row
  const fixed = row.audience.visibility === 'external' || row.audience.visibility === 'editors'
  return {
    open: true,
    revisions: true,
    share: true,
    session: row.originSessionVisible,
    rename: permissions.rename,
    // The rename right is the audience right minus the audience's kind, so a renamer of a fixed artifact is told why.
    audience: permissions.changeAudience ? 'allowed' : permissions.rename && fixed ? 'fixed' : 'hidden',
    delete: permissions.revokeShares
  }
}

/** A moderated share: revoke and delete never need a view of the artifact, opening it does. */
export function moderationActions(share: Pick<OrgArtifactShareDto, 'artifact'>): {
  open: boolean
  revoke: true
  delete: true
} {
  return { open: share.artifact.viewerCanView, revoke: true, delete: true }
}
