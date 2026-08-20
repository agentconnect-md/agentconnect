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

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // The virtualizer keeps an accurate end while rows are still estimated; the plain path just
    // clamps to the bottom.
    if (virtualize && turns.length > 0) rowVirtualizer.scrollToIndex(turns.length - 1, { align: 'end' })
    else el.scrollTop = el.scrollHeight
  }, [virtualize, turns.length, rowVirtualizer])

  // Resolve the scroll pane once mounted; re-arm the follow for the newly-opened session.
  useEffect(() => {
    scrollRef.current = rootRef.current?.closest<HTMLElement>('[data-transcript-scroll]') ?? null
    follow.current = true
    // The view mounts before the turns land, so an empty pane reads as at-the-bottom and the first
    // history render lands at the newest turn — which is what makes the follow reachable at all.
    onAtBottomChange?.(true)
  }, [resetKey, onAtBottomChange])

  // Follow the growing transcript, but ONLY while the reader is already at the bottom.
  useEffect(() => {
    if (follow.current) pinToBottom()
    // The button follows the same latch: away = the reader scrolled up out of a scrollable list.
    const el = scrollRef.current
    onAtBottomChange?.(el ? nearBottom(el) : true)
  }, [turns, pinToBottom, onAtBottomChange])

  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    follow.current = nearBottom(el)
    onAtBottomChange?.(follow.current)
    if (hasOlder && onLoadOlder && !loadingOlder.current && el.scrollTop <= NEAR_TOP) {
      loadingOlder.current = true
      // Preserve the viewport across the prepend: the caller grows the list at the top, so hold the
      // distance-from-bottom and restore it after the new rows land.
      const anchorFromBottom = el.scrollHeight - el.scrollTop
      Promise.resolve(onLoadOlder()).finally(() => {
        requestAnimationFrame(() => {
          const pane = scrollRef.current
          if (pane) pane.scrollTop = pane.scrollHeight - anchorFromBottom
          loadingOlder.current = false
        })
      })
    }
  }, [hasOlder, onLoadOlder, onAtBottomChange])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [onScroll])

  useImperativeHandle(
    handleRef,
    () => ({
      scrollToBottom() {
        follow.current = true
        pinToBottom()
        onAtBottomChange?.(true)
      }
    }),
    [pinToBottom, onAtBottomChange]
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
