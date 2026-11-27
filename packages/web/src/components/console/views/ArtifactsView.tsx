'use client'

// The Artifacts page (`/artifacts`, artifacts.md §6.3, §11.5): every artifact the viewer can open, and organization owners' public links.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import useSWRInfinite from 'swr/infinite'
import { useFormatter, useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { LoadingState } from '@/components/marks'
import { AnchoredFlyout } from '@/components/ui/AnchoredFlyout'
import { useMobileFilterSlot } from '@/components/console/Shell'
import { formatFileSize } from '@/components/console/FileBrowser'
import { ArtifactShareDialog } from '@/components/console/artifact/ArtifactShareDialog'
import { useAudienceLabel } from '@/components/console/artifact/ArtifactViewer'
import { ArtifactRowMenu, type RowMenuItem } from '@/components/console/artifact/ArtifactRowMenu'
import {
  ArtifactAudienceDialog,
  ArtifactRevisionsDialog,
  DeleteArtifactDialog,
  RenameArtifactDialog,
  RevokePublicShareDialog
} from '@/components/console/artifact/ArtifactManageDialogs'
import { ApiError, listArtifacts, listOrgArtifactShares } from '@/lib/api'
import {
  ARTIFACT_KIND_ICON,
  ARTIFACTS_NOT_ENABLED,
  artifactPath,
  artifactsContentDomain,
  type ArtifactDto,
  type ArtifactKind,
  type OrgArtifactDto,
  type OrgArtifactShareDto
} from '@/lib/artifact'
import {
  ARTIFACT_KINDS,
  ARTIFACT_MODERATION_FORBIDDEN,
  ARTIFACTS_PAGE_SIZE,
  artifactFilterKey,
  artifactFiltersActive,
  artifactOwnerLabel,
  artifactRowActions,
  artifactSharedState,
  artifactsPageQuery,
  followNextPage,
  moderationActions,
  parseArtifactFilterKey,
  readArtifactFilters,
  readArtifactsTab,
  uniqueRows,
  type ArtifactsPageFilters,
  type ArtifactsPageTab
} from '@/lib/artifacts-page'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { platformLabel } from '@/lib/platform-labels'
import { consoleKeys } from '@/lib/swr-keys'

type Page<T> = { rows: T[]; nextCursor: string | null }
type Key = readonly [string, string, string, ...string[]]

/** Pages read with `useSWRInfinite`, following short pages until `target` rows are drawn or the list ends. */
function usePagedRows<T extends { id: string }>(
  keyOf: (cursor: string) => Key | null,
  fetchPage: (key: Key) => Promise<Page<T>>
) {
  const [target, setTarget] = useState(ARTIFACTS_PAGE_SIZE)
  const { data, error, isLoading, size, setSize, mutate } = useSWRInfinite<Page<T> & { cursor: string }>(
    // A cursor that names its own page again ends the list rather than looping on one key.
    (_index, previous: (Page<T> & { cursor: string }) | null) =>
      previous && (!previous.nextCursor || previous.nextCursor === previous.cursor)
        ? null
        : keyOf(previous?.nextCursor ?? ''),
    async (key) => ({ ...(await fetchPage(key as Key)), cursor: (key as Key).at(-1) ?? '' }),
    {
      // A further page fetches only itself; `mutate()` re-reads every page from the first, so cursors never go stale.
      revalidateFirstPage: false,
      revalidateOnFocus: false,
      persistSize: false,
      shouldRetryOnError: (err) => !(err instanceof ApiError && [403, 404, 409].includes(err.status))
    }
  )
  const pages = useMemo(() => data ?? [], [data])
  const rows = useMemo(() => uniqueRows(pages), [pages])
  const last = pages.at(-1)
  const nextCursor = last?.nextCursor && last.nextCursor !== last.cursor ? last.nextCursor : null
  const loadingMore = size > pages.length
  const failed = error !== undefined
  const following = followNextPage({ rows: rows.length, target, nextCursor, failed, loading: false })
  useEffect(() => {
    if (followNextPage({ rows: rows.length, target, nextCursor, failed, loading: isLoading || loadingMore }))
      void setSize(pages.length + 1)
  }, [failed, isLoading, loadingMore, nextCursor, pages.length, rows.length, setSize, target])
  return {
    rows,
    error: error as unknown,
    loading: (isLoading || following) && rows.length === 0 && !failed,
    loadingMore: loadingMore || (following && rows.length > 0),
    more: nextCursor !== null && !following,
    loadMore: () => setTarget(rows.length + ARTIFACTS_PAGE_SIZE),
    mutate
  }
}

export default function ArtifactsView() {
  const t = useTranslations('Artifacts.manage')
  const params = useSearchParams()
  const router = useRouter()
  const { myRole, orgPath } = useOrgs()
  // A deployment without artifacts reads nothing (artifacts.md §12).
  const enabled = artifactsContentDomain() !== undefined
  const isOrgOwner = myRole === 'owner'
  const tab: ArtifactsPageTab = isOrgOwner ? readArtifactsTab(params) : 'artifacts'
  const filters = readArtifactFilters(params)
  const navigate = useCallback(
    (next: ArtifactsPageFilters, nextTab: ArtifactsPageTab) => {
      const query = artifactsPageQuery(next, nextTab)
      router.replace(orgPath(query ? `/artifacts?${query}` : '/artifacts'), { scroll: false })
    },
    [orgPath, router]
  )

  if (!enabled) return <NotEnabled />

  return (
    <div className="wrap max-desktop:pt-3 max-desktop:pb-24">
      <div className="mb-4 flex min-h-[34px] items-center gap-4 max-desktop:hidden">
        <p className="psub mt-0 flex-1">{t('description')}</p>
      </div>
      {isOrgOwner && (
        <div className="mb-3 flex items-center gap-3 border-b border-(--border-subtle) max-desktop:mx-4">
          <button
            type="button"
            className={tab === 'artifacts' ? 'tab on' : 'tab'}
            aria-pressed={tab === 'artifacts'}
            data-artifacts-tab="artifacts"
            onClick={() => navigate(filters, 'artifacts')}
          >
            {t('tabs.artifacts')}
          </button>
          <button
            type="button"
            className={tab === 'public' ? 'tab on' : 'tab'}
            aria-pressed={tab === 'public'}
            data-artifacts-tab="public"
            onClick={() => navigate(filters, 'public')}
          >
            {t('tabs.public')}
          </button>
        </div>
      )}
      {tab === 'public' ? (
        <PublicShares />
      ) : (
        <ArtifactList filters={filters} onFilters={(next) => navigate(next, 'artifacts')} />
      )}
    </div>
  )
}

function NotEnabled() {
  const t = useTranslations('Artifacts.manage')
  const { orgPath } = useOrgs()
  return (
    <div className="wrap max-desktop:p-4">
      <div
        data-testid="artifacts-not-enabled"
        className="card flex flex-col items-center gap-2 px-5 py-10 text-center font-sans text-[13px] leading-normal text-(--text-tertiary)"
      >
        <Icon name="info" size={18} color="var(--text-secondary)" />
        <div className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
          {t('notEnabledTitle')}
        </div>
        <p className="m-0">{t('notEnabledBody')}</p>
        <Link className="mt-2 font-medium text-(--text-link)" href={orgPath('/home')}>
          {t('backHome')}
        </Link>
      </div>
    </div>
  )
}

function StateCard({
  icon,
  title,
  children,
  state,
  warn = false
}: {
  icon: string
  title: string
  children?: ReactNode
  state: string
  warn?: boolean
}) {
  return (
    <div
      data-artifacts-state={state}
      role={warn ? 'alert' : undefined}
      className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center max-desktop:mx-4"
    >
      <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name={icon} size={22} color={warn ? 'var(--amber-500)' : 'var(--text-tertiary)'} />
      </span>
      <div className="font-sans text-[15px] font-semibold leading-normal">{title}</div>
      {children}
    </div>
  )
}

function StateText({ children }: { children: ReactNode }) {
  return (
    <div className="max-w-[420px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
      {children}
    </div>
  )
}

type Dialog =
  | { kind: 'rename' | 'audience' | 'delete' | 'revisions' | 'share'; row: OrgArtifactDto }
  | { kind: 'revoke'; share: OrgArtifactShareDto }
  | { kind: 'deleteModerated'; share: OrgArtifactShareDto }
  | null

const GRID = 'grid-cols-[minmax(0,2.4fr)_.8fr_1.1fr_1.1fr_.9fr_.7fr_.9fr_32px] gap-3'

function ArtifactList({
  filters,
  onFilters
}: {
  filters: ArtifactsPageFilters
  onFilters: (next: ArtifactsPageFilters) => void
}) {
  const filterKey = artifactFilterKey(filters)
  // A new filter set starts over at one page.
  return <ArtifactListBody key={filterKey} filters={filters} filterKey={filterKey} onFilters={onFilters} />
}

function ArtifactListBody({
  filters,
  filterKey,
  onFilters
}: {
  filters: ArtifactsPageFilters
  filterKey: string
  onFilters: (next: ArtifactsPageFilters) => void
}) {
  const t = useTranslations('Artifacts.manage')
  const { activeOrg, orgPath } = useOrgs()
  const [dialog, setDialog] = useState<Dialog>(null)
  const list = usePagedRows<OrgArtifactDto>(
    (cursor) => consoleKeys.orgArtifacts(activeOrg?.id, filterKey, cursor),
    async ([, orgId, , key, cursor]) => {
      const page = await listArtifacts(parseArtifactFilterKey(key ?? ''), {
        orgId,
        limit: ARTIFACTS_PAGE_SIZE,
        ...(cursor ? { cursor } : {})
      })
      return { rows: page.artifacts, nextCursor: page.nextCursor }
    }
  )
  const refresh = () => void list.mutate()
  const active = artifactFiltersActive(filters)

  if (list.error instanceof ApiError && list.error.code === ARTIFACTS_NOT_ENABLED) return <NotEnabled />

  const itemsFor = (row: OrgArtifactDto): RowMenuItem[] => {
    const can = artifactRowActions(row)
    const open = (kind: 'rename' | 'audience' | 'delete' | 'revisions' | 'share') => () => setDialog({ kind, row })
    const items: RowMenuItem[] = [
      { key: 'open', label: t('actions.open'), icon: 'external-link', href: orgPath(artifactPath(row.id)) },
      { key: 'revisions', label: t('actions.revisions'), icon: 'clock-arrow-left', onSelect: open('revisions') },
      { key: 'share', label: t('actions.share'), icon: 'share-2', onSelect: open('share') }
    ]
    if (can.session && row.originSessionId)
      items.push({
        key: 'session',
        label: t('actions.session'),
        icon: 'messages-square',
        href: orgPath(`/sessions/${encodeURIComponent(row.originSessionId)}`)
      })
    if (can.rename) items.push({ key: 'rename', label: t('actions.rename'), icon: 'pencil', onSelect: open('rename') })
    if (can.audience !== 'hidden')
      items.push({
        key: 'audience',
        label: t('actions.audience'),
        icon: 'users',
        onSelect: open('audience'),
        ...(can.audience === 'fixed' ? { disabled: true, hint: t('actions.audienceFixed') } : {})
      })
    if (can.delete)
      items.push({ key: 'delete', label: t('actions.delete'), icon: 'trash', danger: true, onSelect: open('delete') })
    return items
  }

  return (
    <>
      <ArtifactFilters filters={filters} onFilters={onFilters} />
      {list.loading ? (
        <div className="card max-desktop:mx-4">
          <LoadingState size={22} padding={28} />
        </div>
      ) : list.rows.length === 0 && list.error !== undefined ? (
        <StateCard icon="triangle-exclamation-point" title={t('loadFailed')} state="failed" warn>
          <Button variant="secondary" size="sm" onClick={refresh}>
            {t('retry')}
          </Button>
        </StateCard>
      ) : list.rows.length === 0 ? (
        active ? (
          <StateCard icon="funnel-x" title={t('noMatches.title')} state="no-matches">
            <StateText>{t('noMatches.description')}</StateText>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onFilters({ scope: 'org', agentId: null, type: null, publiclyShared: false })}
            >
              {t('clearFilters')}
            </Button>
          </StateCard>
        ) : (
          <StateCard icon="shapes" title={t('empty.title')} state="empty">
            <StateText>{t('empty.description')}</StateText>
          </StateCard>
        )
      ) : (
        <>
          <div
            className="card max-desktop:mx-4 max-desktop:overflow-hidden max-desktop:rounded-lg"
            data-artifacts-list=""
          >
            <div className={`row h ${GRID} hidden desktop:grid`}>
              <span>{t('columns.title')}</span>
              <span>{t('columns.type')}</span>
              <span>{t('columns.agent')}</span>
              <span>{t('columns.owner')}</span>
              <span>{t('columns.updated')}</span>
              <span>{t('columns.size')}</span>
              <span>{t('columns.shared')}</span>
              <span />
            </div>
            {list.rows.map((row, index) => (
              <ArtifactRow key={row.id} row={row} first={index === 0} items={itemsFor(row)} />
            ))}
          </div>
          {list.error !== undefined ? (
            <div role="alert" className="mt-3 text-center font-sans text-[12.5px] text-(--status-error)">
              {t('loadFailed')}
            </div>
          ) : list.more || list.loadingMore ? (
            <div className="mt-3 flex justify-center max-desktop:px-4">
              <button
                type="button"
                className="lnk text-[12px]"
                data-artifacts-more=""
                disabled={list.loadingMore}
                onClick={list.loadMore}
              >
                {list.loadingMore ? t('loadingMore') : t('loadMore')}
              </button>
            </div>
          ) : null}
        </>
      )}
      {dialog?.kind === 'rename' && (
        <RenameArtifactDialog artifact={dialog.row} onDone={refresh} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'audience' && (
        <ArtifactAudienceDialog artifact={dialog.row} onDone={refresh} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteArtifactDialog artifact={dialog.row} onDone={refresh} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'revisions' && (
        <ArtifactRevisionsDialog artifact={dialog.row} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'share' && (
        <ArtifactShareDialog
          artifact={dialog.row}
          revision={dialog.row.latest.number}
          onClose={() => {
            setDialog(null)
            // A link made or revoked there changes the Shared column.
            refresh()
          }}
        />
      )}
    </>
  )
}

/** The Owner column's words. */
function useOwnerName(): (owner: ArtifactDto['owner'], viewerIsOwner?: boolean) => string {
  const t = useTranslations('Artifacts.manage.owner')
  return (owner, viewerIsOwner) => {
    const label = artifactOwnerLabel(owner, viewerIsOwner)
    switch (label.kind) {
      case 'you':
        return t('you')
      case 'orgOwners':
        return t('orgOwners')
      case 'name':
        return label.name
      case 'platform':
        return t('platform', { platform: platformLabel(label.platform)?.name ?? label.platform })
      case 'unknown':
        return t('unknown')
    }
  }
}

function useUpdatedLabel(): (iso: string) => string {
  const format = useFormatter()
  return (iso) => {
    const date = new Date(iso)
    // A week back, relative time stops helping.
    if (Date.now() - date.getTime() > 7 * 86_400_000) return format.dateTime(date, { dateStyle: 'medium' })
    return format.relativeTime(date, { now: Date.now(), style: 'narrow' })
  }
}

function ArtifactRow({ row, first, items }: { row: OrgArtifactDto; first: boolean; items: RowMenuItem[] }) {
  const t = useTranslations('Artifacts.manage')
  const { orgPath } = useOrgs()
  const audienceLabel = useAudienceLabel()
  const ownerName = useOwnerName()
  const updated = useUpdatedLabel()
  const shared = artifactSharedState(row)
  const href = orgPath(artifactPath(row.id))
  const tCard = useTranslations('Artifacts.card')
  const files = row.latest.fileCount > 1 ? tCard('files', { count: row.latest.fileCount }) : null
  const when = new Date(row.updatedAt).toLocaleString()
  const sharedBadge =
    shared === 'none' ? (
      <span className="font-sans text-[12px] text-(--text-tertiary)">{t('shared.none')}</span>
    ) : (
      <span className="inline-flex items-center gap-[5px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary)">
        <Icon name={shared === 'public' ? 'globe' : 'users'} size={13} color="var(--text-tertiary)" />
        {shared === 'public' ? t('shared.public') : t('shared.org')}
      </span>
    )
  return (
    <div
      data-artifact-row={row.id}
      className={`row ${GRID} items-center max-desktop:flex max-desktop:min-h-18 max-desktop:gap-3 max-desktop:border-b-0 max-desktop:bg-(--surface-card) max-desktop:px-4 max-desktop:py-3 ${
        first ? '' : 'max-desktop:border-t max-desktop:border-(--border-subtle)'
      }`}
    >
      {/* Desktop: the title cell; phone: the whole card body, kind tile, title and meta. */}
      <Link
        href={href}
        className="flex min-w-0 items-center gap-[10px] text-(--text-primary) no-underline max-desktop:flex-1"
      >
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
          <Icon name={ARTIFACT_KIND_ICON[row.kind]} size={16} color="var(--text-tertiary)" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-sans text-[13px] font-semibold leading-normal max-desktop:text-[14px]">
            {row.title}
          </span>
          <span className="block truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) desktop:hidden">
            {[t(`types.${row.kind}`), row.latest.producedBy.name, updated(row.updatedAt)].join(' · ')}
          </span>
          <span className="block truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) desktop:hidden">
            {[ownerName(row.owner, row.viewerIsOwner), formatFileSize(row.latest.totalBytes), files]
              .filter(Boolean)
              .join(' · ')}
          </span>
          <span className="block truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary) max-desktop:hidden">
            {`r${row.latest.number} · ${audienceLabel(row.audience)}`}
          </span>
        </span>
      </Link>
      <span className="hidden truncate font-sans text-[12px] text-(--text-secondary) desktop:block">
        {t(`types.${row.kind}`)}
      </span>
      <span className="mono hidden truncate text-[12px] text-(--text-secondary) desktop:block">
        {row.latest.producedBy.name}
      </span>
      <span className="hidden truncate font-sans text-[12px] text-(--text-secondary) desktop:block">
        {ownerName(row.owner, row.viewerIsOwner)}
      </span>
      <span title={when} className="hidden truncate font-sans text-[12px] text-(--text-secondary) desktop:block">
        {updated(row.updatedAt)}
      </span>
      <span className="hidden min-w-0 desktop:block">
        <span className="mono block truncate text-[12px] text-(--text-secondary)">
          {formatFileSize(row.latest.totalBytes)}
        </span>
        {files ? (
          <span className="block truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {files}
          </span>
        ) : null}
      </span>
      <span className="hidden min-w-0 desktop:block">{sharedBadge}</span>
      {/* Phone: the shared state sits beside the menu. */}
      {shared !== 'none' && (
        <span className="flex-none desktop:hidden" title={shared === 'public' ? t('shared.public') : t('shared.org')}>
          <Icon name={shared === 'public' ? 'globe' : 'users'} size={15} color="var(--text-tertiary)" />
        </span>
      )}
      <span className="flex justify-end">
        <ArtifactRowMenu title={row.title} items={items} />
      </span>
    </div>
  )
}

type FilterOption = { v: string; label: string; icon?: string }

function ArtifactFilters({
  filters,
  onFilters
}: {
  filters: ArtifactsPageFilters
  onFilters: (next: ArtifactsPageFilters) => void
}) {
  const t = useTranslations('Artifacts.manage')
  const { agents } = useConsoleData()
  const active = artifactFiltersActive(filters)
  const cleared: ArtifactsPageFilters = { scope: 'org', agentId: null, type: null, publiclyShared: false }
  const agentOptions: FilterOption[] = [
    { v: 'all', label: t('allAgents'), icon: 'bot' },
    ...agents.map((agent) => ({ v: agent.id, label: agentLabel(agent) })).sort((a, b) => a.label.localeCompare(b.label))
  ]
  // An agent named by the URL but no longer in the roster still reads as selected.
  if (filters.agentId && !agentOptions.some((option) => option.v === filters.agentId))
    agentOptions.push({ v: filters.agentId, label: filters.agentId.slice(0, 8) })
  const typeOptions: FilterOption[] = [
    { v: 'all', label: t('allTypes'), icon: 'shapes' },
    ...ARTIFACT_KINDS.map((kind) => ({ v: kind, label: t(`types.${kind}`), icon: ARTIFACT_KIND_ICON[kind] }))
  ]
  const scopeOptions: FilterOption[] = [
    { v: 'org', label: t('scope.org') },
    { v: 'mine', label: t('scope.mine') }
  ]
  const publicOptions: FilterOption[] = [
    { v: 'any', label: t('publicAny') },
    { v: 'public', label: t('publiclyShared') }
  ]
  const setAgent = (v: string) => onFilters({ ...filters, agentId: v === 'all' ? null : v })
  const setType = (v: string) => onFilters({ ...filters, type: v === 'all' ? null : (v as ArtifactKind) })
  const setScope = (v: string) => onFilters({ ...filters, scope: v === 'mine' ? 'mine' : 'org' })
  const setPublic = (on: boolean) => onFilters({ ...filters, publiclyShared: on })

  // Phone: the app bar's filter button opens a sheet of pill rows, as on Sessions.
  const { register } = useMobileFilterSlot()
  const [sheet, setSheet] = useState(false)
  const openSheet = useCallback(() => setSheet(true), [])
  useEffect(() => {
    register({ active, open: openSheet })
    return () => register(null)
  }, [active, openSheet, register])
  useEffect(() => {
    if (!sheet) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSheet(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sheet])

  const chips = [
    filters.scope === 'mine' && { key: 'scope', label: t('scope.mine'), clear: () => setScope('org') },
    filters.agentId && {
      key: 'agent',
      label: agentOptions.find((o) => o.v === filters.agentId)?.label ?? '',
      clear: () => setAgent('all')
    },
    filters.type && { key: 'type', label: t(`types.${filters.type}`), clear: () => setType('all') },
    filters.publiclyShared && { key: 'public', label: t('publiclyShared'), clear: () => setPublic(false) }
  ].filter((chip): chip is { key: string; label: string; clear: () => void } => Boolean(chip))

  return (
    <>
      <div className="mb-4 hidden flex-wrap items-center gap-[10px] desktop:flex" data-artifacts-filters="">
        <div className="pillbar" role="group" aria-label={t('scope.label')}>
          {scopeOptions.map((option) => (
            <button
              key={option.v}
              type="button"
              className={filters.scope === option.v ? 'pill on' : 'pill'}
              aria-pressed={filters.scope === option.v}
              data-scope={option.v}
              onClick={() => setScope(option.v)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <FilterMenu
          label={t('agent')}
          value={filters.agentId ?? 'all'}
          options={agentOptions}
          onPick={setAgent}
          testId="agent"
        />
        <FilterMenu
          label={t('type')}
          value={filters.type ?? 'all'}
          options={typeOptions}
          onPick={setType}
          testId="type"
        />
        <button
          type="button"
          className={filters.publiclyShared ? 'selbtn on' : 'selbtn'}
          aria-pressed={filters.publiclyShared}
          data-filter="public"
          onClick={() => setPublic(!filters.publiclyShared)}
        >
          <span className="flex h-[18px] w-[18px] flex-none items-center justify-center">
            <Icon
              name={filters.publiclyShared ? 'square-check' : 'square'}
              size={14}
              color={filters.publiclyShared ? 'var(--brand)' : 'var(--text-tertiary)'}
            />
          </span>
          <span className="lbl">{t('publiclyShared')}</span>
        </button>
        {active && (
          <button type="button" className="lnk ml-auto text-(--text-tertiary)" onClick={() => onFilters(cleared)}>
            <Icon name="x" size={13} />
            {t('clearFilters')}
          </button>
        )}
      </div>
      {chips.length > 0 && (
        <div className="mb-2 flex items-center gap-2 overflow-x-auto border-b border-(--border-subtle) px-4 py-[10px] desktop:hidden [scrollbar-width:none]">
          {chips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex h-8 flex-none items-center gap-1 whitespace-nowrap rounded-full border border-(--border-default) bg-(--surface-active) pr-[5px] pl-[11px] font-sans text-[12.5px] font-medium leading-normal text-(--text-primary)"
            >
              {chip.label}
              <button
                type="button"
                aria-label={t('clearFilter', { filter: chip.label })}
                onClick={chip.clear}
                className="inline-flex h-[18px] w-[18px] cursor-pointer items-center justify-center border-0 bg-transparent text-(--text-tertiary)"
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {sheet && (
        <div className="msheet-scrim desktop:hidden" onClick={() => setSheet(false)}>
          <div
            className="max-h-[88vh] w-full overflow-y-auto rounded-t-2xl bg-(--surface-card) px-4 pt-2 pb-3 shadow-(--shadow-xl)"
            data-artifacts-filter-sheet=""
            onClick={(e) => e.stopPropagation()}
          >
            <div className="msheet-handle" />
            <div className="flex items-center pt-[2px] pb-1">
              <span className="flex-1 font-sans text-[15px] font-semibold leading-normal">{t('filterTitle')}</span>
              {active && (
                <button
                  type="button"
                  className="h-8 border-0 bg-transparent px-[10px] font-sans text-[13px] font-semibold leading-normal text-(--brand)"
                  onClick={() => onFilters(cleared)}
                >
                  {t('clearFilters')}
                </button>
              )}
            </div>
            <PillRow first label={t('scope.label')} options={scopeOptions} value={filters.scope} onPick={setScope} />
            <PillRow label={t('agent')} options={agentOptions} value={filters.agentId ?? 'all'} onPick={setAgent} />
            <PillRow label={t('type')} options={typeOptions} value={filters.type ?? 'all'} onPick={setType} />
            <PillRow
              label={t('sharing')}
              options={publicOptions}
              value={filters.publiclyShared ? 'public' : 'any'}
              onPick={(v) => setPublic(v === 'public')}
            />
            <button
              type="button"
              className="mt-[18px] flex h-[46px] w-full items-center justify-center rounded-[10px] border-0 bg-(--brand) font-sans text-[14px] font-semibold leading-normal text-white"
              onClick={() => setSheet(false)}
            >
              {t('showResults')}
            </button>
            <div className="msheet-home">
              <span className="home-pill" />
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function FilterMenu({
  label,
  value,
  options,
  onPick,
  testId
}: {
  label: string
  value: string
  options: FilterOption[]
  onPick: (v: string) => void
  testId: string
}) {
  const selected = options.find((option) => option.v === value) ?? options[0]!
  return (
    <AnchoredFlyout
      ariaLabel={label}
      width={240}
      align="start"
      estimatedHeight={Math.min(320, options.length * 36 + 12)}
      className="max-h-[320px]"
      triggerClassName="flex"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={open ? 'selbtn on' : 'selbtn'}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`${label}: ${selected.label}`}
          data-filter={testId}
          onClick={toggle}
        >
          <span className="flex h-[18px] w-[18px] flex-none items-center justify-center">
            <Icon name={selected.icon ?? 'bot'} size={15} color="var(--text-tertiary)" />
          </span>
          <span className="lbl">{selected.label}</span>
        </button>
      )}
    >
      {({ close }) =>
        options.map((option) => (
          <button
            key={option.v}
            type="button"
            role="menuitemradio"
            aria-checked={option.v === value}
            className="dmi"
            data-option={option.v}
            onClick={() => {
              close(true)
              if (option.v !== value) onPick(option.v)
            }}
          >
            {option.icon ? <Icon name={option.icon} size={15} /> : <span className="w-[15px] flex-none" />}
            <span className="min-w-0 flex-1 truncate">{option.label}</span>
            {option.v === value && <Icon name="check" size={14} color="var(--brand)" />}
          </button>
        ))
      }
    </AnchoredFlyout>
  )
}

function PillRow({
  label,
  options,
  value,
  onPick,
  first
}: {
  label: string
  options: FilterOption[]
  value: string
  onPick: (v: string) => void
  first?: boolean
}) {
  return (
    <>
      <div
        className={`${first ? 'mt-3' : 'mt-4'} mb-[7px] font-mono text-[10.5px] font-semibold uppercase leading-none tracking-[.08em] text-(--text-tertiary)`}
      >
        {label}
      </div>
      <div className="-mx-4 flex flex-nowrap gap-2 overflow-x-auto px-4 pb-[2px] [scrollbar-width:none]">
        {options.map((option) => (
          <button
            key={option.v}
            type="button"
            aria-pressed={option.v === value}
            onClick={() => onPick(option.v)}
            className={`inline-flex h-[34px] flex-none items-center gap-[7px] whitespace-nowrap rounded-full border px-[14px] font-sans text-[13px] leading-none ${
              option.v === value
                ? 'border-(--brand) bg-(--brand) font-semibold text-white'
                : 'border-(--border-default) bg-(--surface-card) font-medium text-(--text-secondary)'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
    </>
  )
}

const SHARE_GRID = 'grid-cols-[minmax(0,2.2fr)_1.1fr_.6fr_1.1fr_.9fr_32px] gap-3'

function PublicShares() {
  const t = useTranslations('Artifacts.manage')
  const format = useFormatter()
  const { activeOrg, orgPath } = useOrgs()
  const ownerName = useOwnerName()
  const [dialog, setDialog] = useState<Dialog>(null)
  const list = usePagedRows<OrgArtifactShareDto>(
    (cursor) => consoleKeys.orgArtifactShares(activeOrg?.id, cursor),
    async ([, orgId, , cursor]) => {
      const page = await listOrgArtifactShares({ orgId, limit: ARTIFACTS_PAGE_SIZE, ...(cursor ? { cursor } : {}) })
      return { rows: page.shares, nextCursor: page.nextCursor }
    }
  )
  const refresh = () => void list.mutate()
  const creatorName = (share: OrgArtifactShareDto) => {
    const by = share.createdBy
    if (by.displayName || by.email) return (by.displayName || by.email)!
    if (by.platform) return platformLabel(by.platform)?.name ?? by.platform
    return t('owner.unknown')
  }

  if (list.error instanceof ApiError && list.error.code === ARTIFACTS_NOT_ENABLED) return <NotEnabled />

  const itemsFor = (share: OrgArtifactShareDto): RowMenuItem[] => {
    const can = moderationActions(share)
    return [
      ...(can.open
        ? [
            {
              key: 'open',
              label: t('actions.openRevision', { number: share.revision }),
              icon: 'external-link',
              href: orgPath(artifactPath(share.artifact.id, share.revision))
            }
          ]
        : []),
      {
        key: 'revoke',
        label: t('public.revoke'),
        icon: 'link-2-off',
        onSelect: () => setDialog({ kind: 'revoke', share })
      },
      {
        key: 'delete',
        label: t('public.deleteArtifact'),
        icon: 'trash',
        danger: true,
        onSelect: () => setDialog({ kind: 'deleteModerated', share })
      }
    ]
  }

  return (
    <>
      <p className="mt-0 mb-3 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-tertiary) max-desktop:mx-4">
        {t('public.description')}
      </p>
      {list.loading ? (
        <div className="card max-desktop:mx-4">
          <LoadingState size={22} padding={28} />
        </div>
      ) : list.rows.length === 0 && list.error !== undefined ? (
        list.error instanceof ApiError && list.error.code === ARTIFACT_MODERATION_FORBIDDEN ? (
          <StateCard icon="lock" title={t('public.forbidden')} state="forbidden" />
        ) : (
          <StateCard icon="triangle-exclamation-point" title={t('public.loadFailed')} state="failed" warn>
            <Button variant="secondary" size="sm" onClick={refresh}>
              {t('retry')}
            </Button>
          </StateCard>
        )
      ) : list.rows.length === 0 ? (
        <StateCard icon="globe" title={t('public.empty.title')} state="empty">
          <StateText>{t('public.empty.description')}</StateText>
        </StateCard>
      ) : (
        <>
          <div
            className="card max-desktop:mx-4 max-desktop:overflow-hidden max-desktop:rounded-lg"
            data-public-shares=""
          >
            <div className={`row h ${SHARE_GRID} hidden desktop:grid`}>
              <span>{t('public.columns.artifact')}</span>
              <span>{t('columns.owner')}</span>
              <span>{t('public.columns.revision')}</span>
              <span>{t('public.columns.createdBy')}</span>
              <span>{t('public.columns.sharedAt')}</span>
              <span />
            </div>
            {list.rows.map((share, index) => {
              const can = moderationActions(share)
              const when = format.dateTime(new Date(share.createdAt), { dateStyle: 'medium' })
              const title = (
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-[6px]">
                    <span className="truncate font-sans text-[13px] font-semibold leading-normal max-desktop:text-[14px]">
                      {share.artifact.title}
                    </span>
                    {!can.open && (
                      <span className="inline-flex flex-none" title={t('public.cannotView')}>
                        <Icon name="lock" size={12} color="var(--text-tertiary)" />
                      </span>
                    )}
                  </span>
                  <span className="block truncate font-mono text-[11px] font-normal leading-normal text-(--text-tertiary) max-desktop:hidden">
                    {share.displayTail}
                  </span>
                  <span className="block truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) desktop:hidden">
                    {`r${share.revision} · ${ownerName(share.artifact.owner)}`}
                  </span>
                  <span className="block truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) desktop:hidden">
                    {t('public.sharedBy', { name: creatorName(share), date: when })}
                  </span>
                </span>
              )
              return (
                <div
                  key={share.id}
                  data-public-share={share.id}
                  className={`row ${SHARE_GRID} items-center max-desktop:flex max-desktop:min-h-18 max-desktop:gap-3 max-desktop:border-b-0 max-desktop:bg-(--surface-card) max-desktop:px-4 max-desktop:py-3 ${
                    index === 0 ? '' : 'max-desktop:border-t max-desktop:border-(--border-subtle)'
                  }`}
                >
                  {can.open ? (
                    <Link
                      href={orgPath(artifactPath(share.artifact.id, share.revision))}
                      className="flex min-w-0 items-center gap-[10px] text-(--text-primary) no-underline max-desktop:flex-1"
                    >
                      <ShareTile />
                      {title}
                    </Link>
                  ) : (
                    <div className="flex min-w-0 items-center gap-[10px] text-(--text-primary) max-desktop:flex-1">
                      <ShareTile />
                      {title}
                    </div>
                  )}
                  <span className="hidden truncate font-sans text-[12px] text-(--text-secondary) desktop:block">
                    {ownerName(share.artifact.owner)}
                  </span>
                  <span className="mono hidden text-[12px] text-(--text-secondary) desktop:block">
                    {`r${share.revision}`}
                  </span>
                  <span className="hidden truncate font-sans text-[12px] text-(--text-secondary) desktop:block">
                    {creatorName(share)}
                  </span>
                  <span
                    title={new Date(share.createdAt).toLocaleString()}
                    className="hidden truncate font-sans text-[12px] text-(--text-secondary) desktop:block"
                  >
                    {when}
                  </span>
                  <span className="flex justify-end">
                    <ArtifactRowMenu title={share.artifact.title} items={itemsFor(share)} />
                  </span>
                </div>
              )
            })}
          </div>
          {list.error !== undefined ? (
            <div role="alert" className="mt-3 text-center font-sans text-[12.5px] text-(--status-error)">
              {t('public.loadFailed')}
            </div>
          ) : list.more || list.loadingMore ? (
            <div className="mt-3 flex justify-center max-desktop:px-4">
              <button
                type="button"
                className="lnk text-[12px]"
                data-artifacts-more=""
                disabled={list.loadingMore}
                onClick={list.loadMore}
              >
                {list.loadingMore ? t('loadingMore') : t('loadMore')}
              </button>
            </div>
          ) : null}
        </>
      )}
      {dialog?.kind === 'revoke' && (
        <RevokePublicShareDialog share={dialog.share} onDone={refresh} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'deleteModerated' && (
        <DeleteArtifactDialog artifact={dialog.share.artifact} onDone={refresh} onClose={() => setDialog(null)} />
      )}
    </>
  )
}

function ShareTile() {
  return (
    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md border border-(--border-subtle) bg-(--surface-sunken)">
      <Icon name="globe" size={16} color="var(--text-tertiary)" />
    </span>
  )
}
