'use client'

// The dock's Artifacts tab without an open viewer (artifacts.md §11.2): the artifacts this session published or updated, newest first.
import Link from 'next/link'
import { useEffect, useMemo, useRef, type MouseEvent, type ReactNode } from 'react'
import useSWRInfinite from 'swr/infinite'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { formatFileMtime } from '@/components/console/FileBrowser'
import { ApiError, listSessionArtifacts } from '@/lib/api'
import {
  ARTIFACT_KIND_ICON,
  ARTIFACTS_NOT_ENABLED,
  artifactKind,
  artifactPath,
  type SessionArtifactDto,
  type SessionArtifactPageDto
} from '@/lib/artifact'
import { useOrgs } from '@/lib/org-context'
import { consoleKeys } from '@/lib/swr-keys'
import { useArtifactOpener } from '@/components/console/artifact/artifact-opener'
import type { DockTabStatus } from './SessionDock'

/** Rows asked for per page; short pages are followed until this many rows are drawn or the list ends. */
export const ARTIFACT_LIST_PAGE = 25

type PageKey = NonNullable<ReturnType<typeof consoleKeys.sessionArtifacts>>

/** The tab's status from the list's read: `empty` only once every page has answered with no row. */
export function artifactsListStatus(read: {
  rows: number
  loading: boolean
  failed: boolean
  more: boolean
}): DockTabStatus {
  if (read.rows > 0 || read.failed) return 'ready'
  return read.loading || read.more ? 'loading' : 'empty'
}

export function ArtifactsList({
  sessionId,
  refreshKey = '',
  onStatusChange,
  pageLink
}: {
  /** The CP session whose artifacts are listed. */
  sessionId: string
  /** Changes when the transcript gains an artifact card or revision, which re-reads the list. */
  refreshKey?: string
  onStatusChange?: (status: DockTabStatus) => void
  /** The link to the Artifacts page, drawn under the list whatever it holds. */
  pageLink?: ReactNode
}) {
  const t = useTranslations('Artifacts')
  const { activeOrg, orgPath } = useOrgs()
  const opener = useArtifactOpener()
  const orgId = activeOrg?.id
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<SessionArtifactPageDto>(
    (_index, previous: SessionArtifactPageDto | null) =>
      previous && !previous.nextCursor
        ? null
        : consoleKeys.sessionArtifacts(orgId, sessionId, previous?.nextCursor ?? ''),
    (key) => {
      const [, keyOrgId, , keySessionId, cursor] = key as PageKey
      return listSessionArtifacts(keySessionId, {
        orgId: keyOrgId,
        limit: ARTIFACT_LIST_PAGE,
        ...(cursor ? { cursor } : {})
      })
    },
    {
      // A further page fetches only itself; a mount and `mutate()` re-read every page from page one, so cursors never go stale.
      revalidateFirstPage: false,
      revalidateOnMount: true,
      persistSize: false,
      shouldRetryOnError: (err) => !(err instanceof ApiError && (err.status === 404 || err.status === 409))
    }
  )
  const pages = useMemo(() => data ?? [], [data])
  const rows = useMemo(() => {
    const byId = new Map<string, SessionArtifactDto>()
    for (const page of pages)
      for (const artifact of page.artifacts) if (!byId.has(artifact.id)) byId.set(artifact.id, artifact)
    return [...byId.values()]
  }, [pages])
  const nextCursor = pages.at(-1)?.nextCursor ?? null
  const loadingMore = size > pages.length
  const failed = error !== undefined
  // A page can come back short or empty while older ones remain, so the list keeps reading until it has a screenful.
  const following = !failed && nextCursor !== null && rows.length < ARTIFACT_LIST_PAGE

  useEffect(() => {
    if (following && !isLoading && !loadingMore) void setSize(pages.length + 1)
  }, [following, isLoading, loadingMore, pages.length, setSize])

  // A change of the key, not its first value: the mount already reads.
  const lastKey = useRef(refreshKey)
  useEffect(() => {
    if (lastKey.current === refreshKey) return
    lastKey.current = refreshKey
    void mutate()
  }, [mutate, refreshKey])

  const status = artifactsListStatus({ rows: rows.length, loading: isLoading || loadingMore, failed, more: following })
  useEffect(() => {
    onStatusChange?.(status)
  }, [onStatusChange, status])

  const footer = pageLink ? <div className="flex flex-none px-3 py-[10px]">{pageLink}</div> : null
  if (status !== 'ready') return footer
  if (rows.length === 0) {
    const notEnabled = error instanceof ApiError && error.code === ARTIFACTS_NOT_ENABLED
    return (
      <div data-artifacts-list={notEnabled ? 'not-enabled' : 'failed'} className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-1 flex-col px-3 py-[10px]">
          <ListNotice text={notEnabled ? t('card.notEnabled') : t('list.loadFailed')} warn={!notEnabled} />
        </div>
        {footer}
      </div>
    )
  }

  const openInPlace = (event: MouseEvent<HTMLAnchorElement>, artifactId: string) => {
    // A modified or middle click keeps the link's own new-tab behavior.
    if (!opener || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    opener.open({ artifactId }, 'dock')
  }
  return (
    <div data-artifacts-list="" className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 py-[10px]">
        {rows.map((artifact) => (
          <Link
            key={artifact.id}
            href={orgPath(artifactPath(artifact.id))}
            onClick={(event) => openInPlace(event, artifact.id)}
            data-artifact-row={artifact.id}
            className="mx-[-8px] flex min-h-9 flex-none items-center gap-[10px] rounded-[8px] px-2 py-[6px] text-(--text-primary) no-underline transition-colors hover:bg-(--surface-hover) focus-visible:shadow-(--focus-ring) focus-visible:outline-none"
          >
            <Icon
              name={ARTIFACT_KIND_ICON[artifactKind(artifact.latest.entryMediaType, artifact.latest.entry)]}
              size={15}
              color="var(--text-tertiary)"
              className="flex-none"
            />
            <span className="min-w-0 flex-1 truncate font-sans text-[13.5px] font-medium leading-[1.5]">
              {artifact.title}
            </span>
            <span className="flex-none font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('card.revision', { number: artifact.latest.number })}
            </span>
            <span
              title={new Date(artifact.updatedAt).toLocaleString()}
              className="flex-none font-sans text-[12px] font-normal leading-normal whitespace-nowrap text-(--text-tertiary) tabular-nums"
            >
              {formatFileMtime(artifact.updatedAt)}
            </span>
          </Link>
        ))}
        {failed ? (
          <div className="pt-[6px]">
            <ListNotice text={t('list.loadFailed')} warn />
          </div>
        ) : nextCursor && !following ? (
          <button
            type="button"
            data-artifacts-more=""
            disabled={loadingMore}
            onClick={() => void setSize(pages.length + 1)}
            className="flex w-full flex-none cursor-pointer items-center gap-[5px] border-0 bg-transparent pt-[5px] pb-[2px] text-left font-sans text-[12px] font-medium leading-[1.4] text-(--text-tertiary) hover:text-(--text-secondary) disabled:cursor-default"
          >
            {loadingMore ? t('list.loadingMore') : t('list.more')}
            <Icon name="chevron-down" size={12} />
          </button>
        ) : null}
      </div>
      {footer}
    </div>
  )
}

function ListNotice({ text, warn }: { text: string; warn: boolean }) {
  return (
    <div
      role={warn ? 'alert' : undefined}
      className="flex items-start gap-2 px-[2px] py-1 font-sans text-[12px] font-normal leading-[1.55] text-(--text-secondary)"
    >
      <Icon
        name={warn ? 'triangle-exclamation-point' : 'shapes'}
        size={14}
        color={warn ? 'var(--amber-500)' : 'var(--text-tertiary)'}
        className="mt-[2px] flex-none"
      />
      <span>{text}</span>
    </div>
  )
}
