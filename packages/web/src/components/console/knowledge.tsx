'use client'

// Shared Knowledge pieces: the publish editor, tag chips, and the one-line provenance (organization-knowledge.md §2).

import { useEffect, useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  createOrganizationKnowledge,
  creatorLabel,
  updateOrganizationKnowledge,
  type OrganizationKnowledgeDto
} from '@/lib/api'
import { agentLabel } from '@/lib/data'
import { useConsoleData } from '@/lib/data-context'
import { useProfile } from '@/lib/profile'
import { Button, Icon } from '@/components/ui'

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

export interface KnowledgeProvenance {
  source: 'manual' | 'dream'
  sourceAgentId: string | null
  createdByUserId: string | null
  reviewedByUserId: string | null
}

/** "Published by Ada" for a manual revision, "Proposed by dreamer · reviewed by Ada" for a Dream one. */
export function useProvenanceLabel(): (value: KnowledgeProvenance) => string {
  const t = useTranslations('Knowledge')
  const { agents } = useConsoleData()
  const { me } = useProfile()
  return (value) => {
    if (value.source !== 'dream') return t('publishedBy', { name: creatorLabel(value.createdByUserId, me) })
    const agent = agents.find((candidate) => candidate.id === value.sourceAgentId)
    const proposed = t('proposedBy', { name: agent ? agentLabel(agent) : t('removedAgent') })
    if (!value.reviewedByUserId) return proposed
    return `${proposed} · ${t('reviewedBy', { name: creatorLabel(value.reviewedByUserId, me) })}`
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
  const [title, setTitle] = useState(record?.title ?? '')
  const [summary, setSummary] = useState(record?.summary ?? '')
  const [tags, setTags] = useState(record?.tags.join(', ') ?? '')
  const [content, setContent] = useState(record?.content ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ready = !!title.trim() && !!content.trim()

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onClose])

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
          <button type="button" className="iconbtn" onClick={onClose} aria-label={t('close')}>
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
          {error && <div className="font-sans text-[12px] text-(--status-error) desktop:col-span-2">{error}</div>}
        </div>
        <div className="modalfoot">
          <div className="flex-1" />
          <Button variant="ghost" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={busy || !ready} onClick={() => void save()}>
            {busy ? t('publishing') : t('publish')}
          </Button>
        </div>
      </div>
    </div>
  )
}
