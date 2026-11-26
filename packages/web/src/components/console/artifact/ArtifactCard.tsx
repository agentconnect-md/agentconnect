'use client'

// The card a publication leaves in a conversation, pinned to its revision (artifacts.md §11.1).
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { formatFileSize } from '@/components/console/FileBrowser'
import { ApiError, getArtifact } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import {
  ARTIFACT_KIND_ICON,
  ARTIFACTS_NOT_ENABLED,
  artifactKind,
  artifactPath,
  artifactsContentDomain,
  type ArtifactMarker
} from '@/lib/artifact'
import { useArtifactDownload } from './useArtifactDownload'

const ACTION =
  'inline-flex flex-none items-center gap-[6px] rounded-md border border-(--border-default) bg-(--surface-card) px-[10px] py-[5px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary) no-underline transition-colors hover:border-(--border-strong) hover:bg-(--surface-hover) disabled:cursor-default disabled:opacity-55'

/** What the card can say about its revision once the artifact has been read. */
export type ArtifactCardState = 'loading' | 'latest' | 'newer' | 'aged-out' | 'unavailable' | 'not-enabled'

export function ArtifactCard({ marker }: { marker: ArtifactMarker }) {
  const t = useTranslations('Artifacts.card')
  const { activeOrg, orgPath } = useOrgs()
  const { artifactId, revision } = marker
  // A deployment without artifacts reads nothing (artifacts.md §12); a CP that says so mid-session gets the same state.
  const enabled = artifactsContentDomain() !== undefined
  const read = useSWR(
    enabled ? consoleKeys.artifact(activeOrg?.id, artifactId) : null,
    ([, , , id]) => getArtifact(id),
    { shouldRetryOnError: (err) => !(err instanceof ApiError && (err.status === 404 || err.status === 409)) }
  )
  const artifact = read.data
  const summary = artifact?.revisions.find((r) => r.number === revision)
  // The route answers 404 alike for a deleted artifact and one outside the viewer's audience.
  const state: ArtifactCardState =
    !enabled || (read.error instanceof ApiError && read.error.code === ARTIFACTS_NOT_ENABLED)
      ? 'not-enabled'
      : read.error instanceof ApiError && read.error.status === 404
        ? 'unavailable'
        : !artifact
          ? 'loading'
          : !summary
            ? 'aged-out'
            : artifact.latestRevision > revision
              ? 'newer'
              : 'latest'
  const title = artifact?.title ?? marker.title
  const kind = summary ? artifactKind(summary.entryMediaType, summary.entry) : null
  const download = useArtifactDownload(artifactId, revision, title)
  const unavailable = state === 'unavailable' || state === 'not-enabled'

  const meta = [
    t('revision', { number: revision }),
    summary ? formatFileSize(summary.totalBytes) : '',
    summary && summary.fileCount > 1 ? t('files', { count: summary.fileCount }) : ''
  ].filter(Boolean)

  return (
    <div
      data-testid="artifact-card"
      data-state={state}
      className="flex w-full max-w-[460px] min-w-0 flex-col gap-[10px] rounded-md border border-(--border-default) bg-(--surface-card) p-3"
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex h-9 w-9 flex-none items-center justify-center rounded-sm border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon
            name={state === 'unavailable' ? 'file-x' : kind ? ARTIFACT_KIND_ICON[kind] : 'file'}
            size={17}
            color="var(--text-secondary)"
          />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)">
            {title}
          </div>
          <div className="mt-[2px] flex min-w-0 flex-wrap items-center gap-x-2 gap-y-[2px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            <span>{meta.join(' · ')}</span>
            {state === 'newer' && (
              <span className="inline-flex items-center gap-1 font-medium text-(--text-secondary)">
                <Icon name="circle-arrow-up" size={12} />
                {t('newer', { number: artifact!.latestRevision })}
              </span>
            )}
            {state === 'aged-out' && <span className="font-medium text-(--text-secondary)">{t('agedOut')}</span>}
            {state === 'unavailable' && <span className="font-medium text-(--text-secondary)">{t('unavailable')}</span>}
            {state === 'not-enabled' && <span className="font-medium text-(--text-secondary)">{t('notEnabled')}</span>}
          </div>
        </div>
      </div>
      {!unavailable && (
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Link className={ACTION} href={orgPath(artifactPath(artifactId, revision))}>
            <Icon name="external-link" size={13} color="var(--text-secondary)" />
            {t('open')}
          </Link>
          <button
            type="button"
            className={ACTION}
            disabled={download.busy || state === 'aged-out'}
            aria-busy={download.busy}
            onClick={() => void download.run()}
          >
            {download.busy ? <Spinner size={12} /> : <Icon name="download" size={13} color="var(--text-secondary)" />}
            {t('download')}
          </button>
          {download.failed && (
            <span role="alert" className="font-sans text-[11.5px] font-medium leading-normal text-(--red-600)">
              {t('downloadFailed')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
