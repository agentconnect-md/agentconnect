'use client'

// One Dream proposal in Knowledge → Suggestions; Accept binds to the body Inspect fetched (organization-knowledge.md §2, §7.3).

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

const NOTE = 'border-t border-(--border-subtle) px-4 py-[10px] font-sans text-[12px] font-normal leading-normal'

export function SuggestionCard({
  suggestion,
  onReviewed
}: {
  suggestion: OrganizationSuggestionDto
  onReviewed: () => Promise<void>
}) {
  const t = useTranslations('Knowledge')
  const { orgPath } = useOrgs()
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [inspect, setInspect] = useState(false)
  const pending = suggestion.state === 'pending'
  const contentKey =
    inspect && pending && suggestion.contentAvailable ? ['organization-suggestion-content', suggestion.id] : null
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

  const meta = [
    t('proposedBy', { name: suggestion.sourceAgentName ?? t('removedAgent') }),
    t('sessions', { count: suggestion.sessionIds.length }),
    fmtDate(suggestion.createdAt)
  ].join(' · ')
  const acceptedHref =
    suggestion.state === 'accepted' && suggestion.kind === 'knowledge' && suggestion.acceptedArtifactId
      ? orgPath(`/knowledge/${suggestion.acceptedArtifactId}`)
      : null

  return (
    <article className="card overflow-hidden">
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <span className="flex h-8 w-8 flex-none items-center justify-center rounded-md bg-(--brand-soft)">
          <Icon name={suggestion.kind === 'knowledge' ? 'book-open' : 'sparkles'} size={16} color="var(--brand)" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-sans text-[14px] font-semibold leading-normal text-(--text-primary)">
              {suggestion.title}
            </h3>
            {suggestion.operation === 'update' && (
              <span
                className="badge bg-(--status-info-soft) text-[9.5px] text-(--status-info)"
                title={
                  suggestion.targetRevision === null
                    ? undefined
                    : t('replacesRevision', { revision: suggestion.targetRevision })
                }
              >
                {t('update')}
              </span>
            )}
            {pending && !suggestion.contentAvailable && (
              <span className="badge bg-(--status-paused-soft) text-[9.5px] text-(--status-paused)">
                {t('unavailable')}
              </span>
            )}
          </div>
          <div className="mt-[3px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {meta}
          </div>
          {suggestion.summary && (
            <p className="mt-2 font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              {suggestion.summary}
            </p>
          )}
          {suggestion.tags.length > 0 && (
            <div className="mt-2">
              <TagChips values={suggestion.tags} />
            </div>
          )}
        </div>
        {pending && (
          <div className="flex flex-none items-center gap-2">
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
      </div>
      {!pending ? (
        <div className={`${NOTE} flex flex-wrap items-center gap-x-2 gap-y-1 text-(--text-secondary)`}>
          {suggestion.state === 'accepted' ? (
            <>
              <Icon name="check" size={14} color="var(--status-online)" />
              <span>{t('acceptedAs', { revision: suggestion.acceptedArtifactRevision ?? '—' })}</span>
              {suggestion.reviewedAt && (
                <span className="text-(--text-tertiary)">{fmtDate(suggestion.reviewedAt)}</span>
              )}
              {acceptedHref && (
                <Link className="lnk text-[12px]" href={acceptedHref}>
                  {t('open')}
                </Link>
              )}
            </>
          ) : (
            <>
              <Icon name="x" size={14} color="var(--text-tertiary)" />
              <span>{t('rejectedLabel')}</span>
              {suggestion.reviewedAt && (
                <span className="text-(--text-tertiary)">{fmtDate(suggestion.reviewedAt)}</span>
              )}
              {suggestion.reviewReason && <span className="text-(--text-tertiary)">{suggestion.reviewReason}</span>}
            </>
          )}
        </div>
      ) : !suggestion.contentAvailable ? (
        <div className={`${NOTE} text-(--text-tertiary)`}>{t('unavailableHint')}</div>
      ) : !inspect ? (
        <div className={`${NOTE} text-(--text-tertiary)`}>{t('inspectHint')}</div>
      ) : contentError ? (
        <div className={`${NOTE} text-(--status-error)`}>
          {contentError instanceof Error ? contentError.message : t('loadSuggestionError')}
        </div>
      ) : !content ? (
        <div className="border-t border-(--border-subtle)">
          <LoadingState size={20} padding={16} />
        </div>
      ) : (
        <div className="border-t border-(--border-subtle) px-4 py-4">
          {content.kind === 'knowledge' ? <MarkdownView content={content.content} /> : <SkillTree files={content} />}
        </div>
      )}
      {error && <div className={`${NOTE} text-(--status-error)`}>{error}</div>}
    </article>
  )
}
