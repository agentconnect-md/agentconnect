'use client'

// Building blocks the gate and routing Recent evaluations drawers share (decisions.md §9.5).

import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useLocale, useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import type { DecisionEvaluationEntry } from '@agentconnect.md/protocol/decision'
import { latencyText } from '@/lib/decisions/evaluations'

export function formatEvaluationTime(at: string, locale: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return at
  return date.toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** One Recent evaluations row as every list shows it: what was judged and its answer, then when, where, and how it ended. */
export function EvaluationRow({
  title,
  expired,
  answer,
  outcome,
  badge,
  meta,
  at,
  latencyMs,
  padX = 'px-4',
  onClick,
  ...data
}: {
  title: string | null
  expired: boolean
  answer: string | null
  outcome: string
  /** The outcome as a badge, in the answer's place when the row kept no answer; a neutral badge by default. */
  badge?: ReactNode
  /** Where the evaluation ran, after its time on the second line. */
  meta: ReactNode
  at: string
  latencyMs: number | null
  padX?: string
  onClick: () => void
} & { [attribute: `data-${string}`]: string | number }) {
  const t = useTranslations('Decisions')
  const locale = useLocale()
  return (
    <button
      type="button"
      {...data}
      className={`flex w-full cursor-pointer flex-col gap-[3px] border-0 bg-transparent ${padX} py-[10px] text-left hover:bg-(--surface-hover)`}
      onClick={onClick}
    >
      {/* Each line keeps its right side whole and wraps it below when the list is too narrow. */}
      <span className="flex w-full flex-wrap items-center justify-between gap-x-4">
        <span
          className={`min-w-0 flex-[1_1_140px] truncate text-[13px] leading-normal ${
            title ? 'text-(--text-primary)' : 'text-(--text-tertiary)'
          }`}
        >
          {title ?? (expired ? t('evaluations.sheet.detailsExpired') : '—')}
        </span>
        {answer ? (
          <span className="mono flex-none text-[12.5px] text-(--text-primary)">{answer}</span>
        ) : (
          (badge ?? <span className="badge flex-none bg-(--surface-active) text-(--text-secondary)">{outcome}</span>)
        )}
      </span>
      <span className="flex w-full flex-wrap items-center justify-between gap-x-4 font-mono text-[11.5px] leading-normal text-(--text-tertiary)">
        <span className="flex min-w-0 flex-[1_1_140px] items-center gap-[6px]">
          <span className="flex-none">{formatEvaluationTime(at, locale)}</span>
          <span aria-hidden>·</span>
          {meta}
        </span>
        <span className="flex-none">
          {[answer ? outcome : null, latencyText(latencyMs)].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  )
}

/** A detail's heading: the evaluation's title, above its facts. */
export function DetailTitle({ title }: { title: string | null | undefined }) {
  if (!title) return null
  return (
    <h3 className="m-0 font-sans text-[14px] font-semibold leading-[1.45] break-words text-(--text-primary)">
      {title}
    </h3>
  )
}

/** The right-side drawer both lists open in; Escape steps back from a detail before it closes. */
export function EvaluationsDrawer({
  title,
  subtitle,
  closeLabel,
  onClose,
  onBack,
  children,
  testId
}: {
  title: string
  subtitle?: ReactNode
  closeLabel: string
  onClose: () => void
  /** Set while a detail is open, so Escape returns to the list. */
  onBack?: (() => void) | null
  children: ReactNode
  testId?: string
}) {
  const titleId = useId()
  const closeRef = useRef<HTMLButtonElement>(null)
  const latest = useRef({ onClose, onBack })
  useEffect(() => {
    latest.current = { onClose, onBack }
  }, [onClose, onBack])
  useEffect(() => {
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const { onBack: back, onClose: close } = latest.current
      if (back) back()
      else close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const drawer = (
    <div className="scrim items-stretch justify-end p-0" onClick={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid={testId}
        onClick={(event) => event.stopPropagation()}
        className="flex h-full w-full flex-col border-l border-(--border-default) bg-(--surface-card) shadow-(--shadow-xl) desktop:w-[600px]"
      >
        <div className="flex flex-none items-start gap-[10px] border-b border-(--border-subtle) py-[13px] pl-[18px] pr-[14px]">
          <div className="min-w-0 flex-1">
            <div id={titleId} className="font-sans text-[14.5px] font-semibold leading-normal">
              {title}
            </div>
            {subtitle && <div className="mono mt-[3px] truncate text-[11.5px] text-(--text-tertiary)">{subtitle}</div>}
          </div>
          <button ref={closeRef} type="button" className="iconbtn" onClick={onClose} aria-label={closeLabel}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </aside>
    </div>
  )
  return typeof document === 'undefined' ? drawer : createPortal(drawer, document.body)
}

export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-[7px]">
      <div className="flex items-baseline justify-between gap-3">
        <h3 className="m-0 font-sans text-[11px] font-semibold uppercase leading-normal tracking-[0.04em] text-(--text-tertiary)">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 font-sans text-[12px] font-normal leading-normal text-(--text-tertiary)">
      <span className="flex-none">{label}</span>
      <b className="mono min-w-0 break-words text-right font-medium text-(--text-secondary)">{value}</b>
    </div>
  )
}

/** The key facts block at the top of a detail. */
export function Facts({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-[7px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-[13px] py-[11px]">
      {children}
    </div>
  )
}

export function Message({ entry }: { entry: DecisionEvaluationEntry }) {
  return (
    <div className="flex flex-col gap-[3px] rounded-md bg-(--surface-app) px-[10px] py-[8px]">
      <span className="mono text-[11px] text-(--text-tertiary)">{entry.sender.id}</span>
      {entry.quote && (
        <span className="border-l-2 border-(--border-default) pl-2 font-sans text-[12px] font-normal leading-[1.5] text-(--text-tertiary)">
          {entry.quote.text}
        </span>
      )}
      <span className="whitespace-pre-wrap break-words font-sans text-[12.5px] font-normal leading-[1.5] text-(--text-primary)">
        {entry.text}
      </span>
    </div>
  )
}

export function Note({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div className="flex gap-2 font-sans text-[12px] font-normal leading-[1.55] text-(--text-tertiary)">
      <Icon name={icon} size={13} className="mt-[2px] flex-none" />
      <span>{children}</span>
    </div>
  )
}

export function ExpiredBanner({ title, body }: { title: string; body: string }) {
  return (
    <div
      role="status"
      className="flex items-start gap-[9px] rounded-md border border-(--border-subtle) bg-(--surface-sunken) px-[13px] py-[10px] font-sans text-[12.5px] font-normal leading-[1.55]"
    >
      <Icon name="clock" size={14} className="mt-[2px] flex-none" />
      <span className="flex flex-col gap-[2px]">
        <b className="font-semibold">{title}</b>
        <span className="text-(--text-secondary)">{body}</span>
      </span>
    </div>
  )
}

/** Opening a detail unmounts the row that had focus, so focus lands here. */
export function BackLink({ onClick }: { onClick: () => void }) {
  const t = useTranslations('Decisions.evaluations.drawer')
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <button ref={ref} type="button" className="lnk gap-[6px] self-start text-[12.5px]" onClick={onClick}>
      <Icon name="arrow-left" size={14} />
      {t('back')}
    </button>
  )
}
