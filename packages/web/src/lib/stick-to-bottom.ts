'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

/** Distance from the bottom (px) that still counts as "reading the newest". A
 *  couple of rows of slack, so a nudge of the wheel doesn't drop the follow. */
export const STICK_SLACK = 80

export function nearBottom(el: HTMLElement, slack = STICK_SLACK): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < slack
}

/**
 * Keeps a growing transcript pinned to the bottom — but ONLY while the reader is
 * already there, so paging back through history is never yanked forward.
 *
 * The stick decision is latched on `scroll`, never read at growth time: once the
 * new content is in the DOM it has already pushed the bottom away, so a
 * measurement taken then would always read "not at the bottom" and the follow
 * would never fire.
 *
 * One ResizeObserver on the scroller's content box covers every growth source —
 * tail merge, live ACP steps, an image finishing decode, the typing dots — so
 * there is no dependency list to keep in sync with the transcript's internals.
 *
 * `resetKey` re-latches when the open session/conversation changes.
 *
 * Returns `{ pin, awayFromBottom }`. `pin` is a re-arm callback for the one thing
 * a scroll position cannot express: SENDING. Someone who scrolled up to read
 * history and then writes a message is done reading — call it from the send path
 * so their own message, and the reply that follows, are not delivered off-screen.
 * It also backs the "jump to bottom" affordance.
 *
 * `awayFromBottom` tracks whether the reader has scrolled up out of a transcript
 * long enough to scroll — the state that decides whether to show a jump-to-bottom
 * button. It stays false whenever the content fits, so an overflow-free view never
 * flashes the button.
 *
 * Consequence worth naming: a session ARMS while its transcript is still empty
 * (the view mounts before the messages land), so an empty container reads as
 * at-the-bottom and the first render of history scrolls to the newest message.
 * Opening a session therefore lands at the bottom — which is what makes the
 * follow reachable at all, since a reader dropped at the top of a long history
 * would have to scroll all the way down to earn it.
 */
export function useStickToBottom(resetKey: string | null): {
  pin: () => void
  awayFromBottom: boolean
} {
  // Refs, not closure state: the re-arm callback below is handed to render code
  // and has to reach the SAME latch the effect's listeners own.
  const stick = useRef(false)
  const pinRef = useRef<(() => void) | null>(null)
  // Drives the jump-to-bottom button. A ref mirrors it so the listeners can skip
  // redundant setState churn on every scroll/growth tick and only re-render on a
  // real transition.
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const awayRef = useRef(false)

  useEffect(() => {
    // `.content` is the console's stable page container (globals.css). The scroller is no
    // longer the page: the transcript column is its OWN `overflow-y-auto` pane now, tagged
    // `[data-transcript-scroll]`, and it mounts and unmounts with the session view — so it
    // is discovered inside `.content`, not assumed. Everything below points at whichever
    // pane is currently there, and re-points when the view root swaps.
    const page = document.querySelector<HTMLElement>('.content')
    if (!page) return
    stick.current = false
    awayRef.current = false
    setAwayFromBottom(false)

    let scroller: HTMLElement | null = null
    let pinnedTop: number | null = null
    let observed: Element | null = null

    // Mirror the "is the reader scrolled up out of a scrollable transcript" bit into the
    // ref + state, but only on a real transition so a stuck-to-bottom stream (which fires
    // this every growth tick) never re-renders the tree.
    const syncAway = () => {
      if (!scroller) return
      const away = !nearBottom(scroller)
      if (away === awayRef.current) return
      awayRef.current = away
      setAwayFromBottom(away)
    }
    // A pin dispatches a `scroll` event, and the browser delivers it LATER — by which time
    // the content that prompted the pin has usually already grown (React flushes the new
    // rows inside the same task). Measuring that event would read "far from the bottom" and
    // un-arm the follow one beat after arming it — the exact growth-time measurement this
    // whole design avoids. So swallow the echo of our own pin; only a scroll we did not
    // cause may un-arm.
    //
    // Identified by POSITION, not by "the next event is mine": scroll events for one
    // scroller coalesce, so anything that moves the viewport before the pending echo is
    // delivered — a quick flick of the wheel, a programmatic scrollIntoView — arrives as
    // that same single event. A bare flag would discard it and leave the follow armed,
    // dragging the reader back down on the next row. Recording where the pin actually
    // landed makes the echo verifiable: if the viewport still sits there, nothing else
    // moved it.
    const pin = () => {
      if (!scroller) return
      const before = scroller.scrollTop
      scroller.scrollTop = scroller.scrollHeight
      // Read back, because the browser clamps to `scrollHeight - clientHeight`. No movement
      // means no event to swallow — recording a position here would eat the user's next
      // real scroll instead.
      pinnedTop = scroller.scrollTop === before ? null : scroller.scrollTop
    }
    pinRef.current = pin
    const onScroll = () => {
      if (!scroller) return
      const echo = pinnedTop !== null && scroller.scrollTop === pinnedTop
      pinnedTop = null
      // The button follows the viewport even on the pin echo: a pin lands at the bottom, so
      // `syncAway` reads false and hides it.
      syncAway()
      if (echo) return
      stick.current = nearBottom(scroller)
    }
    const observer = new ResizeObserver(() => {
      if (stick.current) pin()
      // Growth while the reader sits in history is exactly when a short transcript becomes
      // scrollable — re-measure so the button appears on that tick.
      syncAway()
    })
    // Point every listener at the transcript column and watch its single growing inner
    // child. Re-runs whenever the view root swaps (loading placeholder → real view, which
    // does NOT always change `resetKey`) — the column, and the inner wrapper under it, come
    // and go with that swap, and a real ResizeObserver stops firing once its target detaches.
    const attach = () => {
      const found = page.querySelector<HTMLElement>('[data-transcript-scroll]')
      if (found !== scroller) {
        if (scroller) scroller.removeEventListener('scroll', onScroll)
        scroller = found
        pinnedTop = null
        if (scroller) scroller.addEventListener('scroll', onScroll, { passive: true })
      }
      if (!scroller) return
      const child = scroller.firstElementChild
      if (child && child !== observed) {
        if (observed) observer.unobserve(observed)
        observed = child
        observer.observe(child)
      }
      // Re-measure against the tree that just mounted, not the one it replaced.
      stick.current = nearBottom(scroller)
      syncAway()
    }
    attach()
    const swaps = new MutationObserver(attach)
    swaps.observe(page, { childList: true })
    return () => {
      if (scroller) scroller.removeEventListener('scroll', onScroll)
      observer.disconnect()
      swaps.disconnect()
      pinRef.current = null
    }
  }, [resetKey])

  const pin = useCallback(() => {
    stick.current = true
    // Jump now for the rows already there; the observer catches the sent message
    // and the reply as they render.
    pinRef.current?.()
    awayRef.current = false
    setAwayFromBottom(false)
  }, [])

  return { pin, awayFromBottom }
}
