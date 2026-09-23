'use client'

// One routing evaluation's frozen snapshots, constraint, input, model, matched actions and per-target admissions (§9.5).

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { Icon } from '@/components/ui'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, cancelReasonKey, latencyText } from '@/lib/decisions/evaluations'
import { ROUTING_OUTCOME_BADGE, routingOutcomeTone, targetName } from '@/lib/decisions/routing-evaluations'
import { ruleNumbers } from '@/lib/decisions/routing-draft'
import type {
  DecisionAnswer,
  DecisionEvaluationEntry,
  DecisionRoutingEvaluationRecord,
  DecisionRoutingEvaluationRecordDetail
} from '@agentconnect.md/protocol/decision'
import { conditionSummary } from '../DecisionConditionFields'
import { formatEvaluationTime } from '../DecisionEvaluationSheet'

export function RoutingOutcomeBadge({
  record
}: {
  record: Pick<DecisionRoutingEvaluationRecord, 'outcome' | 'reason'>
}) {
  const t = useTranslations('Decisions')
  const reason = cancelReasonKey(record.reason)
  return (
    <span
      className={`badge max-w-full flex-none truncate ${ROUTING_OUTCOME_BADGE[routingOutcomeTone(record.outcome)]}`}
    >
      {t(`routing.evaluations.outcomes.${record.outcome}`)}
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

export function DecisionRoutingEvaluationSheet({
  botId,
  channelId,
  channelName,
  seq,
  summary,
  agentNames,
  onClose
}: {
  botId: string
  channelId: string
  channelName: string
  seq: number
  summary: DecisionRoutingEvaluationRecord | null
  agentNames: ReadonlyMap<string, string>
  onClose: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const tDecisions = useTranslations('Decisions')
  const locale = useLocale()
  const titleId = useId()
  const { api, orgId } = useDecisionsPrototype()
  const closeRef = useRef<HTMLButtonElement>(null)
  const { data, error, isLoading } = useSWR(
    ['decision-routing-evaluation', api.mode, orgId, botId, channelId, seq],
    () => api.getRoutingEvaluation(botId, { channelId, seq })
  )
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

  const words = {
    yes: tDecisions('condition.yes'),
    no: tDecisions('condition.no'),
    none: tDecisions('condition.noAnswer')
  }
  const record: DecisionRoutingEvaluationRecordDetail | DecisionRoutingEvaluationRecord | null = data ?? summary
  const detail = data ?? null
  const expired = record?.detailsExpired === true
  const snapshot = detail?.snapshot ?? null
  const numbers = snapshot ? ruleNumbers(snapshot.question, snapshot.routing.rules) : new Map<string, number>()
  const ruleNumber = (id: string) => numbers.get(id) ?? 0

  const sheet = (
    <div className="scrim" onClick={onClose}>
      <div
        className="modal max-w-[680px]"
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
              <span className="mono text-[11px] text-(--text-tertiary)">
                {channelName} · {formatEvaluationTime(record.at, locale)}
              </span>
            )}
          </span>
          {record && <RoutingOutcomeBadge record={record} />}
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
              {tDecisions('loading')}
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
          {record && (
            <Section title={tDecisions('evaluations.sheet.summary')}>
              <Row
                label={t('evaluations.columns.answer')}
                value={answerText(record.answer, words) ?? (record.evaluated ? '—' : t('evaluations.notEvaluated'))}
              />
              <Row
                label={t('try.matchedRules')}
                value={
                  record.usedOtherwise
                    ? t('evaluations.otherwise')
                    : record.matchedRuleIds.map((id) => ruleNumber(id) || id).join(', ') || '—'
                }
              />
              {record.matchedKeys.length > 0 && (
                <Row label={tDecisions('gateTry.matched')} value={record.matchedKeys.join(', ')} />
              )}
              <Row label={t('evaluations.columns.latency')} value={latencyText(record.latencyMs) ?? '—'} />
              <Row label={tDecisions('evaluations.sheet.requested')} value={record.requestedModel} />
              <Row label={tDecisions('evaluations.sheet.actual')} value={record.actualModel ?? '—'} />
              <Row
                label={t('evaluations.sheet.usage')}
                value={
                  record.usage
                    ? tDecisions('evaluations.sheet.usageValue', {
                        input: record.usage.inputTokens,
                        output: record.usage.outputTokens
                      })
                    : '—'
                }
              />
            </Section>
          )}
          {record && (
            <Section title={t('try.effectiveTargets')}>
              {record.targets.length === 0 ? (
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">—</span>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-[5px] p-0">
                  {record.targets.map((target) => (
                    <li
                      key={target.agentId}
                      className="flex flex-wrap items-center gap-2 font-sans text-[12px] font-normal leading-normal"
                    >
                      <span className="mono text-(--text-primary)">{targetName(target, agentNames)}</span>
                      <span className="text-(--text-tertiary)">{t(`evaluations.effects.${target.effect}`)}</span>
                      <span className="badge bg-(--surface-active) text-(--text-secondary)">
                        {t(`evaluations.dispositions.${target.disposition}`)}
                      </span>
                      {target.reason && (
                        <span className="mono text-[11px] text-(--text-tertiary)">{target.reason}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Section>
          )}
          {detail?.constraint && (
            <Section title={t('evaluations.sheet.constraint')}>
              {detail.constraint.length === 0 ? (
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {t('evaluations.sheet.constraintNone')}
                </span>
              ) : (
                detail.constraint.map((entry) => (
                  <Row
                    key={entry.agentId}
                    label={<span className="mono">{targetName(entry, agentNames)}</span>}
                    value={
                      entry.participant
                        ? t('try.participant')
                        : t(`try.situations.${entry.via === 'mention' ? 'mention' : 'thread'}`)
                    }
                  />
                ))
              )}
            </Section>
          )}
          {snapshot && (
            <Section title={t('evaluations.sheet.snapshot')}>
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
                {snapshot.question.instructions}
              </span>
              <Row
                label={tDecisions('evaluations.sheet.questionType')}
                value={tDecisions(`types.${snapshot.question.type}`)}
              />
              <Row label={t('evaluations.sheet.model')} value={`${snapshot.providerId} / ${snapshot.model}`} />
            </Section>
          )}
          {snapshot && (
            <Section title={t('evaluations.sheet.routing')}>
              {snapshot.routing.rules.map((rule, index) => (
                <Row
                  key={rule.id}
                  label={t('rules.number', { number: index + 1 })}
                  value={`${conditionSummary(snapshot.question, rule.when, words)} → ${
                    rule.action.type === 'agent' ? targetName(rule.action, agentNames) : t('action.skip')
                  }`}
                />
              ))}
              <Row
                label={t('otherwise.label')}
                value={
                  snapshot.routing.otherwise.type === 'default_agent' ? t('otherwise.default') : t('otherwise.skip')
                }
              />
            </Section>
          )}
          {detail?.input && (
            <Section title={t('evaluations.sheet.input')}>
              <Message entry={detail.input.currentMessage} />
              <span className="font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
                {tDecisions('try.history')}
              </span>
              {detail.input.history.length === 0 ? (
                <span className="font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
                  {tDecisions('evaluations.sheet.noHistory')}
                </span>
              ) : (
                detail.input.history.map((entry, index) => <Message key={`${entry.id}-${index}`} entry={entry} />)
              )}
              {detail.input.historyOmitted > 0 && (
                <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                  {tDecisions('evaluations.sheet.historyOmitted', { count: detail.input.historyOmitted })}
                </span>
              )}
            </Section>
          )}
          {detail?.fullAnswer && (
            <Section title={tDecisions('evaluations.sheet.answer')}>
              {probabilities(detail.fullAnswer).map(([label, value]) => (
                <Row key={label} label={<span className="mono">{label}</span>} value={value} />
              ))}
            </Section>
          )}
        </div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? sheet : createPortal(sheet, document.body)
}
