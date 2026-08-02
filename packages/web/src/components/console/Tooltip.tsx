'use client'

// One tooltip for the whole console.
//
// Every `title` attribute in the console is a hover hint, and the browser shows
// those in OS chrome after a ~1s dwell — slow enough to feel broken, and styled
// by nothing we control. This layer intercepts them: it lifts the `title` off
// the element (so the native tooltip never fires), and re-renders the same text
// on the design system's timing and tokens.
//
// Working off the attribute rather than a <Tooltip> wrapper is deliberate —
// `title` is already on ~150 controls, and one layer keeps every one of them on
// the same delay. Call sites keep writing plain `title="…"`; opt a subtree out
// with `data-no-tooltip`. A hint that should appear only when an ancestor takes
// keyboard focus can use `data-tooltip-focus-text` without becoming a hover or
// native-title source.

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  isTooltipSource,
  placeTooltip,
  TOOLTIP_SHOW_DELAY_MS,
  TOOLTIP_WARM_MS,
  type TooltipPosition
} from './tooltip-placement'
import { adoptTitle, liftTitle, restoreTitle, TITLE_STASH } from './tooltip-title'

/** Matches both a not-yet-lifted title and the element currently holding one. */
const SOURCE_SELECTOR = `[title],[${TITLE_STASH}]`
const FOCUS_TEXT = 'data-tooltip-focus-text'
const FOCUS_SOURCE_SELECTOR = `[${FOCUS_TEXT}],[data-tooltip-focus][title],[data-tooltip-focus][${TITLE_STASH}]`
const TOOLTIP_ID = 'ac-tooltip'

/** CSS keeps responsive duplicates mounted; focus must anchor to the rendered one. */
function isRendered(el: HTMLElement): boolean {
  for (let current: HTMLElement | null = el; current; current = current.parentElement) {
    const style = window.getComputedStyle(current)
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false
  }
  return true
}

function visibleDescendant(root: HTMLElement, selector: string): HTMLElement | null {
  return Array.from(root.querySelectorAll<HTMLElement>(selector)).find(isRendered) ?? null
}

export function TooltipLayer() {
  const [text, setText] = useState<string | null>(null)
  const [pos, setPos] = useState<TooltipPosition | null>(null)
  const [mounted, setMounted] = useState(false)

  const boxRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<DOMRect | null>(null)
  // The element whose title is currently lifted, and the one a pending open is
  // scheduled for — separate, because the timer fires long after we commit.
  const heldRef = useRef<HTMLElement | null>(null)
  const scheduledRef = useRef<HTMLElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const warmUntilRef = useRef(0)
  // Watches the held element for a `title` React puts back mid-hover.
  const retitleRef = useRef<MutationObserver | null>(null)

  useEffect(() => setMounted(true), [])

  /** Put the lifted `title` back and undo the ARIA wiring that came with it. */
  const release = useCallback(() => {
    const el = heldRef.current
    heldRef.current = null
    retitleRef.current?.disconnect()
    if (el) restoreTitle(el, TOOLTIP_ID)
  }, [])

  const hide = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    scheduledRef.current = null
    // Only an actually-visible tooltip earns the follow-on grace period.
    if (heldRef.current) warmUntilRef.current = Date.now() + TOOLTIP_WARM_MS
    release()
    anchorRef.current = null
    setText(null)
    setPos(null)
  }, [release])

  const open = useCallback((el: HTMLElement) => {
    const title = el.getAttribute('title')
    const value = title ?? el.getAttribute(FOCUS_TEXT)
    if (value === null || !isTooltipSource(el.tagName, value) || !el.isConnected) return
    // Lifting the attribute is what suppresses the browser's own tooltip; it
    // goes back on the element the moment the pointer leaves (see release()).
    if (title !== null && liftTitle(el, TOOLTIP_ID) === null) return
    heldRef.current = el
    anchorRef.current = el.getBoundingClientRect()
    setText(value.trim())

    // Focus-only text is metadata, not a native title, so there is nothing to
    // lift or watch. The focused row already owns the accessible roster text.
    if (title === null) return

    // A control can re-title itself while its tooltip is up — a copy button
    // flipping to "Copied" on activation, or back again on a timer. React
    // writes the new `title` to the element it can see, which is the one we
    // just emptied, so without this the tooltip would show stale text AND the
    // native tooltip would be live again on the same control.
    retitleRef.current ??= new MutationObserver(() => {
      const held = heldRef.current
      if (!held) return
      const next = adoptTitle(held)
      if (next !== null) setText(next.trim())
    })
    // observe() adds a target rather than replacing one — never carry the
    // previous anchor along.
    retitleRef.current.disconnect()
    retitleRef.current.observe(el, { attributes: true, attributeFilter: ['title'] })
  }, [])

  const schedule = useCallback(
    (el: HTMLElement, immediate: boolean) => {
      // Already open for this element, or already queued for it — either way the
      // pointer is just moving over its children.
      if (el === heldRef.current || el === scheduledRef.current) return
      if (el.closest('[data-no-tooltip]')) {
        hide()
        return
      }
      // Read the grace window before hide() re-arms it for this same close.
      const delay = immediate || Date.now() < warmUntilRef.current ? 0 : TOOLTIP_SHOW_DELAY_MS
      hide()
      scheduledRef.current = el
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        scheduledRef.current = null
        open(el)
      }, delay)
    },
    [hide, open]
  )

  // Hover / focus wiring. One document-level listener set, installed once.
  useEffect(() => {
    const sourceFor = (node: EventTarget | null): HTMLElement | null =>
      node instanceof Element ? (node.closest(SOURCE_SELECTOR) as HTMLElement | null) : null

    const onPointerOver = (e: PointerEvent) => {
      // Touch has no hover: a tap would strand a tooltip with nothing to close it.
      if (e.pointerType !== 'mouse') return
      const el = sourceFor(e.target)
      if (!el) {
        if (heldRef.current || scheduledRef.current) hide()
        return
      }
      if (el === heldRef.current) return
      schedule(el, false)
    }

    // Leaving the window fires no pointerover anywhere, so close on the way out.
    const onPointerOut = (e: PointerEvent) => {
      if (e.relatedTarget === null) hide()
    }

    const onFocusIn = (e: FocusEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null
      if (!el) return
      // Keyboard focus only — a click already opened (and will close) its own.
      let keyboard = false
      try {
        keyboard = el.matches(':focus-visible')
      } catch {
        /* :focus-visible unsupported — stay silent rather than fire on clicks */
      }
      if (!keyboard) return
      // Walk up first — but a focusable container can hold its hint on an inner
      // element (a list row whose description hangs off the name, so a hover
      // opens it where the pointer is reading). `closest` only looks upward.
      const source =
        (el.closest(SOURCE_SELECTOR) as HTMLElement | null) ??
        visibleDescendant(el, FOCUS_SOURCE_SELECTOR) ??
        visibleDescendant(el, SOURCE_SELECTOR)
      if (source) schedule(source, true)
    }

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }

    document.addEventListener('pointerover', onPointerOver, true)
    document.addEventListener('pointerout', onPointerOut, true)
    document.addEventListener('pointerdown', hide, true)
    // Keyboard activation has no pointerdown. Release a parked title before the
    // target's click handler can remove or replace its state-driven title.
    document.addEventListener('click', hide, true)
    document.addEventListener('focusin', onFocusIn, true)
    document.addEventListener('focusout', hide, true)
    document.addEventListener('keydown', onKeyDown, true)
    // A tooltip is pinned to a rect that scrolling invalidates; close, don't chase.
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    window.addEventListener('blur', hide)

    return () => {
      document.removeEventListener('pointerover', onPointerOver, true)
      document.removeEventListener('pointerout', onPointerOut, true)
      document.removeEventListener('pointerdown', hide, true)
      document.removeEventListener('click', hide, true)
      document.removeEventListener('focusin', onFocusIn, true)
      document.removeEventListener('focusout', hide, true)
      document.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
      window.removeEventListener('blur', hide)
      // Unmounting mid-hover must still hand the `title` back to its element.
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      release()
    }
  }, [hide, release, schedule])

  // Measure at natural size while hidden, then place it. (`useEffect`, not
  // `useLayoutEffect`: the pre-placement pass is `visibility: hidden`, so the
  // extra frame is invisible and the server render stays warning-free.)
  useEffect(() => {
    if (text === null) return
    const box = boxRef.current
    const anchor = anchorRef.current
    if (!box || !anchor) return
    setPos(
      placeTooltip(anchor, box.getBoundingClientRect(), {
        width: window.innerWidth,
        height: window.innerHeight
      })
    )
  }, [text])

  if (!mounted || text === null) return null

  return createPortal(
    <div
      ref={boxRef}
      id={TOOLTIP_ID}
      role="tooltip"
      className="pointer-events-none fixed z-[1100] max-w-[280px] rounded-sm border border-(--border-default) bg-(--surface-card) px-[9px] py-[5px] font-sans text-[12px] font-medium leading-[1.45] break-words whitespace-pre-line text-(--text-primary) shadow-(--shadow-lg) transition-[opacity,transform]"
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        // Two passes: the first lays the tooltip out at its natural size to be
        // measured, hidden and unplaced. That pass is what gives the transition
        // a committed `opacity: 0` to start from — the second pass (placed,
        // visible) then animates instead of popping. No rAF needed: the measure
        // effect runs after the first pass has already painted.
        visibility: pos ? 'visible' : 'hidden',
        opacity: pos ? 1 : 0,
        transform: pos ? 'none' : 'translateY(2px)'
      }}
    >
      {text}
    </div>,
    document.body
  )
}
