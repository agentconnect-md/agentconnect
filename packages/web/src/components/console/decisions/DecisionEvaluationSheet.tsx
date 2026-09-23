'use client'

// One evaluation's frozen snapshot, input, model and evidence, or Details expired once retention stripped it (§9.4, §9.5).

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Icon } from '@/components/ui'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, cancelReasonKey, latencyText, OUTCOME_BADGE, outcomeTone } from '@/lib/decisions/evaluations'
import type {
  DecisionAnswer,
  DecisionEvaluationEntry,
  DecisionEvaluationRecord,
  DecisionEvaluationRecordDetail
} from '@agentconnect.md/protocol/decision'
import type { DecisionConversationRef } from '@agentconnect.md/protocol/decision-api'
import { conditionSummary } from './DecisionConditionFields'

export function formatEvaluationTime(at: string, locale: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

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

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[7px]">
      <h3 className="m-0 font-sans text-[11px] font-semibold uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)">
        {title}
      </h3>
      {children}
    </section>
  )
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
      <span className="flex-none">{label}</span>
      <b className="mono min-w-0 break-words text-right font-medium text-(--text-secondary)">{value}</b>
    </div>
  )
}

function Message({ entry }: { entry: DecisionEvaluationEntry }) {
  return (
    <div className="flex flex-col gap-[3px] rounded-md bg-(--surface-app) px-[10px] py-[8px]">
      <span className="mono text-[11px] text-(--text-tertiary)">{entry.sender.id}</span>
      {entry.quote && (
        <span className="border-l-2 border-(--border-default) pl-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {entry.quote.text}
        </span>
      )}
      <span className="whitespace-pre-wrap break-words font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
        {entry.text}
      </span>
    </div>
  )
}

function probabilities(answer: DecisionAnswer): Array<[string, string]> {
  const pct = (value: number) => `${Math.round(value * 100)}%`
  if (answer.type === 'boolean') return [['p(yes)', pct(answer.probability)]]
  if (answer.type === 'choice') return Object.entries(answer.probabilities).map(([key, value]) => [key, pct(value)])
  return answer.probabilities.map((value, level) => [String(level), pct(value)])
}

export function DecisionEvaluationSheet({
  conversation,
  seq,
  summary,
  onClose
}: {
  conversation: DecisionConversationRef
  seq: number
  /** The list row, shown while the detail loads and kept when it fails. */
  summary: DecisionEvaluationRecord | null
  onClose: () => void
}) {
  const t = useTranslations('Decisions')
  const locale = useLocale()
  const titleId = useId()
  const { api, orgId } = useDecisionsPrototype()
  const closeRef = useRef<HTMLButtonElement>(null)
  const { data, error, isLoading } = useSWR(
    ['decision-evaluation', api.mode, orgId, conversation.integrationId, conversation.channelId, seq],
    () => api.getEvaluation(conversation, seq)
  )
  // Focus lands on Close once per opening; Escape reads the latest onClose so a parent render never refocuses.
  const onCloseRef = useRef(onClose)
  useEffect(() => {
    onCloseRef.current = onClose
  }, [onClose])
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }
  const record: DecisionEvaluationRecordDetail | DecisionEvaluationRecord | null = data ?? summary
  const detail = data ?? null
  const expired = record?.detailsExpired === true

  const summaryRows = record && (
    <>
      <Row label={t('evaluations.columns.answer')} value={answerText(record.answer, words) ?? '—'} />
      <Row
        label={t('evaluations.columns.matched')}
        value={record.matchedKeys.length ? record.matchedKeys.join(', ') : '—'}
      />
      <Row label={t('evaluations.columns.latency')} value={latencyText(record.latencyMs) ?? '—'} />
      <Row label={t('evaluations.sheet.requested')} value={record.requestedModel} />
      <Row label={t('evaluations.sheet.actual')} value={record.actualModel ?? '—'} />
      <Row
        label={t('evaluations.sheet.usage')}
        value={
          record.usage
            ? t('evaluations.sheet.usageValue', { input: record.usage.inputTokens, output: record.usage.outputTokens })
            : '—'
        }
      />
    </>
  )

  const sheet = (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal max-w-[640px]"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="modalhead">
          <span className="flex min-w-0 flex-1 flex-col gap-[2px]">
            <span id={titleId} className="font-sans text-[15px] font-semibold leading-normal">
              {t('evaluations.sheet.title')}
            </span>
            {record && (
              <span className="mono text-[11px] text-(--text-tertiary)">{formatEvaluationTime(record.at, locale)}</span>
            )}
          </span>
          {record && <OutcomeBadge record={record} />}
          <button
            ref={closeRef}
            type="button"
            className="iconbtn"
            onClick={onClose}
            aria-label={t('evaluations.sheet.close')}
          >
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="modalbody flex flex-col gap-4">
          {isLoading && !data && (
            <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
              {t('loading')}
            </span>
          )}
          {error && !data && (
            <div role="alert" className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--status-error)">
              {errorParts(error)?.status === 404
                ? t('evaluations.sheet.notFound')
                : t('evaluations.sheet.error', { message: errorParts(error)?.message ?? String(error) })}
            </div>
          )}
          {expired && (
            <div
              role="status"
              className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
            >
              <Icon name="clock" size={14} className="mt-[2px] flex-none" />
              <span className="flex flex-col gap-[2px]">
                <b className="font-semibold">{t('evaluations.sheet.detailsExpired')}</b>
                <span className="text-(--text-secondary)">{t('evaluations.sheet.detailsExpiredBody')}</span>
              </span>
            </div>
          )}
          {record && <Section title={t('evaluations.sheet.summary')}>{summaryRows}</Section>}
          {detail?.snapshot && (
            <Section title={t('evaluations.sheet.decision')}>
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
                {detail.snapshot.question.instructions}
              </span>
              <Row label={t('evaluations.sheet.questionType')} value={t(`types.${detail.snapshot.question.type}`)} />
              <Row
                label={t('binding.triggerCondition')}
                value={conditionSummary(detail.snapshot.question, detail.snapshot.condition, words)}
              />
              <Row label={t('model')} value={`${detail.snapshot.providerId} / ${detail.snapshot.model}`} />
            </Section>
          )}
          {detail?.input && (
            <Section title={t('evaluations.sheet.input')}>
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
          {detail?.fullAnswer && (
            <Section title={t('evaluations.sheet.answer')}>
              {probabilities(detail.fullAnswer).map(([label, value]) => (
                <Row key={label} label={<span className="mono">{label}</span>} value={value} />
              ))}
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
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body)
}
