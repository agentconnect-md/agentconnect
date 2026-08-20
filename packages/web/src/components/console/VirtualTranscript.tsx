'use client'

// The webchat transcript's turn list, with deepseek-harness-style windowing. It renders the turns
// SessionDetailView builds — plainly for short chats, virtualized with `@tanstack/react-virtual`
// once they pass the threshold — and owns the follow-to-bottom behaviour that used to live in
// `useStickToBottom`. SessionDetailView keeps the per-turn JSX (passed as `renderTurn`), the scroll
// pane element (this finds it as the `[data-transcript-scroll]` ancestor), and the composer.

import { useVirtualizer } from '@tanstack/react-virtual'
import {
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type Ref
} from 'react'
import { shouldVirtualizeTranscript } from '@/lib/transcript-virtual'

/** Distance from the bottom (px) that still counts as "reading the newest" — a couple of rows of
 *  slack so a nudge of the wheel doesn't drop the follow. Mirrors the old STICK_SLACK. */
const FOLLOW_SLACK = 80
/** Scroll within this of the top and we ask for the previous page (reverse infinite scroll). */
const NEAR_TOP = 240
/** Extra rows rendered beyond the viewport, so a fast scroll doesn't flash blank. */
const OVERSCAN = 6

export interface VirtualTranscriptHandle {
  /** Re-arm the follow and jump to the newest turn — the send path and the jump button call this. */
  scrollToBottom(): void
}

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK
}

export function VirtualTranscript<T extends { key?: string }>({
  turns,
  estimate,
  renderTurn,
  resetKey,
  hasOlder = false,
  onLoadOlder,
  onAtBottomChange,
  handleRef
}: {
  turns: readonly T[]
  /** First-paint height guess for one turn; measurement refines it once the row mounts. */
  estimate: (turn: T) => number
  /** The per-turn JSX, kept in SessionDetailView so its closures stay put. */
  renderTurn: (turn: T, index: number) => ReactNode
  /** Re-arms the follow when the open session/conversation changes. */
  resetKey: string | null
  hasOlder?: boolean
  onLoadOlder?: () => void
  /** Reports whether the reader has scrolled up out of a scrollable transcript (drives the button). */
  onAtBottomChange?: (atBottom: boolean) => void
  handleRef?: Ref<VirtualTranscriptHandle>
}) {
  const rootRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLElement | null>(null)
  // Latched on scroll, never read at growth time: new content has already pushed the bottom away,
  // so a measurement then would always read "not at the bottom" and the follow would never fire.
  const follow = useRef(true)
  const loadingOlder = useRef(false)

  const virtualize = shouldVirtualizeTranscript(turns.length)
  // The turn list is not at the top of the scroller — a "load earlier" row and empty-state notices
  // can sit above it — so the virtualizer needs the offset from the scrollport to the list start,
  // or every row is mispositioned by that gap. Measured below and kept fresh as content shifts.
  const [scrollMargin, setScrollMargin] = useState(0)

  const rowVirtualizer = useVirtualizer({
    count: virtualize ? turns.length : 0,
    enabled: virtualize,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimate(turns[index]!),
    getItemKey: (index) => turns[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin
  })

  useLayoutEffect(() => {
    const root = rootRef.current
    const scroll = scrollRef.current
    if (!root || !scroll) return
    const offset = root.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop
    setScrollMargin((prev) => (Math.abs(prev - offset) > 0.5 ? offset : prev))
  }, [turns.length, virtualize])

  // The latest props in refs, so the effects below don't re-run on every parent render — the parent
  // passes fresh callback identities and a fresh `turns` array each time, and an effect that re-ran
  // on those would re-arm the follow constantly and trap the reader at the bottom.
  const onAtBottomRef = useRef(onAtBottomChange)
  onAtBottomRef.current = onAtBottomChange
  const onLoadOlderRef = useRef(onLoadOlder)
  onLoadOlderRef.current = onLoadOlder
  const hasOlderRef = useRef(hasOlder)
  hasOlderRef.current = hasOlder
  const virtualizeRef = useRef(virtualize)
  virtualizeRef.current = virtualize
  const countRef = useRef(turns.length)
  countRef.current = turns.length
  const virtualizerRef = useRef(rowVirtualizer)
  virtualizerRef.current = rowVirtualizer

  const reportAtBottom = useCallback((atBottom: boolean) => onAtBottomRef.current?.(atBottom), [])

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // The virtualizer keeps an accurate end while rows are still estimated; the plain path clamps.
    if (virtualizeRef.current && countRef.current > 0) {
      virtualizerRef.current.scrollToIndex(countRef.current - 1, { align: 'end' })
    } else {
      el.scrollTop = el.scrollHeight
    }
  }, [])

  // Arm the follow ONLY when the session/conversation changes — never on an ordinary re-render, or
  // the reader is yanked back to the bottom the moment they scroll up. The view mounts before the
  // turns land, so an empty pane reads as at-the-bottom and the first history render lands newest.
  useEffect(() => {
    scrollRef.current = rootRef.current?.closest<HTMLElement>('[data-transcript-scroll]') ?? null
    follow.current = true
    reportAtBottom(true)
  }, [resetKey, reportAtBottom])

  // Follow ACTUAL growth, not every render: a ResizeObserver on the growing content fires only when
  // it really grows (a streamed step, a merged row), and only re-pins while the reader is still at
  // the bottom. `onScroll` latches that, and drives the reverse-infinite-scroll load. Re-attached
  // only on a session switch or a plain↔virtual flip (the root element changes) — not per render.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      follow.current = nearBottom(el)
      reportAtBottom(follow.current)
      if (hasOlderRef.current && onLoadOlderRef.current && !loadingOlder.current && el.scrollTop <= NEAR_TOP) {
        loadingOlder.current = true
        // Hold the distance-from-bottom across the prepend and restore it after the new rows land.
        const anchorFromBottom = el.scrollHeight - el.scrollTop
        Promise.resolve(onLoadOlderRef.current()).finally(() => {
          requestAnimationFrame(() => {
            const pane = scrollRef.current
            if (pane) pane.scrollTop = pane.scrollHeight - anchorFromBottom
            loadingOlder.current = false
          })
        })
      }
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const grow = new ResizeObserver(() => {
      if (follow.current) pinToBottom()
      reportAtBottom(nearBottom(el))
    })
    if (rootRef.current) grow.observe(rootRef.current)
    return () => {
      el.removeEventListener('scroll', onScroll)
      grow.disconnect()
    }
  }, [resetKey, virtualize, pinToBottom, reportAtBottom])

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToBottom() {
        follow.current = true
        pinToBottom()
        reportAtBottom(true)
      }
    }),
    [pinToBottom, reportAtBottom]
  )

  if (!virtualize) {
    return (
      <div ref={rootRef} className="flex flex-col gap-4 max-desktop:pb-3 desktop:gap-[15px]">
        {turns.map((turn, index) => (
          <Fragment key={turn.key ?? index}>{renderTurn(turn, index)}</Fragment>
        ))}
      </div>
    )
  }

  const items = rowVirtualizer.getVirtualItems()
  return (
    <div ref={rootRef} style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
      {items.map((item) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={rowVirtualizer.measureElement}
          className="max-desktop:pb-3"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            // `item.start` is scrollport-relative; the container starts `scrollMargin` down from it.
            transform: `translateY(${item.start - scrollMargin}px)`
          }}
        >
          {renderTurn(turns[item.index]!, item.index)}
        </div>
      ))}
    </div>
  )
}
