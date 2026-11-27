// Share links in the console (artifacts.md §6.3, §8.3): who may do what in the Share dialog, and what a share page shows.
import { ApiError } from '@/lib/api'
import { ARTIFACTS_NOT_ENABLED, type ArtifactDto, type ArtifactShareDto } from '@/lib/artifact'

/** The CP's refusal when §6.3 does not let the caller take a share action. */
export const ARTIFACT_SHARE_FORBIDDEN = 'ARTIFACT_SHARE_FORBIDDEN'
export const ARTIFACT_REVISION_NOT_READY = 'ARTIFACT_REVISION_NOT_READY'
export const ARTIFACT_SHARE_NOT_FOUND = 'ARTIFACT_SHARE_NOT_FOUND'
export const ARTIFACT_SHARE_REVOKED = 'ARTIFACT_SHARE_REVOKED'
export const ARTIFACT_SHARE_MEMBERS_ONLY = 'ARTIFACT_SHARE_MEMBERS_ONLY'

/** The console page a share link opens, outside every organization path. */
export const SHARE_PAGE_PREFIX = '/share/'

/** Who is looking at the dialog: the artifact as the viewer read it, their organization role and their user id. */
export interface ShareViewer {
  artifact: Pick<ArtifactDto, 'viewerIsOwner'>
  role: string | null
  userId: string | null
}

/** §6.3: a `public` share, and moving a share between audiences, belong to the owner and to organization owners who can view. */
export function canSharePublicly(viewer: ShareViewer): boolean {
  return viewer.artifact.viewerIsOwner || viewer.role === 'owner'
}

/** The owner and organization owners revoke any share; a share's creator may revoke their own, which the server confirms. */
export function canRevokeShare(viewer: ShareViewer, share: Pick<ArtifactShareDto, 'createdBy'>): boolean {
  if (canSharePublicly(viewer)) return true
  return viewer.userId !== null && share.createdBy.userId === viewer.userId
}

/** The absolute link of a share created just now: the CP's when it knows the console origin, else this page's. */
export function shareLink(created: { link: string | null; linkPath: string }, origin: string): string {
  return created.link ?? new URL(created.linkPath, origin).href
}

/** What a share page shows for a read that failed. */
export type SharePageProblem = 'notEnabled' | 'revoked' | 'notFound' | 'membersOnly' | 'signIn' | 'failed'

export function sharePageProblem(error: unknown): SharePageProblem {
  if (!(error instanceof ApiError)) return 'failed'
  if (error.code === ARTIFACTS_NOT_ENABLED) return 'notEnabled'
  if (error.status === 410 || error.code === ARTIFACT_SHARE_REVOKED) return 'revoked'
  if (error.code === ARTIFACT_SHARE_MEMBERS_ONLY) return 'membersOnly'
  if (error.status === 401) return 'signIn'
  if (error.status === 404) return 'notFound'
  return 'failed'
}

/** A share token from the page's route segment; null for anything the CP could never have minted. */
export function shareTokenOf(segment: string | undefined): string | null {
  if (!segment) return null
  let token: string
  try {
    token = decodeURIComponent(segment)
  } catch {
    return null
  }
  return /^[A-Za-z0-9_-]{1,256}$/.test(token) ? token : null
}
