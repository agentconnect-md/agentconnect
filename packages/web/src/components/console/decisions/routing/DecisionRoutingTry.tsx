'use client'

// Routing Try (decisions.md §9.3): a channel and situation, the answer, every rule's match, the matched actions, and the effective targets.

import { DecisionChainResults } from '../DecisionChainResults'
import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import { draftConfig, ruleNumbers, type RoutingDraft } from '@/lib/decisions/routing-draft'
import type { RoutingRoster } from '@/lib/decisions/routing-roster'
import type { DecisionAnswer, DecisionDefinition } from '@agentconnect.md/protocol/decision'
import type { DecisionRoutingPreviewResult, DecisionTargetConstraint } from '@agentconnect.md/protocol/decision-api'
import { conditionSummary } from '../DecisionConditionFields'
import { DecisionSampleFields, type SampleLine } from '../DecisionSampleFields'

type Situation = 'new' | 'mention' | 'thread'
type Consumer = DecisionRoutingPreviewResult['consumer']

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
      <span>{label}</span>
      <b className="mono min-w-0 text-right font-medium text-(--text-secondary)">{value}</b>
    </div>
  )
}

const BADGE = {
  activate: 'bg-(--status-online-soft) text-(--status-online)',
  continue: 'bg-(--status-online-soft) text-(--status-online)',
  skip: 'bg-(--surface-active) text-(--text-secondary)',
  unavailable: 'bg-(--status-error-soft) text-(--red-600)',
  not_applied: 'bg-(--status-paused-soft) text-(--amber-500)'
} as const

function answerRows(answer: DecisionAnswer, words: { yes: string; no: string }): Array<[string, string]> {
  const pct = (value: number) => `${Math.round(value * 100)}%`
  if (answer.type === 'score') return [['score', String(answer.value)]]
  if (answer.type === 'choice') return Object.entries(answer.probabilities).map(([key, value]) => [key, pct(value)])
  return [
    [words.yes, pct(answer.probability)],
    [words.no, pct(1 - answer.probability)]
  ]
}

type Failure = { kind: 'offline' } | { kind: 'failed'; message: string }

export function DecisionRoutingTry({
  botId,
  draft,
  decision,
  roster,
  open
}: {
  botId: string
  draft: RoutingDraft
  decision: DecisionDefinition
  roster: RoutingRoster
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
  const channels = roster.channels.filter((channel) => channel.kind !== 'im')
  const [channelId, setChannelId] = useState<string>(() => draft.channelIds[0] ?? channels[0]?.channelId ?? '')
  const [situation, setSituation] = useState<Situation>('new')
  const [recipients, setRecipients] = useState<string[]>([])
  const [participants, setParticipants] = useState<string[]>([])
  const [history, setHistory] = useState<SampleLine[]>([])
  const [current, setCurrent] = useState('')
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [result, setResult] = useState<{
    signature: string
    sample: string
    preview: DecisionRoutingPreviewResult
  } | null>(null)
  const config = draftConfig(draft)
  const targets: DecisionTargetConstraint =
    situation === 'new'
      ? { type: 'new' }
      : {
          type: situation,
          agentIds: recipients,
          participantAgentIds: participants.filter((id) => recipients.includes(id))
        }
  // Any draft, Decision, channel, situation, or sample edit makes the last run stale.
  const signature = JSON.stringify({
    config,
    channelIds: draft.channelIds,
    updatedAt: decision.updatedAt,
    steps: config?.steps?.map((step) => decisions.find((entry) => entry.id === step.decisionId)),
    question: decision.question,
    channelId,
    targets,
    history,
    current
  })
  const stale = result !== null && result.signature !== signature
  const names = new Map(roster.agents.map((agent) => [agent.id, agent.name]))
  const nameOf = (id: string, fallback?: string | null) => fallback ?? names.get(id) ?? id
  const ready = !!config && !!channelId && !!current.trim() && (situation === 'new' || recipients.length > 0)

  const run = async () => {
    if (!config || running || !ready) return
    setRunning(true)
    setFailure(null)
    const ran = signature
    try {
      const preview = await api.previewRouting(botId, {
        config,
        channelIds: draft.channelIds,
        channelId,
        targets,
        state: {
          history: history
            .filter((line) => line.text.trim())
            .map((line) => ({ sender: line.sender.trim() || '@user', text: line.text })),
          currentMessage: { text: current.trim() }
        }
      })
      setResult({ signature: ran, sample: current.trim(), preview })
    } catch (cause) {
      const parts = errorParts(cause)
      setResult(null)
      setFailure(
        parts?.status === 503 && parts.code === 'DAEMON_OFFLINE'
          ? { kind: 'offline' }
          : { kind: 'failed', message: parts?.message ?? (cause instanceof Error ? cause.message : String(cause)) }
      )
    } finally {
      setRunning(false)
    }
  }

  const consumer: Consumer | undefined = result?.preview.consumer
  const evaluation = result?.preview.evaluation
  const constrained = consumer?.targetConstraint.type !== 'new'
  const badge = !consumer
    ? ''
    : consumer.outcome === 'activate'
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
  const numbers = ruleNumbers(decision.question, draft.rules)
  const ruleNumber = (ruleId: string) => numbers.get(ruleId) ?? 0
  const ruleCondition = (ruleId: string) => {
    const when = draft.rules.find((rule) => rule.id === ruleId)?.when
    return when ? conditionSummary(decision.question, when, words) : '—'
  }
  const matchedActions = (consumer?.matchedRuleIds ?? []).map((id) => {
    const rule = draft.rules.find((entry) => entry.id === id)
    return rule?.action.type === 'agent' && rule.action.agentId ? nameOf(rule.action.agentId) : t('action.skip')
  })

  return (
    <div className="card flex flex-col gap-3 p-4" data-testid="routing-try">
      {open && (
        <>
          <h3 className="m-0 font-sans text-[13px] font-semibold leading-normal">{t('try.title')}</h3>
          <div className="grid grid-cols-1 gap-3 desktop:grid-cols-2">
            <label className="fld">
              <span className="fldlbl">{t('try.channel')}</span>
              <select
                className="inp h-8 min-h-0"
                value={channelId}
                onChange={(event) => setChannelId(event.target.value)}
              >
                {channels.map((channel) => (
                  <option key={channel.channelId} value={channel.channelId}>
                    {channel.name}
                  </option>
                ))}
              </select>
            </label>
            <fieldset className="fld m-0 border-0 p-0">
              <legend className="fldlbl">{t('try.situation')}</legend>
              <div className="flex flex-wrap gap-3">
                {(['new', 'mention', 'thread'] as const).map((value) => (
                  <label
                    key={value}
                    className="flex items-center gap-[6px] font-sans text-[12.5px] font-normal leading-normal"
                  >
                    <input
                      type="radio"
                      name={`routing-situation-${botId}`}
                      checked={situation === value}
                      onChange={() => setSituation(value)}
                    />
                    {t(`try.situations.${value}`)}
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          {situation !== 'new' && (
            <fieldset className="fld m-0 border-0 p-0">
              <legend className="fldlbl">
                {situation === 'mention' ? t('try.recipients') : t('try.participants')}
              </legend>
              <ul className="m-0 flex list-none flex-col gap-[6px] p-0">
                {roster.agents.map((agent) => {
                  const selected = recipients.includes(agent.id)
                  return (
                    <li key={agent.id} className="flex flex-wrap items-center gap-3">
                      <label className="flex min-w-[160px] items-center gap-[6px] font-sans text-[12.5px] font-normal leading-normal">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={() =>
                            setRecipients((ids) =>
                              selected ? ids.filter((id) => id !== agent.id) : [...ids, agent.id]
                            )
                          }
                        />
                        {agent.name}
                      </label>
                      {selected && (
                        <label className="flex items-center gap-[6px] font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                          <input
                            type="checkbox"
                            checked={participants.includes(agent.id)}
                            aria-label={`${t('try.participant')}: ${agent.name}`}
                            onChange={() =>
                              setParticipants((ids) =>
                                ids.includes(agent.id) ? ids.filter((id) => id !== agent.id) : [...ids, agent.id]
                              )
                            }
                          />
                          {t('try.participant')}
                        </label>
                      )}
                    </li>
                  )
                })}
              </ul>
            </fieldset>
          )}
          <DecisionSampleFields history={history} current={current} onHistory={setHistory} onCurrent={setCurrent} />
          <div className="flex flex-wrap items-center gap-[9px]">
            <Button variant="secondary" size="sm" disabled={!ready || running} onClick={() => void run()}>
              <Icon name="play" size={14} />
              {running ? t('try.running') : t('try.run')}
            </Button>
          </div>
        </>
      )}

      {result && <DecisionChainResults chain={result.preview.chain} names={decisions} />}
      {failure && (
        <div
          role="alert"
          className="flex items-start gap-[9px] rounded-md border border-(--red-500) bg-(--status-error-soft) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
        >
          <Icon
            name={failure.kind === 'offline' ? 'wifi-off' : 'triangle-alert'}
            size={14}
            className="mt-[2px] flex-none"
          />
          <span>{failure.kind === 'offline' ? t('try.offline') : t('try.failed', { message: failure.message })}</span>
        </div>
      )}

      {result && consumer && (
        <div
          className={`overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) ${stale ? 'opacity-60' : ''}`}
          data-testid="routing-try-result"
        >
          <div className="flex items-center gap-[9px] border-b border-(--border-subtle) px-[12px] py-[10px]">
            <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-[1.45]">{result.sample}</span>
            <span className={`badge flex-none ${BADGE[consumer.outcome]}`}>{badge}</span>
          </div>
          <div className="flex flex-col gap-[7px] bg-(--surface-app) px-[12px] py-[11px]">
            {consumer.outcome === 'not_applied' ? (
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {t(`try.notAppliedBody.${consumer.notAppliedReason ?? 'off'}`)}
              </span>
            ) : (
              <>
                {!consumer.evaluated && (
                  <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    {t('try.notEvaluated')}
                  </span>
                )}
                {consumer.outcome === 'unavailable' && (
                  <span className="flex flex-col gap-[3px] font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                    <span>
                      {t('try.unavailableBody', {
                        reason:
                          evaluation?.status === 'unavailable'
                            ? tDecisions(`try.failures.${evaluation.reason}`)
                            : tDecisions('try.failures.provider')
                      })}
                    </span>
                    <span>{t(`try.continuation.${consumer.fallback ?? 'none'}`)}</span>
                  </span>
                )}
                {evaluation?.status === 'answered' &&
                  answerRows(evaluation.answer, words).map(([label, value]) => (
                    <Row key={label} label={<span className="mono">{label}</span>} value={value} />
                  ))}
                {[...consumer.rules]
                  .sort((a, b) => ruleNumber(a.ruleId) - ruleNumber(b.ruleId))
                  .map((rule) => (
                    <Row
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
                  <Row
                    label={t('try.matchedRules')}
                    value={
                      consumer.usedOtherwise
                        ? t('try.otherwiseUsed')
                        : consumer.matchedRuleIds.map((id) => ruleNumber(id)).join(', ') || '—'
                    }
                  />
                )}
                {matchedActions.length > 0 && <Row label={t('try.matchedActions')} value={matchedActions.join(', ')} />}
                <div className="flex flex-col gap-[4px]">
                  <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
                    {t('try.effectiveTargets')}
                  </span>
                  {consumer.targets.length === 0 ? (
                    <span className="mono text-[11.5px] text-(--text-secondary)">—</span>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-[3px] p-0">
                      {consumer.targets.map((target) => (
                        <li
                          key={target.agentId}
                          className="flex flex-wrap items-center gap-[6px] font-sans text-[12px] font-normal leading-normal"
                        >
                          <span className="mono text-(--text-primary)">
                            {target.name ??
                              (target.status === 'removed' ? t('action.hiddenAgent') : nameOf(target.agentId))}
                          </span>
                          <span className="text-(--text-tertiary)">{t(`evaluations.effects.${target.effect}`)}</span>
                          {target.status !== 'available' && (
                            <span className="badge bg-(--status-error-soft) text-(--red-600)">
                              {target.status === 'removed' ? t('try.targetRemoved') : t('try.targetUnavailable')}
                            </span>
                          )}
                          {target.status !== 'available' && (
                            <span className="text-(--text-tertiary)">{t('try.noSubstitute')}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                {constrained && consumer.outcome === 'continue' && consumer.evaluated && (
                  <span className="font-sans text-[11.5px] font-normal leading-[1.5] text-(--text-tertiary)">
                    {t('try.constrainedNote')}
                  </span>
                )}
              </>
            )}
            <Row
              label={tDecisions('model')}
              value={
                evaluation?.status === 'answered'
                  ? `${decision.providerId} / ${evaluation.model}`
                  : `${decision.providerId} / ${decision.model}`
              }
            />
          </div>
        </div>
      )}
      {result && stale && (
        <span
          role="status"
          className="flex items-center gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          <Icon name="clock" size={12} />
          {t('try.stale')}
        </span>
      )}
    </div>
  )
}
