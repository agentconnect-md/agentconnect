'use client'

// One knowledge entry: current revision, history, owner actions and its readers; the record's entries render as file views (organization-knowledge.md §2, §15.5).

import { useEffect, useState } from 'react'
import dynamic from 'next/dynamic'
import { useParams } from 'next/navigation'
import useSWR from 'swr'
import { useFormatter, useTranslations } from 'next-intl'
import { parseOrganizationFile } from '@agentconnect.md/protocol/organization-files'
import {
  ApiError,
  clearPeopleEntry,
  fetchMyPeopleEntries,
  fmtDate,
  getOrganizationKnowledge,
  listOrganizationKnowledgeRevisions,
  removeMyPeopleEntry,
  setKnowledgeVisibility,
  setOrganizationKnowledgeArchived,
  updateOrganizationKnowledge,
  updatePeopleEntry,
  writeMyPeopleEntry,
  type OrganizationKnowledgeDto
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { useConsoleData } from '@/lib/data-context'
import { agentLabel } from '@/lib/data'
import { useCrumbSlot } from '@/components/console/Shell'
import { NotFound } from '@/components/console/NotFound'
import { KnowledgeEditor, TagChips, useProvenanceLabel } from '@/components/console/knowledge'
import {
  AboutSourcesRail,
  AboutView,
  aboutDocument,
  ChannelsView,
  PeopleView,
  RecordTextEditor,
  isRecordKind,
  recordFile,
  useRecordName,
  type AboutDocument,
  type PeopleActions,
  type RecordKind,
  type SourceFocus
} from '@/components/console/handbook'
import {
  AgentVisibilityCell,
  AgentVisibilityField,
  type AgentVisibilityValue
} from '@/components/console/VisibilityField'
import { ConfirmationDialog } from '@/components/console/ConfirmationDialog'
import { Scrim } from '@/components/console/Scrim'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), { ssr: false })

/** A record entry's text as its file view, or its Markdown when the text no longer fits the shape. */
function RecordBody({
  kind,
  content,
  people,
  about
}: {
  kind: RecordKind
  content: string
  people?: PeopleActions
  about?: { doc: AboutDocument; focus: SourceFocus }
}) {
  if (!parseOrganizationFile(recordFile(kind), content).ok) return <MarkdownView content={content} />
  if (kind === 'organization') return about ? <AboutView {...about} /> : null
  if (kind === 'channels') return <ChannelsView content={content} />
  return <PeopleView content={content} actions={people} />
}

/** "Updated 2 hours ago by Atlas" for About's revision on screen; the agent is named only when one wrote it and still exists. */
function useUpdatedLine(): (date: string, source: { source: string; sourceAgentId: string | null }) => string {
  const th = useTranslations('Knowledge.handbook')
  const format = useFormatter()
  const { agents } = useConsoleData()
  return (date, source) => {
    const when = format.relativeTime(new Date(date), { now: Date.now() })
    const agent = source.source === 'agent' ? agents.find((a) => a.id === source.sourceAgentId) : undefined
    return agent ? th('updatedBy', { when, name: agentLabel(agent) }) : th('updated', { when })
  }
}

/** Which agents read an entry, an owner's choice; About and Channels are every agent's and never open it. */
function VisibilityEditor({
  record,
  onClose,
  onSaved
}: {
  record: OrganizationKnowledgeDto
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('Knowledge.visibility')
  const [value, setValue] = useState<AgentVisibilityValue>({ visibility: record.visibility, readers: record.readers })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await setKnowledgeVisibility(record.id, value)
      await onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }
  return (
    <Scrim onEscape={busy ? undefined : onClose} onClick={busy ? undefined : onClose}>
      <div className="modal max-w-[620px]" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="modalhead">
          <span className="flex-1 font-sans text-[16px] font-semibold leading-normal">{t('title')}</span>
          <button type="button" className="iconbtn" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody">
          <AgentVisibilityField value={value} onChange={setValue} disabled={busy} />
          {error && <div className="mt-2 font-sans text-[12px] text-(--status-error)">{error}</div>}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy} onClick={() => void save()}>
            {busy ? t('saving') : t('save')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}

type PeopleEdit = { key: string; text: string; own: boolean }
type Confirm = { kind: 'clear-record' } | { kind: 'remove-card'; key: string; own: boolean }

export default function KnowledgeDetailView() {
  const t = useTranslations('Knowledge')
  const th = useTranslations('Knowledge.handbook')
  const { id } = useParams<{ id: string }>()
  const { activeOrg, myRole, orgPath } = useOrgs()
  const canManage = myRole === 'owner'
  const provenance = useProvenanceLabel()
  const updatedLine = useUpdatedLine()
  const recordName = useRecordName()
  const [activeSource, setActiveSource] = useState<number | null>(null)
  const entry = useSWR(consoleKeys.organizationKnowledgeEntry(activeOrg?.id, id), ([, , , entryId]) =>
    getOrganizationKnowledge(entryId)
  )
  const record = entry.data
  const kind = record && isRecordKind(record.kind) ? record.kind : null
  const history = useSWR(
    record
      ? consoleKeys.organizationKnowledgeRevisions(activeOrg?.id, record.id, String(record.currentRevision))
      : null,
    ([, , , entryId]) => listOrganizationKnowledgeRevisions(entryId)
  )
  // The caller's own People cards, the ones that carry Edit and Remove for them.
  const mine = useSWR(
    record && kind === 'people'
      ? consoleKeys.myPeopleEntries(activeOrg?.id, record.id, String(record.currentRevision))
      : null,
    ([, , , peopleId]) => fetchMyPeopleEntries(peopleId)
  )
  const [selectedRevision, setSelectedRevision] = useState<number | null>(null)
  const [editing, setEditing] = useState(false)
  const [editingVisibility, setEditingVisibility] = useState(false)
  const [peopleEdit, setPeopleEdit] = useState<PeopleEdit | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The mobile push bar reads the title from this slot.
  const { register: registerCrumb } = useCrumbSlot()
  const title = record ? (kind ? recordName(kind) : record.title) : ''
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
  // About and Channels are read by every agent; People's readers and every other entry's are an owner's choice.
  const visibilityFixed = kind === 'organization' || kind === 'channels'
  // About reads as a document whose footnotes and sources rail point at each other.
  const aboutDoc = kind === 'organization' && shown ? aboutDocument(shown.content) : null
  const about = aboutDoc ? { doc: aboutDoc, focus: { active: activeSource, onActive: setActiveSource } } : undefined

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
      await entry.mutate()
      setConfirm(null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const saveRecord = async (content: string) => {
    await updateOrganizationKnowledge(record.id, {
      title: record.title,
      content,
      tags: [],
      expectedRevision: record.currentRevision
    })
    await entry.mutate()
  }
  const people: PeopleActions | undefined =
    kind === 'people' && isCurrent
      ? {
          ownKeys: mine.data?.keys ?? [],
          owner: canManage,
          onEdit: (key, text, own) => setPeopleEdit({ key, text, own }),
          onRemove: (key, own) => setConfirm({ kind: 'remove-card', key, own })
        }
      : undefined

  return (
    <div className="wrap max-desktop:p-4">
      {/* The mobile push bar carries the title, so only the desktop renders it here. */}
      <div className="flex items-start gap-4">
        <div className="hidden min-w-0 flex-1 desktop:block">
          <div className="flex min-w-0 flex-wrap items-center gap-[10px]">
            <h1 className="ptitle truncate">{title}</h1>
            {kind === 'organization' && (
              <span className="font-mono text-[12px] font-normal leading-normal text-(--text-tertiary)">
                {recordFile(kind)}
              </span>
            )}
            <span className="badge bg-(--surface-active) text-(--text-secondary)">{revisionLabel}</span>
            {record.archivedAt && (
              <span className="badge bg-(--surface-sunken) text-(--text-disabled)">{t('archived')}</span>
            )}
          </div>
          {!kind && meta?.summary && <p className="psub">{meta.summary}</p>}
        </div>
        {canManage && (
          <div className="flex flex-none flex-wrap items-center gap-2">
            {kind ? (
              <>
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                  <Icon name="pencil" size={14} />
                  {th('edit')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => setConfirm({ kind: 'clear-record' })}
                >
                  <Icon name="eraser" size={14} />
                  {th('clear')}
                </Button>
              </>
            ) : (
              <>
                {!record.archivedAt && (
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setEditing(true)}>
                    <Icon name="pencil" size={14} />
                    {t('detail.newRevision')}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => setOrganizationKnowledgeArchived(record.id, !record.archivedAt))}
                >
                  <Icon name={record.archivedAt ? 'archive-restore' : 'archive'} size={14} />
                  {record.archivedAt ? t('detail.restore') : t('detail.archive')}
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="mt-[9px] mb-5 flex flex-wrap items-center gap-x-3 gap-y-2 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        <span className="desktop:hidden">{revisionLabel}</span>
        <span className="inline-flex items-center gap-2">
          <AgentVisibilityCell visibility={record.visibility} readers={record.readers} />
          {canManage && !visibilityFixed && (
            <button type="button" className="lnk text-[12px]" onClick={() => setEditingVisibility(true)}>
              {t('visibility.change')}
            </button>
          )}
        </span>
        {meta &&
          (kind === 'organization' ? (
            <span title={fmtDate(meta.date)}>{updatedLine(meta.date, meta.source)}</span>
          ) : (
            <>
              <span>{provenance(meta.source)}</span>
              <span>{fmtDate(meta.date)}</span>
              <TagChips values={meta.tags} />
            </>
          ))}
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
              kind ? (
                <RecordBody
                  kind={kind}
                  content={shown.content}
                  {...(people ? { people } : {})}
                  {...(about ? { about } : {})}
                />
              ) : (
                <MarkdownView content={shown.content} />
              )
            ) : historyError ? (
              <div className="font-sans text-[12px] text-(--status-error)">{historyError}</div>
            ) : (
              <LoadingState size={20} padding={16} />
            )}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-[18px]">
          {about && <AboutSourcesRail {...about} />}
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
      </div>
      {editing &&
        (kind ? (
          <RecordTextEditor
            title={th('editTitle', { name: title })}
            initial={record.content}
            onClose={() => setEditing(false)}
            onSave={saveRecord}
          />
        ) : (
          <KnowledgeEditor
            record={record}
            onClose={() => setEditing(false)}
            onSaved={async () => {
              await entry.mutate()
            }}
          />
        ))}
      {editingVisibility && (
        <VisibilityEditor
          record={record}
          onClose={() => setEditingVisibility(false)}
          onSaved={async () => {
            await entry.mutate()
          }}
        />
      )}
      {peopleEdit && (
        <RecordTextEditor
          title={peopleEdit.own ? th('editYourCard') : th('editCard')}
          initial={peopleEdit.text}
          onClose={() => setPeopleEdit(null)}
          onSave={async (text) => {
            const body = { text, expectedRevision: record.currentRevision }
            if (peopleEdit.own) await writeMyPeopleEntry(record.id, body)
            else await updatePeopleEntry(record.id, peopleEdit.key, body)
            await Promise.all([entry.mutate(), mine.mutate()])
          }}
        />
      )}
      {confirm && (
        <ConfirmationDialog
          title={
            confirm.kind === 'clear-record'
              ? th('clearTitle', { name: title })
              : confirm.own
                ? th('removeYourCardTitle')
                : th('clearCardTitle')
          }
          confirmLabel={confirm.kind === 'remove-card' && confirm.own ? th('remove') : th('clear')}
          destructive
          busy={busy}
          error={error}
          onClose={() => setConfirm(null)}
          onConfirm={() =>
            void run(async () => {
              if (confirm.kind === 'clear-record') await saveRecord(`# ${record.title}\n`)
              else if (confirm.own) await removeMyPeopleEntry(record.id)
              else await clearPeopleEntry(record.id, confirm.key)
              await mine.mutate()
            })
          }
        >
          {confirm.kind === 'clear-record'
            ? th(kind === 'people' ? 'clearPeopleBody' : 'clearBody')
            : confirm.own
              ? th('removeYourCardBody')
              : th('clearCardBody')}
        </ConfirmationDialog>
      )}
    </div>
  )
}
