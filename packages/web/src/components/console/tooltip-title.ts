/**
 * The `title` attribute lifecycle behind the console's delegated tooltips.
 *
 * `Tooltip.tsx` has to take `title` off an element to stop the browser drawing
 * its own ~1s tooltip, which makes this the delicate part: `title` is not only
 * a hint, it is also the LAST-RESORT ACCESSIBLE NAME of a control that has no
 * text of its own, and React can put a different one back while ours is off the
 * element. Both cases are handled here, apart from the DOM plumbing, so they
 * can be tested directly.
 */

/** Where a lifted `title` is parked while its tooltip is open. */
export const TITLE_STASH = 'data-ac-title'

/**
 * Marks an `aria-label` this module synthesized, so release removes only its
 * own and never an author's.
 */
export const NAME_SYNTHESIZED = 'data-ac-named'

/** The slice of `Element` this module touches — a fake stands in for tests. */
export interface TitleHost {
  readonly textContent: string | null
  getAttribute(name: string): string | null
  setAttribute(name: string, value: string): void
  removeAttribute(name: string): void
  hasAttribute(name: string): boolean
}

/**
 * Whether removing `title` would leave the element with no accessible name.
 *
 * `title` only names an element that has nothing better: an explicit
 * label wins over it, and so does the element's own text (name-from-content).
 * An icon-only button — an `<svg>` and nothing else — has neither, which is
 * exactly the case that needs the name restated.
 */
function namedOnlyByTitle(el: TitleHost): boolean {
  return (
    !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby') && (el.textContent ?? '').trim().length === 0
  )
}

/**
 * Take `title` off the element and park it, wiring up the tooltip node as the
 * element's description. Returns the lifted text, or null if there was none.
 */
export function liftTitle(el: TitleHost, tooltipId: string): string | null {
  const title = el.getAttribute('title')
  if (title === null) return null

  el.setAttribute(TITLE_STASH, title)
  el.removeAttribute('title')

  // `aria-describedby` supplies a description, never a name — so on its own it
  // would leave an icon button unnamed for exactly as long as its tooltip is
  // up (immediately, on keyboard focus). Restate the name explicitly instead.
  if (namedOnlyByTitle(el)) {
    el.setAttribute('aria-label', title)
    el.setAttribute(NAME_SYNTHESIZED, '')
  }
  if (!el.hasAttribute('aria-describedby')) el.setAttribute('aria-describedby', tooltipId)

  return title
}

/**
 * A re-render put a fresh `title` back on an element we are still holding —
 * `Copy…` → `Copied`, `Show…` → `Hide…`. Adopt it: park the new value, keep
 * the synthesized name in step, and hand it back so the tooltip can re-render.
 *
 * Returns null when there is nothing new to adopt (including our own removal
 * of the attribute, which the observer also sees).
 */
export function adoptTitle(el: TitleHost): string | null {
  const title = el.getAttribute('title')
  if (title === null) return null

  el.setAttribute(TITLE_STASH, title)
  el.removeAttribute('title')
  if (el.hasAttribute(NAME_SYNTHESIZED)) el.setAttribute('aria-label', title)

  return title
}

/** Hand the parked `title` back and undo everything lifting it added. */
export function restoreTitle(el: TitleHost, tooltipId: string): void {
  const stashed = el.getAttribute(TITLE_STASH)
  if (stashed === null) return
  el.removeAttribute(TITLE_STASH)

  // Only restore into an empty slot: if a re-render already wrote a newer
  // title, the parked one is stale and must not clobber it.
  if (!el.hasAttribute('title')) el.setAttribute('title', stashed)

  if (el.hasAttribute(NAME_SYNTHESIZED)) {
    el.removeAttribute(NAME_SYNTHESIZED)
    el.removeAttribute('aria-label')
  }
  if (el.getAttribute('aria-describedby') === tooltipId) el.removeAttribute('aria-describedby')
}
