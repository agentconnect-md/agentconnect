'use client'

import Link from 'next/link'
import { useState, type ComponentProps } from 'react'
import { useTranslations } from 'next-intl'
import { DECISION_CHAIN_MAX_STEPS, type DecisionDefinition } from '@agentconnect.md/protocol/decision'
import { Icon } from '@/components/ui'
import { useOrgs } from '@/lib/org-context'
import { newRule, type RoutingDraft, type RoutingDraftRule, type RoutingIssue } from '@/lib/decisions/routing-draft'
import type { RosterAgent } from '@/lib/decisions/routing-roster'
import { DecisionChainNav, RoutingChainContext, reachableSteps } from '../DecisionChainControls'
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
  create: ComponentProps<typeof DecisionPicker>['create']
  otherwiseLabels?: ComponentProps<typeof RoutingRulesTable>['otherwiseLabels']
  onRefresh: () => void
}) {
  const t = useTranslations('Decisions.routing')
  const td = useTranslations('Decisions')
  const { orgPath } = useOrgs()
  const [path, setPath] = useState<string[]>([])
  const active = draft.steps?.find((step) => step.id === path.at(-1))
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
      {path.length > 0 && (
        <DecisionChainNav
          path={[
            { id: '', name: decisions.find((d) => d.id === draft.decisionId)?.name ?? td('chain.first') },
            ...path.map((id) => ({
              id,
              name:
                decisions.find((d) => d.id === draft.steps?.find((s) => s.id === id)?.decisionId)?.name ??
                td('chain.missing')
            }))
          ]}
          onBack={(index) => setPath(path.slice(0, index))}
        />
      )}
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
            create={create}
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
        {issues.some((issue) => issue.code === 'decision_required') && (
          <FieldIssue>{t('decision.required')}</FieldIssue>
        )}
      </div>
      {question && (
        <RoutingChainContext.Provider
          value={{
            decisions,
            steps: draft.steps ?? [],
            canAdd:
              reachableSteps<{ rules: RoutingDraftRule[] }>(draft, draft.steps ?? [], (s) =>
                s.rules.flatMap((rule) => (rule.action.type === 'decision' ? [rule.action.nextStepId] : []))
              ).length <
              DECISION_CHAIN_MAX_STEPS - 1,
            open: (id) => setPath([...path, id]),
            add: (entry) => {
              const id = crypto.randomUUID()
              edit((current) => ({
                ...current,
                steps: [...(current.steps ?? []), { id, decisionId: entry.id, rules: [newRule(entry.question, [])] }]
              }))
              setPath([...path, id])
              return id
            }
          }}
        >
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
