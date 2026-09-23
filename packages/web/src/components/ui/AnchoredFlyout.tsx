'use client'

import { useCallback, useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

export type AnchoredFlyoutStyle = Pick<CSSProperties, 'top' | 'bottom' | 'left' | 'width' | 'maxHeight'>

export interface AnchoredFlyoutControls {
  open: boolean
  menuId: string
  toggle: () => void
  /** Close after choosing an item. Pass true for dismissals that should return
   * keyboard focus to the trigger (Escape/backdrop already do this). */
  close: (restoreFocus?: boolean) => void
}

interface AnchoredFlyoutProps {
  trigger: (controls: AnchoredFlyoutControls) => ReactNode
  children: (controls: Pick<AnchoredFlyoutControls, 'close'>) => ReactNode
  ariaLabel: string
  role?: 'menu' | 'dialog'
  width?: number
  /** Grow to the trigger's width when it is wider than `width` — a full-width mobile control. */
  matchTriggerWidth?: boolean
  estimatedHeight?: number
  align?: 'start' | 'end'
  gap?: number
  viewportMargin?: number
  className?: string
  triggerClassName?: string
}

/** Place a fixed flyout inside the viewport, below its trigger unless above has meaningfully more room. */
export function placeAnchoredFlyout(
  trigger: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  options: {
    width: number
    matchTriggerWidth?: boolean
    estimatedHeight: number
    align: 'start' | 'end'
    gap: number
    margin: number
  }
): AnchoredFlyoutStyle {
  const wanted = options.matchTriggerWidth ? Math.max(options.width, trigger.right - trigger.left) : options.width
  const width = Math.min(wanted, Math.max(0, viewport.width - options.margin * 2))
  const maxLeft = Math.max(options.margin, viewport.width - width - options.margin)
  const alignedLeft = options.align === 'end' ? trigger.right - width : trigger.left
  const left = Math.min(Math.max(options.margin, alignedLeft), maxLeft)
  const roomBelow = Math.max(0, viewport.height - trigger.bottom - options.gap - options.margin)
  const roomAbove = Math.max(0, trigger.top - options.gap - options.margin)

  if (roomBelow >= options.estimatedHeight || roomBelow >= roomAbove) {
    return { left, top: trigger.bottom + options.gap, width, maxHeight: roomBelow }
  }
  return { left, bottom: viewport.height - trigger.top + options.gap, width, maxHeight: roomAbove }
}

/** Shared body-portaled menu surface for controls inside clipped cards,
 * drawers, and scroll containers. The caller owns the trigger and menu items;
 * this primitive owns anchoring, collision handling, layering, and dismissal. */
export function AnchoredFlyout({
  trigger,
  children,
  ariaLabel,
  role = 'menu',
  width = 280,
  matchTriggerWidth = false,
  estimatedHeight = 160,
  align = 'end',
  gap = 5,
  viewportMargin = 8,
  className = '',
  triggerClassName = ''
}: AnchoredFlyoutProps) {
  const triggerRef = useRef<HTMLSpanElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<AnchoredFlyoutStyle | null>(null)
  const menuId = useId()
  const open = style !== null

  const close = useCallback((restoreFocus = false) => {
    setStyle(null)
    if (restoreFocus) {
      requestAnimationFrame(() => triggerRef.current?.querySelector<HTMLElement>('button, [href]')?.focus())
    }
  }, [])

  const toggle = () => {
    if (open) return close(true)
    const anchor = triggerRef.current
    if (!anchor) return
    setStyle(
      placeAnchoredFlyout(
        anchor.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        { width, matchTriggerWidth, estimatedHeight, align, gap, margin: viewportMargin }
      )
    )
  }

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      close(true)
    }
    const onScroll = (event: Event) => {
      if (menuRef.current && event.composedPath().includes(menuRef.current)) return
      close()
    }
    const onResize = () => close()
    document.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
    }
  }, [close, open])

  const controls = { open, menuId, toggle, close }
  return (
    <>
      <span ref={triggerRef} className={triggerClassName}>
        {trigger(controls)}
      </span>
      {style &&
        createPortal(
          <>
            <span
              data-anchored-flyout-backdrop
              aria-hidden="true"
              className="fixed inset-0 z-[1090]"
              onClick={() => close(true)}
            />
            <div
              ref={menuRef}
              data-anchored-flyout
              id={menuId}
              role={role}
              aria-label={ariaLabel}
              className={`fixed z-[1100] overflow-y-auto rounded-lg border border-(--border-default) bg-(--surface-card) p-[5px] shadow-(--shadow-lg) ${className}`}
              style={style}
            >
              {children({ close })}
            </div>
          </>,
          document.body
        )}
    </>
  )
}
