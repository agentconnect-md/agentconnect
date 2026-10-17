'use client'

// Knowledge (`/knowledge`): the Handbook, the organization record's three entries, above the Library and its Suggestions (organization-knowledge.md §2, §15.5).

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  fmtDate,
  getOrganizationRecord,
  listOrganizationKnowledge,
  listOrganizationSuggestions,
  type OrganizationKnowledgeDto
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { KnowledgeEditor, TagChips } from '@/components/console/knowledge'
import {
  HANDBOOK_ICONS,
  RECORD_KINDS,
  useRecordName,
  useRecordSummary,
  useResearchStatus,
  type RecordKind
} from '@/components/console/handbook'
import { AgentVisibilityCell } from '@/components/console/VisibilityField'
import { MemoryConnectionsCard } from '@/components/console/MemoryConnectionsCard'
import { SuggestionRow } from '@/components/console/SuggestionRow'
import { LoadingState } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'

type SuggestionState = 'pending' | 'accepted' | 'rejected'
const SUGGESTION_STATES: SuggestionState[] = ['pending', 'accepted', 'rejected']
const GRID = 'grid-cols-1 desktop:grid-cols-[2.2fr_1.1fr_1.3fr_0.6fr_0.9fr] gap-3'
const HANDBOOK_GRID = 'grid-cols-[auto_minmax(0,1fr)] desktop:grid-cols-[auto_minmax(0,1fr)_1.3fr_0.9fr] gap-3'

function EmptyState({
  icon,
  title,
  card = false,
  children
}: {
  icon: string
  title: string
  /** Standalone card, or bare so it can sit inside one. */
  card?: boolean
  children?: ReactNode
}) {
  return (
    <div
      className={
        card
          ? 'card flex flex-col items-center gap-3 px-6 py-[44px] text-center'
          : 'flex flex-col items-center gap-3 px-6 py-[44px] text-center'
      }
    >
      <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name={icon} size={22} color="var(--text-tertiary)" />
      </span>
      <div className="font-sans text-[15px] font-semibold leading-normal">{title}</div>
      {children}
    </div>
  )
}

function ErrorNote({ message, card = false }: { message: string; card?: boolean }) {
  return (
    <div
      className={
        card
          ? 'card flex items-center justify-center gap-2 px-5 py-10 font-sans text-[13px] text-(--text-tertiary)'
          : 'flex items-center justify-center gap-2 px-5 py-10 font-sans text-[13px] text-(--text-tertiary)'
      }
    >
      <Icon name="triangle-alert" size={16} />
      {message}
    </div>
  )
}

function KnowledgeRow({ record }: { record: OrganizationKnowledgeDto }) {
  const t = useTranslations('Knowledge')
  const { orgPath } = useOrgs()
  const revision = t('revision', { value: record.currentRevision })
  return (
    <Link
      href={orgPath(`/knowledge/${record.id}`)}
      className={`row click ${GRID} ${record.archivedAt ? 'opacity-60' : ''}`}
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
            {record.title}
          </span>
          {record.archivedAt && (
            <span className="badge flex-none bg-(--surface-sunken) text-[9.5px] text-(--text-disabled)">
              {t('archived')}
            </span>
          )}
        </div>
        {record.summary && (
          <div className="mt-[2px] truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {record.summary}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 desktop:hidden">
          <AgentVisibilityCell visibility={record.visibility} readers={record.readers} />
          <span className="font-mono text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {revision} · {fmtDate(record.updatedAt)}
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 desktop:block">
        <TagChips values={record.tags} max={3} />
      </div>
      <div className="hidden min-w-0 desktop:block">
        <AgentVisibilityCell visibility={record.visibility} readers={record.readers} />
      </div>
      <span className="mono hidden text-[12px] text-(--text-secondary) desktop:inline">{revision}</span>
      <span className="hidden font-sans text-[12px] font-normal leading-normal text-(--text-secondary) desktop:inline">
        {fmtDate(record.updatedAt)}
      </span>
    </Link>
  )
}

/** One quiet Handbook row: the entry's icon, name and one-line summary, its readers and its last update. */
function HandbookRow({ kind, record }: { kind: RecordKind; record: OrganizationKnowledgeDto }) {
  const { orgPath } = useOrgs()
  const name = useRecordName()
  const summary = useRecordSummary()
  return (
    <Link href={orgPath(`/knowledge/${record.id}`)} className={`row click ${HANDBOOK_GRID}`}>
      <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name={HANDBOOK_ICONS[kind]} size={15} color="var(--text-secondary)" />
      </span>
      <div className="min-w-0">
        <div className="font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">{name(kind)}</div>
        <div className="truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
          {summary(kind, record.content)}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 desktop:hidden">
          <AgentVisibilityCell visibility={record.visibility} readers={record.readers} />
          <span className="font-sans text-[11px] font-normal leading-normal text-(--text-tertiary)">
            {fmtDate(record.updatedAt)}
          </span>
        </div>
      </div>
      <div className="hidden min-w-0 desktop:block">
        <AgentVisibilityCell visibility={record.visibility} readers={record.readers} />
      </div>
      <span className="hidden font-sans text-[12px] font-normal leading-normal text-(--text-secondary) desktop:inline">
        {fmtDate(record.updatedAt)}
      </span>
    </Link>
  )
}

function Handbook() {
  const t = useTranslations('Knowledge.handbook')
  const { activeOrg } = useOrgs()
  const status = useResearchStatus()
  const record = useSWR(consoleKeys.organizationRecord(activeOrg?.id), () => getOrganizationRecord())
  const entries = RECORD_KINDS.flatMap((kind) => {
    const entry = record.data?.entries.find((candidate) => candidate.kind === kind)
    return entry ? [{ kind, entry }] : []
  })
  const error = record.error instanceof Error ? record.error.message : null
  return (
    <section className="mb-6">
      <div className="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 className="font-sans text-[15px] font-semibold leading-normal text-(--text-primary)">{t('title')}</h2>
        {record.data && (
          <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
            {status(record.data.research)}
          </span>
        )}
      </div>
      {record.isLoading && !record.data ? (
        <div className="card">
          <LoadingState size={22} padding={20} />
        </div>
      ) : error ? (
        <ErrorNote message={error} card />
      ) : entries.length === 0 ? (
        <div className="card flex items-center gap-3 px-4 py-4 font-sans text-[13px] font-normal leading-normal text-(--text-tertiary)">
          <Icon name="book-open" size={16} />
          {t('noRecord')}
        </div>
      ) : (
        <div className="card">
          {entries.map(({ kind, entry }) => (
            <HandbookRow key={kind} kind={kind} record={entry} />
          ))}
        </div>
      )}
    </section>
  )
}

export default function KnowledgeView() {
  const t = useTranslations('Knowledge')
  const { activeOrg, myRole, orgPath } = useOrgs()
  const router = useRouter()
  const search = useSearchParams()
  const canManage = myRole === 'owner'
  const tab = canManage && search.get('tab') === 'suggestions' ? 'suggestions' : 'library'
  const [includeArchived, setIncludeArchived] = useState(false)
  const [suggestionState, setSuggestionState] = useState<SuggestionState>('pending')
  const [openSuggestionId, setOpenSuggestionId] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)

  const knowledge = useSWR(
    consoleKeys.organizationKnowledge(activeOrg?.id, includeArchived),
    ([, , , mode]) => listOrganizationKnowledge(mode === 'include-archived'),
    { keepPreviousData: true }
  )
  // Pending proposals load for every owner: their count on the tab is the review inbox.
  const pending = useSWR(
    canManage ? consoleKeys.organizationSuggestions(activeOrg?.id, 'pending') : null,
    ([, , , state]) => listOrganizationSuggestions({ state })
  )
  const suggestions = useSWR(
    canManage && tab === 'suggestions' ? consoleKeys.organizationSuggestions(activeOrg?.id, suggestionState) : null,
    ([, , , state]) => listOrganizationSuggestions({ state })
  )

  const reviewed = async () => {
    await Promise.all([suggestions.mutate(), pending.mutate(), knowledge.mutate()])
  }
  const changeTab = (next: 'library' | 'suggestions') => {
    router.replace(orgPath(`/knowledge${next === 'suggestions' ? '?tab=suggestions' : ''}`))
  }
  const pendingCount = pending.data?.length ?? 0
  const knowledgeError = knowledge.error instanceof Error ? knowledge.error.message : null
  const suggestionsError = suggestions.error instanceof Error ? suggestions.error.message : null
  // The record's entries live in the Handbook, never in the Library.
  const library = knowledge.data?.filter((record) => record.kind === 'entry')

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex min-h-[34px] flex-wrap items-center gap-3">
        <p className="psub mt-0 min-w-[200px] flex-1">{t('description')}</p>
        {canManage && (
          <Button size="sm" onClick={() => setEditing(true)}>
            <Icon name="plus" size={15} />
            {t('publish')}
          </Button>
        )}
      </div>

      <Handbook />

      <section>
        <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-(--border-subtle)">
          <button type="button" className={tab === 'library' ? 'tab on' : 'tab'} onClick={() => changeTab('library')}>
            {t('tabs.library')}
          </button>
          {canManage && (
            <button
              type="button"
              className={
                tab === 'suggestions'
                  ? 'tab on inline-flex items-center gap-[6px]'
                  : 'tab inline-flex items-center gap-[6px]'
              }
              onClick={() => changeTab('suggestions')}
            >
              {t('tabs.suggestions')}
              {pendingCount > 0 && (
                <span className="badge bg-(--brand-soft) text-[10px] text-(--brand-soft-text)">{pendingCount}</span>
              )}
            </button>
          )}
          <div className="flex-1" />
          {tab === 'library' && (
            <label className="mb-1 flex items-center gap-2 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('includeArchived')}
              <Toggle checked={includeArchived} onChange={setIncludeArchived} />
            </label>
          )}
        </div>

        {tab === 'library' ? (
          <>
            {knowledge.isLoading && !knowledge.data ? (
              <div className="card">
                <LoadingState size={22} padding={28} />
              </div>
            ) : knowledgeError ? (
              <ErrorNote message={knowledgeError} card />
            ) : !library?.length ? (
              <EmptyState icon="book-open" title={t('empty.title')} card>
                <div className="max-w-[400px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                  {t('empty.description')}
                </div>
                {canManage && (
                  <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                    <Icon name="plus" size={15} />
                    {t('publish')}
                  </Button>
                )}
              </EmptyState>
            ) : (
              <div className="card">
                <div className={`row h hidden desktop:grid ${GRID}`}>
                  <span>{t('columns.title')}</span>
                  <span>{t('columns.tags')}</span>
                  <span>{t('columns.visibility')}</span>
                  <span>{t('columns.revision')}</span>
                  <span>{t('columns.updated')}</span>
                </div>
                {library.map((record) => (
                  <KnowledgeRow key={record.id} record={record} />
                ))}
              </div>
            )}
            <MemoryConnectionsCard canManage={canManage} />
          </>
        ) : (
          <div className="card">
            <div className="cardhead justify-between gap-3">
              <div className="pillbar">
                {SUGGESTION_STATES.map((state) => (
                  <button
                    key={state}
                    type="button"
                    className={suggestionState === state ? 'pill on' : 'pill'}
                    onClick={() => setSuggestionState(state)}
                  >
                    {t(`states.${state}`)}
                  </button>
                ))}
              </div>
              {!!suggestions.data?.length && (
                <span className="hidden font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:inline">
                  {t('suggestionCount', { count: suggestions.data.length })}
                </span>
              )}
            </div>
            {suggestions.isLoading && !suggestions.data ? (
              <LoadingState size={22} padding={28} />
            ) : suggestionsError ? (
              <ErrorNote message={suggestionsError} />
            ) : !suggestions.data?.length ? (
              <EmptyState icon="sparkles" title={t('emptySuggestions', { state: suggestionState })}>
                {suggestionState === 'pending' && (
                  <div className="max-w-[400px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                    {t('emptySuggestionsHint')}
                  </div>
                )}
              </EmptyState>
            ) : (
              suggestions.data.map((suggestion) => (
                <SuggestionRow
                  key={suggestion.id}
                  suggestion={suggestion}
                  open={openSuggestionId === suggestion.id}
                  onToggle={() => setOpenSuggestionId((current) => (current === suggestion.id ? null : suggestion.id))}
                  onReviewed={reviewed}
                />
              ))
            )}
          </div>
        )}
      </section>

      {editing && (
        <KnowledgeEditor
          record={null}
          onClose={() => setEditing(false)}
          onSaved={async () => {
            await knowledge.mutate()
          }}
        />
      )}
    </div>
  )
}
