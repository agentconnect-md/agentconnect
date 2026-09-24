'use client'

// Gate Try (decisions.md §9.3): answer → the draft condition → Would trigger the fixed target, or Would skip.

import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import { errorParts } from '@/lib/decisions/binding'
import type {
  ChannelDecisionGate,
  DecisionAnswer,
  DecisionCondition,
  DecisionDefinition
} from '@agentconnect.md/protocol/decision'
import type { DecisionConversationRef, DecisionGatePreviewResult } from '@agentconnect.md/protocol/decision-api'
import { DecisionChainResults } from './DecisionChainResults'
import { conditionSummary } from './DecisionConditionFields'

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
      <span>{label}</span>
      <b className="mono min-w-0 text-right font-medium text-(--text-secondary)">{value}</b>
    </div>
  )
}

const BADGE = {
  trigger: 'bg-(--status-online-soft) text-(--status-online)',
  skip: 'bg-(--surface-active) text-(--text-secondary)',
  unavailable: 'bg-(--status-error-soft) text-(--red-600)',
  not_applied: 'bg-(--status-paused-soft) text-(--amber-500)'
} as const

/** The probability rows an answer shows before the condition is applied. */
function answerRows(
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

type Failure = { kind: 'offline' } | { kind: 'failed'; message: string }

export function DecisionGateTry({
  conversation,
  decision,
  when,
  binding,
  agentName,
  open
}: {
  conversation: DecisionConversationRef
  decision: DecisionDefinition
  when: DecisionCondition
  binding?: ChannelDecisionGate
  /** The row's agent, named until the server resolves the consumer target. */
  agentName: string
  /** Whether the sample form is shown; a result stays visible when it is collapsed. */
  open: boolean
}) {
  const t = useTranslations('Decisions')
  const { api, decisions } = useDecisionsPrototype()
  const words = { yes: t('condition.yes'), no: t('condition.no'), none: t('condition.noAnswer') }
  const [current, setCurrent] = useState('')
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [result, setResult] = useState<{
    signature: string
    sample: string
    preview: DecisionGatePreviewResult
  } | null>(null)
  // Any edit to the Decision (including a saved question or model change), condition, or sample makes the last run stale.
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
        binding,
        current
      }),
    [
      decision.id,
      decision.updatedAt,
      decision.providerId,
      decision.model,
      decision.question,
      when,
      binding,
      current,
      decisions
    ]
  )
  const stale = result !== null && result.signature !== signature

  const run = async () => {
    if (running || !current.trim()) return
    setRunning(true)
    setFailure(null)
    const ran = signature
    try {
      const preview = await api.previewGate(conversation, {
        decisionBinding: binding ?? { type: 'gate', decisionId: decision.id, when },
        // The rules modal tries one message on its own, with no sample history.
        state: { history: [], currentMessage: { text: current.trim() } }
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

  const consumer = result?.preview.consumer
  const evaluation = result?.preview.evaluation
  const target = consumer?.target.name || agentName
  const badge =
    consumer?.outcome === 'trigger'
      ? t('binding.wouldTrigger')
      : consumer?.outcome === 'skip'
        ? t('gateTry.wouldSkip')
        : consumer?.outcome === 'unavailable'
          ? t('try.unavailableBadge')
          : t('gateTry.notApplied')

  return (
    <>
      {open && (
        <div className="flex flex-wrap items-start gap-[9px]">
          <input
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void run()
              }
            }}
            placeholder={t('gateTry.placeholder')}
            aria-label={t('try.current')}
            className="inp h-8 min-h-0 min-w-[200px] flex-1"
          />
          <Button variant="secondary" size="sm" disabled={!current.trim() || running} onClick={() => void run()}>
            <Icon name="play" size={14} />
            {running ? t('try.running') : t('binding.try')}
          </Button>
        </div>
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
          <span>
            {failure.kind === 'offline' ? t('gateTry.offline') : t('gateTry.failed', { message: failure.message })}
          </span>
        </div>
      )}

      {/* Outside the sample disclosure, so collapsing it keeps the verdict on screen. */}
      {result && consumer && (
        <div
          className={`overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) ${
            stale ? 'opacity-60' : ''
          }`}
          data-testid="gate-try-result"
        >
          <div className="flex items-center gap-[9px] border-b border-(--border-subtle) px-[12px] py-[10px]">
            <span className="min-w-0 flex-1 font-sans text-[12.5px] font-normal leading-[1.45]">{result.sample}</span>
            <span className={`badge flex-none ${BADGE[consumer.outcome]}`}>{badge}</span>
          </div>
          <div className="flex flex-col gap-[7px] bg-(--surface-app) px-[12px] py-[11px]">
            {consumer.outcome === 'unavailable' ? (
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {t('gateTry.unavailableBody', {
                  reason:
                    evaluation?.status === 'unavailable'
                      ? t(`try.failures.${evaluation.reason}`)
                      : t('try.failures.provider'),
                  agent: target
                })}
              </span>
            ) : consumer.outcome === 'not_applied' ? (
              <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
                {t(`gateTry.notAppliedBody.${consumer.notAppliedReason ?? 'off'}`)}
              </span>
            ) : (
              <>
                {evaluation?.status === 'answered' &&
                  answerRows(evaluation.answer, words).map((row) => (
                    <Row key={row.label} label={<span className="mono">{row.label}</span>} value={row.value} />
                  ))}
                <Row label={t('binding.triggerCondition')} value={conditionSummary(decision.question, when, words)} />
                {consumer.matchedKeys.length > 0 && (
                  <Row label={t('gateTry.matched')} value={consumer.matchedKeys.join(', ')} />
                )}
                <Row
                  label={t('gateTry.outcome')}
                  value={
                    consumer.outcome === 'trigger'
                      ? t('gateTry.triggersAgent', { agent: target })
                      : t('gateTry.wouldSkip')
                  }
                />
              </>
            )}
            <Row
              label={t('model')}
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
          {t('gateTry.stale')}
        </span>
      )}
    </>
  )
}
