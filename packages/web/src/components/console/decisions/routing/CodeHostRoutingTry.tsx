'use client'

// Repository routing Try (code-host-decisions.md §7): a sample event, the answer, the matched rules, and the agents it fires.

import { useTranslations } from 'next-intl'
import { previewCodeHostRouting, type CodeHostRoutingDto } from '@/lib/api'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { ruleNumbers, type RoutingDraft } from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { codeHostTemplate } from '@/lib/decisions/try-state'
import type { DecisionDefinition, SharedBotDecisionRouting } from '@agentconnect.md/protocol/decision'
import type { CodeHostRoutingPreviewResult } from '@agentconnect.md/protocol/decision-api'
import { tryEvaluation } from '@/lib/decisions/evaluation-source'
import { answerRows } from '../DecisionGateTry'
import { DecisionEvaluationDetail } from '../DecisionEvaluationDetail'
import { DecisionTryPanel, TryNote, TryRow, type TryResultView, type TryTone } from '../try/DecisionTryPanel'
import { CodeHostStateFields } from '../try/TryStateFields'

const TONE: Record<CodeHostRoutingPreviewResult['consumer']['outcome'], TryTone> = {
  activate: 'positive',
  skip: 'neutral',
  unavailable: 'error',
  not_applied: 'paused'
}

export function CodeHostRoutingTry({
  routing,
  draft,
  config,
  decision,
  agents,
  open
}: {
  routing: CodeHostRoutingDto
  draft: RoutingDraft
  /** The draft as a saveable configuration. */
  config: SharedBotDecisionRouting
  decision: DecisionDefinition
  agents: readonly RosterAgent[]
  open: boolean
}) {
  const t = useTranslations('Decisions.routing')
  const tc = useTranslations('Decisions.routing.codeHost.try')
  const tDecisions = useTranslations('Decisions')
  const { decisions, orgId } = useDecisionsPrototype()
  const words = {
    yes: tDecisions('condition.yes'),
    no: tDecisions('condition.no'),
    none: tDecisions('condition.noAnswer')
  }
  const signature = JSON.stringify({
    config,
    updatedAt: decision.updatedAt,
    steps: config.steps?.map((step) => decisions.find((entry) => entry.id === step.decisionId)),
    question: decision.question
  })
  const names = new Map(agents.map((agent) => [agent.id, agent.name]))
  const numbers = ruleNumbers(decision.question, draft.rules)
  const scope = { provider: routing.provider, repoId: routing.repoId, family: routing.family }

  const view = (preview: CodeHostRoutingPreviewResult): TryResultView => {
    const { consumer, evaluation } = preview
    const badge =
      consumer.outcome === 'activate'
        ? t('try.wouldActivate')
        : consumer.outcome === 'skip'
          ? t('try.wouldNotActivate')
          : consumer.outcome === 'unavailable'
            ? tDecisions('try.unavailableBadge')
            : t('try.notApplied')
    const targets = consumer.targets.map(
      (target) => target.name ?? names.get(target.agentId) ?? t('action.hiddenAgent')
    )
    return {
      badge,
      tone: TONE[consumer.outcome],
      ...(preview.chain ? { chain: preview.chain } : {}),
      ...(preview.detail
        ? {
            details: (
              <DecisionEvaluationDetail
                source={tryEvaluation('code_host', preview.detail)}
                seq={0}
                summary={preview.detail}
                decisionName={(id) =>
                  decisions.find((entry) => entry.id === id)?.name ?? tDecisions('binding.hiddenDecision')
                }
              />
            )
          }
        : {}),
      body:
        consumer.outcome === 'not_applied' ? (
          <TryNote>{tc(`notAppliedBody.${consumer.notAppliedReason ?? 'paused'}`)}</TryNote>
        ) : (
          <>
            {consumer.outcome === 'unavailable' && (
              <TryNote>
                {tc('unavailableBody', {
                  reason:
                    evaluation?.status === 'unavailable'
                      ? tDecisions(`try.failures.${evaluation.reason}`)
                      : tDecisions('try.failures.provider')
                })}
              </TryNote>
            )}
            {evaluation?.status === 'answered' &&
              answerRows(evaluation.answer, words).map((row) => (
                <TryRow key={row.label} label={<span className="mono">{row.label}</span>} value={row.value} />
              ))}
            {consumer.outcome !== 'unavailable' && (
              <TryRow
                label={t('try.matchedRules')}
                value={
                  consumer.usedOtherwise
                    ? t('try.otherwiseUsed')
                    : consumer.matchedRuleIds.map((id) => numbers.get(id) ?? 0).join(', ') || '—'
                }
              />
            )}
            <TryRow label={tc('agents')} value={targets.join(', ') || tc('noAgent')} />
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
      lane="code_host"
      initial={codeHostTemplate(routing.provider, routing.family)}
      fields={(value, onChange) => <CodeHostStateFields value={value} onChange={onChange} />}
      signature={signature}
      run={(state) => previewCodeHostRouting(scope, { config, state }, orgId)}
      view={view}
      offlineText={t('try.offline')}
      open={open}
    />
  )
}
