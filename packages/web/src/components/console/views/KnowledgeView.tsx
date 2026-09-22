'use client'

// Knowledge (`/knowledge`): library rows open the entry page; owners also get the Suggestions tab (organization-knowledge.md §2).

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useState, type ReactNode } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  fmtDate,
  listOrganizationKnowledge,
  listOrganizationSuggestions,
  type OrganizationKnowledgeDto
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { KnowledgeEditor, TagChips } from '@/components/console/knowledge'
import { MemoryConnectionsCard } from '@/components/console/MemoryConnectionsCard'
import { SuggestionCard } from '@/components/console/SuggestionCard'
import { LoadingState } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'

type SuggestionState = 'pending' | 'accepted' | 'rejected'
const SUGGESTION_STATES: SuggestionState[] = ['pending', 'accepted', 'rejected']
const GRID = 'grid-cols-1 desktop:grid-cols-[2.4fr_1.3fr_0.7fr_1fr] gap-3'

function EmptyCard({ icon, title, children }: { icon: string; title: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center gap-3 px-6 py-[44px] text-center">
      <span className="flex h-[46px] w-[46px] items-center justify-center rounded-[11px] border border-(--border-subtle) bg-(--surface-sunken)">
        <Icon name={icon} size={22} color="var(--text-tertiary)" />
      </span>
      <div className="font-sans text-[15px] font-semibold leading-normal">{title}</div>
      {children}
    </div>
  )
}

function ErrorCard({ message }: { message: string }) {
  return (
    <div className="card flex items-center justify-center gap-2 px-5 py-10 font-sans text-[13px] text-(--text-tertiary)">
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
        <div className="mt-1 font-mono text-[11px] font-normal leading-normal text-(--text-tertiary) desktop:hidden">
          {revision} · {fmtDate(record.updatedAt)}
        </div>
      </div>
      <div className="hidden min-w-0 desktop:block">
        <TagChips values={record.tags} max={3} />
      </div>
      <span className="mono hidden text-[12px] text-(--text-secondary) desktop:inline">{revision}</span>
      <span className="hidden font-sans text-[12px] font-normal leading-normal text-(--text-secondary) desktop:inline">
        {fmtDate(record.updatedAt)}
      </span>
    </Link>
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

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex min-h-[34px] flex-wrap items-center gap-3">
        <p className="psub mt-0 min-w-[200px] flex-1">{t('description')}</p>
        {tab === 'library' && (
          <label className="flex items-center gap-2 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {t('includeArchived')}
            <Toggle checked={includeArchived} onChange={setIncludeArchived} />
          </label>
        )}
        {canManage && (
          <Button size="sm" onClick={() => setEditing(true)}>
            <Icon name="plus" size={15} />
            {t('publish')}
          </Button>
        )}
      </div>

      {canManage && (
        <div className="mb-4 flex border-b border-(--border-subtle)">
          <button type="button" className={tab === 'library' ? 'tab on' : 'tab'} onClick={() => changeTab('library')}>
            {t('tabs.library')}
          </button>
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
        </div>
      )}

      {tab === 'library' ? (
        <>
          {knowledge.isLoading && !knowledge.data ? (
            <div className="card">
              <LoadingState size={22} padding={28} />
            </div>
          ) : knowledgeError ? (
            <ErrorCard message={knowledgeError} />
          ) : !knowledge.data?.length ? (
            <EmptyCard icon="book-open" title={t('empty.title')}>
              <div className="max-w-[400px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                {t('empty.description')}
              </div>
              {canManage && (
                <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                  <Icon name="plus" size={15} />
                  {t('publish')}
                </Button>
              )}
            </EmptyCard>
          ) : (
            <div className="card">
              <div className={`row h hidden desktop:grid ${GRID}`}>
                <span>{t('columns.title')}</span>
                <span>{t('columns.tags')}</span>
                <span>{t('columns.revision')}</span>
                <span>{t('columns.updated')}</span>
              </div>
              {knowledge.data.map((record) => (
                <KnowledgeRow key={record.id} record={record} />
              ))}
            </div>
          )}
          <MemoryConnectionsCard canManage={canManage} />
        </>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="pillbar self-start">
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
          {suggestions.isLoading && !suggestions.data ? (
            <div className="card">
              <LoadingState size={22} padding={28} />
            </div>
          ) : suggestionsError ? (
            <ErrorCard message={suggestionsError} />
          ) : !suggestions.data?.length ? (
            <EmptyCard icon="sparkles" title={t('emptySuggestions', { state: suggestionState })}>
              {suggestionState === 'pending' && (
                <div className="max-w-[400px] font-sans text-[13px] font-normal leading-[1.55] text-(--text-secondary)">
                  {t('emptySuggestionsHint')}
                </div>
              )}
            </EmptyCard>
          ) : (
            suggestions.data.map((suggestion) => (
              <SuggestionCard key={suggestion.id} suggestion={suggestion} onReviewed={reviewed} />
            ))
          )}
        </div>
      )}

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
