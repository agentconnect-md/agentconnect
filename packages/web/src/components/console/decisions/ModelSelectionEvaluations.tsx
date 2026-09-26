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
import { Icon } from '@/components/ui'
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
                <button
                  type="button"
                  onClick={() => setOpen(item.seq)}
                  className={`flex w-full flex-col gap-1 border-0 bg-transparent ${padX} py-[9px] text-left hover:bg-(--surface-hover)`}
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

/** The agent's recent model selections, listed under the sample in the By decision editor. */
export function ModelSelectionEvaluations({
  agentId,
  orgId,
  live
}: {
  agentId: string
  orgId?: string
  live: boolean
}) {
  const t = useTranslations('Agents.dialog.modelSelection.evaluations')
  const state = useModelEvaluations(agentId, orgId, live)
  return (
    <details className="group rounded-md border border-(--border-subtle)" data-testid="model-selection-evaluations">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-[10px] px-4 py-[9px] [&::-webkit-details-marker]:hidden">
        <span className="flex items-center gap-2 font-sans text-[13px] font-semibold leading-normal">
          <Icon
            name="chevron-down"
            size={13}
            className="flex-none -rotate-90 text-(--text-tertiary) transition-transform group-open:rotate-0"
          />
          {t('title')}
          {state.empty && <span className="mono text-[11.5px] font-normal text-(--text-tertiary)">{t('noneYet')}</span>}
        </span>
        <Icon name="history" size={14} className="flex-none text-(--text-tertiary)" />
      </summary>
      <div className="border-t border-(--border-subtle)">
        <ModelEvaluationsBody state={state} padX="px-4" />
      </div>
    </details>
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
