'use client'

// What the transcript is WAITING ON the reader for, and the banner that says so when it has
// scrolled out of sight. Two kinds share it because they are the same thing to a reader: an
// in-band elicitation nobody answered, and a native configuration card nobody opened. Both stop
// the agent dead, and both are a card in a transcript that may be a long way up.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'

interface Pending {
  /** What the banner calls it — a card title, a question's first line. */
  label: string
  el: HTMLElement
}

interface Registry {
  /** Register (or update) one waiting item; the returned callback ref holds the node it scrolls to. */
  hold: (key: string, label: string) => (el: HTMLElement | null) => void
  /** Stop waiting on one item — answered, opened, or gone. */
  release: (key: string) => void
}

const Ctx = createContext<Registry | null>(null)
const Waiting = createContext<{ keys: string[]; items: Map<string, Pending> } | null>(null)

/**
 * Registration is a REF CALLBACK rather than an effect, because the node is what the banner
 * scrolls to and a node that arrives one commit late is a banner whose button does nothing on
 * its first click. The label rides along so the provider never has to read the DOM for it.
 */
export function PendingActionsProvider({ children }: { children: ReactNode }) {
  const items = useRef(new Map<string, Pending>())
  const [keys, setKeys] = useState<string[]>([])
  // Order is the transcript's own: a banner that named the second question while the first is
  // still unanswered would send the reader to the wrong card.
  const resync = useCallback(() => {
    setKeys((current) => {
      const next = [...items.current.entries()]
        .sort(([, a], [, b]) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
        .map(([key]) => key)
      return next.length === current.length && next.every((key, i) => key === current[i]) ? current : next
    })
  }, [])
  const hold = useCallback(
    (key: string, label: string) => (el: HTMLElement | null) => {
      if (el) items.current.set(key, { label, el })
      else items.current.delete(key)
      resync()
    },
    [resync]
  )
  const release = useCallback(
    (key: string) => {
      if (items.current.delete(key)) resync()
    },
    [resync]
  )
  const registry = useMemo<Registry>(() => ({ hold, release }), [hold, release])
  const waiting = useMemo(() => ({ keys, items: items.current }), [keys])
  return (
    <Ctx.Provider value={registry}>
      <Waiting.Provider value={waiting}>{children}</Waiting.Provider>
    </Ctx.Provider>
  )
}

/**
 * Hold a spot in the banner for as long as `waiting` is true. Returns the ref to put on the card,
 * or `undefined` outside a provider — every caller also renders in places that have none (a
 * history page, a test harness), so this never throws.
 */
export function usePendingAction(
  key: string,
  label: string,
  waiting: boolean
): ((el: HTMLElement | null) => void) | undefined {
  const registry = useContext(Ctx)
  const hold = registry?.hold
  const release = registry?.release
  useEffect(() => {
    if (waiting) return
    release?.(key)
  }, [waiting, key, release])
  useEffect(() => () => release?.(key), [key, release])
  return waiting && hold ? hold(key, label) : undefined
}

/**
 * The banner. It names only what the reader CANNOT SEE: a question on screen needs no pointer to
 * itself, and a banner that stayed up while its card sat in the middle of the viewport would be
 * the kind of chrome people learn to ignore.
 */
export function PendingActionsBanner({ className = '' }: { className?: string }) {
  const waiting = useContext(Waiting)
  const keys = waiting?.keys
  const items = waiting?.items
  const [hidden, setHidden] = useState<string[]>([])
  useEffect(() => {
    if (!keys?.length || !items) {
      setHidden([])
      return
    }
    const nodes = keys.map((key) => items.get(key)?.el).filter((el): el is HTMLElement => !!el)
    if (!nodes.length) return
    // The scroll pane is the viewport that matters, not the window: the transcript is its own
    // overflow region, and a card scrolled out of THAT is out of sight whatever the page is doing.
    const root = nodes[0]!.closest('[data-transcript-scroll]')
    const seen = new Map<HTMLElement, boolean>()
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) seen.set(entry.target as HTMLElement, entry.isIntersecting)
        setHidden(keys.filter((key) => seen.get(items.get(key)?.el as HTMLElement) === false))
      },
      { root: root ?? null, threshold: 0 }
    )
    for (const node of nodes) observer.observe(node)
    return () => observer.disconnect()
  }, [keys, items])
  const first = hidden[0]
  const item = first ? items?.get(first) : undefined
  if (!item) return null
  const more = hidden.length - 1
  return (
    <div className={`mx-auto w-full min-w-0 max-w-[880px] flex-none pt-2 ${className}`}>
      <button
        type="button"
        className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-md border border-(--amber-500) bg-(--status-paused-soft) px-3 py-2 text-left"
        onClick={() => item.el.scrollIntoView({ behavior: 'smooth', block: 'center' })}
      >
        <Icon name="clock" size={13} className="flex-none text-(--amber-500)" />
        <span className="min-w-0 flex-1 truncate font-sans text-[13px] font-medium leading-normal text-(--amber-500)">
          {item.label} is waiting for your action
          {more > 0 ? ` (+${more} more)` : ''}
        </span>
        <span className="flex-none font-sans text-[12px] font-semibold leading-normal text-(--amber-500)">Show</span>
      </button>
    </div>
  )
}
