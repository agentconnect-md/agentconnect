'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { usePendingAction } from '@/components/console/PendingActions'
import { type ElicitAnswerValue, type ElicitFieldSpec } from '@/lib/data'
import { Icon } from '@/components/ui'
import { foldCustomAnswers, planLabel, typedInvalidReason } from '@/components/console/session-work'
import type { FmtStep } from '@/components/console/transcript-steps'

// How a plan entry reads: ACP's three statuses, an unknown one treated as not yet started.
const PLAN_PENDING = { icon: 'circle', color: 'var(--text-disabled)', text: 'text-(--text-secondary)' }
const PLAN_MARK: Record<string, typeof PLAN_PENDING> = {
  completed: { icon: 'circle-check', color: 'var(--green-500)', text: 'text-(--text-tertiary)' },
  in_progress: { icon: 'circle-dot', color: 'var(--blue-500)', text: 'text-(--text-primary) font-medium' },
  pending: PLAN_PENDING
}

/** The turn's task list as its own block above the answer, never folded into work; a row without its body shows its summary. */
export function PlanBlock({ step }: { step: FmtStep }) {
  const entries = step.plan ?? []
  if (entries.length === 0) {
    // No entries survived: show the row's label, if any (a live block always has entries).
    return step.text ? (
      <span className="font-sans text-[12.5px] font-normal leading-normal text-(--text-tertiary)">{step.text}</span>
    ) : null
  }
  return (
    <div className="overflow-hidden rounded-md border border-(--border-subtle) bg-(--surface-app)">
      <div className="flex items-center gap-[6px] px-[14px] py-2 font-sans text-[12.5px] font-medium leading-normal text-(--text-secondary)">
        <Icon name="list-checks" size={13} color="var(--text-tertiary)" />
        {planLabel(entries)}
      </div>
      <div className="flex flex-col gap-[7px] border-t border-(--border-subtle) px-[14px] py-[10px]">
        {entries.map((entry, ei) => {
          const mark = PLAN_MARK[entry.status] ?? PLAN_PENDING
          return (
            <div key={ei} className="flex min-w-0 items-start gap-[8px]">
              <span className="mt-[2px] flex-none">
                <Icon name={mark.icon} size={13} color={mark.color} />
              </span>
              <span className={`min-w-0 font-sans text-[13px] leading-[1.5] ${mark.text}`}>{entry.content}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// How a settled elicitation card reads once its buttons are gone, and the accent edge it wears.
const ELICIT_OUTCOME: Record<
  string,
  { icon: string; color: string; edge: string; label: (answer?: string) => string }
> = {
  accepted: {
    icon: 'check',
    color: 'var(--green-500)',
    edge: 'border-l-(--green-500)',
    label: (answer) => answer ?? 'Answered'
  },
  dismissed: { icon: 'x', color: 'var(--text-tertiary)', edge: 'border-l-(--border-strong)', label: () => 'Dismissed' },
  cancelled: {
    icon: 'clock',
    color: 'var(--text-tertiary)',
    edge: 'border-l-(--border-strong)',
    label: () => 'Cancelled'
  },
  // URL mode's second settlement: the agent reported the flow behind an opened link finished.
  completed: { icon: 'check', color: 'var(--green-500)', edge: 'border-l-(--green-500)', label: () => 'Completed' },
  // Persisted cards only: the ask no surface here had a control for, so nothing was ever offered.
  unrenderable: {
    icon: 'x',
    color: 'var(--text-tertiary)',
    edge: 'border-l-(--border-strong)',
    label: () => "Couldn't be answered here"
  }
}

/** A consent URL's display parts with host warnings (advisory); null ⇒ not something to open in a tab. Pure. */
function readConsentUrl(url: string): { scheme: string; host: string; rest: string; warnings: string[] } | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  // Split the ORIGINAL string by position: the parser rewrites the host, so a search for it would find nothing.
  const afterScheme = url.indexOf('//') + 2
  const authorityEnd = url.slice(afterScheme).search(/[/?#]/)
  const hostEnd = authorityEnd < 0 ? url.length : afterScheme + authorityEnd
  const warnings: string[] = []
  if (parsed.protocol !== 'https:')
    warnings.push('Not encrypted (http) — anything you type on that page can be read in transit.')
  // Check the original spelling too: the parser punycodes a Unicode host, and the reader sees the original.
  const shownHost = url.slice(afterScheme, hostEnd)
  // Userinfo makes the shown authority attacker-chosen (`login.example.com@evil.test`), so name the real host.
  if (shownHost.includes('@'))
    warnings.push(`This link goes to ${parsed.hostname} — the text before the @ is not the destination.`)
  if (/(^|\.)xn--/i.test(parsed.hostname) || /[^\x00-\x7F]/.test(shownHost))
    warnings.push(
      `This host is not plain ASCII (it resolves to ${parsed.hostname}), which can disguise a lookalike domain.`
    )
  return {
    scheme: url.slice(0, afterScheme),
    host: url.slice(afterScheme, hostEnd),
    rest: url.slice(hostEnd),
    warnings
  }
}

/** What a multi-select card asks of the reader, from the schema's bounds. */
function selectionHint(min: number, max?: number): string {
  if (min > 0 && max !== undefined) return min === max ? `Select exactly ${min}` : `Select ${min}–${max}`
  if (min > 0) return `Select at least ${min}`
  return max !== undefined ? `Select up to ${max}` : 'Select any that apply'
}

/** What a typed card's control starts out holding: the schema's `default`, or nothing. */
function typedDraft(elicit: Pick<ElicitFieldSpec, 'defaultValue'> | undefined): string {
  const value = elicit?.defaultValue
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

/** The options a card starts out holding: a multi-select's default list, or the single default pick. */
function pickedDefaults(elicit: Pick<ElicitFieldSpec, 'defaultValue'> | undefined): string[] {
  const value = elicit?.defaultValue
  if (Array.isArray(value)) return value
  return typeof value === 'string' || typeof value === 'boolean' ? [String(value)] : []
}

/** What each field of a form card starts out holding — its own schema default, per kind. */
function formDrafts(fields: ElicitFieldSpec[] | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of fields ?? []) if (f.kind === 'text' || f.kind === 'number') out[f.propName] = typedDraft(f)
  return out
}

/** Which questions open with their "Other" box showing: only those the schema gave a default. */
function formOthers(fields: ElicitFieldSpec[] | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const f of fields ?? []) if (f.customAnswerFor && typedDraft(f).trim()) out[f.customAnswerFor] = true
  return out
}

function formPicks(fields: ElicitFieldSpec[] | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const f of fields ?? []) if (f.kind !== 'text' && f.kind !== 'number') out[f.propName] = pickedDefaults(f)
  return out
}

/** Why a form field is not yet answerable (the daemon's per-kind rules); an optional untouched field is fine. */
function fieldInvalidReason(
  f: ElicitFieldSpec,
  drafts: Record<string, string>,
  picks: Record<string, string[]>
): string | undefined {
  if (f.kind === 'text' || f.kind === 'number') {
    const draft = drafts[f.propName] ?? ''
    if (!draft.trim() && !f.required) return undefined
    return typedInvalidReason(f, draft)
  }
  const picked = picks[f.propName] ?? []
  if (f.kind === 'multi-enum') {
    const min = f.multi?.minItems ?? 0
    const max = f.multi?.maxItems
    if (!picked.length && !f.required) return undefined
    return picked.length < min || (max !== undefined && picked.length > max) ? selectionHint(min, max) : undefined
  }
  return picked.length === 1 || (!picked.length && !f.required) ? undefined : 'Choose one'
}

/** A form card's answer: each answered field in its schema type; an untouched optional field is left out. */
function formAnswer(
  fields: ElicitFieldSpec[],
  drafts: Record<string, string>,
  picks: Record<string, string[]>
): Record<string, string | number | string[]> {
  const out: Record<string, string | number | string[]> = {}
  for (const f of fields) {
    if (f.kind === 'text' || f.kind === 'number') {
      const draft = drafts[f.propName] ?? ''
      if (draft.trim()) out[f.propName] = f.kind === 'number' ? Number(draft) : draft
      continue
    }
    const picked = picks[f.propName] ?? []
    // A required multi-select carries even the empty set: "none of them" is its answer.
    if (f.kind === 'multi-enum') {
      if (f.required || picked.length) out[f.propName] = picked
    } else if (picked.length === 1) out[f.propName] = picked[0]!
  }
  return out
}

/** Whether a form field currently holds an answer — what the card's progress counter counts. */
function fieldAnswered(f: ElicitFieldSpec, drafts: Record<string, string>, picks: Record<string, string[]>): boolean {
  if (f.kind === 'text' || f.kind === 'number') return !!(drafts[f.propName] ?? '').trim()
  return (picks[f.propName] ?? []).length > 0
}

/** The free-text box a question carries instead of an option, if the form gave it one. */
function companionOf(fields: ElicitFieldSpec[], f: ElicitFieldSpec): ElicitFieldSpec | undefined {
  return fields.find((c) => c.customAnswerFor === f.propName)
}

/** Whether a question's typed box answers it alone: not when the schema requires the question's own property. */
function customAnswerStandsAlone(
  f: ElicitFieldSpec,
  companion: ElicitFieldSpec | undefined,
  drafts: Record<string, string>
): boolean {
  return !!companion && !f.required && !!(drafts[companion.propName] ?? '').trim()
}

/** Whether a question is answered, by its control or a box that answers for it, as the counter and Submit agree. */
function rowAnswered(
  f: ElicitFieldSpec,
  companion: ElicitFieldSpec | undefined,
  drafts: Record<string, string>,
  picks: Record<string, string[]>
): boolean {
  return fieldAnswered(f, drafts, picks) || customAnswerStandsAlone(f, companion, drafts)
}

/** Why a question is not yet answerable: its typed box is always checked, its own control only where it stands alone. */
function rowInvalidReason(
  f: ElicitFieldSpec,
  companion: ElicitFieldSpec | undefined,
  drafts: Record<string, string>,
  picks: Record<string, string[]>
): string | undefined {
  const draft = companion ? (drafts[companion.propName] ?? '') : ''
  if (companion && draft.trim()) {
    const typed = typedInvalidReason(companion, draft)
    if (typed || customAnswerStandsAlone(f, companion, drafts)) return typed
  }
  return fieldInvalidReason(f, drafts, picks)
}

// One elicitation control, styled alike wherever a card places it.
const ELICIT_CHIP = 'chip max-w-full truncate rounded-sm disabled:cursor-default disabled:opacity-55'
const ELICIT_CHIP_ON =
  'chip max-w-full truncate rounded-sm border-(--brand) bg-(--brand) text-white disabled:cursor-default disabled:opacity-55'
// "Other" is an option the agent did not offer, so it wears the soft accent.
const ELICIT_CHIP_SOFT = 'chip max-w-full truncate rounded-sm text-(--text-tertiary) disabled:opacity-55'
const ELICIT_CHIP_SOFT_ON =
  'chip max-w-full truncate rounded-sm border-(--brand-soft-border) bg-(--brand-soft) text-(--brand-soft-text) disabled:opacity-55'
const ELICIT_ROW_BASE =
  'flex w-full min-w-0 cursor-pointer items-start gap-[9px] rounded-sm border px-[11px] py-[8px] text-left font-sans text-[13px] font-medium leading-[1.45] disabled:cursor-default disabled:opacity-55'
const ELICIT_ROW = `${ELICIT_ROW_BASE} border-(--border-default) bg-(--surface-card) text-(--text-secondary) hover:border-(--border-strong) hover:bg-(--surface-hover)`
const ELICIT_ROW_ON = `${ELICIT_ROW_BASE} border-(--border-strong) bg-(--surface-hover) text-(--text-primary)`
const ELICIT_ROW_SOFT = `${ELICIT_ROW_BASE} border-(--border-default) bg-(--surface-card) text-(--text-tertiary) hover:border-(--border-strong) hover:bg-(--surface-hover)`
const ELICIT_ROW_SOFT_ON = `${ELICIT_ROW_BASE} border-(--border-strong) bg-(--surface-hover) text-(--text-primary)`
const ELICIT_INPUT = 'inp w-full min-w-0 bg-(--surface-app) disabled:cursor-default disabled:opacity-55'
// A sentence-long option turns the whole question into a list of rows, so the options stay alike.
const LONG_OPTION = 22
const asList = (options: { label: string }[]) => options.some((o) => o.label.length > LONG_OPTION)

/** One offered option, a chip or a full-width row; `staged` marks a pick held until Submit. */
function ElicitOption({
  label,
  on,
  list,
  soft,
  mono,
  staged,
  multi,
  disabled,
  onPick
}: {
  label: string
  on: boolean
  list: boolean
  soft?: boolean
  mono?: boolean
  staged?: boolean
  multi?: boolean
  disabled: boolean
  onPick: () => void
}) {
  const cls = list
    ? soft
      ? on
        ? ELICIT_ROW_SOFT_ON
        : ELICIT_ROW_SOFT
      : on
        ? ELICIT_ROW_ON
        : ELICIT_ROW
    : soft
      ? on
        ? ELICIT_CHIP_SOFT_ON
        : ELICIT_CHIP_SOFT
      : on
        ? ELICIT_CHIP_ON
        : ELICIT_CHIP
  return (
    <button
      type="button"
      {...(staged || multi ? { 'aria-pressed': on } : {})}
      className={cls + (mono ? ' font-mono' : '')}
      disabled={disabled}
      title={label}
      onClick={onPick}
    >
      {list && staged ? (
        <span
          className={`mt-[2px] grid size-[14px] flex-none place-items-center border ${multi ? 'rounded-[4px]' : 'rounded-full'} ${on ? 'border-(--brand) bg-(--brand)' : 'border-(--border-strong) bg-(--surface-card)'}`}
        >
          {on ? <span className={`size-[6px] bg-white ${multi ? 'rounded-[1px]' : 'rounded-full'}`} /> : null}
        </span>
      ) : null}
      <span className="min-w-0">{label}</span>
    </button>
  )
}
const ELICIT_HINT = 'font-sans text-[11.5px] font-normal leading-normal text-(--text-tertiary)'
const ELICIT_ACTIONS = 'flex flex-wrap items-center gap-[8px] border-t border-(--border-subtle) pt-[11px]'

/** Answers in progress by request, so a card that remounts (a dock view switch, leaving the page) keeps what was typed and picked until it settles. */
const keptAnswers = new Map<string, Record<string, unknown>>()

/** Forgets every kept answer, for tests that reuse a request id. */
export function forgetKeptAnswers(): void {
  keptAnswers.clear()
}

/** One part of a card's answer in progress, kept by request across remounts. */
function useKeptAnswer<T>(
  requestId: string | undefined,
  part: string,
  initial: () => T
): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    const kept = requestId ? keptAnswers.get(requestId) : undefined
    return kept && part in kept ? (kept[part] as T) : initial()
  })
  const set = (next: T | ((prev: T) => T)) =>
    setValue((prev) => {
      const value = typeof next === 'function' ? (next as (prev: T) => T)(prev) : next
      if (requestId) keptAnswers.set(requestId, { ...keptAnswers.get(requestId), [part]: value })
      return value
    })
  return [value, set]
}

/** The agent's in-band question (choice, multi-select, typed field or form), live or settled; inert without `onAnswer`. */
export function ElicitationCard({ step, onAnswer }: { step: FmtStep; onAnswer?: (value: ElicitAnswerValue) => void }) {
  const t = useTranslations('Sessions.detail')
  // A custom-answer box the daemon could not bind is folded into its question here, off the pair's names.
  const fields = step.elicit?.fields?.length ? foldCustomAnswers(step.elicit.fields) : undefined
  const requestId = step.elicit?.requestId
  const [picked, setPicked] = useKeptAnswer<string[]>(requestId, 'picked', () => pickedDefaults(step.elicit))
  const [draft, setDraft] = useKeptAnswer<string>(requestId, 'draft', () => typedDraft(step.elicit))
  const [drafts, setDrafts] = useKeptAnswer<Record<string, string>>(requestId, 'drafts', () => formDrafts(fields))
  const [picks, setPicks] = useKeptAnswer<Record<string, string[]>>(requestId, 'picks', () => formPicks(fields))
  const [others, setOthers] = useKeptAnswer<Record<string, boolean>>(requestId, 'others', () => formOthers(fields))
  // A settled question has nothing left to keep.
  const settledOutcome = step.elicit?.outcome
  useEffect(() => {
    if (requestId && settledOutcome) keptAnswers.delete(requestId)
  }, [requestId, settledOutcome])
  // Minimizing is a UI fold, never an answer: the ask stays live and open, just out of the way.
  const [minimized, setMinimized] = useState(false)
  // An unanswered question raises the pending banner, only where this reader can answer it.
  const holdRef = usePendingAction(
    `elicit:${step.elicit?.requestId ?? ''}`,
    (step.text.split('\n', 1)[0] ?? step.text).slice(0, 80) || 'A question',
    !!step.elicit && !step.elicit.outcome && !!onAnswer
  )
  const elicit = step.elicit
  const multi = elicit?.multi
  const consentUrl = elicit?.url
  const consent = consentUrl ? readConsentUrl(consentUrl) : null
  // The card's questions: a select's free-text companion belongs to it, never numbered or counted alone.
  const rows = fields?.filter((f) => !f.customAnswerFor)
  const typed = !fields && elicit && (elicit.text || elicit.number) ? elicit : undefined
  // A question's box opens from its own chip; closing it drops the hidden draft.
  const toggleOther = (f: ElicitFieldSpec, companion: ElicitFieldSpec) => {
    const on = !others[f.propName]
    setOthers((prev) => ({ ...prev, [f.propName]: on }))
    if (!on) setDrafts((prev) => ({ ...prev, [companion.propName]: '' }))
  }
  const min = multi?.minItems ?? 0
  const max = multi?.maxItems
  // The same bounds the daemon re-checks: a browser frame is not what makes an answer valid.
  const complete = picked.length >= min && (max === undefined || picked.length <= max)
  const invalid = typed ? typedInvalidReason(typed, draft) : undefined
  if (!elicit) return null
  const settled = elicit.outcome ? ELICIT_OUTCOME[elicit.outcome] : undefined
  // The head reads the card's phase: accent edge, icon, and for a long form how much is still open.
  const edge = settled ? settled.edge : 'border-l-(--brand)'
  const headIcon = settled ? settled.icon : consent ? 'external-link' : 'message-square-dot'
  const headColor = settled ? settled.color : 'var(--brand)'
  // The head names the ask in one line; the rest of the agent's text reads as a preamble.
  const headLine = step.text.split('\n', 1)[0] ?? step.text
  const preamble = step.text.slice(headLine.length).trim()
  // A body that is nothing but answers reads a Dismiss beside them as one more answer, so an options card refuses from its head; other shapes have an action row where a refusal beside Submit reads right.
  const cornerDismiss = !settled && !fields && !typed && !consentUrl
  const canMinimize = !settled
  const counter =
    rows && !settled
      ? `${rows.filter((f) => rowAnswered(f, companionOf(fields!, f), drafts, picks)).length}/${rows.length} answered`
      : undefined
  return (
    <div
      ref={holdRef}
      className={`overflow-hidden rounded-md border border-l-2 border-(--border-subtle) bg-(--surface-card) shadow-(--shadow-xs) ${edge}`}
    >
      <div className="flex min-w-0 items-start gap-[9px] px-[14px] py-[11px]">
        <span className="mt-[2px] flex-none">
          <Icon name={headIcon} size={14} color={headColor} />
        </span>
        <span className="min-w-0 whitespace-pre-wrap font-sans text-[13.5px] font-medium leading-[1.5] text-(--text-primary)">
          {headLine}
        </span>
        {counter && (
          <span className="mt-[3px] flex-none font-mono text-[11.5px] font-normal leading-normal text-(--text-tertiary)">
            {counter}
          </span>
        )}
        {step.time && (
          <span className="mt-[3px] ml-auto flex-none font-mono text-[11.5px] font-normal leading-normal text-(--text-disabled)">
            {step.time}
          </span>
        )}
        {(canMinimize || cornerDismiss) && (
          <span className={`-my-[2px] -mr-[4px] flex flex-none items-center gap-[2px] ${step.time ? '' : 'ml-auto'}`}>
            {canMinimize && (
              <button
                type="button"
                className="iconbtn h-[22px] w-[22px]"
                aria-expanded={!minimized}
                aria-label={minimized ? t('expandQuestion') : t('minimizeQuestion')}
                title={minimized ? t('expandQuestion') : t('minimizeQuestion')}
                onClick={() => setMinimized((v) => !v)}
              >
                <Icon name={minimized ? 'chevron-right' : 'chevron-down'} size={12} color="var(--text-tertiary)" />
              </button>
            )}
            {cornerDismiss && (
              <button
                type="button"
                className="iconbtn h-[22px] w-[22px]"
                disabled={!onAnswer}
                aria-label={t('declineWithoutAnswer')}
                title={t('declineWithoutAnswer')}
                onClick={() => onAnswer?.(null)}
              >
                <Icon name="x" size={12} color="var(--text-tertiary)" />
              </button>
            )}
          </span>
        )}
      </div>
      {/* Minimized folds the card to its head line alone — the ask is untouched, only hidden. */}
      {/* A card that settles while folded unfolds itself: the outcome is the one row left to read. */}
      {(!minimized || settled) && (
        <div className="min-w-0 border-t border-(--border-subtle) px-[14px] py-[11px]">
          {preamble && !settled ? (
            <span className="mb-[11px] block min-w-0 whitespace-pre-wrap font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-secondary)">
              {preamble}
            </span>
          ) : null}
          {settled ? (
            <span className="inline-flex min-w-0 items-center gap-[7px] font-sans text-[12.5px] font-normal leading-normal text-(--text-secondary)">
              <Icon name={settled.icon} size={13} color={settled.color} />
              <span className="min-w-0 truncate">{settled.label(elicit.answerLabel)}</span>
            </span>
          ) : consent && consentUrl ? (
            // URL mode: the URL is shown and never fetched; the reader's click on a plain new-tab link is the consent.
            <div className="flex w-full min-w-0 flex-col gap-[11px]">
              <div className="min-w-0 rounded-sm border border-(--border-subtle) bg-(--surface-app) px-[11px] py-[9px] font-mono text-[12.5px] leading-[1.5] break-all">
                <span className="text-(--text-tertiary)">{consent.scheme}</span>
                <span className="font-medium text-(--text-primary)">{consent.host}</span>
                <span className="text-(--text-tertiary)">{consent.rest}</span>
              </div>
              {consent.warnings.map((w) => (
                <span
                  key={w}
                  className="inline-flex min-w-0 items-start gap-[6px] rounded-sm border border-(--border-subtle) bg-(--amber-50) px-[10px] py-[7px] font-sans text-[12px] font-normal leading-[1.45] text-(--text-primary)"
                >
                  <span className="mt-[2px] flex-none">
                    <Icon name="triangle-alert" size={13} color="var(--amber-500)" />
                  </span>
                  <span className="min-w-0">{w}</span>
                </span>
              ))}
              <div className={ELICIT_ACTIONS}>
                {onAnswer ? (
                  <a
                    className="dsbtn dsbtn-primary xs no-underline"
                    href={consentUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => onAnswer(consentUrl)}
                  >
                    {t('openLink')}
                  </a>
                ) : (
                  <span className="dsbtn dsbtn-primary xs cursor-default opacity-55">{t('openLink')}</span>
                )}
                <button
                  type="button"
                  className={ELICIT_CHIP}
                  disabled={!onAnswer}
                  onClick={() => onAnswer?.(null)}
                  title={t('refuseWithoutOpening')}
                >
                  {t('decline')}
                </button>
                <span className={`ml-auto ${ELICIT_HINT}`}>{t('opensNewTab')}</span>
              </div>
            </div>
          ) : fields && rows ? (
            <div className="flex w-full min-w-0 flex-col">
              {rows.map((f, fi) => {
                const companion = companionOf(fields, f)
                const reason = rowInvalidReason(f, companion, drafts, picks)
                const hint =
                  f.kind === 'multi-enum' ? selectionHint(f.multi?.minItems ?? 0, f.multi?.maxItems) : undefined
                const list = asList(f.options)
                return (
                  <div
                    key={f.propName}
                    className={
                      fi > 0
                        ? 'grid min-w-0 grid-cols-[22px_minmax(0,1fr)] gap-x-[10px] gap-y-[7px] border-t border-(--border-subtle) py-[11px]'
                        : 'grid min-w-0 grid-cols-[22px_minmax(0,1fr)] gap-x-[10px] gap-y-[7px] pb-[11px]'
                    }
                  >
                    <span className="mt-[1px] font-mono text-[11.5px] font-normal leading-normal text-(--text-disabled)">
                      {String(fi + 1).padStart(2, '0')}
                    </span>
                    <div className="flex min-w-0 flex-col gap-[7px]">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-[8px] gap-y-[2px]">
                        <span className="min-w-0 font-sans text-[13px] font-semibold leading-normal text-(--text-primary)">
                          {f.label}
                        </span>
                        {f.description ? (
                          <span className="min-w-0 font-sans text-[12px] font-normal leading-normal text-(--text-secondary)">
                            {f.description}
                          </span>
                        ) : null}
                        <span
                          className={
                            f.required
                              ? 'ml-auto flex-none font-sans text-[11.5px] font-normal leading-normal text-(--brand-soft-text)'
                              : 'ml-auto flex-none font-sans text-[11.5px] font-normal leading-normal text-(--text-disabled)'
                          }
                        >
                          {f.required ? 'required' : 'optional'}
                        </span>
                      </div>
                      {f.kind === 'text' || f.kind === 'number' ? (
                        <input
                          className={`${ELICIT_INPUT} desktop:max-w-[320px]`}
                          type={f.kind === 'number' ? 'number' : 'text'}
                          value={drafts[f.propName] ?? ''}
                          disabled={!onAnswer}
                          aria-label={f.label}
                          {...(f.number?.minimum !== undefined ? { min: f.number.minimum } : {})}
                          {...(f.number?.maximum !== undefined ? { max: f.number.maximum } : {})}
                          {...(f.number?.integer ? { step: 1 } : {})}
                          {...(f.text?.maxLength !== undefined ? { maxLength: f.text.maxLength } : {})}
                          onChange={(e) => setDrafts((prev) => ({ ...prev, [f.propName]: e.target.value }))}
                        />
                      ) : (
                        <div
                          className={
                            list
                              ? 'flex min-w-0 flex-col gap-[6px] desktop:max-w-[520px]'
                              : 'flex min-w-0 flex-wrap items-center gap-[6px]'
                          }
                        >
                          {f.options.map((option) => {
                            const held = picks[f.propName] ?? []
                            const on = held.includes(option.value)
                            // At the cap, an unpicked option stops taking a tap.
                            const cap = f.kind === 'multi-enum' ? f.multi?.maxItems : undefined
                            const capped = !on && cap !== undefined && held.length >= cap
                            return (
                              <ElicitOption
                                key={option.value}
                                label={option.label}
                                on={on}
                                list={list}
                                mono={option.label === option.value}
                                staged
                                multi={f.kind === 'multi-enum'}
                                disabled={!onAnswer || capped}
                                onPick={() =>
                                  setPicks((prev) => {
                                    const was = prev[f.propName] ?? []
                                    if (was.includes(option.value))
                                      return { ...prev, [f.propName]: was.filter((v) => v !== option.value) }
                                    // A single-pick field replaces its choice; a multi-select adds to the set.
                                    return {
                                      ...prev,
                                      [f.propName]: f.kind === 'multi-enum' ? [...was, option.value] : [option.value]
                                    }
                                  })
                                }
                              />
                            )
                          })}
                          {companion ? (
                            <ElicitOption
                              label={t('other')}
                              on={!!others[f.propName]}
                              list={list}
                              soft
                              staged={list}
                              disabled={!onAnswer}
                              onPick={() => toggleOther(f, companion)}
                            />
                          ) : null}
                        </div>
                      )}
                      {companion && (f.kind === 'text' || f.kind === 'number' || others[f.propName]) ? (
                        <input
                          className={`${ELICIT_INPUT} ${list ? 'desktop:max-w-[340px]' : 'font-mono desktop:max-w-[260px]'}`}
                          type="text"
                          autoFocus={!!others[f.propName]}
                          value={drafts[companion.propName] ?? ''}
                          disabled={!onAnswer}
                          aria-label={`${f.label} — ${companion.label}`}
                          placeholder={companion.label}
                          {...(companion.text?.maxLength !== undefined ? { maxLength: companion.text.maxLength } : {})}
                          onChange={(e) => setDrafts((prev) => ({ ...prev, [companion.propName]: e.target.value }))}
                        />
                      ) : null}
                      {reason ? (
                        <span className="inline-flex min-w-0 items-start gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--brand-soft-text)">
                          <span className="mt-[2px] flex-none">
                            <Icon name="triangle-alert" size={12} color="var(--brand)" />
                          </span>
                          <span className="min-w-0">{reason}</span>
                        </span>
                      ) : hint ? (
                        <span className={ELICIT_HINT}>{hint}</span>
                      ) : null}
                    </div>
                  </div>
                )
              })}
              <div className={ELICIT_ACTIONS}>
                <button
                  type="button"
                  className="dsbtn dsbtn-primary xs"
                  disabled={!onAnswer || rows.some((f) => !!rowInvalidReason(f, companionOf(fields, f), drafts, picks))}
                  onClick={() => onAnswer?.(formAnswer(fields, drafts, picks))}
                >
                  {t('submitAnswers')}
                </button>
                <button
                  type="button"
                  className={ELICIT_CHIP}
                  disabled={!onAnswer}
                  onClick={() => onAnswer?.(null)}
                  title={t('dismissWithoutAnswer')}
                >
                  {t('dismiss')}
                </button>
                <span className={`ml-auto ${ELICIT_HINT}`}>{t('optionalAnswers')}</span>
              </div>
            </div>
          ) : typed ? (
            <div className="flex w-full min-w-0 flex-col gap-[9px]">
              <input
                className={`${ELICIT_INPUT} desktop:max-w-[380px]`}
                type={elicit.number ? 'number' : 'text'}
                value={draft}
                disabled={!onAnswer}
                aria-label={t('yourAnswer')}
                {...(elicit.number?.minimum !== undefined ? { min: elicit.number.minimum } : {})}
                {...(elicit.number?.maximum !== undefined ? { max: elicit.number.maximum } : {})}
                {...(elicit.number?.integer ? { step: 1 } : {})}
                {...(elicit.text?.maxLength !== undefined ? { maxLength: elicit.text.maxLength } : {})}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && onAnswer && !invalid) onAnswer(elicit.number ? Number(draft) : draft)
                }}
              />
              {invalid && (
                <span className="inline-flex min-w-0 items-start gap-[6px] font-sans text-[11.5px] font-normal leading-normal text-(--brand-soft-text)">
                  <span className="mt-[2px] flex-none">
                    <Icon name="triangle-alert" size={12} color="var(--brand)" />
                  </span>
                  <span className="min-w-0">{invalid}</span>
                </span>
              )}
              <div className={ELICIT_ACTIONS}>
                <button
                  type="button"
                  className="dsbtn dsbtn-primary xs"
                  disabled={!onAnswer || !!invalid}
                  onClick={() => onAnswer?.(elicit.number ? Number(draft) : draft)}
                >
                  {t('submit')}
                </button>
                <button
                  type="button"
                  className={ELICIT_CHIP}
                  disabled={!onAnswer}
                  onClick={() => onAnswer?.(null)}
                  title={t('dismissWithoutAnswer')}
                >
                  {t('dismiss')}
                </button>
                <span className={`ml-auto ${ELICIT_HINT}`}>{t('enterSubmits')}</span>
              </div>
            </div>
          ) : (
            <div className="flex w-full min-w-0 flex-col gap-[10px]">
              <div
                className={
                  asList(elicit.options)
                    ? 'flex min-w-0 flex-col gap-[6px] desktop:max-w-[520px]'
                    : 'flex min-w-0 flex-wrap items-center gap-[6px]'
                }
              >
                {elicit.options.map((option) => {
                  const on = picked.includes(option.value)
                  // At the cap, the options still unpicked stop taking a tap.
                  const capped = !!multi && !on && max !== undefined && picked.length >= max
                  return (
                    <ElicitOption
                      key={option.value}
                      label={option.label}
                      on={on}
                      list={asList(elicit.options)}
                      mono={option.label === option.value}
                      // A single-choice card answers on the tap, so only a multi-select shows a held indicator.
                      {...(multi ? { staged: true, multi: true } : {})}
                      disabled={!onAnswer || capped}
                      onPick={() =>
                        multi
                          ? setPicked((prev) => (on ? prev.filter((v) => v !== option.value) : [...prev, option.value]))
                          : onAnswer?.(option.value)
                      }
                    />
                  )
                })}
              </div>
              {multi && <span className={ELICIT_HINT}>{selectionHint(min, max)}</span>}
              {/* Only a multi-select has anything to submit — a single-choice card answers on the tap. */}
              {multi && (
                <div className={ELICIT_ACTIONS}>
                  <button
                    type="button"
                    className="dsbtn dsbtn-primary xs"
                    disabled={!onAnswer || !complete}
                    onClick={() => onAnswer?.(picked)}
                  >
                    {t('confirm')}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
