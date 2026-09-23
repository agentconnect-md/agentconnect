'use client'

// Recent evaluations for one gated conversation (decisions.md §9.5): a bounded daemon read, never stored by the CP.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, latencyText } from '@/lib/decisions/evaluations'
import type { DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import type { DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import { DecisionEvaluationSheet, formatEvaluationTime, OutcomeBadge } from './DecisionEvaluationSheet'

const PAGE = 20
const COLUMNS =
  'desktop:grid desktop:grid-cols-[132px_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1.1fr)_72px] desktop:items-center desktop:gap-3'

/** 503 splits into an outage and an upgrade prompt by the machine code. */
function unavailableKind(cause: unknown): 'offline' | 'unsupported' | null {
  const parts = errorParts(cause)
  if (parts?.status !== 503) return null
  return parts.code === 'DAEMON_UPGRADE_REQUIRED' ? 'unsupported' : 'offline'
}

export function DecisionEvaluationsPanel({ conversation }: { conversation: DecisionConversationRef }) {
  const t = useTranslations('Decisions')
  const locale = useLocale()
  const { api, orgId } = useDecisionsPrototype()
  const words = { yes: t('condition.yes'), no: t('condition.no') }
  const { data, error, isLoading, mutate } = useSWR(
    ['decision-evaluations', api.mode, orgId, conversation.integrationId, conversation.channelId],
    () => api.listEvaluations(conversation, { limit: PAGE })
  )
  // Later pages are appended locally; a fresh first page (revalidation or a new key) drops them.
  const [appended, setAppended] = useState<{
    base: unknown
    items: DecisionEvaluationRecord[]
    nextCursor: number | null
  } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(null)
  // The row that opened the sheet gets keyboard focus back once it closes.
  const opener = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (open !== null || !opener.current) return
    opener.current.focus()
    opener.current = null
  }, [open])
  const closeSheet = useCallback(() => setOpen(null), [])
  const more = appended && appended.base === data ? appended : null

  const items = [...(data?.items ?? []), ...(more?.items ?? [])]
  const nextCursor = more ? more.nextCursor : (data?.nextCursor ?? null)
  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return
    setLoadingMore(true)
    setMoreError(null)
    try {
      const page = await api.listEvaluations(conversation, { cursor: nextCursor, limit: PAGE })
      setAppended((current) => ({
        base: data,
        items: [...(current && current.base === data ? current.items : []), ...page.items],
        nextCursor: page.nextCursor
      }))
    } catch (cause) {
      setMoreError(errorParts(cause)?.message ?? (cause instanceof Error ? cause.message : String(cause)))
    } finally {
      setLoadingMore(false)
    }
  }

  const note = (icon: string, text: string, action?: { label: string; run: () => void }) => (
    <div
      role="status"
      className="flex flex-wrap items-start gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)"
    >
      <Icon name={icon} size={13} className="mt-[2px] flex-none" />
      <span className="min-w-0 flex-1">{text}</span>
      {action && (
        <button type="button" className="lnk text-[11.5px] font-medium" onClick={action.run}>
          {action.label}
        </button>
      )}
    </div>
  )

  let body
  if (isLoading && !data) body = note('loader', t('loading'))
  else if (error && !data) {
    const kind = unavailableKind(error)
    body =
      kind === 'offline'
        ? note('wifi-off', t('evaluations.offline'), { label: t('binding.retry'), run: () => void mutate() })
        : kind === 'unsupported'
          ? note('circle-arrow-up', t('evaluations.unsupported'))
          : note('triangle-alert', t('evaluations.error', { message: errorParts(error)?.message ?? String(error) }), {
              label: t('binding.retry'),
              run: () => void mutate()
            })
  } else if (items.length === 0) body = note('info', t('evaluations.empty'))
  else
    body = (
      <div className="overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card)">
        <div
          className={`hidden border-b border-(--border-subtle) px-[12px] py-[7px] font-sans text-[11px] font-medium leading-normal text-(--text-tertiary) ${COLUMNS}`}
        >
          <span>{t('evaluations.columns.time')}</span>
          <span>{t('evaluations.columns.answer')}</span>
          <span>{t('evaluations.columns.matched')}</span>
          <span>{t('evaluations.columns.outcome')}</span>
          <span className="text-right">{t('evaluations.columns.latency')}</span>
        </div>
        <ul className="m-0 list-none p-0">
          {items.map((record) => {
            const answer = answerText(record.answer, words) ?? (record.detailsExpired ? t('evaluations.expired') : '—')
            return (
              <li key={record.seq} className="border-b border-(--border-subtle) last:border-b-0">
                <button
                  type="button"
                  onClick={(event) => {
                    opener.current = event.currentTarget
                    setOpen(record.seq)
                  }}
                  className={`flex w-full cursor-pointer flex-col gap-[5px] border-0 bg-transparent px-[12px] py-[9px] text-left hover:bg-(--surface-hover) ${COLUMNS}`}
                >
                  <span className="flex items-center justify-between gap-2 desktop:contents">
                    <span className="mono text-[11.5px] text-(--text-secondary)">
                      {formatEvaluationTime(record.at, locale)}
                    </span>
                    <span className="desktop:hidden">
                      <OutcomeBadge record={record} />
                    </span>
                  </span>
                  <span className="min-w-0 truncate font-sans text-[12px] font-normal leading-normal text-(--text-primary)">
                    <span className="text-(--text-tertiary) desktop:hidden">{t('evaluations.columns.answer')}: </span>
                    {answer}
                  </span>
                  <span className="mono min-w-0 truncate text-[11.5px] text-(--text-secondary)">
                    <span className="font-sans text-(--text-tertiary) desktop:hidden">
                      {t('evaluations.columns.matched')}:{' '}
                    </span>
                    {record.matchedKeys.length ? record.matchedKeys.join(', ') : '—'}
                  </span>
                  <span className="hidden min-w-0 desktop:flex">
                    <OutcomeBadge record={record} />
                  </span>
                  <span className="mono text-[11.5px] text-(--text-tertiary) desktop:text-right">
                    <span className="font-sans desktop:hidden">{t('evaluations.columns.latency')}: </span>
                    {latencyText(record.latencyMs) ?? '—'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </div>
    )

  return (
    <div className="flex flex-col gap-2">
      {body}
      {items.length > 0 && nextCursor !== null && (
        <div className="flex flex-wrap items-center gap-[9px]">
          <Button variant="secondary" size="sm" disabled={loadingMore} onClick={() => void loadMore()}>
            {loadingMore ? t('loading') : t('evaluations.loadMore')}
          </Button>
          {moreError && (
            <span className="font-sans text-[12px] font-normal leading-normal text-(--status-error)">
              {t('evaluations.error', { message: moreError })}
            </span>
          )}
        </div>
      )}
      {open !== null && (
        <DecisionEvaluationSheet
          conversation={conversation}
          seq={open}
          summary={items.find((record) => record.seq === open) ?? null}
          onClose={closeSheet}
        />
      )}
    </div>
  )
}
