'use client'

// Recent evaluations for one gated conversation or code-host routing (decisions.md §9.5): a bounded daemon read, never stored by the CP.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Button, Icon } from '@/components/ui'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText } from '@/lib/decisions/evaluations'
import { conversationEvaluations, type DecisionEvaluationSource } from '@/lib/decisions/evaluation-source'
import type { DecisionEvaluationRecord } from '@agentconnect.md/protocol/decision'
import type { DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import { DecisionEvaluationDetail, OutcomeBadge } from './DecisionEvaluationDetail'
import { EvaluationRow, EvaluationsDrawer } from './EvaluationParts'

const PAGE = 20

/** 503 splits into an outage and an upgrade prompt by the machine code. */
function unavailableKind(cause: unknown): 'offline' | 'unsupported' | null {
  const parts = errorParts(cause)
  if (parts?.status !== 503) return null
  return parts.code === 'DAEMON_UPGRADE_REQUIRED' ? 'unsupported' : 'offline'
}

export function DecisionEvaluationsDrawer({
  conversation,
  source: givenSource,
  channelName,
  agentName,
  initialSeq,
  decisionId,
  onClose
}: (
  | { conversation: DecisionConversationRef; source?: undefined }
  | { conversation?: undefined; source: DecisionEvaluationSource }
) & {
  /** The conversation or routed repository as its row reads, for the drawer's subtitle. */
  channelName?: string
  agentName?: string
  /** Opens straight on this evaluation's detail; Back still lands on the list. */
  initialSeq?: number
  decisionId?: string
  onClose: () => void
}) {
  const t = useTranslations('Decisions')
  const locale = useLocale()
  const { api, orgId, decisions } = useDecisionsPrototype()
  const integrationId = conversation?.integrationId
  const channelId = conversation?.channelId
  const source = useMemo(
    () => givenSource ?? conversationEvaluations(api, orgId, { integrationId: integrationId!, channelId: channelId! }),
    [givenSource, api, orgId, integrationId, channelId]
  )
  const copy =
    source.lane === 'code_host' ? 'evaluations.codeHost' : source.lane === 'api' ? 'evaluations.api' : 'evaluations'
  const words = { yes: t('condition.yes'), no: t('condition.no') }
  const decisionName = useCallback(
    (id: string) => decisions.find((entry) => entry.id === id)?.name ?? t('binding.hiddenDecision'),
    [decisions, t]
  )
  const { data, error, isLoading, mutate } = useSWR(['decision-evaluations', ...source.key, decisionId], () =>
    source.list({ limit: PAGE, ...(decisionId ? { decisionId } : {}) })
  )
  // Later pages are appended locally; a fresh first page (revalidation or a new key) drops them.
  const [appended, setAppended] = useState<{
    base: unknown
    items: DecisionEvaluationRecord[]
    nextCursor: number | null
  } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState<string | null>(null)
  const [open, setOpen] = useState<number | null>(initialSeq ?? null)
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
      const page = await source.list({ cursor: nextCursor, limit: PAGE, ...(decisionId ? { decisionId } : {}) })
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
        ? note('wifi-off', t(`${copy}.offline`), { label: t('binding.retry'), run: () => void mutate() })
        : kind === 'unsupported'
          ? note('circle-arrow-up', t(`${copy}.unsupported`))
          : note('triangle-alert', t('evaluations.error', { message: errorParts(error)?.message ?? String(error) }), {
              label: t('binding.retry'),
              run: () => void mutate()
            })
  } else if (items.length === 0 && nextCursor === null) body = note('info', t(`${copy}.empty`))
  else
    body = (
      <>
        <ul ref={listRef} className="m-0 list-none p-0">
          {items.map((record) => {
            const answer = answerText(record.answer, words)
            return (
              <li key={record.seq} className="border-b border-(--border-subtle)">
                <EvaluationRow
                  data-seq={record.seq}
                  padX="px-[18px]"
                  title={record.title}
                  expired={record.detailsExpired}
                  answer={answer && record.matchedKeys.length ? `${answer} → ${record.matchedKeys.join(', ')}` : answer}
                  outcome={t(`evaluations.outcomes.${record.outcome}`)}
                  badge={<OutcomeBadge record={record} />}
                  meta={
                    <span className="truncate">
                      {decisionName(record.decisionId)} · {record.actualModel ?? record.requestedModel}
                    </span>
                  }
                  at={record.at}
                  latencyMs={record.latencyMs}
                  onClick={() => {
                    opener.current = record.seq
                    setOpen(record.seq)
                  }}
                />
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
            {t(source.lane === 'api' ? 'evaluations.api.retention' : 'evaluations.retention')}
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
          source={source}
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
