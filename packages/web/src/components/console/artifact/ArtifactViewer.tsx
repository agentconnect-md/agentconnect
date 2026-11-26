'use client'

// The viewer: header with the revision menu and Download, the info line, notices, and the entry (artifacts.md §11.3–§11.4).
import { useState } from 'react'
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
import { artifactsContentDomain, type ArtifactDto, type ArtifactRevisionSummary } from '@/lib/artifact'
import { ArtifactBody, ArtifactBodyNotice } from './ArtifactBody'
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

/** One artifact at one revision; `missing` is a requested revision that is no longer kept, so the latest is shown instead. */
export function ArtifactViewer({
  artifact,
  revision,
  missing,
  onRevision,
  path,
  onPath
}: {
  artifact: ArtifactDto
  revision: number
  missing?: number
  onRevision: (revision: number) => void
  /** The site page to open first; see `ArtifactSite`. */
  path?: string | null
  onPath?: (path: string | null) => void
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
  const download = useArtifactDownload(artifact.id, revision, artifact.title, files)

  const downloadButton = (
    <Button
      variant="secondary"
      size="sm"
      disabled={download.busy || !files}
      onClick={() => void download.run()}
      ariaLabel={t('download')}
    >
      {download.busy ? <Spinner size={12} /> : <Icon name="download" size={14} />}
      <span className={download.busy ? '' : 'max-desktop:hidden'}>
        {download.zipping ? t('zipping') : t('download')}
      </span>
    </Button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="artifact-viewer">
      <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 px-4 pt-3 desktop:px-0 desktop:pt-0">
        <div className="min-w-0 flex-1">
          {/* The mobile push bar carries the title, so only the desktop renders it here. */}
          <h1 className="ptitle hidden truncate desktop:block">{artifact.title}</h1>
          {summary && (
            <div className="flex desktop:mt-[6px] min-w-0 flex-wrap items-center gap-x-2 gap-y-[2px] font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">
              <span className="inline-flex items-center gap-1">
                <Icon name="bot" size={13} />
                {summary.producedBy.name}
              </span>
              <span aria-hidden>·</span>
              <span>{audienceLabel(artifact.audience)}</span>
              <span aria-hidden>·</span>
              <span title={format.dateTime(new Date(summary.createdAt), { dateStyle: 'medium', timeStyle: 'short' })}>
                {t('updated', { time: format.relativeTime(new Date(summary.createdAt), { now: Date.now() }) })}
              </span>
            </div>
          )}
        </div>
        <div className="flex flex-none items-center gap-2">
          <RevisionMenu revisions={artifact.revisions} shown={revision} onSelect={onRevision} />
          {downloadButton}
        </div>
      </div>
      {download.failed && (
        <div
          role="alert"
          className="px-4 pt-2 font-sans text-[12px] font-medium leading-normal text-(--red-600) desktop:px-0"
        >
          {t('downloadFailed')}
        </div>
      )}
      {missing !== undefined && (
        <div
          role="status"
          className="mx-4 mt-3 flex items-center gap-2 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) desktop:mx-0"
        >
          <Icon name="info" size={14} color="var(--text-tertiary)" />
          {t('revisionGone', { missing, number: revision })}
        </div>
      )}
      {missing === undefined && artifact.latestRevision > revision && (
        <div
          role="status"
          className="mx-4 mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary) desktop:mx-0"
        >
          <span className="inline-flex items-center gap-2">
            <Icon name="circle-arrow-up" size={14} color="var(--text-tertiary)" />
            {t('newerAvailable', { number: artifact.latestRevision })}
          </span>
          <button type="button" className="lnk text-[12.5px]" onClick={() => onRevision(artifact.latestRevision)}>
            {t('viewLatest')}
          </button>
        </div>
      )}
      <div className="mt-3 flex min-h-[320px] flex-1 flex-col overflow-hidden border-y border-(--border-subtle) bg-(--surface-card) desktop:rounded-md desktop:border">
        {read.data ? (
          <ArtifactBody
            artifactId={artifact.id}
            revision={read.data}
            title={artifact.title}
            download={downloadButton}
            contentDomain={artifactsContentDomain()}
            path={path ?? null}
            onPath={onPath}
          />
        ) : read.error ? (
          <ArtifactBodyNotice icon="triangle-exclamation-point" tone="error">
            {t('loadFailed')}
          </ArtifactBodyNotice>
        ) : (
          <div className="flex flex-1 items-center justify-center py-12" aria-busy="true">
            <Spinner size={30} />
          </div>
        )}
      </div>
    </div>
  )
}
