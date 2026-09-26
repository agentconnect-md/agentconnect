'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import type { DecisionModelEvaluationRecord } from '@agentconnect.md/protocol/decision'
import { fetchAgentModelEvaluation, fetchAgentModelEvaluations } from '@/lib/api'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, cancelReasonKey } from '@/lib/decisions/evaluations'
import { DecisionChainResults } from './DecisionChainResults'
import { DecisionModelResult } from './DecisionModelResult'
import {
  BackLink,
  EvaluationsDrawer,
  ExpiredBanner,
  Facts,
  formatEvaluationTime,
  Row,
  Section
} from './EvaluationParts'

const PAGE = 20

export function ModelSelectionEvaluationsDrawer({
  agentId,
  agentName,
  orgId,
  onClose
}: {
  agentId: string
  agentName: string
  orgId?: string
  onClose: () => void
}) {
  const t = useTranslations('Agents.detail.modelEvaluations')
  const decisions = useTranslations('Decisions')
  const locale = useLocale()
  const { data, error, isLoading, mutate } = useSWR(['agent-model-evaluations', orgId, agentId], () =>
    fetchAgentModelEvaluations(agentId, { limit: PAGE }, orgId)
  )
  const [older, setOlder] = useState<{
    base: unknown
    items: DecisionModelEvaluationRecord[]
    cursor: number | null
  } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [open, setOpen] = useState<number | null>(null)
  const extra = older?.base === data ? older : null
  const items = [...(data?.items ?? []), ...(extra?.items ?? [])]
  const cursor = extra ? extra.cursor : (data?.nextCursor ?? null)
  const detail = useSWR(open === null ? null : ['agent-model-evaluation', orgId, agentId, open], () =>
    fetchAgentModelEvaluation(agentId, open!, orgId)
  )
  const record = items.find((item) => item.seq === open) ?? null
  const shown = detail.data ?? record
  const errorKind = errorParts(error)
  const reason = shown?.reason
  const reasonLabel =
    reason === 'no_target'
      ? t('noTarget')
      : reason === 'unavailable'
        ? t('unavailable')
        : reason
          ? decisions(`evaluations.reasons.${cancelReasonKey(reason) ?? 'other'}`)
          : null
  const loadMore = async () => {
    if (cursor === null || loadingMore) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const page = await fetchAgentModelEvaluations(agentId, { cursor, limit: PAGE }, orgId)
      setOlder((current) => ({
        base: data,
        items: [...(current && current.base === data ? current.items : []), ...page.items],
        cursor: page.nextCursor
      }))
    } catch {
      setMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }

  return (
    <EvaluationsDrawer
      title={t('title')}
      subtitle={agentName}
      closeLabel={t('close')}
      onClose={onClose}
      onBack={open === null ? null : () => setOpen(null)}
      testId="model-selection-evaluations"
    >
      {open === null ? (
        <>
          {isLoading && !data && (
            <p className="px-[18px] py-4 text-[12px] text-(--text-tertiary)">{decisions('loading')}</p>
          )}
          {error && !data && (
            <div role="alert" className="px-[18px] py-4 text-[12px] text-(--status-error)">
              {errorKind?.status === 503
                ? t(errorKind.code === 'DAEMON_UPGRADE_REQUIRED' ? 'unsupported' : 'offline')
                : t('error')}{' '}
              <button type="button" className="lnk" onClick={() => void mutate()}>
                {t('retry')}
              </button>
            </div>
          )}
          {data && items.length === 0 && cursor === null && (
            <p className="px-[18px] py-4 text-[12px] text-(--text-tertiary)">{t('empty')}</p>
          )}
          <ul className="m-0 list-none p-0">
            {items.map((item) => (
              <li key={item.seq} className="border-b border-(--border-subtle)">
                <button
                  type="button"
                  onClick={() => setOpen(item.seq)}
                  className="flex w-full flex-col gap-1 border-0 bg-transparent px-[18px] py-3 text-left hover:bg-(--surface-hover)"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="mono text-[11px] text-(--text-tertiary)">
                      {formatEvaluationTime(item.at, locale)}
                    </span>
                    <span
                      className={`badge ${item.outcome === 'selected' ? 'bg-(--status-online-soft) text-(--status-online)' : 'bg-(--surface-active) text-(--text-secondary)'}`}
                    >
                      {t(`outcome.${item.outcome}`)}
                    </span>
                  </span>
                  <span className="font-sans text-[12.5px] text-(--text-primary)">
                    {item.target.runtime} · {item.target.model}
                  </span>
                  <span className="mono text-[11px] text-(--text-tertiary)">
                    {answerText(item.answer, { yes: decisions('condition.yes'), no: decisions('condition.no') }) ??
                      t('noAnswer')}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {moreError && (
            <p role="alert" className="px-[18px] text-[12px] text-(--status-error)">
              {t('error')}
            </p>
          )}
          {cursor !== null && (
            <button type="button" className="lnk mx-[18px] my-3" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? decisions('loading') : t('loadMore')}
            </button>
          )}
          <p className="px-[18px] py-3 text-[11px] text-(--text-tertiary)">{t('retention')}</p>
        </>
      ) : (
        <div className="flex flex-col gap-4 px-[18px] py-4">
          <BackLink onClick={() => setOpen(null)} />
          {detail.error && (
            <p role="alert" className="text-[12px] text-(--status-error)">
              {t('error')}
            </p>
          )}
          {!shown && !detail.error && <p className="text-[12px] text-(--text-tertiary)">{decisions('loading')}</p>}
          {shown && (
            <>
              <Facts>
                <Row label={t('time')} value={formatEvaluationTime(shown.at, locale)} />
                <Row label={t('outcomeLabel')} value={t(`outcome.${shown.outcome}`)} />
                <Row label={t('target')} value={`${shown.target.runtime} · ${shown.target.model}`} />
                {reasonLabel && <Row label={t('reason')} value={reasonLabel} />}
              </Facts>
              {shown.detailsExpired && <ExpiredBanner title={t('expired')} body={t('expiredBody')} />}
              {detail.data && (
                <>
                  <DecisionModelResult
                    question={detail.data.question}
                    answer={detail.data.fullAnswer}
                    summary={detail.data.answer}
                    matchedKeys={[]}
                    matched={false}
                    requestedModel={detail.data.requestedModel ?? '—'}
                    actualModel={detail.data.actualModel}
                    latencyMs={detail.data.latencyMs}
                    usage={detail.data.usage}
                    status={detail.data.fullAnswer ? 'answered' : detail.data.reason ? 'unavailable' : 'not_evaluated'}
                    expired={detail.data.detailsExpired}
                    rawRequest={detail.data.rawRequest}
                    rawResponse={detail.data.rawResponse}
                  />
                  <DecisionChainResults chain={detail.data.chain} />
                  {detail.data.selection && (
                    <Section title={t('rules')}>
                      <pre className="overflow-auto rounded-md border border-(--border-subtle) p-3 text-[11px]">
                        {JSON.stringify(detail.data.selection, null, 2)}
                      </pre>
                    </Section>
                  )}
                  {detail.data.input && (
                    <Section title={t('input')}>
                      <pre className="overflow-auto rounded-md border border-(--border-subtle) p-3 text-[11px]">
                        {JSON.stringify(detail.data.input, null, 2)}
                      </pre>
                    </Section>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </EvaluationsDrawer>
  )
}
