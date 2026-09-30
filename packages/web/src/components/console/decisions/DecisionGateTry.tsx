'use client'

// Gate Try (decisions.md §9.3): answer → the draft condition → Would trigger the fixed target, or Would skip.

import { useMemo } from 'react'
import { useTranslations } from 'next-intl'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import type { GateTrySource } from '@/lib/decisions/try-source'
import { apiTemplate, conversationTemplate } from '@/lib/decisions/try-state'
import type {
  ChannelDecisionGate,
  DecisionAnswer,
  DecisionCondition,
  DecisionDefinition
} from '@agentconnect.md/protocol/decision'
import type { DecisionGatePreviewResult } from '@agentconnect.md/protocol/decision-api'
import { tryEvaluation } from '@/lib/decisions/evaluation-source'
import { conditionSummary } from './DecisionConditionFields'
import { DecisionEvaluationDetail } from './DecisionEvaluationDetail'
import { DecisionTryPanel, TryNote, TryRow, type TryResultView, type TryTone } from './try/DecisionTryPanel'
import { ApiStateFields, ConversationStateFields } from './try/TryStateFields'

/** The probability rows an answer shows before the condition is applied. */
export function answerRows(
  answer: DecisionAnswer,
  words: { yes: string; no: string }
): Array<{ label: string; value: string }> {
  const pct = (value: number) => `${Math.round(value * 100)}%`
  if (answer.type === 'score') return [{ label: 'score', value: String(answer.value) }]
  if (answer.type === 'choice')
    return Object.entries(answer.probabilities).map(([key, value]) => ({ label: key, value: pct(value) }))
  return [
    { label: words.yes, value: pct(answer.probability) },
    { label: words.no, value: pct(1 - answer.probability) }
  ]
}

const TONE: Record<DecisionGatePreviewResult['consumer']['outcome'], TryTone> = {
  trigger: 'positive',
  skip: 'neutral',
  unavailable: 'error',
  not_applied: 'paused'
}

export function DecisionGateTry({
  source,
  decision,
  when,
  binding,
  agentName,
  open
}: {
  source: GateTrySource
  decision: DecisionDefinition
  when: DecisionCondition
  binding?: ChannelDecisionGate
  /** The row's agent, named until the server resolves the consumer target. */
  agentName: string
  /** Whether the sample editor is shown; a result stays visible when it is collapsed. */
  open: boolean
}) {
  const t = useTranslations('Decisions')
  const { decisions } = useDecisionsPrototype()
  const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }
  const api = source.lane === 'api'
  const decisionName = (id: string) => decisions.find((entry) => entry.id === id)?.name ?? t('binding.hiddenDecision')
  // Any edit to the Decision (including a saved question or model change) or condition makes the last run stale.
  const signature = useMemo(
    () =>
      JSON.stringify({
        decisionId: decision.id,
        updatedAt: decision.updatedAt,
        steps: binding?.steps?.map((step) => decisions.find((entry) => entry.id === step.decisionId)),
        providerId: decision.providerId,
        model: decision.model,
        question: decision.question,
        when,
        binding
      }),
    [decision.id, decision.updatedAt, decision.providerId, decision.model, decision.question, when, binding, decisions]
  )
  const gate = binding ?? { type: 'gate' as const, decisionId: decision.id, when }

  const view = (preview: DecisionGatePreviewResult): TryResultView => {
    const { consumer, evaluation } = preview
    const target = consumer.target.name || agentName
    const badge =
      consumer.outcome === 'trigger'
        ? t('binding.wouldTrigger')
        : consumer.outcome === 'skip'
          ? t('gateTry.wouldSkip')
          : consumer.outcome === 'unavailable'
            ? t('try.unavailableBadge')
            : t('gateTry.notApplied')
    const reason =
      evaluation?.status === 'unavailable' ? t(`try.failures.${evaluation.reason}`) : t('try.failures.provider')
    return {
      badge,
      tone: TONE[consumer.outcome],
      ...(preview.chain ? { chain: preview.chain } : {}),
      ...(preview.detail
        ? {
            details: (
              <DecisionEvaluationDetail
                source={tryEvaluation(api ? 'api' : 'conversation', preview.detail)}
                seq={0}
                summary={preview.detail}
                decisionName={decisionName}
              />
            )
          }
        : {}),
      body: (
        <>
          {consumer.outcome === 'unavailable' ? (
            <TryNote>
              {t(api ? 'gateTry.api.unavailableBody' : 'gateTry.unavailableBody', { reason, agent: target })}
            </TryNote>
          ) : consumer.outcome === 'not_applied' ? (
            <TryNote>
              {api && consumer.notAppliedReason === 'unsupported'
                ? t('gateTry.api.unsupported')
                : t(`gateTry.notAppliedBody.${consumer.notAppliedReason ?? 'off'}`)}
            </TryNote>
          ) : (
            <>
              {evaluation?.status === 'answered' &&
                answerRows(evaluation.answer, words).map((row) => (
                  <TryRow key={row.label} label={<span className="mono">{row.label}</span>} value={row.value} />
                ))}
              <TryRow label={t('binding.triggerCondition')} value={conditionSummary(decision.question, when, words)} />
              {consumer.matchedKeys.length > 0 && (
                <TryRow label={t('gateTry.matched')} value={consumer.matchedKeys.join(', ')} />
              )}
              <TryRow
                label={t('gateTry.outcome')}
                value={
                  consumer.outcome === 'trigger'
                    ? t(api ? 'gateTry.api.admits' : 'gateTry.triggersAgent', { agent: target })
                    : t(api ? 'gateTry.api.refuses' : 'gateTry.wouldSkip')
                }
              />
            </>
          )}
          <TryRow
            label={t('model')}
            value={
              evaluation?.status === 'answered'
                ? `${decision.providerId} / ${evaluation.model}`
                : `${decision.providerId} / ${decision.model}`
            }
          />
        </>
      )
    }
  }

  if (source.lane === 'api')
    return (
      <DecisionTryPanel
        lane="api"
        initial={apiTemplate()}
        fields={(value, onChange) => <ApiStateFields value={value} onChange={onChange} />}
        signature={signature}
        run={(state) => source.preview(gate, state)}
        view={view}
        offlineText={t('gateTry.api.offline')}
        open={open}
      />
    )
  return (
    <DecisionTryPanel
      lane="conversation"
      initial={conversationTemplate()}
      fields={(value, onChange) => <ConversationStateFields value={value} onChange={onChange} />}
      signature={signature}
      run={(state) => source.preview(gate, state)}
      view={view}
      offlineText={t('gateTry.offline')}
      open={open}
    />
  )
}
