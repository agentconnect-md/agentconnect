'use client'

// A link to one message: a page's address with `#msg=<transcript seq>`, which scrolls to that message on arrival.

import { useEffect, useRef } from 'react'

const PREFIX = '#msg='
/** How long a page may take to draw the message a link names before the jump gives up. */
const LOCATE_WINDOW_MS = 10_000
/** How long the message stays marked after the jump. */
const MARK_MS = 2_400

/** One message's link: `base` (a page's path or address, with any query) and the message's transcript seq. */
export function messageLink(base: string, seq: number): string {
  return `${new URL(base, window.location.href).href.replace(/#.*$/, '')}${PREFIX}${seq}`
}

/** The transcript seq a link's hash names, or null. */
export function messageSeqOf(hash: string): number | null {
  if (!hash.startsWith(PREFIX)) return null
  const seq = Number(hash.slice(PREFIX.length))
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null
}

/** On arrival with a message link, once that message is drawn: let go of the bottom-follow, scroll it into view and mark it. */
export function useLocateMessage(release: () => void) {
  const releaseRef = useRef(release)
  useEffect(() => {
    releaseRef.current = release
  })
  useEffect(() => {
    let timer = 0
    let unmark = 0
    const locate = () => {
      window.clearInterval(timer)
      const seq = messageSeqOf(window.location.hash)
      if (seq === null) return
      const started = Date.now()
      timer = window.setInterval(() => {
        const selector = `[data-msg-seq="${seq}"]`
        // An open thread's copy of the message wins: the link named that thread.
        const el =
          document.querySelector<HTMLElement>(`[data-thread-panel] ${selector}, [data-task-thread] ${selector}`) ??
          document.querySelector<HTMLElement>(selector)
        if (!el) {
          if (Date.now() - started > LOCATE_WINDOW_MS) window.clearInterval(timer)
          return
        }
        window.clearInterval(timer)
        releaseRef.current()
        el.scrollIntoView({ block: 'center' })
        el.setAttribute('data-message-located', '')
        unmark = window.setTimeout(() => el.removeAttribute('data-message-located'), MARK_MS)
      }, 200)
    }
    locate()
    window.addEventListener('hashchange', locate)
    return () => {
      window.removeEventListener('hashchange', locate)
      window.clearInterval(timer)
      window.clearTimeout(unmark)
    }
  }, [])
}
