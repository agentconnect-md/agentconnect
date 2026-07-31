'use client'

import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import { useMemo, useState, type ReactNode } from 'react'
import useSWR from 'swr'
import {
  ApiError,
  createOrganizationKnowledge,
  fetchOrganizationSuggestionContent,
  listManagedSkills,
  listOrganizationKnowledge,
  listOrganizationSuggestions,
  reviewOrganizationSuggestion,
  setManagedSkillArchived,
  setOrganizationKnowledgeArchived,
  updateOrganizationKnowledge,
  type ManagedSkillDto,
  type OrganizationKnowledgeDto,
  type OrganizationSuggestionContentDto,
  type OrganizationSuggestionDto
} from '@/lib/api'
import { useOrgs } from '@/lib/org-context'
import { LoadingState } from '@/components/marks'
import { Button, Icon, Toggle } from '@/components/ui'

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
                binary · {bytes(base64ByteLength(file.content))}
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
              Binary asset · {bytes(base64ByteLength(file.content))}
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
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inspect, setInspect] = useState(false)
  const contentKey =
    inspect && suggestion.state === 'pending' && suggestion.contentAvailable
      ? ['organization-suggestion-content', suggestion.id]
      : null
  const { data: content, error: contentError } = useSWR(contentKey, () =>
    fetchOrganizationSuggestionContent(suggestion.id)
  )

  const review = async (decision: 'accept' | 'reject') => {
    if (busy) return
    setBusy(decision)
    setError(null)
    try {
      await reviewOrganizationSuggestion(suggestion.id, decision)
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
            <span className={`badge text-[9.5px] ${tone}`}>{suggestion.state}</span>
            <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-tertiary)">
              {suggestion.operation}
            </span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 font-sans text-[11px] text-(--text-tertiary)">
            <span>Proposed by {suggestion.sourceAgentName ?? suggestion.sourceAgentId}</span>
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
            <span title={suggestion.dreamId}>Dream {suggestion.dreamId}</span>
            {suggestion.operation === 'update' && suggestion.targetArtifactId && (
              <>
                <span aria-hidden>·</span>
                <span title={suggestion.targetArtifactId}>
                  target {suggestion.targetArtifactId} rev {suggestion.targetRevision}
                </span>
              </>
            )}
            <span aria-hidden>·</span>
            <span title={suggestion.sessionIds.join(', ')}>
              {suggestion.sessionIds.length} source session{suggestion.sessionIds.length === 1 ? '' : 's'}:{' '}
              {suggestion.sessionIds.join(', ')}
            </span>
            {suggestion.reviewedAt && (
              <>
                <span aria-hidden>·</span>
                <span>reviewed {when(suggestion.reviewedAt)}</span>
              </>
            )}
          </div>
        </div>
        {suggestion.state === 'pending' && (
          <div className="flex flex-none items-center gap-2">
            <Button variant="secondary" size="xs" disabled={!!busy} onClick={() => void review('reject')}>
              <Icon name="x" size={13} />
              {busy === 'reject' ? 'Rejecting…' : 'Reject'}
            </Button>
            <Button
              variant="primary"
              size="xs"
              disabled={!!busy || !suggestion.contentAvailable || !content}
              onClick={() => void review('accept')}
            >
              <Icon name="check" size={13} />
              {busy === 'accept' ? 'Accepting…' : 'Accept'}
            </Button>
          </div>
        )}
      </header>
      <div className="px-4 py-4">
        {suggestion.state !== 'pending' ? (
          <div className="font-sans text-[12px] text-(--text-tertiary)">
            {suggestion.state === 'accepted'
              ? `Accepted as revision ${suggestion.acceptedArtifactRevision ?? '—'}.`
              : `Rejected${suggestion.reviewReason ? `: ${suggestion.reviewReason}` : '.'}`}
            {' The retained suggestion metadata remains available; its daemon-local review body is no longer served.'}
          </div>
        ) : !suggestion.contentAvailable ? (
          <div className="flex items-center gap-2 rounded-md bg-(--status-paused-soft) px-3 py-3 font-sans text-[12px] text-(--text-secondary)">
            <Icon name="server-off" size={15} />
            The staged body is unavailable because its source daemon is offline, upgrading, or no longer owns the source
            agent. It can be inspected when that source is ready again.
          </div>
        ) : !inspect ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-3">
            <p className="font-sans text-[12px] text-(--text-secondary)">
              The staged body is fetched from its source daemon only when you inspect it. Acceptance stays disabled
              until the complete body renders.
            </p>
            <Button variant="secondary" size="xs" onClick={() => setInspect(true)}>
              <Icon name="eye" size={13} />
              Inspect staged content
            </Button>
          </div>
        ) : contentError ? (
          <div className="font-sans text-[12px] text-(--status-error)">
            {contentError instanceof Error ? contentError.message : 'Could not load this suggestion.'}
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

function KnowledgeEditor({
  record,
  onClose,
  onSaved
}: {
  record: OrganizationKnowledgeDto | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
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
            {record ? `Publish revision ${record.currentRevision + 1}` : 'Publish organization knowledge'}
          </span>
          <button className="iconbtn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-3">
          <label className="fld">
            <span className="fldlbl">Title</span>
            <input className="inp" value={title} maxLength={128} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="fld">
            <span className="fldlbl">Summary</span>
            <input
              className="inp"
              value={summary}
              maxLength={1024}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label className="fld">
            <span className="fldlbl">Tags</span>
            <input
              className="inp mn"
              placeholder="architecture, runbook, deployment"
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label className="fld">
            <span className="fldlbl">Markdown</span>
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
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || !title.trim() || !content.trim()} onClick={() => void save()}>
            {busy ? 'Publishing…' : record ? 'Publish revision' : 'Publish'}
          </Button>
        </div>
      </div>
    </div>
  )
}

export default function KnowledgeView() {
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
  const skillsKey = activeOrg ? ['managed-skills', activeOrg.id, includeArchived] : null
  const suggestionsKey = activeOrg && canManage ? ['organization-suggestions', activeOrg.id, suggestionState] : null
  const knowledge = useSWR(knowledgeKey, () => listOrganizationKnowledge(includeArchived))
  const managedSkills = useSWR(skillsKey, () => listManagedSkills(includeArchived))
  const suggestions = useSWR(suggestionsKey, () => listOrganizationSuggestions({ state: suggestionState }))

  const refreshOrganization = async () => {
    await Promise.all([knowledge.mutate(), managedSkills.mutate()])
  }
  const reviewed = async () => {
    await Promise.all([suggestions.mutate(), knowledge.mutate(), managedSkills.mutate()])
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
  const archiveSkill = async (skill: ManagedSkillDto) => {
    setActionError(null)
    try {
      await setManagedSkillArchived(skill.id, !skill.archivedAt)
      await managedSkills.mutate()
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
        <p className="psub mt-0 min-w-[240px] flex-1">
          Owner-approved, revisioned knowledge shared across your organization and discovered by agents on demand.
        </p>
        {tab === 'organization' && canManage && (
          <Button variant="primary" size="sm" onClick={() => setEditor(null)}>
            <Icon name="plus" size={14} />
            Publish knowledge
          </Button>
        )}
      </div>

      <div className="mb-4 flex items-center justify-between border-b border-(--border-subtle)">
        <div className="tabs border-b-0">
          <button className={tab === 'organization' ? 'tab on' : 'tab'} onClick={() => changeTab('organization')}>
            Organization
          </button>
          <button className={tab === 'suggestions' ? 'tab on' : 'tab'} onClick={() => changeTab('suggestions')}>
            Suggestions
          </button>
        </div>
        {tab === 'organization' && (
          <label className="flex items-center gap-2 pb-2 font-sans text-[11.5px] text-(--text-tertiary)">
            Include archived
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
        <div className="flex flex-col gap-4">
          <section className="card overflow-hidden">
            <div className="cardhead justify-between">
              <span className="cardtitle">Knowledge library</span>
              <span className="mono text-[11px] text-(--text-tertiary)">{knowledge.data?.length ?? 0} entries</span>
            </div>
            {knowledge.isLoading ? (
              <LoadingState size={22} padding={24} />
            ) : knowledge.error ? (
              <Empty icon="triangle-alert">{knowledge.error.message}</Empty>
            ) : !knowledge.data?.length ? (
              <Empty icon="book-open">No organization knowledge has been published yet.</Empty>
            ) : (
              <div className="divide-y divide-(--border-subtle)">
                {knowledge.data.map((record) => (
                  <details key={record.id} className={`group ${record.archivedAt ? 'opacity-60' : ''}`}>
                    <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 marker:hidden">
                      <Icon name="chevron-right" size={15} className="mt-[2px] flex-none group-open:rotate-90" />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-sans text-[13px] font-semibold text-(--text-primary)">
                            {record.title}
                          </span>
                          <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-tertiary)">
                            rev {record.currentRevision}
                          </span>
                          {record.archivedAt && (
                            <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-disabled)">
                              archived
                            </span>
                          )}
                        </div>
                        {record.summary && (
                          <p className="mt-1 font-sans text-[12px] leading-[1.45] text-(--text-secondary)">
                            {record.summary}
                          </p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <Tags values={record.tags} />
                          <span className="font-sans text-[10.5px] text-(--text-disabled)">
                            updated {when(record.updatedAt)} · {record.source === 'dream' ? 'Dream proposal' : 'manual'}
                            {record.reviewedByUserId
                              ? ` · reviewed by ${record.reviewedByUserId}`
                              : record.createdByUserId
                                ? ` · published by ${record.createdByUserId}`
                                : ''}
                          </span>
                        </div>
                      </div>
                      {canManage && (
                        <div className="flex flex-none items-center gap-1" onClick={(event) => event.preventDefault()}>
                          {!record.archivedAt && (
                            <button
                              className="iconbtn"
                              title="Publish a new revision"
                              onClick={() => setEditor(record)}
                            >
                              <Icon name="pencil" size={13} />
                            </button>
                          )}
                          <button
                            className="iconbtn"
                            title={record.archivedAt ? 'Restore' : 'Archive'}
                            onClick={() => void archiveKnowledge(record)}
                          >
                            <Icon name={record.archivedAt ? 'archive-restore' : 'archive'} size={13} />
                          </button>
                        </div>
                      )}
                    </summary>
                    <div className="border-t border-(--border-subtle) px-5 py-4">
                      <MarkdownView content={record.content} />
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

          <section className="card overflow-hidden">
            <div className="cardhead justify-between">
              <span>
                <span className="cardtitle">Managed skills</span>
                <span className="mono ml-2 text-[10.5px] text-(--text-tertiary)">approved .skill bundles</span>
              </span>
              <span className="mono text-[11px] text-(--text-tertiary)">{managedSkills.data?.length ?? 0} skills</span>
            </div>
            {managedSkills.isLoading ? (
              <LoadingState size={22} padding={24} />
            ) : managedSkills.error ? (
              <Empty icon="triangle-alert">{managedSkills.error.message}</Empty>
            ) : !managedSkills.data?.length ? (
              <Empty icon="sparkles">Accepted skill suggestions will appear here.</Empty>
            ) : (
              <div className="grid grid-cols-1 divide-y divide-(--border-subtle) desktop:grid-cols-2 desktop:divide-y-0">
                {managedSkills.data.map((skill) => (
                  <details
                    key={skill.id}
                    className={`border-(--border-subtle) desktop:border-b desktop:odd:border-r ${skill.archivedAt ? 'opacity-60' : ''}`}
                  >
                    <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 marker:hidden">
                      <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--brand-soft)">
                        <Icon name="sparkles" size={15} color="var(--brand)" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-[12px] font-semibold text-(--text-primary)">
                            {skill.name}
                          </span>
                          <span className="badge bg-(--surface-sunken) text-[9.5px] text-(--text-tertiary)">
                            rev {skill.currentRevision}
                          </span>
                          {skill.archivedAt && <span className="badge text-[9.5px]">archived</span>}
                        </div>
                        <p className="mt-1 font-sans text-[11.5px] leading-[1.45] text-(--text-secondary)">
                          {skill.description}
                        </p>
                        <div className="mono mt-2 text-[10px] text-(--text-disabled)">
                          {skill.fileCount} files · {bytes(skill.expandedBytes)} expanded ·{' '}
                          {bytes(skill.compressedBytes)} archive
                        </div>
                      </div>
                      {canManage && (
                        <button
                          className="iconbtn"
                          title={skill.archivedAt ? 'Restore' : 'Archive'}
                          onClick={(event) => {
                            event.preventDefault()
                            void archiveSkill(skill)
                          }}
                        >
                          <Icon name={skill.archivedAt ? 'archive-restore' : 'archive'} size={13} />
                        </button>
                      )}
                    </summary>
                    <div className="border-t border-(--border-subtle) bg-(--surface-sunken) px-4 py-3">
                      {(skill.manifest.files ?? []).map((file) => (
                        <div
                          key={file.path}
                          className="flex gap-2 py-[3px] font-mono text-[10.5px] text-(--text-tertiary)"
                        >
                          <Icon name="file" size={12} />
                          <span className="min-w-0 flex-1 truncate">{file.path}</span>
                          <span>{bytes(file.bytes)}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>
        </div>
      ) : !canManage ? (
        <section className="card">
          <Empty icon="shield">Only organization owners can review Dream suggestions.</Empty>
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
                {state[0]!.toUpperCase() + state.slice(1)}
              </button>
            ))}
            <span className="ml-auto font-sans text-[11px] text-(--text-tertiary)">
              {suggestionCounts.total} suggestion{suggestionCounts.total === 1 ? '' : 's'}
              {suggestionState === 'pending' ? ` · ${suggestionCounts.available} available now` : ''}
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
                  ? 'Only organization owners can review suggestions.'
                  : suggestions.error.message}
              </Empty>
            </section>
          ) : !suggestions.data?.length ? (
            <section className="card">
              <Empty icon="sparkles">No {suggestionState} suggestions.</Empty>
            </section>
          ) : (
            suggestions.data.map((suggestion) => (
              <SuggestionCard key={suggestion.id} suggestion={suggestion} onReviewed={reviewed} />
            ))
          )}
        </div>
      )}

      {editor !== undefined && (
        <KnowledgeEditor record={editor} onClose={() => setEditor(undefined)} onSaved={refreshOrganization} />
      )}
    </div>
  )
}
