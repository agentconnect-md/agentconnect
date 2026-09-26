'use client'

import { Fragment, useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { placeAnchoredFlyout, type AnchoredFlyoutStyle } from './AnchoredFlyout'

const DWELL_MS = 250
// An interactive card waits this long after the pointer leaves, so it can cross the gap onto the card.
const GRACE_MS = 150

// Details for a trigger whose label can truncate: spread `triggerProps`, `hide()` on open, render `card(content)`.
export function useHoverCard({
  width = 250,
  estimatedHeight = 170,
  interactive = false
}: { width?: number; estimatedHeight?: number; interactive?: boolean } = {}) {
  const id = useId()
  const [style, setStyle] = useState<AnchoredFlyoutStyle | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hide = useCallback(() => {
    clearTimeout(timer.current)
    setStyle(null)
  }, [])
  const show = (anchor: HTMLElement) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(
      () =>
        setStyle(
          placeAnchoredFlyout(
            anchor.getBoundingClientRect(),
            { width: window.innerWidth, height: window.innerHeight },
            { width, estimatedHeight, align: 'start', gap: 6, margin: 8 }
          )
        ),
      DWELL_MS
    )
  }
  const leave = () => {
    if (!interactive) return hide()
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setStyle(null), GRACE_MS)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useEffect(() => {
    if (!style) return
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [style, hide])
  return {
    hide,
    triggerProps: {
      onMouseEnter: (event: { currentTarget: HTMLElement }) => show(event.currentTarget),
      onMouseLeave: leave,
      'aria-describedby': style ? id : undefined
    },
    card: (content: ReactNode) =>
      style &&
      createPortal(
        <span
          id={id}
          role="tooltip"
          style={style}
          {...(interactive ? { onMouseEnter: () => clearTimeout(timer.current), onMouseLeave: leave } : {})}
          className={`${interactive ? '' : 'pointer-events-none '}fixed z-[1100] block overflow-hidden rounded-md border border-(--border-default) bg-(--surface-card) px-[11px] py-[9px] text-left shadow-(--shadow-lg)`}
        >
          {content}
        </span>,
        document.body
      )
  }
}

/** The card's label/value grid; values are monospace and truncate to one line. */
export function HoverCardRows({ rows }: { rows: readonly (readonly [string, ReactNode])[] }) {
  return (
    <span className="grid grid-cols-[72px_minmax(0,1fr)] gap-x-2 gap-y-[5px] font-sans text-[11.5px] leading-normal">
      {rows.map(([label, value]) => (
        <Fragment key={label}>
          <span className="text-(--text-tertiary)">{label}</span>
          <span className="truncate font-mono text-(--text-primary)">{value || '—'}</span>
        </Fragment>
      ))}
    </span>
  )
}
