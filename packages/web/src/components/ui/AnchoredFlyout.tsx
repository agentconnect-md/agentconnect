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
  width?: number
  estimatedHeight?: number
  align?: 'start' | 'end'
  gap?: number
  viewportMargin?: number
  className?: string
  triggerClassName?: string
}

/** Place a fixed flyout inside the viewport, preferring below its trigger and
 * flipping above when that side has meaningfully more space. */
export function placeAnchoredFlyout(
  trigger: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
  options: {
    width: number
    estimatedHeight: number
    align: 'start' | 'end'
    gap: number
    margin: number
  }
): AnchoredFlyoutStyle {
  const width = Math.min(options.width, Math.max(0, viewport.width - options.margin * 2))
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
  width = 280,
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
        { width, estimatedHeight, align, gap, margin: viewportMargin }
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
              role="menu"
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
