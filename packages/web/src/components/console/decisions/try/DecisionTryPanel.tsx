'use client'

// Every Try (decisions.md §9.3): one sample state, edited as its JSON or as Raw JSON, run against the draft.

import { useMemo, useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Button, Icon } from '@/components/ui'
import { errorParts } from '@/lib/decisions/binding'
import { useDecisionsPrototype } from '@/lib/decisions/provider'
import {
  checkTryState,
  parseTryState,
  trySampleTitle,
  tryStateJson,
  type TryLane,
  type TryParseError,
  type TryStates
} from '@/lib/decisions/try-state'
import type { DecisionChainTrace } from '@agentconnect.md/protocol/decision'
import { DecisionChainResults } from '../DecisionChainResults'
import { StateJson } from './StateJson'

export type TryTone = 'positive' | 'neutral' | 'error' | 'paused'

const BADGE: Record<TryTone, string> = {
  positive: 'bg-(--status-online-soft) text-(--status-online)',
  neutral: 'bg-(--surface-active) text-(--text-secondary)',
  error: 'bg-(--status-error-soft) text-(--red-600)',
  paused: 'bg-(--status-paused-soft) text-(--amber-500)'
}

export interface TryResultView {
  badge: string
  tone: TryTone
  body: ReactNode
  chain?: DecisionChainTrace
}

/** One label/value line of a result card. */
export function TryRow({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
      <span>{label}</span>
      <b className="mono min-w-0 text-right font-medium text-(--text-secondary)">{value}</b>
    </div>
  )
}

/** Prose inside a result card. */
export function TryNote({ children }: { children: ReactNode }) {
  return <span className="font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">{children}</span>
}

type Failure = { kind: 'offline' } | { kind: 'failed'; message: string }

const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry
  )

export function DecisionTryPanel<L extends TryLane, R>({
  lane,
  initial,
  fields,
  signature,
  run,
  view,
  offlineText,
  open
}: {
  lane: L
  /** The lane's template, used once on mount. */
  initial: TryStates[L]
  /** The lane's fields drawn as its JSON. */
  fields: (value: TryStates[L], onChange: (next: TryStates[L]) => void) => ReactNode
  /** The draft the sample runs against; any change makes the last run stale. */
  signature: string
  run: (state: TryStates[L]) => Promise<R>
  view: (result: R) => TryResultView
  offlineText: string
  /** Whether the editor is shown; a result stays visible when it is collapsed. */
  open: boolean
}) {
  const t = useTranslations('Decisions.tryState')
  const tDecisions = useTranslations('Decisions')
  const { decisions } = useDecisionsPrototype()
  const [value, setValue] = useState<TryStates[L]>(initial)
  const [mode, setMode] = useState<'fields' | 'raw'>('fields')
  const [raw, setRaw] = useState('')
  const [error, setError] = useState<TryParseError | null>(null)
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [result, setResult] = useState<{ signature: string; sample: string; value: R } | null>(null)
  // Both editors key the same state alike, so switching between them never makes a run stale.
  const sample = useMemo(() => {
    const parsed = mode === 'raw' ? parseTryState(lane, raw) : null
    return canonicalJson(parsed ? (parsed.ok ? parsed.value : raw) : value)
  }, [lane, mode, raw, value])
  const current = `${signature}|${sample}`
  const stale = result !== null && result.signature !== current
  const ready = mode === 'raw' ? raw.trim().length > 0 : trySampleTitle(value).length > 0

  const edit = (next: TryStates[L]) => {
    setError(null)
    setValue(next)
  }
  const toRaw = () => {
    setError(null)
    setRaw(tryStateJson(value))
    setMode('raw')
  }
  // Leaving Raw JSON needs a state the fields can draw; otherwise Raw JSON stays open with the reason.
  const toFields = () => {
    const parsed = parseTryState(lane, raw)
    if (!parsed.ok) return setError(parsed.error)
    setError(null)
    setValue(parsed.value)
    setMode('fields')
  }

  const submit = async () => {
    if (running || !ready) return
    const parsed = mode === 'raw' ? parseTryState(lane, raw) : ({ ok: true, value } as const)
    const checked = parsed.ok ? checkTryState(lane, parsed.value) : parsed
    if (!checked.ok) return setError(checked.error)
    setError(null)
    setRunning(true)
    setFailure(null)
    const ran = current
    try {
      const outcome = await run(checked.value)
      setResult({ signature: ran, sample: trySampleTitle(checked.value), value: outcome })
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

  const errorText = (e: TryParseError) =>
    e.kind === 'json'
      ? t('errors.json', { message: e.message })
      : e.kind === 'shape'
        ? t('errors.shape')
        : e.kind === 'bound'
          ? t('errors.bound', { key: e.key })
          : t('errors.schema', { path: e.path || '(root)', message: e.message })
  const shown = result ? view(result.value) : null

  return (
    <>
      {open && (
        <div className="flex flex-col gap-2" data-testid="try-panel">
          <div className="flex flex-wrap items-center gap-2">
            <span className="fldlbl m-0">{t('sample')}</span>
            <span className="flex-1" />
            <span className="pillbar" role="group" aria-label={t('editor')}>
              <button
                type="button"
                className={mode === 'fields' ? 'pill on' : 'pill'}
                aria-pressed={mode === 'fields'}
                onClick={() => mode === 'raw' && toFields()}
              >
                {t('fields')}
              </button>
              <button
                type="button"
                className={mode === 'raw' ? 'pill on' : 'pill'}
                aria-pressed={mode === 'raw'}
                onClick={() => mode === 'fields' && toRaw()}
              >
                {t('raw')}
              </button>
            </span>
          </div>
          {mode === 'fields' ? (
            <StateJson label={t('sample')}>{fields(value, edit)}</StateJson>
          ) : (
            <textarea
              value={raw}
              rows={Math.min(18, Math.max(6, raw.split('\n').length))}
              spellCheck={false}
              aria-label={t('rawLabel')}
              onChange={(event) => {
                setError(null)
                setRaw(event.target.value)
              }}
              className="inp block w-full resize-y font-mono text-[12px] font-normal leading-[1.6]"
            />
          )}
          {error && (
            <span role="alert" className="font-sans text-[12px] font-normal leading-[1.5] text-(--red-600)">
              {errorText(error)}
            </span>
          )}
          <div className="flex flex-wrap items-center gap-[9px]">
            <Button variant="secondary" size="sm" disabled={!ready || running} onClick={() => void submit()}>
              <Icon name="play" size={14} />
              {running ? tDecisions('try.running') : tDecisions('binding.try')}
            </Button>
          </div>
        </div>
      )}

      {shown?.chain && <DecisionChainResults chain={shown.chain} names={decisions} />}
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
          <span>{failure.kind === 'offline' ? offlineText : t('failed', { message: failure.message })}</span>
        </div>
      )}

      {/* Outside the editor, so collapsing it keeps the verdict on screen. */}
      {result && shown && (
        <div
          className={`overflow-hidden rounded-lg border border-(--border-subtle) bg-(--surface-card) ${stale ? 'opacity-60' : ''}`}
          data-testid="try-result"
        >
          <div className="flex items-center gap-[9px] border-b border-(--border-subtle) px-[12px] py-[10px]">
            <span className="min-w-0 flex-1 truncate font-sans text-[12.5px] font-normal leading-[1.45]">
              {result.sample}
            </span>
            <span className={`badge flex-none ${BADGE[shown.tone]}`}>{shown.badge}</span>
          </div>
          <div className="flex flex-col gap-[7px] bg-(--surface-app) px-[12px] py-[11px]">{shown.body}</div>
        </div>
      )}
      {result && stale && (
        <span
          role="status"
          className="flex items-center gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)"
        >
          <Icon name="clock" size={12} />
          {t('stale')}
        </span>
      )}
    </>
  )
}
