// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** Linear's brand purple — the one literal color in this module (STYLE.md rule 1:
 *  a brand value has no design token and stays literal). */
const LINEAR_PURPLE = '#5e6ad2'

/**
 * Linear's official logomark ({@link WebPlatformModule.Mark}): the circle sliced by
 * diagonal bands that shorten toward the lower-left, as published in the brand kit
 * (the Simple Icons tracing of it). It fills its viewBox edge to edge like Slack's and
 * Discord's, so it takes the same capped box a full-bleed square glyph does.
 */
export function LinearMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return (
    <svg viewBox="0 0 24 24" style={squareMarkBox(fillPct)} fill={LINEAR_PURPLE} aria-hidden>
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}
