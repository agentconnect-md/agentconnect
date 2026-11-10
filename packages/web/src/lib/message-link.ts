'use client'

// A link to one message: a page's address with `#msg=<transcript seq>`, which scrolls to that message on arrival.

import { useEffect, useRef } from 'react'

const PREFIX = '#msg='
/** How long a page may take to draw the message a link names, after its last earlier page, before the jump gives up. */
const LOCATE_WINDOW_MS = 10_000
/** Most earlier pages one jump reads while looking for its message. */
const MAX_EARLIER_PAGES = 50
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

/** A transcript's earlier pages, which a jump reads back through until its message is drawn. */
export interface EarlierPages {
  has: boolean
  loading: boolean
  load: () => Promise<void>
}

/** Which links a view lands: the page's own (no `?thread=`), or an open thread's (with one). */
export type LocateScope = 'page' | 'thread'

const SCOPE_ROOT: Record<LocateScope, string> = {
  page: '[data-transcript-scroll]',
  thread: '[data-thread-panel], [data-task-thread]'
}

/** Scrolls to the message with transcript seq `seq` in `scope` once it is drawn, reading earlier pages back to it, and marks it; returns a cancel. */
export function landOnMessage(
  scope: LocateScope,
  seq: number,
  opts: { release: () => void; earlier?: () => EarlierPages | undefined }
): () => void {
  let unmark = 0
  let waitFrom = Date.now()
  let pages = 0
  let paging = false
  const timer = window.setInterval(() => {
    const roots = [...document.querySelectorAll<HTMLElement>(SCOPE_ROOT[scope])]
    const el = roots.map((root) => root.querySelector<HTMLElement>(`[data-msg-seq="${seq}"]`)).find(Boolean)
    if (el) {
      window.clearInterval(timer)
      opts.release()
      el.scrollIntoView({ block: 'center' })
      el.setAttribute('data-message-located', '')
      unmark = window.setTimeout(() => el.removeAttribute('data-message-located'), MARK_MS)
      return
    }
    // Older than everything drawn: read the next earlier page, one at a time.
    const drawn = roots.flatMap((root) =>
      [...root.querySelectorAll<HTMLElement>('[data-msg-seq]')].map((node) => Number(node.dataset.msgSeq))
    )
    const older = drawn.length > 0 && seq < Math.min(...drawn)
    const pager = opts.earlier?.()
    if (older && pager?.has && !pager.loading && !paging && pages < MAX_EARLIER_PAGES) {
      paging = true
      pages++
      void pager.load().finally(() => {
        paging = false
        waitFrom = Date.now()
      })
      return
    }
    if (!paging && !pager?.loading && Date.now() - waitFrom > LOCATE_WINDOW_MS) window.clearInterval(timer)
  }, 200)
  return () => {
    window.clearInterval(timer)
    window.clearTimeout(unmark)
  }
}

/** On arrival with a message link, once that message is drawn (reading earlier pages back to it): let go of the bottom-follow, scroll to it and mark it. */
export function useLocateMessage(scope: LocateScope, release: () => void, earlier?: EarlierPages) {
  const releaseRef = useRef(release)
  const earlierRef = useRef(earlier)
  useEffect(() => {
    releaseRef.current = release
    earlierRef.current = earlier
  })
  useEffect(() => {
    let cancel = () => {}
    const locate = () => {
      cancel()
      const seq = messageSeqOf(window.location.hash)
      const inThread = new URLSearchParams(window.location.search).has('thread')
      if (seq === null || inThread !== (scope === 'thread')) return
      cancel = landOnMessage(scope, seq, { release: () => releaseRef.current(), earlier: () => earlierRef.current })
    }
    locate()
    window.addEventListener('hashchange', locate)
    return () => {
      window.removeEventListener('hashchange', locate)
      cancel()
    }
  }, [scope])
}
