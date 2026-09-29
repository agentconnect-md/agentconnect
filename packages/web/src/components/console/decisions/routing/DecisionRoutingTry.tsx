'use client'

// Routing Try (decisions.md §9.3): the answer, every rule's match, the matched actions, and the effective targets.

import { useTranslations } from 'next-intl'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { ruleNumbers, type RoutingDraft } from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { conversationSample, routingTargets, routingTemplate } from '@/lib/decisions/try-state'
import type { DecisionDefinition, SharedBotDecisionRouting } from '@agentconnect.md/protocol/decision'
import type { DecisionRoutingPreviewResult } from '@agentconnect.md/protocol/decision-api'
import { conditionSummary } from '../DecisionConditionFields'
import { answerRows } from '../DecisionGateTry'
import { DecisionTryPanel, TryNote, TryRow, type TryResultView, type TryTone } from '../try/DecisionTryPanel'
import { RoutingStateFields } from '../try/TryStateFields'

const TONE: Record<DecisionRoutingPreviewResult['consumer']['outcome'], TryTone> = {
  activate: 'positive',
  continue: 'positive',
  skip: 'neutral',
  unavailable: 'error',
  not_applied: 'paused'
}

export function DecisionRoutingTry({
  botId,
  channelId,
  draft,
  config,
  decision,
  agents,
  open
}: {
  botId: string
  /** The conversation the modal was opened from: the sample's channel. */
  channelId: string
  draft: RoutingDraft
  /** The draft as a saveable configuration. */
  config: SharedBotDecisionRouting
  decision: DecisionDefinition
  agents: readonly RosterAgent[]
  open: boolean
}) {
  const t = useTranslations('Decisions.routing')
  const tDecisions = useTranslations('Decisions')
  const { api, decisions } = useDecisionsPrototype()
  const words = {
    yes: tDecisions('condition.yes'),
    no: tDecisions('condition.no'),
    none: tDecisions('condition.noAnswer')
  }
  // Any draft or Decision edit makes the last run stale.
  const signature = JSON.stringify({
    config,
    channelIds: draft.channelIds,
    channelId,
    updatedAt: decision.updatedAt,
    steps: config.steps?.map((step) => decisions.find((entry) => entry.id === step.decisionId)),
    question: decision.question
  })
  const names = new Map(agents.map((agent) => [agent.id, agent.name]))
  const nameOf = (id: string) => names.get(id) ?? id
  const numbers = ruleNumbers(decision.question, draft.rules)
  const ruleNumber = (ruleId: string) => numbers.get(ruleId) ?? 0
  const ruleCondition = (ruleId: string) => {
    const when = draft.rules.find((rule) => rule.id === ruleId)?.when
    return when ? conditionSummary(decision.question, when, words) : '—'
  }

  const view = (preview: DecisionRoutingPreviewResult): TryResultView => {
    const { consumer, evaluation } = preview
    const constrained = consumer.targetConstraint.type !== 'new'
    const badge =
      consumer.outcome === 'activate'
        ? t('try.wouldActivate')
        : consumer.outcome === 'continue'
          ? t('try.wouldContinue')
          : consumer.outcome === 'skip'
            ? constrained
              ? t('try.wouldSkip')
              : t('try.wouldNotActivate')
            : consumer.outcome === 'unavailable'
              ? tDecisions('try.unavailableBadge')
              : t('try.notApplied')
    const matchedActions = consumer.matchedRuleIds.map((id) => {
      const rule = draft.rules.find((entry) => entry.id === id)
      return rule?.action.type === 'agent' && rule.action.agentId ? nameOf(rule.action.agentId) : t('action.skip')
    })
    return {
      badge,
      tone: TONE[consumer.outcome],
      ...(preview.chain ? { chain: preview.chain } : {}),
      body:
        consumer.outcome === 'not_applied' ? (
          <TryNote>{t(`try.notAppliedBody.${consumer.notAppliedReason ?? 'off'}`)}</TryNote>
        ) : (
          <>
            {!consumer.evaluated && <TryNote>{t('try.notEvaluated')}</TryNote>}
            {consumer.outcome === 'unavailable' && (
              <span className="flex flex-col gap-[3px]">
                <TryNote>
                  {t('try.unavailableBody', {
                    reason:
                      evaluation?.status === 'unavailable'
                        ? tDecisions(`try.failures.${evaluation.reason}`)
                        : tDecisions('try.failures.provider')
                  })}
                </TryNote>
                <TryNote>{t(`try.continuation.${consumer.fallback ?? 'none'}`)}</TryNote>
              </span>
            )}
            {evaluation?.status === 'answered' &&
              answerRows(evaluation.answer, words).map((row) => (
                <TryRow key={row.label} label={<span className="mono">{row.label}</span>} value={row.value} />
              ))}
            {[...consumer.rules]
              .sort((a, b) => ruleNumber(a.ruleId) - ruleNumber(b.ruleId))
              .map((rule) => (
                <TryRow
                  key={rule.ruleId}
                  label={
                    rule.matched
                      ? t('try.ruleMatched', { number: ruleNumber(rule.ruleId) })
                      : t('try.ruleNotMatched', { number: ruleNumber(rule.ruleId) })
                  }
                  value={`${t('try.threshold')}: ${ruleCondition(rule.ruleId)}`}
                />
              ))}
            {consumer.evaluated && consumer.outcome !== 'unavailable' && (
              <TryRow
                label={t('try.matchedRules')}
                value={
                  consumer.usedOtherwise
                    ? t('try.otherwiseUsed')
                    : consumer.matchedRuleIds.map((id) => ruleNumber(id)).join(', ') || '—'
                }
              />
            )}
            {matchedActions.length > 0 && <TryRow label={t('try.matchedActions')} value={matchedActions.join(', ')} />}
            <TryRow
              label={t('try.effectiveTargets')}
              value={
                consumer.targets
                  .map((target) => {
                    const name =
                      target.name ?? (target.status === 'removed' ? t('action.hiddenAgent') : nameOf(target.agentId))
                    const effect = t(`evaluations.effects.${target.effect}`)
                    return target.status === 'available'
                      ? `${name} (${effect})`
                      : `${name} (${effect}, ${target.status === 'removed' ? t('try.targetRemoved') : t('try.targetUnavailable')})`
                  })
                  .join(', ') || '—'
              }
            />
            {consumer.targets.some((target) => target.status !== 'available') && (
              <TryNote>{t('try.noSubstitute')}</TryNote>
            )}
            {constrained && consumer.outcome === 'continue' && consumer.evaluated && (
              <TryNote>{t('try.constrainedNote')}</TryNote>
            )}
            <TryRow
              label={tDecisions('model')}
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

  return (
    <DecisionTryPanel
      lane="routing"
      initial={routingTemplate()}
      fields={(value, onChange) => <RoutingStateFields value={value} onChange={onChange} agents={agents} />}
      signature={signature}
      run={(state) =>
        api.previewRouting(botId, {
          config,
          channelIds: draft.channelIds,
          channelId,
          targets: routingTargets(state),
          state: conversationSample(state)
        })
      }
      view={view}
      offlineText={t('try.offline')}
      open={open}
    />
  )
}
