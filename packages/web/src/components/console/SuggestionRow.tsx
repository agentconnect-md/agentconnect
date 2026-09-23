'use client'

// One Dream proposal in Knowledge → Suggestions: opening a pending row fetches the body Accept binds to (organization-knowledge.md §2, §7.3).

import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useState } from 'react'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import {
  fetchOrganizationSuggestionContent,
  fmtDate,
  reviewOrganizationSuggestion,
  type OrganizationSuggestionContentDto,
  type OrganizationSuggestionDto
} from '@/lib/api'
import { consoleKeys } from '@/lib/swr-keys'
import { useOrgs } from '@/lib/org-context'
import { TagChips } from '@/components/console/knowledge'
import { LoadingState } from '@/components/marks'
import { Button, Icon } from '@/components/ui'

const MarkdownView = dynamic(() => import('@/components/console/MarkdownView'), { ssr: false })

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

const FILE_HEAD =
  'border-b border-(--border-subtle) bg-(--surface-sunken) px-3 py-2 font-mono text-[11px] text-(--text-tertiary)'

function SkillTree({ files }: { files: OrganizationSuggestionContentDto & { kind: 'skill' } }) {
  const t = useTranslations('Knowledge')
  // The manifest leads; everything else follows in path order.
  const ordered = [...files.files].sort(
    (a, b) => Number(b.path === 'SKILL.md') - Number(a.path === 'SKILL.md') || a.path.localeCompare(b.path)
  )
  return (
    <div className="flex flex-col gap-3 px-4 py-3">
      <div className="rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-3 py-2">
        <div className="pb-1 font-sans text-[11px] font-medium leading-normal text-(--text-tertiary)">
          {t('filesCount', { count: ordered.length })}
        </div>
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
          <div className={FILE_HEAD}>{file.path}</div>
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

const HEADER = 'row grid-cols-[auto_minmax(0,1fr)_auto] gap-3 border-b-0'
const META = 'mt-[3px] truncate font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)'
const NOTE = 'px-4 py-4 font-sans text-[12px] font-normal leading-normal'

function KindMark({ kind }: { kind: OrganizationSuggestionDto['kind'] }) {
  return (
    <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--brand-soft)">
      <Icon name={kind === 'knowledge' ? 'book-open' : 'sparkles'} size={15} color="var(--brand)" />
    </span>
  )
}

function Title({ suggestion, meta }: { suggestion: OrganizationSuggestionDto; meta: string }) {
  const t = useTranslations('Knowledge')
  return (
    <div className="min-w-0">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="truncate font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
          {suggestion.title}
        </span>
        {suggestion.operation === 'update' && (
          <span
            className="badge flex-none bg-(--status-info-soft) text-[9.5px] text-(--status-info)"
            title={
              suggestion.targetRevision === null
                ? undefined
                : t('replacesRevision', { revision: suggestion.targetRevision })
            }
          >
            {t('update')}
          </span>
        )}
        {suggestion.state === 'pending' && !suggestion.contentAvailable && (
          <span className="badge flex-none bg-(--status-paused-soft) text-[9.5px] text-(--status-paused)">
            {t('unavailable')}
          </span>
        )}
      </div>
      <div className={META}>{meta}</div>
    </div>
  )
}

export function SuggestionRow({
  suggestion,
  open,
  onToggle,
  onReviewed
}: {
  suggestion: OrganizationSuggestionDto
  open: boolean
  onToggle: () => void
  onReviewed: () => Promise<void>
}) {
  const t = useTranslations('Knowledge')
  const { activeOrg, orgPath } = useOrgs()
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = suggestion.state === 'pending'
  const reviewable = pending && suggestion.contentAvailable
  const panelId = `suggestion-${suggestion.id}`
  // The body loads as soon as the row opens: that read is the inspection Accept binds to.
  const {
    data: content,
    error: contentError,
    mutate
  } = useSWR(
    open && reviewable ? consoleKeys.organizationSuggestionContent(activeOrg?.id, suggestion.id) : null,
    ([, , , id]) => fetchOrganizationSuggestionContent(id)
  )

  const review = async (decision: 'accept' | 'reject') => {
    const snapshotToken = content?.snapshotToken
    if (busy || !reviewable || (decision === 'accept' && !snapshotToken)) return
    setBusy(decision)
    setError(null)
    try {
      if (decision === 'accept' && snapshotToken) {
        await reviewOrganizationSuggestion(suggestion.id, 'accept', snapshotToken)
      } else await reviewOrganizationSuggestion(suggestion.id, 'reject')
      await onReviewed()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  const meta = [
    t('proposedBy', { name: suggestion.sourceAgentName ?? t('removedAgent') }),
    t('sessions', { count: suggestion.sessionIds.length }),
    fmtDate(suggestion.createdAt)
  ].join(' · ')

  if (suggestion.state === 'accepted') {
    const outcome = (
      <>
        <KindMark kind={suggestion.kind} />
        <Title suggestion={suggestion} meta={meta} />
        <div className="flex min-w-0 flex-none items-center gap-2 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
          <Icon name="circle-check" size={14} color="var(--status-online)" className="flex-none" />
          <span className="truncate">{t('acceptedAs', { revision: suggestion.acceptedArtifactRevision ?? '—' })}</span>
          <span className="hidden text-(--text-tertiary) desktop:inline">{fmtDate(suggestion.reviewedAt)}</span>
          {suggestion.kind === 'knowledge' && suggestion.acceptedArtifactId && (
            <Icon name="chevron-right" size={14} color="var(--text-tertiary)" className="flex-none" />
          )}
        </div>
      </>
    )
    return suggestion.kind === 'knowledge' && suggestion.acceptedArtifactId ? (
      <Link href={orgPath(`/knowledge/${suggestion.acceptedArtifactId}`)} className={`${HEADER} click`}>
        {outcome}
      </Link>
    ) : (
      <div className={HEADER}>{outcome}</div>
    )
  }

  if (suggestion.state === 'rejected') {
    return (
      <div className={HEADER}>
        <KindMark kind={suggestion.kind} />
        <Title suggestion={suggestion} meta={meta} />
        <div className="min-w-0 max-w-[280px] flex-none text-right font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
          <span className="inline-flex items-center gap-2">
            <Icon name="circle-x" size={14} color="var(--text-tertiary)" className="flex-none" />
            <span>{t('rejectedLabel')}</span>
            <span className="hidden text-(--text-tertiary) desktop:inline">{fmtDate(suggestion.reviewedAt)}</span>
          </span>
          {suggestion.reviewReason && (
            <div className="truncate text-[11.5px] text-(--text-tertiary)" title={suggestion.reviewReason}>
              {suggestion.reviewReason}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div data-suggestion={suggestion.id} className="group border-b border-(--border-subtle) last:border-b-0">
      <button
        type="button"
        className={`${HEADER} click w-full text-left`}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={onToggle}
      >
        <KindMark kind={suggestion.kind} />
        <Title suggestion={suggestion} meta={meta} />
        <span className="flex flex-none items-center gap-3">
          {suggestion.summary && !open && (
            <span className="hidden max-w-[320px] truncate font-sans text-[12px] font-normal leading-normal text-(--text-tertiary) desktop:inline">
              {suggestion.summary}
            </span>
          )}
          <Icon name={open ? 'chevron-down' : 'chevron-right'} size={15} color="var(--text-tertiary)" />
        </span>
      </button>

      {open && (
        <div
          id={panelId}
          className="border-t border-(--border-subtle) bg-(--surface-sunken) px-4 py-3 group-last:rounded-b-[10px]"
        >
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <div className="flex min-w-[200px] flex-1 flex-col gap-2">
              {suggestion.summary && (
                <p className="m-0 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                  {suggestion.summary}
                </p>
              )}
              {(suggestion.tags.length > 0 || suggestion.targetRevision !== null) && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <TagChips values={suggestion.tags} />
                  {suggestion.targetRevision !== null && (
                    <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                      {t('replacesRevision', { revision: suggestion.targetRevision })}
                    </span>
                  )}
                </div>
              )}
            </div>
            <div className="flex flex-none items-center gap-2">
              <Button
                variant="secondary"
                size="xs"
                disabled={!!busy || !reviewable}
                onClick={() => void review('reject')}
              >
                <Icon name="x" size={13} />
                {busy === 'reject' ? t('rejecting') : t('reject')}
              </Button>
              <Button
                variant="primary"
                size="xs"
                disabled={!!busy || !reviewable || !content}
                onClick={() => void review('accept')}
              >
                <Icon name="check" size={13} />
                {busy === 'accept' ? t('accepting') : t('accept')}
              </Button>
            </div>
          </div>

          <div className="mt-3 overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-card)">
            {!reviewable ? (
              <div className={`${NOTE} flex items-center gap-2 text-(--text-tertiary)`}>
                <Icon name="plug-zap" size={14} className="flex-none" />
                {t('unavailableHint')}
              </div>
            ) : contentError ? (
              <div className={`${NOTE} flex flex-wrap items-center gap-2 text-(--status-error)`}>
                <Icon name="triangle-alert" size={14} className="flex-none" />
                <span>{contentError instanceof Error ? contentError.message : t('loadSuggestionError')}</span>
                <button type="button" className="lnk text-[12px]" onClick={() => void mutate()}>
                  {t('retry')}
                </button>
              </div>
            ) : !content ? (
              <LoadingState size={20} padding={20} />
            ) : content.kind === 'knowledge' ? (
              <div className="px-5 py-4">
                <MarkdownView content={content.content} />
              </div>
            ) : (
              <SkillTree files={content} />
            )}
          </div>
          {error && (
            <div className="mt-3 rounded-md bg-(--status-error-soft) px-3 py-2 font-sans text-[12px] font-normal leading-normal text-(--status-error)">
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
