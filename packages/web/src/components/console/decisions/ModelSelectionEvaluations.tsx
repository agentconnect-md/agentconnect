'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import type { DecisionModelEvaluationRecord } from '@agentconnect.md/protocol/decision'
import { fetchAgentModelEvaluation, fetchAgentModelEvaluations } from '@/lib/api'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, cancelReasonKey } from '@/lib/decisions/evaluations'
import { useOrgs } from '@/lib/org-context'
import { MOCK_MODE, MOCK_PREFIX } from '@/lib/data'
import { chainStepResult, useChainStep } from '@/lib/decisions/chain-step'
import { DecisionChainResults } from './DecisionChainResults'
import { DecisionModelResult } from './DecisionModelResult'
import {
  BackLink,
  DetailTitle,
  EvaluationRow,
  EvaluationsDrawer,
  ExpiredBanner,
  Facts,
  formatEvaluationTime,
  Row,
  Section
} from './EvaluationParts'

const PAGE = 20

/** The Agent whose model selections a Recent evaluations view reads; `live` false shows the empty state without a request. */
export interface ModelEvaluationsTarget {
  agentId: string
  agentName: string
  live: boolean
}

/** A demo agent has no daemon to read from, so its target shows the empty state. */
export function modelEvaluationsTarget(agent: { id: string; name: string; displayName?: string | null }) {
  return {
    agentId: agent.id,
    agentName: agent.displayName || agent.name,
    live: !MOCK_MODE && !agent.name.startsWith(MOCK_PREFIX)
  }
}

function useModelEvaluations(
  agentId: string,
  orgId: string | undefined,
  live: boolean,
  { decisionId, initialSeq }: { decisionId?: string; initialSeq?: number } = {}
) {
  const filter = decisionId ? { decisionId } : {}
  const { data, error, isLoading, mutate } = useSWR(
    live ? ['agent-model-evaluations', orgId, agentId, decisionId] : null,
    () => fetchAgentModelEvaluations(agentId, { limit: PAGE, ...filter }, orgId)
  )
  const page = live ? data : { items: [], nextCursor: null }
  const [older, setOlder] = useState<{
    base: unknown
    items: DecisionModelEvaluationRecord[]
    cursor: number | null
  } | null>(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState(false)
  const [open, setOpen] = useState<number | null>(initialSeq ?? null)
  const extra = older?.base === data ? older : null
  const items = [...(page?.items ?? []), ...(extra?.items ?? [])]
  const cursor = extra ? extra.cursor : (page?.nextCursor ?? null)
  const detail = useSWR(open === null ? null : ['agent-model-evaluation', orgId, agentId, open], () =>
    fetchAgentModelEvaluation(agentId, open!, orgId)
  )
  const loadMore = async () => {
    if (cursor === null || loadingMore) return
    setLoadingMore(true)
    setMoreError(false)
    try {
      const next = await fetchAgentModelEvaluations(agentId, { cursor, limit: PAGE, ...filter }, orgId)
      setOlder((current) => ({
        base: data,
        items: [...(current && current.base === data ? current.items : []), ...next.items],
        cursor: next.nextCursor
      }))
    } catch {
      setMoreError(true)
    } finally {
      setLoadingMore(false)
    }
  }
  return {
    loaded: !!page,
    loading: isLoading && !data,
    error: data ? undefined : error,
    retry: () => void mutate(),
    items,
    cursor,
    empty: !!page && items.length === 0 && cursor === null,
    loadMore,
    loadingMore,
    moreError,
    open,
    setOpen,
    detail
  }
}

type ModelEvaluations = ReturnType<typeof useModelEvaluations>

function ModelEvaluationsBody({ state, padX }: { state: ModelEvaluations; padX: string }) {
  const t = useTranslations('Agents.dialog.modelSelection.evaluations')
  const decisions = useTranslations('Decisions')
  const locale = useLocale()
  const { items, cursor, open, setOpen, detail } = state
  const record = items.find((item) => item.seq === open) ?? null
  const shown = detail.data ?? record
  const chainStep = useChainStep(open, detail.data?.chain, detail.data?.steps)
  // The frozen question the shown step answered; the root keeps only its requested model, not its provider.
  const instructions = chainStep.step
    ? { question: chainStep.step.question, model: `${chainStep.step.providerId} / ${chainStep.step.model}` }
    : detail.data?.question
      ? { question: detail.data.question, model: detail.data.requestedModel }
      : null
  const errorKind = errorParts(state.error)
  const reason = shown?.reason
  const reasonLabel =
    reason === 'no_target'
      ? t('noTarget')
      : reason === 'unavailable'
        ? t('unavailable')
        : reason
          ? decisions(`evaluations.reasons.${cancelReasonKey(reason) ?? 'other'}`)
          : null

  if (open === null)
    return (
      <>
        {state.loading && (
          <p className={`m-0 ${padX} py-3 text-[12px] text-(--text-tertiary)`}>{decisions('loading')}</p>
        )}
        {state.error && (
          <div role="alert" className={`${padX} py-3 text-[12px] text-(--status-error)`}>
            {errorKind?.status === 503
              ? t(errorKind.code === 'DAEMON_UPGRADE_REQUIRED' ? 'unsupported' : 'offline')
              : t('error')}{' '}
            <button type="button" className="lnk" onClick={state.retry}>
              {t('retry')}
            </button>
          </div>
        )}
        {state.empty && <p className={`m-0 ${padX} py-3 text-[12px] text-(--text-tertiary)`}>{t('empty')}</p>}
        {items.length > 0 && (
          <ul className="m-0 list-none p-0">
            {items.map((item) => (
              <li key={item.seq} className="border-b border-(--border-subtle)">
                <EvaluationRow
                  padX={padX}
                  title={item.title}
                  expired={item.detailsExpired}
                  answer={answerText(item.answer, { yes: decisions('condition.yes'), no: decisions('condition.no') })}
                  outcome={t(`outcome.${item.outcome}`)}
                  badge={
                    <span
                      className={`badge flex-none ${item.outcome === 'selected' ? 'bg-(--status-online-soft) text-(--status-online)' : 'bg-(--surface-active) text-(--text-secondary)'}`}
                    >
                      {t(`outcome.${item.outcome}`)}
                    </span>
                  }
                  meta={
                    <span className="truncate">
                      {item.target.runtime} · {item.target.model}
                    </span>
                  }
                  at={item.at}
                  latencyMs={item.latencyMs}
                  onClick={() => setOpen(item.seq)}
                />
              </li>
            ))}
          </ul>
        )}
        {state.moreError && (
          <p role="alert" className={`m-0 ${padX} pt-3 text-[12px] text-(--status-error)`}>
            {t('error')}
          </p>
        )}
        {cursor !== null && (
          <div className={`${padX} pt-3`}>
            <button type="button" className="lnk" disabled={state.loadingMore} onClick={() => void state.loadMore()}>
              {state.loadingMore ? decisions('loading') : t('loadMore')}
            </button>
          </div>
        )}
        {items.length > 0 && <p className={`m-0 ${padX} py-3 text-[11px] text-(--text-tertiary)`}>{t('retention')}</p>}
      </>
    )

  return (
    <div className={`flex flex-col gap-4 ${padX} py-[14px]`}>
      <BackLink onClick={() => setOpen(null)} />
      <DetailTitle title={shown?.title} />
      {detail.error && (
        <p role="alert" className="m-0 text-[12px] text-(--status-error)">
          {t('error')}
        </p>
      )}
      {!shown && !detail.error && <p className="m-0 text-[12px] text-(--text-tertiary)">{decisions('loading')}</p>}
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
              <DecisionChainResults chain={detail.data.chain} {...chainStep.selector} />
              {chainStep.step && (
                <DecisionModelResult
                  {...chainStepResult(chainStep.step, detail.data.chain![chainStep.index]!)}
                  expired={detail.data.detailsExpired}
                />
              )}
              {!chainStep.step && (
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
              )}
              {instructions && (
                <Section title={decisions('evaluations.detail.instructions')}>
                  <span className="font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-primary)">
                    {instructions.question.instructions}
                  </span>
                  <Row
                    label={decisions('evaluations.sheet.questionType')}
                    value={decisions(`types.${instructions.question.type}`)}
                  />
                  {instructions.model && <Row label={decisions('model')} value={instructions.model} />}
                </Section>
              )}
              {detail.data.selection && (
                <Section title={t('rules')}>
                  <pre className="m-0 overflow-auto rounded-md border border-(--border-subtle) p-3 text-[11px]">
                    {JSON.stringify(detail.data.selection, null, 2)}
                  </pre>
                </Section>
              )}
              {detail.data.input && (
                <Section title={t('input')}>
                  <pre className="m-0 overflow-auto rounded-md border border-(--border-subtle) p-3 text-[11px]">
                    {JSON.stringify(detail.data.input, null, 2)}
                  </pre>
                </Section>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** The same list in a side drawer, opened from a By decision hover card. */
export function ModelSelectionEvaluationsDrawer({
  target,
  decisionId,
  initialSeq,
  onClose
}: {
  target: ModelEvaluationsTarget
  /** Only selections rooted at this Decision, as the Decision page lists them. */
  decisionId?: string
  initialSeq?: number
  onClose: () => void
}) {
  const t = useTranslations('Agents.dialog.modelSelection.evaluations')
  const { activeOrg } = useOrgs()
  const state = useModelEvaluations(target.agentId, activeOrg?.id, target.live, { decisionId, initialSeq })
  return (
    <EvaluationsDrawer
      title={t('title')}
      subtitle={target.agentName}
      closeLabel={t('close')}
      onClose={onClose}
      onBack={state.open === null ? null : () => state.setOpen(null)}
      testId="model-selection-evaluations-drawer"
    >
      <ModelEvaluationsBody state={state} padX="px-[18px]" />
    </EvaluationsDrawer>
  )
}
