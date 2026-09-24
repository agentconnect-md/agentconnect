'use client'

// What Jev actually returned for one evaluation: the distribution, the trigger marks, usage, and the raw JSON (decisions.md §9.5).

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { answerText, latencyText } from '@/lib/decisions/evaluations'
import { distributionRows, modelLine, prettyJson, type DistributionRow } from '@/lib/decisions/model-result'
import type {
  DecisionAnswer,
  DecisionAnswerSummary,
  DecisionCondition,
  DecisionQuestion,
  DecisionRawJson
} from '@agentconnect.md/protocol/decision'
import { Section } from './EvaluationParts'

const pct = (value: number) => `${Math.round(value * 100)}%`

function Bar({ row, note }: { row: DistributionRow; note?: string }) {
  const t = useTranslations('Decisions.evaluations.model')
  return (
    <li className="flex flex-col gap-[3px]" data-chosen={row.chosen || undefined}>
      <div className="flex items-center gap-[10px]">
        <span
          className={`mono w-[88px] flex-none truncate text-[11.5px] ${row.chosen || row.inRange ? 'font-semibold text-(--text-primary)' : 'text-(--text-secondary)'}`}
          title={row.label}
        >
          {row.label}
        </span>
        <span className="relative h-[6px] min-w-0 flex-1 rounded-full bg-(--surface-active)">
          <span
            className={`absolute inset-y-0 left-0 rounded-full ${row.chosen ? 'bg-(--brand)' : 'bg-(--border-strong)'}`}
            style={{ width: pct(row.probability) }}
          />
          {row.threshold !== null && (
            <span
              className="absolute -top-[3px] h-[12px] w-[2px] -translate-x-1/2 rounded-full bg-(--text-secondary)"
              style={{ left: pct(row.threshold) }}
              title={t('threshold', { value: pct(row.threshold) })}
            />
          )}
        </span>
        <span className="mono w-[38px] flex-none text-right text-[11.5px] text-(--text-secondary)">
          {pct(row.probability)}
        </span>
        <span className="w-[78px] flex-none truncate font-sans text-[11px] font-medium leading-normal">
          {row.triggers ? (
            <span className="text-(--status-online)">{t('triggers')}</span>
          ) : row.inRange ? (
            <span className="text-(--text-tertiary)">{t('inRange')}</span>
          ) : row.threshold !== null ? (
            <span className="mono text-(--text-tertiary)">{t('threshold', { value: pct(row.threshold) })}</span>
          ) : null}
        </span>
      </div>
      {(row.description || note) && (
        <span className="flex min-w-0 gap-[8px] pl-[98px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary) max-desktop:pl-0">
          {row.description && <span className="min-w-0 truncate">{row.description}</span>}
          {note && <span className="mono flex-none text-(--text-secondary)">{note}</span>}
        </span>
      )}
    </li>
  )
}

function RawBlock({ label, raw }: { label: string; raw: DecisionRawJson | null }) {
  const t = useTranslations('Decisions.evaluations.model')
  const [copied, setCopied] = useState(false)
  if (!raw)
    return (
      <div className="flex items-baseline justify-between gap-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
        <span>{label}</span>
        <span>{t('rawMissing')}</span>
      </div>
    )
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(raw.text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setCopied(false)
    }
  }
  return (
    <details className="group rounded-md border border-(--border-subtle)">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-[11px] [&::-webkit-details-marker]:hidden py-[7px] font-sans text-[12px] font-medium leading-normal text-(--text-secondary) hover:bg-(--surface-hover)">
        <Icon name="chevron-right" size={13} className="flex-none group-open:rotate-90" />
        <Icon name="braces" size={13} className="flex-none text-(--text-tertiary)" />
        <span className="flex-1">{label}</span>
        <span className="mono text-[11px] font-normal text-(--text-tertiary)">
          {t('rawSize', { count: raw.text.length })}
        </span>
      </summary>
      <div className="flex flex-col gap-[6px] border-t border-(--border-subtle) px-[11px] py-[9px]">
        <div className="flex items-center justify-between gap-2">
          <span className="font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {raw.truncated ? t('rawTruncated', { count: raw.text.length }) : ''}
          </span>
          <button type="button" className="lnk gap-[5px] text-[11.5px] font-medium" onClick={() => void copy()}>
            <Icon name={copied ? 'check' : 'copy'} size={12} />
            {copied ? t('copied') : t('copy')}
          </button>
        </div>
        <pre className="mono m-0 max-h-[320px] overflow-auto whitespace-pre rounded-sm bg-(--surface-sunken) px-[10px] py-[8px] text-[11px] leading-[1.5] text-(--text-primary)">
          {raw.truncated ? raw.text : prettyJson(raw.text)}
        </pre>
      </div>
    </details>
  )
}

export function DecisionModelResult({
  question,
  answer,
  summary,
  condition,
  matchedKeys,
  matched,
  keyNotes,
  requestedModel,
  actualModel,
  latencyMs,
  usage,
  status,
  expired,
  rawRequest,
  rawResponse
}: {
  question: DecisionQuestion | null
  /** The full answer; null when Jev did not answer or retention stripped it. */
  answer: DecisionAnswer | null
  summary: DecisionAnswerSummary | null
  condition?: DecisionCondition | null
  matchedKeys: readonly string[]
  matched: boolean
  /** Extra text per option key, such as the routing rules it matched. */
  keyNotes?: ReadonlyMap<string, string>
  requestedModel: string
  actualModel: string | null
  latencyMs: number | null
  usage: { inputTokens: number; outputTokens: number } | null
  /** Why there is no answer: the model was unavailable, the run was canceled, or it is still pending. */
  status: 'answered' | 'unavailable' | 'canceled' | 'pending' | 'not_evaluated'
  expired: boolean
  /** Undefined when the serving daemon does not report raw JSON; null when this evaluation kept none. */
  rawRequest?: DecisionRawJson | null
  rawResponse?: DecisionRawJson | null
}) {
  const t = useTranslations('Decisions.evaluations.model')
  const tDecisions = useTranslations('Decisions')
  const words = { yes: tDecisions('condition.yes'), no: tDecisions('condition.no') }
  const rows = answer ? distributionRows({ question, answer, condition, matchedKeys, matched, words }) : []
  const answered = answerText(summary, words)
  const facts = [
    latencyText(latencyMs),
    usage ? t('tokens', { input: usage.inputTokens, output: usage.outputTokens }) : null
  ].filter(Boolean)
  const showRaw = rawRequest !== undefined || rawResponse !== undefined

  return (
    <Section
      title={t('title')}
      aside={
        <span className="mono truncate text-[11px] text-(--text-tertiary)">
          {modelLine(requestedModel, actualModel)}
        </span>
      }
    >
      <div
        className="flex flex-col gap-[10px] rounded-md border border-(--border-subtle) px-[13px] py-[11px]"
        data-testid="model-result"
      >
        {rows.length > 0 && (
          <ul className="m-0 flex list-none flex-col gap-[8px] p-0">
            {rows.map((row) => (
              <Bar key={row.key} row={row} note={keyNotes?.get(row.key)} />
            ))}
          </ul>
        )}
        {rows.length === 0 && (
          <span className="font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
            {expired ? t('expired') : t(`status.${status}`)}
          </span>
        )}
        {(answered || facts.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-[14px] gap-y-1 border-t border-(--border-subtle) pt-[9px] font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
            {answered && (
              <span>
                {t('answer')} <b className="mono font-medium text-(--text-primary)">{answered}</b>
              </span>
            )}
            {answered && matched && <span className="font-medium text-(--status-online)">{t('triggers')}</span>}
            {facts.length > 0 && <span className="mono text-[11.5px] text-(--text-tertiary)">{facts.join(' · ')}</span>}
          </div>
        )}
        {showRaw && (
          <div className="flex flex-col gap-[6px]">
            <RawBlock label={t('rawRequest')} raw={rawRequest ?? null} />
            <RawBlock label={t('rawResponse')} raw={rawResponse ?? null} />
          </div>
        )}
      </div>
    </Section>
  )
}
