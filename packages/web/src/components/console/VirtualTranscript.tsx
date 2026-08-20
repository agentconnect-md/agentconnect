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

  // Resolve the scroll pane via a callback ref, NOT an effect keyed on `resetKey`: for a real CP
  // session `resetKey` is already final at mount, so an effect would never re-run when the turns
  // land (the empty→first-render flip) and the pane would stay unresolved forever. A callback ref
  // fires whenever the root mounts — including that flip — so the lookup is independent of resetKey.
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null)
  const setRoot = useCallback((node: HTMLDivElement | null) => {
    rootRef.current = node
    const pane = node?.closest<HTMLElement>('[data-transcript-scroll]') ?? null
    scrollRef.current = pane
    setScrollEl(pane)
  }, [])

  const rowVirtualizer = useVirtualizer({
    count: virtualize ? turns.length : 0,
    enabled: virtualize,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => estimate(turns[index]!),
    getItemKey: (index) => turns[index]?.key ?? index,
    overscan: OVERSCAN,
    scrollMargin
  })

  // The latest props in refs, so the effects below don't re-run on every parent render — the parent
  // passes fresh callback identities and a fresh `turns` array each time, and an effect that re-ran
  // on those would re-arm the follow constantly and trap the reader at the bottom.
  const onAtBottomRef = useRef(onAtBottomChange)
  onAtBottomRef.current = onAtBottomChange
  const onLoadOlderRef = useRef(onLoadOlder)
  onLoadOlderRef.current = onLoadOlder
  const hasOlderRef = useRef(hasOlder)
  hasOlderRef.current = hasOlder
  // Where the last pin landed, so onScroll can swallow the pin's own (delayed) scroll event.
  const pinnedTop = useRef<number | null>(null)

  const reportAtBottom = useCallback((atBottom: boolean) => onAtBottomRef.current?.(atBottom), [])

  const pinToBottom = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    // Scroll the PANE to its true bottom, not the last turn's: the typing dots, the flex-1 spacer
    // and the sticky composer follow the turn list, so aligning the last turn would leave the newest
    // reply under the composer and read as "not at the bottom".
    const before = el.scrollTop
    el.scrollTop = el.scrollHeight
    // Record the landing (browser-clamped) so onScroll can swallow this pin's echo by position — but
    // only if the pin actually moved: an already-at-bottom pin dispatches no scroll event, so arming
    // the latch here would instead eat the reader's next real scroll that happens to land here.
    pinnedTop.current = el.scrollTop === before ? null : el.scrollTop
  }, [])

  // The list is offset from the scrollport by whatever sits above it (a "load earlier" row, the
  // paging spinner, an offline/purge notice); the virtualizer needs that offset or every row is
  // mispositioned. Remeasured on every content change (below), not just when the turn COUNT changes.
  const measureScrollMargin = useCallback(() => {
    const root = rootRef.current
    const el = scrollRef.current
    // `offsetParent === null` means the list is display:none — opening a file conceals the transcript
    // while the observed wrapper stays visible (hosting the viewer), so the ResizeObserver still fires.
    // Measuring then reads all-zero rects and latches a large NEGATIVE margin; skip until it's back.
    if (!root || !el || root.offsetParent === null) return
    const offset = root.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop
    setScrollMargin((prev) => (Math.abs(prev - offset) > 0.5 ? offset : prev))
  }, [])

  // Arm the follow ONLY when the session/conversation changes — never on an ordinary re-render, or
  // the reader is yanked back to the bottom the moment they scroll up. The view mounts before the
  // turns land, so an empty pane reads as at-the-bottom and the first history render lands newest.
  useEffect(() => {
    follow.current = true
    reportAtBottom(true)
  }, [resetKey, reportAtBottom])

  // Follow ACTUAL growth, not every render. A ResizeObserver on the scroller's inner wrapper fires
  // whenever anything in the pane grows or shrinks — a streamed step, a merged row, a notice
  // appearing above the list — so it doubles as the trigger to re-pin (while the reader is at the
  // bottom) and to remeasure `scrollMargin`. `onScroll` latches whether the reader is still at the
  // bottom and drives the reverse-infinite-scroll load. Re-attached only on a session switch or a
  // plain↔virtual flip, not per render.
  useEffect(() => {
    const el = scrollEl
    if (!el) return
    const onScroll = () => {
      // Swallow the echo of our own pin: it dispatches a scroll event delivered LATER, by which time
      // a streamed row may already have grown the content, so measuring it would read "far from the
      // bottom" and drop the follow one beat after arming it. Matched by position (events coalesce).
      const echo = pinnedTop.current !== null && el.scrollTop === pinnedTop.current
      pinnedTop.current = null
      if (echo) return
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
      measureScrollMargin()
      if (follow.current) pinToBottom()
      reportAtBottom(nearBottom(el))
    })
    // Observe the scroller's inner wrapper (always present, unlike the turn list which is absent for
    // an empty transcript), so the follow survives the empty→first-render transition.
    const content = el.firstElementChild
    if (content) grow.observe(content)
    return () => {
      el.removeEventListener('scroll', onScroll)
      grow.disconnect()
    }
  }, [scrollEl, virtualize, pinToBottom, reportAtBottom, measureScrollMargin])

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

  // Nothing to render when empty — return null rather than an empty wrapper, whose parent `gap-4` +
  // `max-desktop:pb-3` would otherwise leave dead space above the mobile empty state / prompts.
  if (turns.length === 0) return null

  if (!virtualize) {
    return (
      <div ref={setRoot} className="flex flex-col gap-4 max-desktop:pb-3 desktop:gap-[15px]">
        {turns.map((turn, index) => (
          <Fragment key={turn.key ?? index}>{renderTurn(turn, index)}</Fragment>
        ))}
      </div>
    )
  }

  const items = rowVirtualizer.getVirtualItems()
  return (
    <div ref={setRoot} style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
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
