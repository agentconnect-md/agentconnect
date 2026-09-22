'use client'

// One knowledge entry: current revision, history, owner actions; older revisions render in place (organization-knowledge.md §2).

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useParams } from 'next/navigation'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  ApiError,
  fmtDate,
  getOrganizationKnowledge,
  listOrganizationKnowledgeRevisions,
  setOrganizationKnowledgeArchived
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { useCrumbSlot } from '@/components/console/Shell'
import { NotFound } from '@/components/console/NotFound'
import { KnowledgeEditor, TagChips, useProvenanceLabel } from '@/components/console/knowledge'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), { ssr: false })

export default function KnowledgeDetailView() {
  const t = useTranslations('Knowledge')
  const { id } = useParams<{ id: string }>()
  const { activeOrg, myRole, orgPath } = useOrgs()
  const canManage = myRole === 'owner'
  const provenance = useProvenanceLabel()
  const entry = useSWR(consoleKeys.organizationKnowledgeEntry(activeOrg?.id, id), ([, , , entryId]) =>
    getOrganizationKnowledge(entryId)
  )
  const record = entry.data
  const history = useSWR(
    record
      ? consoleKeys.organizationKnowledgeRevisions(activeOrg?.id, record.id, String(record.currentRevision))
      : null,
    ([, , , entryId]) => listOrganizationKnowledgeRevisions(entryId)
  )
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The mobile push bar reads the title from this slot.
  const { register: registerCrumb } = useCrumbSlot()
  const title = record?.title ?? ''
  useEffect(() => {
    if (!title) return
    registerCrumb({ id, title, status: '', statusLabel: '' })
    return () => registerCrumb(null)
  }, [registerCrumb, id, title])
  // A revision published from this page becomes the one shown.
  const currentRevision = record?.currentRevision
  useEffect(() => setSelectedRevision(null), [currentRevision])

  if (!record) {
    const notFound = entry.error instanceof ApiError && entry.error.status === 404
    return (
      <div className="wrap max-desktop:p-4">
        {notFound ? (
          <NotFound
            icon="book-x"
            kind="KNOWLEDGE"
            title={t('detail.notFoundTitle')}
            pre={t('detail.notFoundPre')}
            chip={id}
            post={t('detail.notFoundPost')}
            actionLabel={t('detail.backToKnowledge')}
            actionHref={orgPath('/knowledge')}
            searchLabel={t('detail.searchKnowledge')}
          />
        ) : entry.error instanceof Error ? (
          <div className="card flex items-center justify-center gap-2 px-5 py-10 font-sans text-[13px] text-(--text-tertiary)">
            <Icon name="triangle-alert" size={16} />
            {entry.error.message}
          </div>
        ) : (
          <LoadingState fill />
        )}
      </div>
    )
  }

  const viewing = selectedRevision ?? record.currentRevision
  const isCurrent = viewing === record.currentRevision
  const older = isCurrent ? null : history.data?.find((revision) => revision.revision === viewing)
  const shown = isCurrent ? record : older
  // Summary, provenance, date, and tags belong to the revision on screen; title and archive state to the entry.
  const meta = isCurrent
    ? { summary: record.summary, tags: record.tags, date: record.revisionCreatedAt, source: record }
    : older
      ? { summary: older.summary, tags: older.tags, date: older.createdAt, source: older }
      : null
  const revisionLabel = t('revision', { value: record.currentRevision })
  const historyError = history.error instanceof Error ? history.error.message : null

  const toggleArchive = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await setOrganizationKnowledgeArchived(record.id, !record.archivedAt)
      await entry.mutate()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="wrap max-desktop:p-4">
      {/* The mobile push bar carries the title, so only the desktop renders it here. */}
      <div className="flex items-start gap-4">
        <div className="hidden min-w-0 flex-1 desktop:block">
          <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
            <h1 className="ptitle truncate">{record.title}</h1>
            <span className="badge bg-(--surface-active) text-(--text-secondary)">{revisionLabel}</span>
            {record.archivedAt && (
              <span className="badge bg-(--surface-sunken) text-(--text-disabled)">{t('archived')}</span>
            )}
          </div>
          {meta?.summary && <p className="psub">{meta.summary}</p>}
        </div>
        {canManage && (
          <div className="flex flex-none items-center gap-2">
            {!record.archivedAt && (
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                <Icon name="pencil" size={14} />
                {t('detail.newRevision')}
              </Button>
            )}
            <Button variant="secondary" size="sm" disabled={busy} onClick={() => void toggleArchive()}>
              <Icon name={record.archivedAt ? 'archive-restore' : 'archive'} size={14} />
              {record.archivedAt ? t('detail.restore') : t('detail.archive')}
            </Button>
          </div>
        )}
      </div>
      <div className="mt-[9px] mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        <span className="desktop:hidden">{revisionLabel}</span>
        {meta && (
          <>
            <span>{provenance(meta.source)}</span>
            <span>{fmtDate(meta.date)}</span>
            <TagChips values={meta.tags} />
          </>
        )}
      </div>
      {error && (
        <div className="mb-3 rounded-md bg-(--status-error-soft) px-3 py-2 font-sans text-[12px] text-(--status-error)">
          {error}
        </div>
      )}
      <div className="grid grid-cols-1 items-start gap-[18px] desktop:grid-cols-[minmax(0,1fr)_280px]">
        <div className="card min-w-0 overflow-hidden">
          {!isCurrent && (
            <div className="flex flex-wrap items-center gap-2 border-b border-(--border-subtle) bg-(--status-paused-soft) px-4 py-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
              <Icon name="rotate-ccw" size={14} />
              <span>{t('detail.viewingOlder', { revision: viewing })}</span>
              <button type="button" className="lnk text-[12px]" onClick={() => setSelectedRevision(null)}>
                {t('detail.showCurrent')}
              </button>
            </div>
          )}
          <div className="px-5 py-4">
            {shown ? (
              <MarkdownView content={shown.content} />
            ) : historyError ? (
              <div className="font-sans text-[12px] text-(--status-error)">{historyError}</div>
            ) : (
              <LoadingState size={20} padding={16} />
            )}
          </div>
        </div>
        <div className="card overflow-hidden">
          <div className="cardhead">
            <span className="cardtitle">{t('detail.history')}</span>
          </div>
          {history.isLoading && !history.data ? (
            <LoadingState size={18} padding={16} />
          ) : historyError ? (
            <div className="px-4 py-3 font-sans text-[12px] text-(--status-error)">{historyError}</div>
          ) : (
            history.data?.map((revision) => {
              const active = revision.revision === viewing
              const current = revision.revision === record.currentRevision
              return (
                <button
                  key={revision.revision}
                  type="button"
                  aria-current={active ? 'true' : undefined}
                  className={
                    active
                      ? 'row click w-full grid-cols-[minmax(0,1fr)_auto] gap-2 bg-(--surface-active) text-left'
                      : 'row click w-full grid-cols-[minmax(0,1fr)_auto] gap-2 text-left'
                  }
                  onClick={() => setSelectedRevision(current ? null : revision.revision)}
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-2">
                      <span className="mono text-[12px] font-medium text-(--text-primary)">
                        {t('revision', { value: revision.revision })}
                      </span>
                      {current && (
                        <span className="badge bg-(--status-online-soft) text-[9.5px] text-(--status-online)">
                          {t('detail.current')}
                        </span>
                      )}
                    </span>
                    <span className="mt-[2px] block truncate font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                      {provenance(revision)}
                    </span>
                  </span>
                  <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
                    {fmtDate(revision.createdAt)}
                  </span>
                </button>
              )
            })
          )}
        </div>
      </div>
      {editing && (
        <KnowledgeEditor
          record={record}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            await entry.mutate()
          }}
        />
      )}
    </div>
  )
}
