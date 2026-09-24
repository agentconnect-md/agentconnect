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
import { DecisionEvaluationDetail, OutcomeBadge } from './DecisionEvaluationDetail'
import { EvaluationsDrawer, formatEvaluationTime } from './EvaluationParts'

const PAGE = 20
const COLUMNS = 'desktop:grid desktop:grid-cols-[96px_minmax(0,1fr)_auto_60px] desktop:items-center desktop:gap-3'

/** 503 splits into an outage and an upgrade prompt by the machine code. */
function unavailableKind(cause: unknown): 'offline' | 'unsupported' | null {
  const parts = errorParts(cause)
  if (parts?.status !== 503) return null
  return parts.code === 'DAEMON_UPGRADE_REQUIRED' ? 'unsupported' : 'offline'
}

export function DecisionEvaluationsDrawer({
  conversation,
  channelName,
  agentName,
  onClose
}: {
  conversation: DecisionConversationRef
  /** The conversation as its row reads, for the drawer's subtitle. */
  channelName?: string
  agentName?: string
  onClose: () => void
}) {
  const t = useTranslations('Decisions')
  const locale = useLocale()
  const { api, orgId, decisions } = useDecisionsPrototype()
  const words = { yes: t('condition.yes'), no: t('condition.no') }
  const decisionName = useCallback(
    (id: string) => decisions.find((entry) => entry.id === id)?.name ?? t('binding.hiddenDecision'),
    [decisions, t]
  )
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
  // The row that opened a detail gets keyboard focus back on the way back to the list.
  const opener = useRef<number | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  useEffect(() => {
    if (open !== null || opener.current === null) return
    listRef.current?.querySelector<HTMLElement>(`[data-seq="${opener.current}"]`)?.focus()
    opener.current = null
  }, [open])
  const back = useCallback(() => setOpen(null), [])
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
      className="flex flex-wrap items-start gap-2 px-[18px] py-4 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)"
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
      <>
        <div
          className={`hidden border-b border-(--border-subtle) bg-(--surface-sunken) px-[18px] py-[7px] font-sans text-[11px] font-medium leading-normal text-(--text-tertiary) ${COLUMNS}`}
        >
          <span>{t('evaluations.columns.time')}</span>
          <span>{t('evaluations.columns.result')}</span>
          <span>{t('evaluations.columns.outcome')}</span>
          <span className="text-right">{t('evaluations.columns.latency')}</span>
        </div>
        <ul ref={listRef} className="m-0 list-none p-0">
          {items.map((record) => {
            const answer = answerText(record.answer, words) ?? (record.detailsExpired ? t('evaluations.expired') : '—')
            return (
              <li key={record.seq} className="border-b border-(--border-subtle)">
                <button
                  type="button"
                  data-seq={record.seq}
                  onClick={() => {
                    opener.current = record.seq
                    setOpen(record.seq)
                  }}
                  className={`flex w-full cursor-pointer flex-col gap-[5px] border-0 bg-transparent px-[18px] py-[10px] text-left hover:bg-(--surface-hover) ${COLUMNS}`}
                >
                  <span className="flex items-center justify-between gap-2 desktop:contents">
                    <span className="mono text-[11px] text-(--text-tertiary)">
                      {formatEvaluationTime(record.at, locale)}
                    </span>
                    <span className="desktop:hidden">
                      <OutcomeBadge record={record} />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-col gap-[3px]">
                    <span className="truncate font-sans text-[12.5px] font-normal leading-[1.4] text-(--text-primary)">
                      {answer}
                      {record.matchedKeys.length > 0 && (
                        <span className="text-(--text-tertiary)"> → {record.matchedKeys.join(', ')}</span>
                      )}
                    </span>
                    <span className="mono truncate text-[11px] text-(--text-tertiary)">
                      {decisionName(record.decisionId)} · {record.actualModel ?? record.requestedModel}
                    </span>
                  </span>
                  <span className="hidden min-w-0 desktop:flex">
                    <OutcomeBadge record={record} />
                  </span>
                  <span className="mono text-[11px] text-(--text-tertiary) desktop:text-right">
                    <span className="font-sans desktop:hidden">{t('evaluations.columns.latency')}: </span>
                    {latencyText(record.latencyMs) ?? '—'}
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
        {nextCursor !== null && (
          <div className="flex flex-wrap items-center gap-[9px] px-[18px] py-3">
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
        <div className="px-[18px] py-3">
          <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
            {t('evaluations.retention')}
          </span>
        </div>
      </>
    )

  const subtitle = [channelName, agentName].filter(Boolean).join(' · ')
  return (
    <EvaluationsDrawer
      title={t('evaluations.toggle')}
      subtitle={subtitle || undefined}
      closeLabel={t('evaluations.drawer.close')}
      onClose={onClose}
      onBack={open !== null ? back : null}
      testId="decision-evaluations"
    >
      {open !== null ? (
        <DecisionEvaluationDetail
          conversation={conversation}
          seq={open}
          summary={items.find((record) => record.seq === open) ?? null}
          decisionName={decisionName}
          onBack={back}
        />
      ) : (
        body
      )}
    </EvaluationsDrawer>
  )
}
