'use client'

// The viewer in place on a session page, in the dock's Artifacts tab or the left pane (artifacts.md §11.2): reads the artifact, then hands it to ArtifactViewer.
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { ApiError, getArtifact } from '@/lib/api'
import { ARTIFACTS_NOT_ENABLED, shownRevision } from '@/lib/artifact'
import { artifactStandalonePath, type ArtifactViewerState } from '@/lib/artifact-viewer-url'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { ArtifactViewer } from './ArtifactViewer'
import { ArtifactBodyNotice } from './ArtifactBody'
import { useFollowLatest } from './useFollowLatest'

export function SessionArtifactViewer({
  viewer,
  onClose,
  onRevision,
  onPath
}: {
  viewer: ArtifactViewerState
  onClose: () => void
  onRevision: (revision: number) => void
  onPath: (path: string | null) => void
}) {
  const t = useTranslations('Artifacts')
  const { activeOrg, orgPath } = useOrgs()
  const read = useSWR(consoleKeys.artifact(activeOrg?.id, viewer.artifactId), ([, , , id]) => getArtifact(id), {
    shouldRetryOnError: (err) => !(err instanceof ApiError && (err.status === 404 || err.status === 409))
  })
  const artifact = read.data
  const variant = viewer.placement
  // While the latest is shown a newer revision takes its place (§11.4); a choice of revision ends the notice.
  const follow = useFollowLatest(artifact, viewer.revision, onRevision)
  const choose = (revision: number) => {
    follow.dismiss()
    onRevision(revision)
  }

  if (!artifact) {
    // A deleted artifact and one outside the viewer's audience answer the same 404, so the copy names neither.
    const gone =
      read.error instanceof ApiError && (read.error.code === ARTIFACTS_NOT_ENABLED || read.error.status === 404)
    const notice = !read.error
      ? null
      : read.error instanceof ApiError && read.error.code === ARTIFACTS_NOT_ENABLED
        ? t('card.notEnabled')
        : gone
          ? t('card.unavailable')
          : t('page.loadFailed')
    return (
      <section
        data-testid="artifact-viewer"
        data-variant={variant}
        data-state={notice ? 'unavailable' : 'loading'}
        className={
          variant === 'pane' ? 'card flex min-h-0 flex-1 flex-col overflow-hidden' : 'flex min-h-0 flex-1 flex-col'
        }
      >
        <div className="flex flex-none items-center justify-end border-b border-(--border-subtle) px-3 py-2">
          <button
            type="button"
            className="iconbtn flex-none"
            data-artifact-viewer-close=""
            aria-label={variant === 'dock' ? t('viewer.backToList') : t('viewer.backToConversation')}
            title={variant === 'dock' ? t('viewer.backToList') : t('viewer.backToConversation')}
            onClick={onClose}
          >
            <Icon name={variant === 'dock' ? 'chevron-left' : 'x'} size={15} />
          </button>
        </div>
        {notice ? (
          <ArtifactBodyNotice icon={gone ? 'file-x' : 'triangle-exclamation-point'} tone={gone ? 'muted' : 'error'}>
            {notice}
          </ArtifactBodyNotice>
        ) : (
          <div className="flex flex-1 items-center justify-center py-12" aria-busy="true">
            <Spinner size={30} />
          </div>
        )}
      </section>
    )
  }

  const { shown, missing } = shownRevision(artifact, viewer.revision)
  return (
    <ArtifactViewer
      artifact={artifact}
      revision={shown}
      {...(missing !== undefined ? { missing } : {})}
      onRevision={choose}
      path={viewer.path}
      onPath={onPath}
      variant={variant}
      onClose={onClose}
      fullScreenHref={orgPath(artifactStandalonePath({ artifactId: artifact.id, revision: shown, path: viewer.path }))}
      updatedTo={follow.updatedTo}
      onDismissUpdated={follow.dismiss}
    />
  )
}
