'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import {
  DECISION_CHAIN_MAX_STEPS,
  type ChannelDecisionGate,
  type DecisionDefinition,
  type DecisionGateStep
} from '@agentconnect.md/protocol/decision'
import { defaultConditionFor } from '@/lib/decisions/provider'
import { DecisionPicker } from './DecisionPicker'
import { DecisionConditionFields } from './DecisionConditionFields'
import { DecisionChainNav, NextDecision, reachableSteps } from './DecisionChainControls'

const edges = (step: DecisionGateStep) => [step.nextStepId, step.elseStepId].filter((id): id is string => !!id)

export function GateChainFields({
  value,
  decisions,
  disabled,
  onChange
}: {
  value: ChannelDecisionGate
  decisions: DecisionDefinition[]
  disabled: boolean
  onChange: (value: ChannelDecisionGate) => void
}) {
  const t = useTranslations('Decisions.chain')
  const [path, setPath] = useState<string[]>([])
  const activeId = path.at(-1)
  const step = value.steps?.find((step) => step.id === activeId)
  const current = step ?? value
  const decision = decisions.find((d) => d.id === current.decisionId)
  const change = (next: DecisionGateStep, steps = value.steps ?? []) => {
    const root = step ? value : { type: 'gate' as const, ...next }
    const updated = step ? steps.map((entry) => (entry.id === step.id ? { ...next, id: step.id } : entry)) : steps
    const reachable = reachableSteps<DecisionGateStep>(root, updated, edges)
    const { steps: _steps, ...rest } = root
    onChange({ ...rest, ...(reachable.length ? { steps: reachable } : {}) })
  }
  return (
    <div className="flex flex-col gap-3">
      {step && (
        <>
          <DecisionChainNav
            path={[
              { id: '', name: decisions.find((d) => d.id === value.decisionId)?.name ?? t('first') },
              ...path.map((id) => ({
                id,
                name:
                  decisions.find((d) => d.id === value.steps?.find((s) => s.id === id)?.decisionId)?.name ??
                  t('missing')
              }))
            ]}
            onBack={(index) => setPath(path.slice(0, index))}
          />
          <DecisionPicker
            decisions={decisions}
            value={step.decisionId}
            disabled={disabled}
            onSelect={(entry) => change({ ...step, decisionId: entry.id, when: defaultConditionFor(entry) })}
          />
          {decision &&
            (step.when.type === decision.question.type ? (
              <fieldset disabled={disabled}>
                <DecisionConditionFields
                  question={decision.question}
                  value={step.when}
                  issues={[]}
                  onChange={(when) => change({ ...step, when })}
                />
              </fieldset>
            ) : (
              <button
                type="button"
                className="lnk"
                disabled={disabled}
                onClick={() => change({ ...step, when: defaultConditionFor(decision) })}
              >
                {t('resetCondition')}
              </button>
            ))}
        </>
      )}
      {(['nextStepId', 'elseStepId'] as const).map((key) => {
        const id = current[key]
        const next = value.steps?.find((step) => step.id === id)
        return (
          <div key={key} className="flex items-center gap-2">
            <span className="w-[112px] flex-none text-[12px] text-(--text-secondary)">
              {t(key === 'nextStepId' ? 'matches' : 'misses')}
            </span>
            <Icon name="arrow-right" size={13} className="text-(--text-tertiary)" />
            {id ? (
              <>
                <button
                  type="button"
                  className="inp min-h-8 min-w-0 flex-1 gap-2 text-[12px]"
                  onClick={() => setPath([...path, id])}
                >
                  <Icon name="split" size={13} />
                  <span className="truncate">
                    {decisions.find((d) => d.id === next?.decisionId)?.name ?? t('missing')}
                  </span>
                  <Icon name="chevron-right" size={12} />
                </button>
                <button
                  type="button"
                  className="iconbtn"
                  disabled={disabled}
                  title={t('remove')}
                  aria-label={t('remove')}
                  onClick={() => {
                    const { [key]: _removed, ...rest } = current
                    change(rest)
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 flex-1 text-[12px]">{t(key === 'nextStepId' ? 'trigger' : 'skip')}</span>
                <NextDecision
                  decisions={decisions}
                  disabled={disabled || (value.steps?.length ?? 0) >= DECISION_CHAIN_MAX_STEPS - 1}
                  onSelect={(entry) => {
                    const id = crypto.randomUUID()
                    change({ ...current, [key]: id }, [
                      ...(value.steps ?? []),
                      { id, decisionId: entry.id, when: defaultConditionFor(entry) }
                    ])
                    setPath([...path, id])
                  }}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
