'use client'

import Link from 'next/link'
import { type ComponentProps } from 'react'
import { useTranslations } from 'next-intl'
import { DECISION_CHAIN_MAX_STEPS, type DecisionDefinition } from '@agentconnect.md/protocol/decision'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { newRule, type RoutingDraft, type RoutingDraftRule, type RoutingIssue } from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { DecisionChainSheet, RoutingChainContext, reachableSteps, useDecisionChainPath } from '../DecisionChainControls'
import { conditionText } from '../rule-summary'
import { DecisionPicker } from '../DecisionPicker'
import { FieldIssue } from './RoutingFields'
import { RoutingRulesTable, fitsQuestion } from './RoutingRulesTable'

// Repository and shared-bot routing edit the same graph, with their own target roster and Otherwise label.
export function RoutingChainFields({
  draft,
  edit,
  decisions,
  loading,
  agents,
  issues,
  disabled,
  canWrite,
  create,
  otherwiseLabels,
  onRefresh
}: {
  draft: RoutingDraft
  edit: (patch: (current: RoutingDraft) => RoutingDraft) => void
  decisions: DecisionDefinition[]
  loading: boolean
  agents: RosterAgent[]
  issues: RoutingIssue[]
  disabled: boolean
  canWrite: boolean
  create: (stepId?: string) => ComponentProps<typeof DecisionPicker>['create']
  otherwiseLabels?: ComponentProps<typeof RoutingRulesTable>['otherwiseLabels']
  onRefresh: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const td = useTranslations('Decisions')
  const { orgPath } = useOrgs()
  const { path, enter, to, back } = useDecisionChainPath(draft, (entry) => edit(() => entry))
  const nameOf = (decisionId?: string | null) => decisions.find((d) => d.id === decisionId)?.name ?? td('chain.missing')
  const chain = {
    decisions,
    steps: draft.steps ?? [],
    canAdd:
      reachableSteps<{ rules: RoutingDraftRule[] }>(draft, draft.steps ?? [], (s) =>
        s.rules.flatMap((rule) => (rule.action.type === 'decision' ? [rule.action.nextStepId] : []))
      ).length <
      DECISION_CHAIN_MAX_STEPS - 1,
    open: enter,
    add: (entry: DecisionDefinition) => {
      const id = crypto.randomUUID()
      edit((current) => ({
        ...current,
        steps: [...(current.steps ?? []), { id, decisionId: entry.id, rules: [newRule(entry.question, [])] }]
      }))
      enter(id)
      return id
    }
  }
  // One level of the chain: the root in place, or a later Decision inside its sheet.
  const level = (stepId?: string) => {
    const active = draft.steps?.find((step) => step.id === stepId)
    const step = active ?? draft
    const decision = decisions.find((d) => d.id === step.decisionId)
    const question = decision?.question
    const editStep = (
      patch: (step: { rules: RoutingDraftRule[] }) => { decisionId?: string; rules: RoutingDraftRule[] }
    ) =>
      edit((current) =>
        active
          ? { ...current, steps: current.steps?.map((s) => (s.id === active.id ? { ...s, ...patch(s) } : s)) }
          : { ...current, ...patch(current) }
      )
    return (
      <>
        <div className="fld">
          <span className="fldlbl">{t('decision.label')}</span>
          <div className="flex flex-wrap items-center gap-[9px]">
            <DecisionPicker
              decisions={decisions}
              value={step.decisionId}
              placeholder={step.decisionId ? t('decision.hidden') : t('decision.select')}
              loading={loading}
              disabled={disabled}
              triggerClassName="block w-[280px] min-w-0 max-w-full max-desktop:w-full"
              onSelect={(entry) => {
                if (entry.id !== step.decisionId)
                  editStep((s) => ({
                    decisionId: entry.id,
                    rules: s.rules.filter((rule) => fitsQuestion(rule.when, entry.question))
                  }))
              }}
              create={create(active?.id)}
            />
            {decision && (
              <>
                <Link
                  href={orgPath(`/decisions/${encodeURIComponent(decision.id)}`)}
                  className="lnk gap-[6px] text-[11.5px] font-medium"
                >
                  <Icon name="pencil" size={12} />
                  {td('viewAndEdit')}
                </Link>
                <span className="mono text-[11px] text-(--text-tertiary)">
                  {t('decision.summary', { type: td(`types.${decision.question.type}`), model: decision.model })}
                </span>
              </>
            )}
          </div>
          {!active && issues.some((issue) => issue.code === 'decision_required') && (
            <FieldIssue>{t('decision.required')}</FieldIssue>
          )}
        </div>
        {question && (
          <RoutingChainContext.Provider value={chain}>
            <RoutingRulesTable
              question={question}
              rules={step.rules}
              otherwise={draft.otherwise}
              agents={agents}
              issues={
                active
                  ? issues
                      .filter((issue) => issue.path[0] === 'steps' && issue.path[1] === draft.steps?.indexOf(active))
                      .map((issue) => ({ ...issue, path: issue.path.slice(2) }))
                  : issues
              }
              disabled={disabled}
              canWrite={canWrite}
              otherwiseLabels={otherwiseLabels}
              onRules={(patch) => editStep((s) => ({ rules: patch(s.rules) }))}
              onOtherwise={(otherwise) => edit((current) => ({ ...current, otherwise }))}
              onRefresh={onRefresh}
            />
          </RoutingChainContext.Provider>
        )}
      </>
    )
  }
  const allSteps = [draft, ...(draft.steps ?? [])]
  return (
    <>
      {level()}
      {path.map((id, index) => {
        const parent = allSteps.find((step) =>
          step.rules.some((rule) => rule.action.type === 'decision' && rule.action.nextStepId === id)
        )
        const rule = parent?.rules.find((r) => r.action.type === 'decision' && r.action.nextStepId === id)
        const parentQuestion = decisions.find((d) => d.id === parent?.decisionId)?.question
        return (
          <DecisionChainSheet
            key={id}
            depth={index + 1}
            top={index === path.length - 1}
            parent={nameOf(parent?.decisionId)}
            condition={rule?.when ? conditionText(rule.when, parentQuestion) : undefined}
            title={nameOf(draft.steps?.find((step) => step.id === id)?.decisionId)}
            canWrite={canWrite}
            onParent={() => to(index)}
            onSave={() => back(true)}
            onCancel={() => back(false)}
          >
            {level(id)}
          </DecisionChainSheet>
        )
      })}
    </>
  )
}
