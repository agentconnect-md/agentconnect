'use client'

// One gate evaluation inside the Recent evaluations drawer: frozen snapshot, model result, raw JSON and context (§9.4, §9.5).

import { DecisionChainResults } from './DecisionChainResults'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, cancelReasonKey, latencyText, OUTCOME_BADGE, outcomeTone } from '@/lib/decisions/evaluations'
import { modelLine } from '@/lib/decisions/model-result'
import { matchDecisionCondition } from '@agentconnect.md/protocol/decision'
import type {
  DecisionEvaluationOutcome,
  DecisionEvaluationRecord,
  DecisionEvaluationRecordDetail
} from '@agentconnect.md/protocol/decision'
import type { DecisionEvaluationSource } from '@/lib/decisions/evaluation-source'
import { conditionSummary } from './DecisionConditionFields'
import { DecisionModelResult } from './DecisionModelResult'
import { BackLink, ExpiredBanner, Facts, formatEvaluationTime, Message, Note, Row, Section } from './EvaluationParts'

export function OutcomeBadge({ record }: { record: Pick<DecisionEvaluationRecord, 'outcome' | 'reason'> }) {
  const t = useTranslations('Decisions')
  const reason = cancelReasonKey(record.reason)
  return (
    <span className={`badge max-w-full flex-none truncate ${OUTCOME_BADGE[outcomeTone(record.outcome)]}`}>
      {t(`evaluations.outcomes.${record.outcome}`)}
      {reason && ` · ${t(`evaluations.reasons.${reason}`)}`}
    </span>
  )
}

const MODEL_STATUS: Record<DecisionEvaluationOutcome, 'answered' | 'unavailable' | 'canceled' | 'pending'> = {
  triggered: 'answered',
  skipped: 'answered',
  unavailable: 'unavailable',
  canceled: 'canceled',
  pending: 'pending'
}

export function DecisionEvaluationDetail({
  source,
  seq,
  summary,
  decisionName,
  onBack
}: {
  source: DecisionEvaluationSource
  seq: number
  /** The list row, shown while the detail loads and kept when it fails. */
  summary: DecisionEvaluationRecord | null
  decisionName: (decisionId: string) => string
  onBack: () => void
}) {
  const t = useTranslations('Decisions')
  const locale = useLocale()
  const { data, error, isLoading } = useSWR(['decision-evaluation', ...source.key, seq], () => source.get(seq))
  const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }
  const record: DecisionEvaluationRecordDetail | DecisionEvaluationRecord | null = data ?? summary
  const detail = data ?? null
  const expired = record?.detailsExpired === true
  const snapshot = detail?.snapshot ?? null
  const rootMatch =
    snapshot && detail?.fullAnswer
      ? matchDecisionCondition(snapshot.question, snapshot.condition, detail.fullAnswer)
      : null

  return (
    <div className="flex flex-col gap-[14px] px-[18px] py-4" data-testid="evaluation-detail">
      <BackLink onClick={onBack} />
      {record && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-[11.5px] text-(--text-tertiary)">{formatEvaluationTime(record.at, locale)}</span>
          <OutcomeBadge record={record} />
        </div>
      )}
      {isLoading && !data && (
        <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">{t('loading')}</span>
      )}
      {error && !data && (
        <div role="alert" className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
          {errorParts(error)?.status === 404
            ? t('evaluations.sheet.notFound')
            : t('evaluations.sheet.error', { message: errorParts(error)?.message ?? String(error) })}
        </div>
      )}
      {expired && (
        <ExpiredBanner title={t('evaluations.sheet.detailsExpired')} body={t('evaluations.sheet.detailsExpiredBody')} />
      )}
      {record && (
        <Facts>
          <Row label={t('evaluations.detail.decision')} value={decisionName(record.decisionId)} />
          <Row label={t('evaluations.detail.result')} value={answerText(record.answer, words) ?? '—'} />
          <Row
            label={t('evaluations.columns.matched')}
            value={record.matchedKeys.length ? record.matchedKeys.join(', ') : '—'}
          />
          <Row label={t('evaluations.detail.outcome')} value={<OutcomeBadge record={record} />} />
          <Row
            label={t('evaluations.detail.triggerWhen')}
            value={snapshot ? conditionSummary(snapshot.question, snapshot.condition, words) : '—'}
          />
          <Row label={t('evaluations.detail.model')} value={modelLine(record.requestedModel, record.actualModel)} />
          <Row label={t('evaluations.columns.latency')} value={latencyText(record.latencyMs) ?? '—'} />
        </Facts>
      )}
      <DecisionChainResults
        chain={detail?.chain}
        names={detail?.chain?.map((step) => ({ id: step.decisionId, name: decisionName(step.decisionId) }))}
      />
      {record && (
        <DecisionModelResult
          question={snapshot?.question ?? null}
          answer={detail?.fullAnswer ?? null}
          summary={record.answer}
          condition={snapshot?.condition ?? null}
          matchedKeys={rootMatch?.matchedKeys ?? record.matchedKeys}
          matched={rootMatch?.matched ?? record.outcome === 'triggered'}
          requestedModel={record.requestedModel}
          actualModel={record.actualModel}
          latencyMs={record.latencyMs}
          usage={record.usage}
          status={MODEL_STATUS[record.outcome]}
          expired={expired}
          {...(detail && detail.rawRequest !== undefined ? { rawRequest: detail.rawRequest } : {})}
          {...(detail && detail.rawResponse !== undefined ? { rawResponse: detail.rawResponse } : {})}
        />
      )}
      {snapshot && (
        <Section title={t('evaluations.detail.instructions')}>
          <span className="font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-primary)">
            {snapshot.question.instructions}
          </span>
          <Row label={t('evaluations.sheet.questionType')} value={t(`types.${snapshot.question.type}`)} />
          <Row label={t('model')} value={`${snapshot.providerId} / ${snapshot.model}`} />
        </Section>
      )}
      {detail?.input && (
        <Section title={t('evaluations.detail.context')}>
          <span className="font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
            {t('evaluations.sheet.input')}
          </span>
          <Message entry={detail.input.currentMessage} />
          <span className="font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
            {t('try.history')}
          </span>
          {detail.input.history.length === 0 ? (
            <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {t('evaluations.sheet.noHistory')}
            </span>
          ) : (
            detail.input.history.map((entry, index) => <Message key={`${entry.id}-${index}`} entry={entry} />)
          )}
          {detail.input.historyOmitted > 0 && (
            <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
              {t('evaluations.sheet.historyOmitted', { count: detail.input.historyOmitted })}
            </span>
          )}
          <Row
            label={t('try.context')}
            value={
              detail.input.context.partial
                ? t('evaluations.sheet.partial', {
                    reasons: detail.input.context.reasons.join(', ') || '—',
                    count: detail.input.context.omittedMessages
                  })
                : t('evaluations.sheet.complete')
            }
          />
        </Section>
      )}
      {detail?.evidence && (
        <Section title={t('evaluations.sheet.evidence')}>
          <Row label={t('evaluations.sheet.snapshotRow')} value={String(detail.evidence.snapshotSeq)} />
          <Row
            label={t('evaluations.sheet.background')}
            value={detail.evidence.suppliedBackground === null ? '—' : String(detail.evidence.suppliedBackground)}
          />
        </Section>
      )}
      {snapshot && <Note icon="clock">{t('evaluations.detail.asConfigured')}</Note>}
    </div>
  )
}
