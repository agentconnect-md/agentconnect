'use client'

import { useCallback, useEffect, useRef } from 'react'

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
 * Returns a re-arm callback for the one thing a scroll position cannot express:
 * SENDING. Someone who scrolled up to read history and then writes a message is
 * done reading — call it from the send path so their own message, and the reply
 * that follows, are not delivered off-screen.
 *
 * Consequence worth naming: a session ARMS while its transcript is still empty
 * (the view mounts before the messages land), so an empty container reads as
 * at-the-bottom and the first render of history scrolls to the newest message.
 * Opening a session therefore lands at the bottom — which is what makes the
 * follow reachable at all, since a reader dropped at the top of a long history
 * would have to scroll all the way down to earn it.
 */
export function useStickToBottom(resetKey: string | null): () => void {
  // Refs, not closure state: the re-arm callback below is handed to render code
  // and has to reach the SAME latch the effect's listeners own.
  const stick = useRef(false)
  const scrollerRef = useRef<HTMLElement | null>(null)
  const pinRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // `.content` is the console's single page scroller (globals.css); the view's
    // root is its only child, and it — not the fixed-height scroller — is what
    // grows.
    const scroller = document.querySelector<HTMLElement>('.content')
    if (!scroller) return
    scrollerRef.current = scroller
    stick.current = false
    // A pin dispatches a `scroll` event, and the browser delivers it LATER — by
    // which time the content that prompted the pin has usually already grown
    // (React flushes the new rows inside the same task). Measuring that event
    // would read "far from the bottom" and un-arm the follow one beat after
    // arming it — the exact growth-time measurement this whole design avoids.
    // So swallow the echo of our own pin; only a scroll we did not cause may
    // un-arm.
    //
    // Identified by POSITION, not by "the next event is mine": scroll events for
    // one scroller coalesce, so anything that moves the viewport before the
    // pending echo is delivered — the `?focus` scrollIntoView, a quick flick of
    // the wheel — arrives as that same single event. A bare flag would discard
    // it and leave the follow armed, dragging the reader back down on the next
    // row. Recording where the pin actually landed makes the echo verifiable:
    // if the viewport still sits there, nothing else moved it.
    let pinnedTop: number | null = null
    const pin = () => {
      const before = scroller.scrollTop
      scroller.scrollTop = scroller.scrollHeight
      // Read back, because the browser clamps to `scrollHeight - clientHeight`.
      // No movement means no event to swallow — recording a position here would
      // eat the user's next real scroll instead.
      pinnedTop = scroller.scrollTop === before ? null : scroller.scrollTop
    }
    pinRef.current = pin
    const onScroll = () => {
      const echo = pinnedTop !== null && scroller.scrollTop === pinnedTop
      pinnedTop = null
      if (echo) return
      stick.current = nearBottom(scroller)
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(() => {
      if (stick.current) pin()
    })
    // The child under `.content` is a loading placeholder before it is the real
    // view root, and the swap does NOT always change `resetKey` — a merged
    // conversation keys on its URL, which is known before its roster resolves.
    // Re-point on every swap, or the observer sits on a detached node (a real
    // ResizeObserver stops firing once its target leaves the document) and the
    // follow is silently dead for the whole visit.
    let observed: Element | null = null
    const attach = () => {
      const child = scroller.firstElementChild
      if (!child || child === observed) return
      if (observed) observer.unobserve(observed)
      observed = child
      observer.observe(child)
      // Re-measure against the tree that just mounted, not the one it replaced.
      stick.current = nearBottom(scroller)
    }
    attach()
    const swaps = new MutationObserver(attach)
    swaps.observe(scroller, { childList: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      observer.disconnect()
      swaps.disconnect()
      scrollerRef.current = null
      pinRef.current = null
    }
  }, [resetKey])

  return useCallback(() => {
    stick.current = true
    // Jump now for the rows already there; the observer catches the sent message
    // and the reply as they render.
    pinRef.current?.()
  }, [])
}
