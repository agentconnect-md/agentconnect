'use client'

import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import {
  ApiError,
  createOrganizationKnowledge,
  fetchOrganizationSuggestionContent,
  listOrganizationKnowledge,
  listOrganizationKnowledgeRevisions,
  listOrganizationSuggestions,
  reviewOrganizationSuggestion,
  setOrganizationKnowledgeArchived,
  updateOrganizationKnowledge,
  type OrganizationKnowledgeDto,
  type OrganizationKnowledgeRevisionDto,
  type OrganizationSuggestionContentDto,
  type OrganizationSuggestionDto
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { LoadingState } from '@/components/marks'
import { MemoryConnectionsCard } from '@/components/console/MemoryConnectionsCard'
import { Button, Icon, Toggle } from '@/components/ui'
import { useTranslations } from 'next-intl'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), { ssr: false })

type SuggestionState = 'pending' | 'accepted' | 'rejected'

function when(iso: string): string {
  return new Date(iso).toLocaleString()
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function base64ByteLength(value: string): number {
  if (!value) return 0
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((value.length * 3) / 4) - padding)
}

function Tags({ values }: { values: string[] }) {
  if (!values.length) return null
  return (
    <span className="flex flex-wrap gap-1">
      {values.map((tag) => (
        <span key={tag} className="badge bg-(--surface-sunken) text-[10px] text-(--text-tertiary)">
          {tag}
        </span>
      ))}
    </span>
  )
}

function Empty({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-center gap-2 px-5 py-10 font-sans text-[13px] text-(--text-tertiary)">
      <Icon name={icon} size={16} />
      {children}
    </div>
  )
}

function SkillTree({ files }: { files: OrganizationSuggestionContentDto & { kind: 'skill' } }) {
  const t = useTranslations('Knowledge')
  const ordered = [...files.files].sort((a, b) => a.path.localeCompare(b.path))
  return (
    <div className="flex flex-col gap-3">
      <div className="rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2">
        {ordered.map((file) => (
          <div
            key={file.path}
            className="flex items-center gap-2 py-[3px] font-mono text-[11.5px] text-(--text-secondary)"
          >
            <Icon name={file.path.includes('/') ? 'file' : 'file-text'} size={13} color="var(--text-tertiary)" />
            <span>{file.path}</span>
            {file.encoding === 'base64' && (
              <span className="ml-auto text-[10px] text-(--text-disabled)">
                {t('binary')} · {bytes(base64ByteLength(file.content))}
              </span>
            )}
          </div>
        ))}
      </div>
      {ordered.map((file) => (
        <section key={`body:${file.path}`} className="overflow-hidden rounded-md border border-(--border-subtle)">
          <div className="border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-mono text-[11px] text-(--text-tertiary)">
            {file.path}
          </div>
          {file.encoding === 'base64' ? (
            <div className="px-3 py-4 font-sans text-[12px] text-(--text-tertiary)">
              {t('binaryAsset')} · {bytes(base64ByteLength(file.content))}
            </div>
          ) : file.path.toLowerCase().endsWith('.md') ? (
            <div className="px-4 py-3">
              <MarkdownView content={file.content} />
            </div>
          ) : (
            <pre className="max-h-[420px] overflow-auto whitespace-pre-wrap px-3 py-3 font-mono text-[11.5px] leading-[1.55] text-(--text-secondary)">
              {file.content}
            </pre>
          )}
        </section>
      ))}
    </div>
  )
}

export function SuggestionCard({
  suggestion,
  onReviewed
}: {
  suggestion: OrganizationSuggestionDto
  onReviewed: () => Promise<void>
}) {
  const t = useTranslations('Knowledge')
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inspect, setInspect] = useState(false)
  const contentKey =
    inspect && suggestion.state === 'pending' && suggestion.contentAvailable
      ? ['organization-suggestion-content', suggestion.id]
      : null
  const {
    data: content,
    error: contentError,
    mutate
  } = useSWR(contentKey, () => fetchOrganizationSuggestionContent(suggestion.id))

  const review = async (decision: 'accept' | 'reject') => {
    const inspectedSnapshotToken = content?.snapshotToken
    if (busy || (decision === 'accept' && !inspectedSnapshotToken)) return
    setBusy(decision)
    setError(null)
    try {
      if (decision === 'accept') {
        if (!inspectedSnapshotToken) return
        await reviewOrganizationSuggestion(suggestion.id, 'accept', inspectedSnapshotToken)
      } else await reviewOrganizationSuggestion(suggestion.id, 'reject')
      await onReviewed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const tone =
    suggestion.state === 'accepted'
      ? 'bg-(--status-online-soft) text-(--status-online)'
      : suggestion.state === 'rejected'
        ? 'bg-(--surface-sunken) text-(--text-disabled)'
        : 'bg-(--brand-soft) text-(--brand-soft-text)'

  return (
    <article className="card overflow-hidden">
      <header className="flex flex-wrap items-start gap-3 border-b border-(--border-subtle) px-4 py-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-[8px] bg-(--surface-sunken)">
          <Icon name={suggestion.kind === 'knowledge' ? 'book-open' : 'sparkles'} size={16} color="var(--brand)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-sans text-[14px] font-semibold text-(--text-primary)">{suggestion.title}</h3>
            <span className={`badge text-[9.5px] ${tone}`}>{t(`states.${suggestion.state}`)}</span>
            <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-tertiary)">
              {t(`operations.${suggestion.operation}`)}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[11px] text-(--text-tertiary)">
            <span>{t('proposedBy', { name: suggestion.sourceAgentName ?? suggestion.sourceAgentId })}</span>
            <span aria-hidden>·</span>
            <time dateTime={suggestion.createdAt}>{when(suggestion.createdAt)}</time>
            <span aria-hidden>·</span>
            <span>{bytes(suggestion.contentBytes)}</span>
          </div>
          {suggestion.summary && (
            <p className="mt-2 font-sans text-[12px] leading-[1.5] text-(--text-secondary)">{suggestion.summary}</p>
          )}
          <div className="mt-2">
            <Tags values={suggestion.tags} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px] text-(--text-disabled)">
            <span title={suggestion.dreamId}>{t('dream', { id: suggestion.dreamId })}</span>
            {suggestion.operation === 'update' && suggestion.targetArtifactId && (
              <>
                <span aria-hidden>·</span>
                <span title={suggestion.targetArtifactId}>
                  {t('targetRevision', { id: suggestion.targetArtifactId, revision: suggestion.targetRevision ?? '—' })}
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            <span title={suggestion.sessionIds.join(', ')}>
              {t('sourceSessions', { count: suggestion.sessionIds.length })}: {suggestion.sessionIds.join(', ')}
            </span>
            {suggestion.reviewedAt && (
              <>
                <span aria-hidden>·</span>
                <span>{t('reviewed', { time: when(suggestion.reviewedAt) })}</span>
              </>
            )}
          </div>
        </div>
        {suggestion.state === 'pending' && (
          <div className="flex flex-none items-center gap-2">
            {/* Accept's token comes only from the content read, so that step sits beside it — and every
                button keeps ONE meaning, so a stray second click cannot land on a decision. */}
            <Button
              variant="secondary"
              size="xs"
              disabled={!!busy || !suggestion.contentAvailable}
              onClick={() => {
                setInspect(true)
                if (contentError) void mutate()
              }}
            >
              <Icon name="eye" size={13} />
              {t('inspect')}
            </Button>
            <Button
              variant="secondary"
              size="xs"
              disabled={!!busy || !suggestion.contentAvailable}
              onClick={() => void review('reject')}
            >
              <Icon name="x" size={13} />
              {busy === 'reject' ? t('rejecting') : t('reject')}
            </Button>
            <Button
              variant="primary"
              size="xs"
              disabled={!!busy || !suggestion.contentAvailable || !content}
              onClick={() => void review('accept')}
            >
              <Icon name="check" size={13} />
              {busy === 'accept' ? t('accepting') : t('accept')}
            </Button>
          </div>
        )}
      </header>
      <div className="px-4 py-4">
        {suggestion.state !== 'pending' ? (
          <div className="font-sans text-[12px] text-(--text-tertiary)">
            {suggestion.state === 'accepted'
              ? t('acceptedRevision', { revision: suggestion.acceptedArtifactRevision ?? '—' })
              : t('rejected', { reason: suggestion.reviewReason ? `: ${suggestion.reviewReason}` : '.' })}
            {` ${t('retainedMetadata')}`}
          </div>
        ) : !suggestion.contentAvailable ? (
          <div className="flex items-center gap-2 rounded-md bg-(--status-paused-soft) px-3 py-3 font-sans text-[12px] text-(--text-secondary)">
            <Icon name="server-off" size={15} />
            {t('reviewUnavailable')}
          </div>
        ) : !inspect ? (
          <p className="rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-3 font-sans text-[12px] text-(--text-secondary)">
            {t('inspectHintPrefix')} <strong>{t('inspect')}</strong> {t('inspectHintSuffix')}
          </p>
        ) : contentError ? (
          <div className="font-sans text-[12px] text-(--status-error)">
            {contentError instanceof Error ? contentError.message : t('loadSuggestionError')}
          </div>
        ) : !content ? (
          <LoadingState size={20} padding={16} />
        ) : content.kind === 'knowledge' ? (
          <MarkdownView content={content.content} />
        ) : (
          <SkillTree files={content} />
        )}
        {error && <div className="mt-3 font-sans text-[12px] text-(--status-error)">{error}</div>}
      </div>
    </article>
  )
}

type RevisionProvenance = Pick<
  OrganizationKnowledgeRevisionDto,
  | 'source'
  | 'sourceAgentId'
  | 'sourceDreamId'
  | 'sourceSessionIds'
  | 'createdByUserId'
  | 'reviewedByUserId'
  | 'createdAt'
  | 'digest'
>

function Provenance({ value }: { value: RevisionProvenance }) {
  const t = useTranslations('Knowledge')
  return (
    <div className="flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10px] text-(--text-disabled)">
      <span>{value.source === 'dream' ? t('dreamProposal') : t('manualPublish')}</span>
      <span aria-hidden>·</span>
      <time dateTime={value.createdAt}>{when(value.createdAt)}</time>
      {value.sourceAgentId && (
        <>
          <span aria-hidden>·</span>
          <span title={value.sourceAgentId}>{t('agentId', { id: value.sourceAgentId })}</span>
        </>
      )}
      {value.sourceDreamId && (
        <>
          <span aria-hidden>·</span>
          <span title={value.sourceDreamId}>{t('dream', { id: value.sourceDreamId })}</span>
        </>
      )}
      {value.sourceSessionIds.length > 0 && (
        <>
          <span aria-hidden>·</span>
          <span title={value.sourceSessionIds.join(', ')}>
            {t('sourceSessions', { count: value.sourceSessionIds.length })}
          </span>
        </>
      )}
      {value.reviewedByUserId ? (
        <>
          <span aria-hidden>·</span>
          <span>{t('reviewedBy', { id: value.reviewedByUserId })}</span>
        </>
      ) : value.createdByUserId ? (
        <>
          <span aria-hidden>·</span>
          <span>{t('publishedBy', { id: value.createdByUserId })}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <span title={value.digest}>{value.digest.slice(0, 19)}…</span>
    </div>
  )
}

export function KnowledgeEntry({
  record,
  canManage,
  onEdit,
  onArchive
}: {
  record: OrganizationKnowledgeDto
  canManage: boolean
  onEdit: () => void
  onArchive: () => void
}) {
  const t = useTranslations('Knowledge')
  const [open, setOpen] = useState(false)
  const [selectedRevision, setSelectedRevision] = useState(record.currentRevision)
  useEffect(() => setSelectedRevision(record.currentRevision), [record.currentRevision])
  const history = useSWR(open ? ['organization-knowledge-revisions', record.id, record.currentRevision] : null, () =>
    listOrganizationKnowledgeRevisions(record.id)
  )
  const selected = history.data?.find((revision) => revision.revision === selectedRevision)

  return (
    <details
      className={`group ${record.archivedAt ? 'opacity-60' : ''}`}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 marker:hidden">
        <Icon name="chevron-right" size={15} className="mt-[2px] flex-none group-open:rotate-90" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-sans text-[13px] font-semibold text-(--text-primary)">{record.title}</span>
            <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-tertiary)">
              {t('revision', { value: record.currentRevision })}
            </span>
            {record.archivedAt && (
              <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-disabled)">{t('archived')}</span>
            )}
          </div>
          {record.summary && (
            <p className="mt-1 font-sans text-[12px] leading-[1.45] text-(--text-secondary)">{record.summary}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Tags values={record.tags} />
            <span className="font-sans text-[10.5px] text-(--text-disabled)">
              {t('updated', {
                time: when(record.updatedAt),
                source: record.source === 'dream' ? t('dreamProposal') : t('manual')
              })}
            </span>
          </div>
        </div>
        {canManage && (
          <div className="flex flex-none items-center gap-1" onClick={(event) => event.preventDefault()}>
            {!record.archivedAt && (
              <button className="iconbtn" title={t('publishRevisionTitle')} onClick={onEdit}>
                <Icon name="pencil" size={13} />
              </button>
            )}
            <button className="iconbtn" title={record.archivedAt ? t('restore') : t('archive')} onClick={onArchive}>
              <Icon name={record.archivedAt ? 'archive-restore' : 'archive'} size={13} />
            </button>
          </div>
        )}
      </summary>
      <div className="border-t border-(--border-subtle) px-5 py-4">
        {history.isLoading ? (
          <LoadingState size={18} padding={12} />
        ) : history.error ? (
          <div className="font-sans text-[12px] text-(--status-error)">{history.error.message}</div>
        ) : !selected ? (
          <div className="font-sans text-[12px] text-(--text-tertiary)">{t('revisionHistoryUnavailable')}</div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-(--surface-sunken) px-3 py-2">
              <label className="flex items-center gap-2 font-sans text-[11px] text-(--text-tertiary)">
                {t('revisionLabel')}
                <select
                  className="inp h-7 min-w-20 py-0 text-[11px]"
                  aria-label={t('revisionSelectAria', { title: record.title })}
                  value={selectedRevision}
                  onChange={(event) => setSelectedRevision(Number(event.target.value))}
                >
                  {history.data?.map((revision) => (
                    <option key={revision.revision} value={revision.revision}>
                      {revision.revision}
                      {revision.revision === record.currentRevision ? ` (${t('current')})` : ''}
                    </option>
                  ))}
                </select>
              </label>
              <div className="min-w-0 flex-1">
                <Provenance value={selected} />
              </div>
            </div>
            {selected.summary && <p className="font-sans text-[12px] text-(--text-secondary)">{selected.summary}</p>}
            <Tags values={selected.tags} />
            <MarkdownView content={selected.content} />
          </div>
        )}
      </div>
    </details>
  )
}

function KnowledgeEditor({
  record,
  onClose,
  onSaved
}: {
  record: OrganizationKnowledgeDto | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('Knowledge')
  const [title, setTitle] = useState(record?.title ?? '')
  const [summary, setSummary] = useState(record?.summary ?? '')
  const [tags, setTags] = useState(record?.tags.join(', ') ?? '')
  const [content, setContent] = useState(record?.content ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    if (busy || !title.trim() || !content.trim()) return
    setBusy(true)
    setError(null)
    const input = {
      title: title.trim(),
      content,
      ...(summary.trim() ? { summary: summary.trim() } : {}),
      tags: tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    }
    try {
      if (record) await updateOrganizationKnowledge(record.id, { ...input, expectedRevision: record.currentRevision })
      else await createOrganizationKnowledge(input)
      await onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <div className="scrim" onClick={onClose}>
      <div className="modal max-w-[780px]" onClick={(event) => event.stopPropagation()}>
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="book-open" size={16} color="var(--brand)" />
          </span>
          <span className="flex-1 font-sans text-[16px] font-semibold">
            {record ? t('publishRevision', { value: record.currentRevision + 1 }) : t('publishKnowledge')}
          </span>
          <button className="iconbtn" onClick={onClose} aria-label={t('close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-3">
          <label className="fld">
            <span className="fldlbl">{t('fields.title')}</span>
            <input className="inp" value={title} maxLength={128} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="fld">
            <span className="fldlbl">{t('fields.summary')}</span>
            <input
              className="inp"
              value={summary}
              maxLength={1024}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label className="fld">
            <span className="fldlbl">{t('fields.tags')}</span>
            <input
              className="inp mn"
              placeholder={t('fields.tagsPlaceholder')}
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label className="fld">
            <span className="fldlbl">{t('fields.markdown')}</span>
            <textarea
              className="inp mn min-h-[300px] resize-y py-3"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          {error && <div className="font-sans text-[12px] text-(--status-error)">{error}</div>}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !title.trim() || !content.trim()} onClick={() => void save()}>
            {busy ? t('publishing') : record ? t('publishRevisionAction') : t('publish')}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function KnowledgeView() {
  const t = useTranslations('Knowledge')
  const { activeOrg, myRole, orgPath } = useOrgs()
  const router = useRouter()
  const search = useSearchParams()
  const tab = search.get('tab') === 'suggestions' ? 'suggestions' : 'organization'
  const [includeArchived, setIncludeArchived] = useState(false)
  const [suggestionState, setSuggestionState] = useState<SuggestionState>('pending')
  const [editor, setEditor] = useState<OrganizationKnowledgeDto | null | undefined>(undefined)
  const [actionError, setActionError] = useState<string | null>(null)
  const canManage = myRole === 'owner'

  const knowledgeKey = activeOrg ? ['organization-knowledge', activeOrg.id, includeArchived] : null
  const suggestionsKey =
    activeOrg && canManage && tab === 'suggestions' ? ['organization-suggestions', activeOrg.id, suggestionState] : null
  const knowledge = useSWR(knowledgeKey, () => listOrganizationKnowledge(includeArchived))
  const suggestions = useSWR(suggestionsKey, () => listOrganizationSuggestions({ state: suggestionState }))

  const refreshOrganization = async () => {
    await knowledge.mutate()
  }
  const reviewed = async () => {
    await Promise.all([suggestions.mutate(), knowledge.mutate()])
  }
  const changeTab = (next: 'organization' | 'suggestions') => {
    router.replace(orgPath(`/knowledge${next === 'suggestions' ? '?tab=suggestions' : ''}`))
  }
  const archiveKnowledge = async (record: OrganizationKnowledgeDto) => {
    setActionError(null)
    try {
      await setOrganizationKnowledgeArchived(record.id, !record.archivedAt)
      await knowledge.mutate()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const suggestionCounts = useMemo(() => {
    const rows = suggestions.data ?? []
    return { total: rows.length, available: rows.filter((row) => row.contentAvailable).length }
  }, [suggestions.data])

  return (
    <div className="wrap max-desktop:p-4">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <p className="psub mt-0 min-w-[240px] flex-1">{t('description')}</p>
        {tab === 'organization' && canManage && (
          <Button variant="primary" size="sm" onClick={() => setEditor(null)}>
            <Icon name="plus" size={14} />
            {t('publishKnowledge')}
          </Button>
        )}
      </div>

      <div className="mb-4 flex items-center justify-between border-b border-(--border-subtle)">
        <div className="tabs border-b-0">
          <button className={tab === 'organization' ? 'tab on' : 'tab'} onClick={() => changeTab('organization')}>
            {t('tabs.organization')}
          </button>
          <button className={tab === 'suggestions' ? 'tab on' : 'tab'} onClick={() => changeTab('suggestions')}>
            {t('tabs.suggestions')}
          </button>
        </div>
        {tab === 'organization' && (
          <label className="flex items-center gap-2 pb-2 font-sans text-[11.5px] text-(--text-tertiary)">
            {t('includeArchived')}
            <Toggle checked={includeArchived} onChange={setIncludeArchived} />
          </label>
        )}
      </div>

      {actionError && (
        <div className="mb-3 rounded-md bg-(--status-error-soft) px-3 py-2 font-sans text-[12px] text-(--status-error)">
          {actionError}
        </div>
      )}

      {tab === 'organization' ? (
        <section className="card overflow-hidden">
          <div className="cardhead justify-between">
            <span className="cardtitle">{t('library')}</span>
            <span className="mono text-[11px] text-(--text-tertiary)">
              {t('entries', { count: knowledge.data?.length ?? 0 })}
            </span>
          </div>
          {knowledge.isLoading ? (
            <LoadingState size={22} padding={24} />
          ) : knowledge.error ? (
            <Empty icon="triangle-alert">{knowledge.error.message}</Empty>
          ) : !knowledge.data?.length ? (
            <Empty icon="book-open">{t('emptyKnowledge')}</Empty>
          ) : (
            <div className="divide-y divide-(--border-subtle)">
              {knowledge.data.map((record) => (
                <KnowledgeEntry
                  key={record.id}
                  record={record}
                  canManage={canManage}
                  onEdit={() => setEditor(record)}
                  onArchive={() => void archiveKnowledge(record)}
                />
              ))}
            </div>
          )}
        </section>
      ) : !canManage ? (
        <section className="card">
          <Empty icon="shield">{t('ownerOnly')}</Empty>
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {(['pending', 'accepted', 'rejected'] as const).map((state) => (
              <button
                key={state}
                className={suggestionState === state ? 'pill on' : 'pill'}
                onClick={() => setSuggestionState(state)}
              >
                {t(`states.${state}`)}
              </button>
            ))}
            <span className="ml-auto font-sans text-[11px] text-(--text-tertiary)">
              {t('suggestionCount', { count: suggestionCounts.total })}
              {suggestionState === 'pending' ? ` · ${t('availableNow', { count: suggestionCounts.available })}` : ''}
            </span>
          </div>
          {suggestions.isLoading ? (
            <section className="card">
              <LoadingState size={22} padding={28} />
            </section>
          ) : suggestions.error ? (
            <section className="card">
              <Empty icon="triangle-alert">
                {suggestions.error instanceof ApiError && suggestions.error.status === 403
                  ? t('ownerOnlySuggestions')
                  : suggestions.error.message}
              </Empty>
            </section>
          ) : !suggestions.data?.length ? (
            <section className="card">
              <Empty icon="sparkles">{t('emptySuggestions', { state: t(`states.${suggestionState}`) })}</Empty>
            </section>
          ) : (
            suggestions.data.map((suggestion) => (
              <SuggestionCard key={suggestion.id} suggestion={suggestion} onReviewed={reviewed} />
            ))
          )}
        </div>
      )}

      <MemoryConnectionsCard canManage={canManage} />

      {editor !== undefined && (
        <KnowledgeEditor record={editor} onClose={() => setEditor(undefined)} onSaved={refreshOrganization} />
      )}
    </div>
  )
}
