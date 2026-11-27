'use client'

// The viewer: header with the revision menu, Share and Download, the info line, notices, and the entry (artifacts.md §11.3–§11.4, §11.6).
import { useMemo, useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { isCodeHostProvider } from '@agentconnect.md/protocol/code-host'
import { Button, Icon } from '@/components/ui'
import { Spinner } from '@/components/marks'
import { getArtifactRevision } from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { CODE_HOST_PROJECTION } from '@/lib/code-hosts'
import { platformLabel } from '@/lib/platform-labels'
import {
  ARTIFACT_KIND_ICON,
  artifactKind,
  artifactsContentDomain,
  type ArtifactDto,
  type ArtifactRevisionSummary
} from '@/lib/artifact'
import { memberFileUrl } from '@/lib/artifact-download'
import { ArtifactBody, ArtifactBodyNotice } from './ArtifactBody'
import { ArtifactShareDialog } from './ArtifactShareDialog'
import { useArtifactDownload } from './useArtifactDownload'

/** Who can see the artifact, in the session audience's own words. */
function useAudienceLabel(): (audience: ArtifactDto['audience']) => string {
  const t = useTranslations('Sessions.visibility')
  const ta = useTranslations('Artifacts.viewer')
  return (audience) => {
    if (audience.visibility === 'private') return t('private')
    if (audience.visibility === 'org') return t('everyone')
    if (audience.visibility === 'editors') return t('editors')
    const provider = audience.externalProvider
    const name =
      (provider && platformLabel(provider)?.name) ||
      (provider && isCodeHostProvider(provider) ? CODE_HOST_PROJECTION[provider].label : ta('externalProvider'))
    return t('externalMembers', { provider: name })
  }
}

function RevisionMenu({
  revisions,
  shown,
  onSelect
}: {
  revisions: ArtifactRevisionSummary[]
  shown: number
  onSelect: (revision: number) => void
}) {
  const t = useTranslations('Artifacts.viewer')
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  return (
    <div className="relative flex-none">
      <Button
        variant="secondary"
        size="sm"
        ariaHasPopup="menu"
        ariaExpanded={open}
        ariaLabel={t('revisions')}
        onClick={() => setOpen((v) => !v)}
      >
        {t('revisionShort', { number: shown })}
        <Icon name="chevron-down" size={14} />
      </Button>
      {open && (
        <>
          <div onClick={() => setOpen(false)} className="fixed inset-0 z-45" />
          <div
            role="menu"
            className="dmenu max-h-[360px] min-w-[260px] overflow-auto max-desktop:right-auto max-desktop:left-0"
          >
            {revisions.map((r) => (
              <button
                key={r.number}
                type="button"
                role="menuitemradio"
                aria-checked={r.number === shown}
                className="dmi items-start"
                onClick={() => {
                  setOpen(false)
                  if (r.number !== shown) onSelect(r.number)
                }}
              >
                <span className="min-w-0 flex-1 text-left">
                  <span className="block">{t('revision', { number: r.number })}</span>
                  <span className="block truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    {`${format.dateTime(new Date(r.createdAt), { dateStyle: 'medium', timeStyle: 'short' })} · ${r.producedBy.name}`}
                  </span>
                </span>
                {r.number === shown && <Icon name="check" size={14} />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Where the viewer sits: the standalone page, or in place on a session page, the dock's Artifacts tab or the left pane (artifacts.md §11.2). */
export type ArtifactViewerVariant = 'page' | 'dock' | 'pane'

/** One artifact at one revision; `missing` is a requested revision that is no longer kept, so the latest is shown instead. */
export function ArtifactViewer({
  artifact,
  revision,
  missing,
  onRevision,
  path,
  onPath,
  variant = 'page',
  onClose,
  fullScreenHref,
  updatedTo,
  onDismissUpdated
}: {
  artifact: ArtifactDto
  revision: number
  missing?: number
  onRevision: (revision: number) => void
  /** The site page to open first; see `ArtifactSite`. */
  path?: string | null
  onPath?: (path: string | null) => void
  variant?: ArtifactViewerVariant
  /** In place only: back to the dock's list, or back to the conversation from the left pane. */
  onClose?: () => void
  /** In place only: the standalone page showing the same revision and site page. */
  fullScreenHref?: string
  /** The revision the viewer just followed to, for its "Updated to rN" notice (§11.4). */
  updatedTo?: number | null
  onDismissUpdated?: () => void
}) {
  const t = useTranslations('Artifacts.viewer')
  const format = useFormatter()
  const audienceLabel = useAudienceLabel()
  const { activeOrg } = useOrgs()
  const summary = artifact.revisions.find((r) => r.number === revision)
  const read = useSWR(
    consoleKeys.artifactRevision(activeOrg?.id, artifact.id, revision),
    ([, , , id, number]) => getArtifactRevision(id, Number(number)),
    { revalidateOnFocus: false, revalidateIfStale: false }
  )
  const files = read.data?.manifest.files
  const fileUrl = useMemo(() => memberFileUrl(artifact.id, revision), [artifact.id, revision])
  const download = useArtifactDownload(
    files ? { fileUrl, files } : { artifactId: artifact.id, revision },
    artifact.title
  )
  const [sharing, setSharing] = useState(false)
  const inPlace = variant !== 'page'

  const shareButton = (
    <Button
      variant="secondary"
      size="sm"
      ariaHasPopup="dialog"
      ariaLabel={t('share')}
      className="flex-none"
      onClick={() => setSharing(true)}
    >
      <Icon name="share-2" size={14} />
      <span className={inPlace ? 'hidden @min-[560px]:inline' : 'max-desktop:hidden'}>{t('share')}</span>
    </Button>
  )
  const shareDialog = sharing ? (
    <ArtifactShareDialog artifact={artifact} revision={revision} onClose={() => setSharing(false)} />
  ) : null

  const downloadButton = (
    <Button
      variant="secondary"
      size="sm"
      disabled={download.busy || !files}
      onClick={() => void download.run()}
      ariaLabel={t('download')}
    >
      {download.busy ? <Spinner size={12} /> : <Icon name="download" size={14} />}
      {/* In place the label yields to the title below the container's 560px; the page hides it on a phone. */}
      <span className={download.busy ? '' : inPlace ? 'hidden @min-[560px]:inline' : 'max-desktop:hidden'}>
        {download.zipping ? t('zipping') : t('download')}
      </span>
    </Button>
  )

  const info = summary && (
    <>
      <span className="inline-flex min-w-0 items-center gap-1">
        <Icon name="bot" size={13} />
        <span className="truncate">{summary.producedBy.name}</span>
      </span>
      <span aria-hidden>·</span>
      <span>{audienceLabel(artifact.audience)}</span>
      <span aria-hidden>·</span>
      <span title={format.dateTime(new Date(summary.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}>
        {t('updated', { time: format.relativeTime(new Date(summary.createdAt), { now: Date.now() }) })}
      </span>
    </>
  )

  const body = read.data ? (
    <ArtifactBody
      artifactId={artifact.id}
      revision={read.data}
      title={artifact.title}
      download={downloadButton}
      contentDomain={artifactsContentDomain()}
      path={path ?? null}
      onPath={onPath}
      fileUrl={fileUrl}
    />
  ) : read.error ? (
    <ArtifactBodyNotice icon="triangle-exclamation-point" tone="error">
      {t('loadFailed')}
    </ArtifactBodyNotice>
  ) : (
    <div className="flex flex-1 items-center justify-center py-12" aria-busy="true">
      <Spinner size={30} />
    </div>
  )

  const failed = download.failed && t('downloadFailed')
  const gone = missing !== undefined && (
    <>
      <Icon name="info" size={14} color="var(--text-tertiary)" />
      {t('revisionGone', { missing, number: revision })}
    </>
  )
  const newer = missing === undefined && artifact.latestRevision > revision && (
    <>
      <span className="inline-flex items-center gap-2">
        <Icon name="circle-arrow-up" size={14} color="var(--text-tertiary)" />
        {t('newerAvailable', { number: artifact.latestRevision })}
      </span>
      <button type="button" className="lnk text-[12.5px]" onClick={() => onRevision(artifact.latestRevision)}>
        {t('viewLatest')}
      </button>
    </>
  )

  const followed = missing === undefined && updatedTo === revision && (
    <>
      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
        <Icon name="refresh-cw" size={14} color="var(--text-tertiary)" />
        {t('updatedTo', { number: revision })}
      </span>
      {onDismissUpdated ? (
        <button
          type="button"
          className="iconbtn flex-none"
          data-artifact-updated-dismiss=""
          aria-label={t('dismiss')}
          title={t('dismiss')}
          onClick={onDismissUpdated}
        >
          <Icon name="x" size={14} />
        </button>
      ) : null}
    </>
  )
  const notice = gone || newer || followed

  if (inPlace) {
    const kind = summary ? artifactKind(summary.entryMediaType, summary.entry) : null
    const close = onClose && (
      <button
        type="button"
        className="iconbtn flex-none"
        data-artifact-viewer-close=""
        aria-label={variant === 'dock' ? t('backToList') : t('backToConversation')}
        title={variant === 'dock' ? t('backToList') : t('backToConversation')}
        onClick={onClose}
      >
        <Icon name={variant === 'dock' ? 'chevron-left' : 'x'} size={15} />
      </button>
    )
    return (
      <section
        data-testid="artifact-viewer"
        data-variant={variant}
        className={
          variant === 'pane'
            ? 'card @container flex min-h-0 flex-1 flex-col overflow-hidden'
            : '@container flex min-h-0 flex-1 flex-col'
        }
      >
        {/* At the dock's 380px the title truncates and Share and Download keep only their icons; the revision menu and Full screen stay. */}
        <div className="flex min-w-0 flex-none items-center gap-2 border-b border-(--border-subtle) px-3 py-2">
          {variant === 'dock' ? close : null}
          <Icon
            name={kind ? ARTIFACT_KIND_ICON[kind] : 'file'}
            size={15}
            color="var(--text-tertiary)"
            className="flex-none"
          />
          <h2
            className="m-0 min-w-0 flex-1 truncate font-sans text-[13.5px] font-semibold leading-normal text-(--text-primary)"
            title={artifact.title}
          >
            {artifact.title}
          </h2>
          <RevisionMenu revisions={artifact.revisions} shown={revision} onSelect={onRevision} />
          {shareButton}
          {downloadButton}
          {fullScreenHref ? (
            <Link
              href={fullScreenHref}
              className="iconbtn flex-none"
              data-artifact-viewer-full-screen=""
              aria-label={t('fullScreen')}
              title={t('fullScreen')}
            >
              <Icon name="maximize-2" size={15} />
            </Link>
          ) : null}
          {variant === 'pane' ? close : null}
        </div>
        {info ? (
          <div className="flex min-w-0 flex-none flex-wrap items-center gap-x-2 gap-y-[2px] border-b border-(--border-subtle) px-3 py-[6px] font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {info}
          </div>
        ) : null}
        {failed ? (
          <div
            role="alert"
            className="flex-none border-b border-(--border-subtle) px-3 py-2 font-sans text-[12px] font-medium leading-normal text-(--red-600)"
          >
            {failed}
          </div>
        ) : null}
        {notice ? (
          <div
            role="status"
            data-artifact-notice=""
            className="flex flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)"
          >
            {notice}
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-(--surface-card)">{body}</div>
        {shareDialog}
      </section>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-viewer" data-variant="page">
      <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 px-4 pt-3 desktop:px-0 desktop:pt-0">
        <div className="min-w-0 flex-1">
          {/* The mobile push bar carries the title, so only the desktop renders it here. */}
          <h1 className="ptitle hidden truncate desktop:block">{artifact.title}</h1>
          {info && (
            <div className="flex desktop:mt-[6px] min-w-0 flex-wrap items-center gap-x-2 gap-y-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              {info}
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-2">
          <RevisionMenu revisions={artifact.revisions} shown={revision} onSelect={onRevision} />
          {shareButton}
          {downloadButton}
        </div>
      </div>
      {failed && (
        <div
          role="alert"
          className="px-4 pt-2 font-sans text-[12px] font-medium leading-normal text-(--red-600) desktop:px-0"
        >
          {failed}
        </div>
      )}
      {gone && (
        <div
          role="status"
          className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) desktop:mx-0"
        >
          {gone}
        </div>
      )}
      {(newer || followed) && (
        <div
          role="status"
          data-artifact-notice=""
          className="mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) desktop:mx-0"
        >
          {newer || followed}
        </div>
      )}
      <div className="mt-3 flex min-h-[320px] flex-1 flex-col overflow-hidden border-y border-(--border-subtle) bg-(--surface-card) desktop:rounded-md desktop:border">
        {body}
      </div>
      {shareDialog}
    </div>
  )
}
