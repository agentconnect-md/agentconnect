// The session page's artifact viewer in its URL (artifacts.md §11.2): which artifact, revision and site page, and where it opened.
import { artifactPath, isArtifactId, requestedRevision } from './artifact'
import { readViewerPath, VIEWER_PATH_PARAM } from './artifact-content/viewer-path'

/** The open artifact's id. */
export const ARTIFACT_PARAM = 'artifact'
/** The pinned revision, as the standalone page's `?revision=`; absent opens the latest. */
export const ARTIFACT_REVISION_PARAM = 'artifactRevision'
/** The site page the frame shows, as the standalone page's `?path=`. */
export const ARTIFACT_PATH_PARAM = 'artifactPath'
/** `pane` for the left conversation pane; absent is the dock's Artifacts tab. */
export const ARTIFACT_PLACE_PARAM = 'artifactIn'

const ARTIFACT_PARAMS = [ARTIFACT_PARAM, ARTIFACT_REVISION_PARAM, ARTIFACT_PATH_PARAM, ARTIFACT_PLACE_PARAM] as const

/** Where a session page opens the viewer: opposite the card, so the conversation in progress keeps its composer. */
export type ArtifactPlacement = 'dock' | 'pane'

/** What to open: one artifact, pinned to a revision when one is given, at a site page when one is given. */
export interface ArtifactViewerTarget {
  artifactId: string
  revision?: number
  path?: string | null
}

/** The viewer the URL names. */
export interface ArtifactViewerState {
  artifactId: string
  revision?: number
  path: string | null
  placement: ArtifactPlacement
}

/** The viewer a session URL names, or null; a malformed id names none, a malformed revision or path is dropped. */
export function readArtifactViewer(params: Pick<URLSearchParams, 'get'>): ArtifactViewerState | null {
  const artifactId = params.get(ARTIFACT_PARAM)
  if (!artifactId || !isArtifactId(artifactId)) return null
  const revision = requestedRevision(params.get(ARTIFACT_REVISION_PARAM))
  return {
    artifactId,
    ...(revision !== undefined ? { revision } : {}),
    path: readViewerPath(params.get(ARTIFACT_PATH_PARAM)),
    placement: params.get(ARTIFACT_PLACE_PARAM) === 'pane' ? 'pane' : 'dock'
  }
}

/** A copy of `params` naming `state`, or naming no viewer for null; every other parameter is kept. */
export function writeArtifactViewer(
  params: URLSearchParams | string,
  state: ArtifactViewerState | null
): URLSearchParams {
  const next = new URLSearchParams(params)
  for (const key of ARTIFACT_PARAMS) next.delete(key)
  if (!state) return next
  next.set(ARTIFACT_PARAM, state.artifactId)
  if (state.revision !== undefined) next.set(ARTIFACT_REVISION_PARAM, String(state.revision))
  if (state.path) next.set(ARTIFACT_PATH_PARAM, state.path)
  if (state.placement === 'pane') next.set(ARTIFACT_PLACE_PARAM, 'pane')
  return next
}

/** The standalone page showing the same artifact, revision and site page, for Full screen and phones. */
export function artifactStandalonePath(target: ArtifactViewerTarget): string {
  const base = artifactPath(target.artifactId, target.revision)
  if (!target.path) return base
  const query = new URLSearchParams({ [VIEWER_PATH_PARAM]: target.path })
  return `${base}${base.includes('?') ? '&' : '?'}${query}`
}
