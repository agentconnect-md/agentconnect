'use client'

// Shared Knowledge pieces: the publish editor, tag chips, and the one-line provenance (organization-knowledge.md §2).

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  createOrganizationKnowledge,
  creatorLabel,
  updateOrganizationKnowledge,
  type KnowledgeSource,
  type KnowledgeWriterKind,
  type OrganizationKnowledgeDto
} from '@/lib/api'
import { AgentVisibilityField, type AgentVisibilityValue } from '@/components/console/VisibilityField'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useOrgs } from '@/lib/org-context'
import { useProfile } from '@/lib/profile'
import { Button, Icon } from '@/components/ui'
import { Scrim } from '@/components/console/Scrim'

export function TagChips({ values, max }: { values: string[]; max?: number }) {
  if (!values.length) return null
  const shown = max ? values.slice(0, max) : values
  const rest = values.length - shown.length
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((tag) => (
        <span key={tag} className="badge bg-(--surface-sunken) text-[10px] text-(--text-tertiary)">
          {tag}
        </span>
      ))}
      {rest > 0 && (
        <span className="font-sans text-[10.5px] font-normal leading-normal text-(--text-disabled)">+{rest}</span>
      )}
    </span>
  )
}

const WRITER_KEYS = {
  research: 'research',
  'first-look': 'firstLook',
  conversation: 'conversation',
  person: 'person'
} as const

export interface KnowledgeProvenance {
  source: KnowledgeSource
  writerKind?: KnowledgeWriterKind | null
  sourceAgentId: string | null
  createdByUserId: string | null
  reviewedByUserId: string | null
}

/** "Published by Ada" for a manual revision, "Proposed by dreamer · reviewed by Ada" for a Dream one, "Written by Atlas" for the record. */
export function useProvenanceLabel(): (value: KnowledgeProvenance) => string {
  const t = useTranslations('Knowledge')
  const { agents } = useConsoleData()
  const { me } = useProfile()
  return (value) => {
    if (value.source === 'migration') return t('movedFromMemory')
    if (value.source === 'agent') {
      const writer = agents.find((candidate) => candidate.id === value.sourceAgentId)
      const name = writer ? agentLabel(writer) : t('removedAgent')
      return value.writerKind
        ? t('writtenByKind', { name, kind: t(`writers.${WRITER_KEYS[value.writerKind]}`) })
        : t('writtenBy', { name })
    }
    if (value.source !== 'dream') return t('publishedBy', { name: creatorLabel(value.createdByUserId, me) })
    const agent = agents.find((candidate) => candidate.id === value.sourceAgentId)
    const proposed = t('proposedBy', { name: agent ? agentLabel(agent) : t('removedAgent') })
    if (!value.reviewedByUserId) return proposed
    return `${proposed} · ${t('reviewedBy', { name: creatorLabel(value.reviewedByUserId, me) })}`
  }
}

interface KnowledgeDraft {
  revision: number | null
  title: string
  summary: string
  tags: string
  content: string
  /** A new entry's audience, kept so a restored draft does not widen it. */
  audience?: AgentVisibilityValue
}

const draftKey = (orgId: string, recordId: string | null) => `ac.knowledge-draft:${orgId}:${recordId ?? 'new'}`

// Storage can throw (privacy mode, quota); a lost draft then degrades to the old behavior.
function readDraft(key: string, revision: number | null): KnowledgeDraft | null {
  try {
    const raw = sessionStorage.getItem(key)
    const draft = raw ? (JSON.parse(raw) as KnowledgeDraft) : null
    return draft?.revision === revision ? draft : null
  } catch {
    return null
  }
}

function writeDraft(key: string, draft: KnowledgeDraft | null) {
  try {
    if (draft) sessionStorage.setItem(key, JSON.stringify(draft))
    else sessionStorage.removeItem(key)
  } catch {
    // Best effort only.
  }
}

export function KnowledgeEditor({
  record,
  onClose,
  onSaved
}: {
  /** The entry a new revision is published for; null publishes a new entry. */
  record: OrganizationKnowledgeDto | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const t = useTranslations('Knowledge.editor')
  const titleId = useId()
  const { activeOrg } = useOrgs()
  const key = draftKey(activeOrg?.id ?? '', record?.id ?? null)
  const revision = record?.currentRevision ?? null
  const initial: KnowledgeDraft = {
    revision,
    title: record?.title ?? '',
    summary: record?.summary ?? '',
    tags: record?.tags.join(', ') ?? '',
    content: record?.content ?? ''
  }
  const [restored] = useState(() => readDraft(key, revision))
  const [title, setTitle] = useState(restored?.title ?? initial.title)
  const [summary, setSummary] = useState(restored?.summary ?? initial.summary)
  const [tags, setTags] = useState(restored?.tags ?? initial.tags)
  const [content, setContent] = useState(restored?.content ?? initial.content)
  // Which agents read a new entry; an existing entry's readers change on its page.
  const [readers, setReaders] = useState<AgentVisibilityValue>(restored?.audience ?? { visibility: 'all', readers: [] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = !!title.trim() && !!content.trim()

  // Closing without publishing keeps the edits for the next open in this tab.
  const dismiss = () => {
    const audienceChanged = !record && (readers.visibility !== 'all' || readers.readers.length > 0)
    const draft = { revision, title, summary, tags, content, ...(record ? {} : { audience: readers }) }
    const edited =
      audienceChanged ||
      (['title', 'summary', 'tags', 'content'] as const).some((field) => draft[field] !== initial[field])
    writeDraft(key, edited ? draft : null)
    onClose()
  }

  const save = async () => {
    if (busy || !ready) return
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
      else
        await createOrganizationKnowledge({
          ...input,
          visibility: readers.visibility,
          ...(readers.visibility === 'selected' ? { readers: readers.readers } : {})
        })
      writeDraft(key, null)
      await onSaved()
      onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <Scrim onEscape={busy ? undefined : dismiss} onClick={dismiss}>
      <div
        className="modal max-w-[780px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalhead">
          <span className="flex h-[30px] w-[30px] flex-none items-center justify-center rounded-[7px] bg-(--brand-soft)">
            <Icon name="book-open" size={16} color="var(--brand)" />
          </span>
          <span id={titleId} className="flex-1 font-sans text-[16px] font-semibold leading-normal">
            {record ? t('revisionTitle', { value: record.currentRevision + 1 }) : t('createTitle')}
          </span>
          <button type="button" className="iconbtn" onClick={dismiss} aria-label={t('close')}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody grid grid-cols-1 gap-3 desktop:grid-cols-2">
          <label className="fld">
            <span className="fldlbl">{t('title')}</span>
            <input className="inp" value={title} maxLength={128} onChange={(event) => setTitle(event.target.value)} />
          </label>
          <label className="fld">
            <span className="fldlbl">{t('tags')}</span>
            <input
              className="inp mn"
              placeholder={t('tagsPlaceholder')}
              value={tags}
              onChange={(event) => setTags(event.target.value)}
            />
          </label>
          <label className="fld desktop:col-span-2">
            <span className="fldlbl">{t('summary')}</span>
            <input
              className="inp"
              value={summary}
              maxLength={1024}
              onChange={(event) => setSummary(event.target.value)}
            />
          </label>
          <label className="fld desktop:col-span-2">
            <span className="fldlbl">{t('content')}</span>
            <textarea
              className="inp mn min-h-[300px] resize-y py-3"
              value={content}
              onChange={(event) => setContent(event.target.value)}
            />
          </label>
          {!record && (
            <div className="desktop:col-span-2">
              <AgentVisibilityField value={readers} onChange={setReaders} disabled={busy} />
            </div>
          )}
          {error && <div className="font-sans text-[12px] text-(--status-error) desktop:col-span-2">{error}</div>}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" onClick={dismiss}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? t('publishing') : t('publish')}
          </Button>
        </div>
      </div>
    </Scrim>
  )
}
