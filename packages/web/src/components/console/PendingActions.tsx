'use client'

// What the transcript is WAITING ON the reader for, and the banner that says so when it has
// scrolled out of sight. Two kinds share it because they are the same thing to a reader: an
// in-band elicitation nobody answered, and a native configuration card nobody opened. Both stop
// the agent dead, and both are a card in a transcript that may be a long way up.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '@/components/ui'

interface Pending {
  key: string
  /** What the banner calls it — a card title, a question's first line. */
  label: string
  el: HTMLElement
}

interface Registry {
  /** Register (or update) one waiting item under the node the banner scrolls to. */
  hold: (key: string, label: string, el: HTMLElement) => void
  /** Stop waiting on one item — answered, opened, or gone — IF `el` still holds the slot. A
   *  remount hands the same key to a new node, and the old instance tears down afterwards: an
   *  unconditional release would then drop the live card instead of the dead one. */
  release: (key: string, el: HTMLElement) => void
}

const Ctx = createContext<Registry | null>(null)
const Waiting = createContext<Pending[] | null>(null)

/**
 * Registration is a REF CALLBACK rather than an effect, because the node is what the banner
 * scrolls to and a node that arrives one commit late is a banner whose button does nothing on
 * its first click. The label rides along so the provider never has to read the DOM for it.
 */
export function PendingActionsProvider({ children }: { children: ReactNode }) {
  const items = useRef(new Map<string, Pending>())
  const [entries, setEntries] = useState<Pending[]>([])
  // Order is the transcript's own: a banner that named the second question while the first is
  // still unanswered would send the reader to the wrong card.
  //
  // The published snapshot carries the NODES, not just the keys, and the bail-out compares all
  // three fields — because a remount swaps the element under an unchanged key. React detaches the
  // old ref and attaches the new one in the same commit, so the key list nets out identical; a
  // snapshot that only tracked keys would leave the banner observing a detached node and silently
  // stop counting a card that is still waiting.
  const resync = useCallback(() => {
    setEntries((current) => {
      const next = [...items.current.values()].sort((a, b) =>
        a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      )
      const same =
        next.length === current.length &&
        next.every((entry, i) => {
          const was = current[i]!
          return entry.key === was.key && entry.label === was.label && entry.el === was.el
        })
      return same ? current : next
    })
  }, [])
  const hold = useCallback(
    (key: string, label: string, el: HTMLElement) => {
      items.current.set(key, { key, label, el })
      resync()
    },
    [resync]
  )
  const release = useCallback(
    (key: string, el: HTMLElement) => {
      if (items.current.get(key)?.el !== el) return
      items.current.delete(key)
      resync()
    },
    [resync]
  )
  const registry = useMemo<Registry>(() => ({ hold, release }), [hold, release])
  return (
    <Ctx.Provider value={registry}>
      <Waiting.Provider value={entries}>{children}</Waiting.Provider>
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
  // The node this instance put in the registry. Held so every release names it: the teardown of a
  // remounted card runs AFTER its replacement has claimed the key, and a release that only named
  // the key would drop the card still on the page.
  const mine = useRef<HTMLElement | null>(null)
  const attach = useCallback(
    (el: HTMLElement | null) => {
      if (el) {
        mine.current = el
        hold?.(key, label, el)
        return
      }
      if (mine.current) release?.(key, mine.current)
      mine.current = null
    },
    [key, label, hold, release]
  )
  // Ceasing to wait detaches the ref, which releases through `attach` above; this covers the
  // unmount, where React never calls the ref again.
  useEffect(
    () => () => {
      if (mine.current) release?.(key, mine.current)
      mine.current = null
    },
    [key, release]
  )
  return waiting && hold ? attach : undefined
}

/**
 * The banner. It names only what the reader CANNOT SEE: a question on screen needs no pointer to
 * itself, and a banner that stayed up while its card sat in the middle of the viewport would be
 * the kind of chrome people learn to ignore.
 */
export function PendingActionsBanner({ className = '' }: { className?: string }) {
  const entries = useContext(Waiting)
  const [hidden, setHidden] = useState<Pending[]>([])
  useEffect(() => {
    if (!entries?.length) {
      setHidden([])
      return
    }
    // The scroll pane is the viewport that matters, not the window: the transcript is its own
    // overflow region, and a card scrolled out of THAT is out of sight whatever the page is doing.
    const root = entries[0]!.el.closest('[data-transcript-scroll]')
    const seen = new Map<HTMLElement, boolean>()
    const observer = new IntersectionObserver(
      (records) => {
        for (const record of records) seen.set(record.target as HTMLElement, record.isIntersecting)
        setHidden(entries.filter((entry) => seen.get(entry.el) === false))
      },
      { root: root ?? null, threshold: 0 }
    )
    for (const entry of entries) observer.observe(entry.el)
    return () => observer.disconnect()
  }, [entries])
  const item = hidden[0]
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
