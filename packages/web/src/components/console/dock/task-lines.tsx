'use client'

// The dock Tasks tab's parts: a collapsible group with a sticky header, one-line rows led by the state icon that may open their details, and the "N more" fold.

import { useState, type ReactNode } from 'react'
import { useTranslations } from 'next-intl'
import { Icon } from '@/components/ui'
import { StateIcon, type StateKind } from '@/components/console/StateIcon'

/** Rows a group shows before its fold, unless more than this many are running. */
export const FOLD_AT = 5

/** What a group shows: its open rows up to the fold (all running ones always), then everything once the fold is open. */
export function foldRows<T>(live: T[], rest: T[], running: number, open: boolean): { rows: T[]; hidden: number } {
  const all = [...live, ...rest]
  const keep = Math.min(live.length, Math.max(FOLD_AT, running))
  return { rows: open ? all : all.slice(0, keep), hidden: all.length - keep }
}

/** Newest first by the given time, with running rows ahead of the rest. */
export function runningFirst<T>(rows: T[], running: (row: T) => boolean, at: (row: T) => string): T[] {
  return [...rows].sort((a, b) => Number(running(b)) - Number(running(a)) || at(b).localeCompare(at(a)))
}

export function LineGroup({
  id,
  title,
  open,
  onToggle,
  children
}: {
  id: string
  title: string
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <section data-task-group={id} aria-label={title} className="flex flex-none flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="sticky top-[-10px] z-[2] flex cursor-pointer items-center gap-[5px] self-stretch border-0 bg-(--surface-app) px-0 pt-1 pb-[6px] text-left font-sans text-[13px] font-medium leading-[1.4] text-(--text-tertiary) hover:text-(--text-secondary)"
      >
        {title}
        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={13} />
      </button>
      {open ? children : null}
    </section>
  )
}

/** One task, follow-up, subagent or command: its state, its name, and its time at the right, which a Stop replaces on hover. */
export function LineRow({
  state,
  stateLabel,
  title,
  time,
  timeTip,
  stop,
  note,
  details,
  done = false,
  attrs
}: {
  state: StateKind
  stateLabel: string
  title: ReactNode
  time: string
  timeTip?: string
  stop?: { label: string; disabled?: boolean; onClick: () => void }
  /** A line under the row, such as what a stop did. */
  note?: ReactNode
  /** What clicking the row opens under it; a row with details carries no Stop. */
  details?: ReactNode
  /** A finished row reads quieter. */
  done?: boolean
  attrs?: Record<`data-${string}`, string | undefined>
}) {
  const [open, setOpen] = useState(false)
  const titleClass = `flex min-w-0 flex-1 items-center font-sans text-[13.5px] leading-[1.5] ${
    done ? 'font-normal text-(--text-secondary)' : 'font-medium text-(--text-primary)'
  }`
  return (
    <div
      {...attrs}
      className="group/line mx-[-8px] flex flex-none flex-col rounded-[8px] px-2 py-[6px] hover:bg-(--surface-hover)"
    >
      <div className="relative flex min-h-6 min-w-0 items-center gap-[10px]">
        <StateIcon state={state} label={stateLabel} />
        {details ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className={`${titleClass} cursor-pointer gap-[5px] border-0 bg-transparent p-0 text-left after:absolute after:-inset-x-2 after:-inset-y-[6px] after:z-10`}
          >
            {title}
            <Icon
              name={open ? 'chevron-down' : 'chevron-right'}
              size={13}
              color="var(--text-tertiary)"
              className="flex-none"
            />
          </button>
        ) : (
          <div className={titleClass}>{title}</div>
        )}
        <span className="relative flex flex-none items-center gap-[10px]">
          <span
            title={timeTip}
            className={`font-sans text-[12px] font-normal leading-normal whitespace-nowrap text-(--text-tertiary) tabular-nums ${
              stop
                ? 'pointer-fine:group-hover/line:invisible pointer-fine:group-has-[button:focus-visible]/line:invisible'
                : ''
            }`}
          >
            {time}
          </span>
          {stop ? (
            <button
              type="button"
              aria-label={stop.label}
              title={stop.label}
              disabled={stop.disabled}
              onClick={stop.onClick}
              // Over the time and shown on hover or focus for a mouse; always shown, beside it, on a touch screen.
              className="relative z-20 my-[-1px] inline-flex h-[26px] w-[26px] cursor-pointer items-center justify-center rounded-[7px] border-0 bg-(--surface-active) p-0 text-(--text-secondary) hover:bg-(--border-default) hover:text-(--text-primary) pointer-fine:focus-visible:opacity-100 disabled:cursor-not-allowed pointer-fine:absolute pointer-fine:right-0 pointer-fine:opacity-0 pointer-fine:group-hover/line:opacity-100"
            >
              <Icon name="square" size={12} />
            </button>
          ) : null}
        </span>
      </div>
      {note ? <div className="mt-[3px] ml-6">{note}</div> : null}
      {details && open ? <div className="mt-[6px] mb-[2px] ml-6 flex min-w-0 flex-col gap-[6px]">{details}</div> : null}
    </div>
  )
}

/** "N more" under a group's folded rows, "Show less" once they are open. */
export function FoldToggle({ hidden, open, onToggle }: { hidden: number; open: boolean; onToggle: () => void }) {
  const t = useTranslations('Common.taskList')
  return (
    <button
      type="button"
      aria-expanded={open}
      data-fold-toggle=""
      onClick={onToggle}
      className="flex w-full cursor-pointer items-center gap-[5px] border-0 bg-transparent pt-[5px] pb-[2px] pl-6 text-left font-sans text-[12px] font-medium leading-[1.4] text-(--text-tertiary) hover:text-(--text-secondary)"
    >
      {open ? t('showLess') : t('moreCount', { count: hidden })}
      <Icon name={open ? 'chevron-up' : 'chevron-down'} size={12} />
    </button>
  )
}
