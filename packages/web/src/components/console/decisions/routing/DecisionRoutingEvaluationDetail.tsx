'use client'

// One routing evaluation inside the drawer: frozen snapshots, model result and raw JSON, constraint, targets and input (§9.5).

import { DecisionChainResults } from '../DecisionChainResults'
import { useLocale, useTranslations } from 'next-intl'
import useSWR from 'swr'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { answerText, cancelReasonKey, latencyText } from '@/lib/decisions/evaluations'
import { chainStepResult, conditionMatch, useChainStep } from '@/lib/decisions/chain-step'
import { modelLine } from '@/lib/decisions/model-result'
import {
  matchedRuleNumbers,
  ROUTING_OUTCOME_BADGE,
  routingOutcomeTone,
  targetName,
  targetsText
} from '@/lib/decisions/routing-evaluations'
import { displayOrder, ruleNumbers } from '@/lib/decisions/routing-draft'
import type {
  DecisionRoutingEvaluationOutcome,
  DecisionRoutingEvaluationRecord,
  DecisionRoutingEvaluationRecordDetail,
  DecisionRoutingStep
} from '@agentconnect.md/protocol/decision'
import { conditionSummary } from '../DecisionConditionFields'
import { DecisionModelResult } from '../DecisionModelResult'
import {
  BackLink,
  DetailTitle,
  ExpiredBanner,
  Facts,
  formatEvaluationTime,
  Message,
  Note,
  Row,
  Section
} from '../EvaluationParts'

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

function modelStatus(
  record: Pick<DecisionRoutingEvaluationRecord, 'outcome' | 'evaluated'>
): 'answered' | 'unavailable' | 'canceled' | 'pending' | 'not_evaluated' {
  if (!record.evaluated) return 'not_evaluated'
  const byOutcome: Partial<Record<DecisionRoutingEvaluationOutcome, 'unavailable' | 'canceled' | 'pending'>> = {
    unavailable: 'unavailable',
    canceled: 'canceled',
    pending: 'pending'
  }
  return byOutcome[record.outcome] ?? 'answered'
}

export function DecisionRoutingEvaluationDetail({
  botId,
  channelId,
  channelName,
  seq,
  summary,
  agentNames,
  decisionName,
  onBack,
  record: given
}: {
  botId: string
  channelId: string
  channelName: string
  seq: number
  summary: DecisionRoutingEvaluationRecord | null
  agentNames: ReadonlyMap<string, string>
  decisionName: (decisionId: string) => string
  /** Back to the list; a detail opened on its own, such as a Try's, has none. */
  onBack?: () => void
  /** A record already in hand, such as a Try's run, read instead of the bot's stored verdict. */
  record?: DecisionRoutingEvaluationRecordDetail
}) {
  const t = useTranslations('Decisions.routing')
  const tDecisions = useTranslations('Decisions')
  const locale = useLocale()
  const { api, orgId, decisions } = useDecisionsPrototype()
  const loaded = useSWR(given ? null : ['decision-routing-evaluation', api.mode, orgId, botId, channelId, seq], () =>
    api.getRoutingEvaluation(botId, { channelId, seq })
  )
  const { error, isLoading } = loaded
  const data = given ?? loaded.data
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
  const { index: stepIndex, step, selector } = useChainStep(seq, detail?.chain, detail?.steps)

  // Each matched choice key names the matched rules it satisfied and where they route.
  const ruleKeyNotes = (
    rules: DecisionRoutingStep['rules'],
    ruleNumber: ReadonlyMap<string, number>,
    matchedRuleIds: readonly string[],
    matchedKeys: readonly string[]
  ) => {
    const notes = new Map<string, string>()
    for (const rule of rules) {
      if (!matchedRuleIds.includes(rule.id) || rule.when.type !== 'choice') continue
      const label = `${t('rules.number', { number: ruleNumber.get(rule.id) ?? 0 })} → ${
        rule.action.type === 'agent'
          ? targetName(rule.action, agentNames)
          : rule.action.type === 'decision'
            ? tDecisions('chain.next')
            : t('action.skip')
      }`
      for (const key of Object.keys(rule.when.thresholds)) {
        if (!matchedKeys.includes(key)) continue
        notes.set(key, notes.has(key) ? `${notes.get(key)}, ${label}` : label)
      }
    }
    return notes
  }
  // Every frozen choice rule contributes its threshold to that option's bar, matched or not.
  const thresholdsOf = (rules: DecisionRoutingStep['rules']) => {
    const thresholds = new Map<string, number[]>()
    for (const rule of rules) {
      if (rule.when.type !== 'choice') continue
      for (const [key, threshold] of Object.entries(rule.when.thresholds))
        thresholds.set(key, [...(thresholds.get(key) ?? []), threshold])
    }
    return thresholds
  }
  const keyNotes =
    record && snapshot
      ? ruleKeyNotes(snapshot.routing.rules, numbers, record.matchedRuleIds, record.matchedKeys)
      : new Map<string, string>()
  const ruleThresholds = thresholdsOf(snapshot?.routing.rules ?? [])
  const matchedRules = record ? matchedRuleNumbers(record, numbers) : []

  // A later step's own frozen rules decide its marks, matched against that step's answer.
  const stepResult = (() => {
    if (!step) return null
    const base = chainStepResult(step, detail!.chain![stepIndex]!)
    const rules = snapshot?.routing.steps?.find((entry) => entry.id === step.stepId)?.rules ?? []
    const matches = base.answer
      ? rules.map((rule) => ({ rule, match: conditionMatch(step.question, rule.when, base.answer!) }))
      : []
    const matchedRuleIds = matches.filter((m) => m.match.matched).map((m) => m.rule.id)
    const matchedKeys = [...new Set(matches.flatMap((m) => (m.match.matched ? m.match.matchedKeys : [])))]
    const numbers = ruleNumbers(step.question, rules)
    return {
      rules,
      numbers,
      matchedRuleIds,
      result: {
        ...base,
        ruleThresholds: thresholdsOf(rules),
        matchedKeys,
        matched: matchedRuleIds.length > 0,
        keyNotes: ruleKeyNotes(rules, numbers, matchedRuleIds, matchedKeys)
      }
    }
  })()
  // The Rules and Snapshot sections follow the selected step: its question, rules, hits and model.
  const shown = snapshot
    ? stepResult
      ? {
          question: step!.question,
          rules: stepResult.rules,
          numbers: stepResult.numbers,
          hits: stepResult.matchedRuleIds,
          model: `${step!.providerId} / ${step!.model}`
        }
      : {
          question: snapshot.question,
          rules: snapshot.routing.rules,
          numbers,
          hits: record?.matchedRuleIds ?? [],
          model: `${snapshot.providerId} / ${snapshot.model}`
        }
    : null

  return (
    <div className="flex flex-col gap-[14px] px-[18px] py-4" data-testid="routing-evaluation-detail">
      {onBack && <BackLink onClick={onBack} />}
      <DetailTitle title={record?.title} />
      {record && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mono text-[11.5px] text-(--text-tertiary)">
            {channelName} · {formatEvaluationTime(record.at, locale)}
          </span>
          <RoutingOutcomeBadge record={record} />
        </div>
      )}
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
        <ExpiredBanner title={t('evaluations.sheet.detailsExpired')} body={t('evaluations.sheet.detailsExpiredBody')} />
      )}
      {record && (
        <Facts>
          <Row label={t('evaluations.columns.channel')} value={channelName} />
          <Row label={tDecisions('evaluations.detail.decision')} value={decisionName(record.decisionId)} />
          <Row
            label={t('evaluations.columns.answer')}
            value={answerText(record.answer, words) ?? (record.evaluated ? '—' : t('evaluations.notEvaluated'))}
          />
          <Row
            label={t('try.matchedRules')}
            value={
              record.usedOtherwise
                ? t('evaluations.otherwise')
                : matchedRules.length
                  ? t('evaluations.rules', { numbers: matchedRules.join(', ') })
                  : record.matchedRuleIds.join(', ') || '—'
            }
          />
          {record.matchedKeys.length > 0 && (
            <Row label={tDecisions('gateTry.matched')} value={record.matchedKeys.join(', ')} />
          )}
          <Row label={t('evaluations.columns.targets')} value={targetsText(record, agentNames) ?? '—'} />
          <Row label={tDecisions('evaluations.detail.outcome')} value={<RoutingOutcomeBadge record={record} />} />
          <Row
            label={tDecisions('evaluations.detail.model')}
            value={modelLine(record.requestedModel, record.actualModel)}
          />
          <Row label={t('evaluations.columns.latency')} value={latencyText(record.latencyMs) ?? '—'} />
        </Facts>
      )}
      <DecisionChainResults chain={detail?.chain} names={decisions} {...selector} />
      {stepResult && <DecisionModelResult {...stepResult.result} expired={expired} />}
      {record && !stepResult && (
        <DecisionModelResult
          question={snapshot?.question ?? null}
          answer={detail?.fullAnswer ?? null}
          summary={record.answer}
          {...(snapshot ? { ruleThresholds } : {})}
          matchedKeys={record.matchedKeys}
          matched={
            snapshot
              ? snapshot.routing.rules.some((rule) => record.matchedRuleIds.includes(rule.id))
              : record.matchedRuleIds.length > 0 && !record.usedOtherwise
          }
          keyNotes={keyNotes}
          requestedModel={record.requestedModel}
          actualModel={record.actualModel}
          latencyMs={record.latencyMs}
          usage={record.usage}
          status={modelStatus(record)}
          expired={expired}
          {...(detail && detail.rawRequest !== undefined ? { rawRequest: detail.rawRequest } : {})}
          {...(detail && detail.rawResponse !== undefined ? { rawResponse: detail.rawResponse } : {})}
        />
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
                  {target.reason && <span className="mono text-[11px] text-(--text-tertiary)">{target.reason}</span>}
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
      {detail?.input && (
        <Section title={tDecisions('evaluations.detail.context')}>
          <span className="font-sans text-[11.5px] font-medium leading-normal text-(--text-tertiary)">
            {t('evaluations.sheet.input')}
          </span>
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
      {snapshot && shown && (
        <Section title={t('evaluations.sheet.routing')}>
          <ol className="m-0 flex list-none flex-col gap-[6px] p-0">
            {displayOrder(shown.question, shown.rules).map((index) => {
              const rule = shown.rules[index]!
              const hit = shown.hits.includes(rule.id)
              return (
                <li key={rule.id} className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal">
                  <span
                    className={`mono flex h-[18px] w-[18px] flex-none items-center justify-center rounded-xs text-[10px] ${hit ? 'bg-(--brand) text-white' : 'bg-(--surface-active) text-(--text-secondary)'}`}
                  >
                    {shown.numbers.get(rule.id) ?? index + 1}
                  </span>
                  <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-(--text-primary)">
                    {conditionSummary(shown.question, rule.when, words)}
                  </span>
                  <span className="text-(--text-tertiary)">→</span>
                  <span className="mono text-[11.5px] text-(--text-secondary)">
                    {rule.action.type === 'agent'
                      ? targetName(rule.action, agentNames)
                      : rule.action.type === 'decision'
                        ? tDecisions('chain.next')
                        : t('action.skip')}
                  </span>
                </li>
              )
            })}
            <li className="flex items-center gap-2 font-sans text-[12px] font-normal leading-normal">
              <span
                className={`mono flex h-[18px] w-[18px] flex-none items-center justify-center rounded-xs text-[10px] ${record?.usedOtherwise ? 'bg-(--brand) text-white' : 'bg-(--surface-active) text-(--text-secondary)'}`}
              >
                —
              </span>
              <span className="mono min-w-0 flex-1 truncate text-[11.5px] text-(--text-primary)">
                {t('otherwise.label')}
              </span>
              <span className="text-(--text-tertiary)">→</span>
              <span className="mono text-[11.5px] text-(--text-secondary)">
                {snapshot.routing.otherwise.type === 'default_agent' ? t('otherwise.default') : t('otherwise.skip')}
              </span>
            </li>
          </ol>
        </Section>
      )}
      {shown && (
        <Section title={t('evaluations.sheet.snapshot')}>
          <span className="font-sans text-[12.5px] font-normal leading-[1.55] text-(--text-primary)">
            {shown.question.instructions}
          </span>
          <Row
            label={tDecisions('evaluations.sheet.questionType')}
            value={tDecisions(`types.${shown.question.type}`)}
          />
          <Row label={t('evaluations.sheet.model')} value={shown.model} />
        </Section>
      )}
      {snapshot && <Note icon="clock">{t('evaluations.sheet.asConfigured')}</Note>}
    </div>
  )
}
