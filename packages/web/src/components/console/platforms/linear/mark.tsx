// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import { DEFAULT_MARK_FILL_PCT, markBox } from '@/components/mark-box'

/** Linear's brand purple — the one literal color in this module (STYLE.md rule 1:
 *  a brand value has no design token and stays literal). */
const LINEAR_PURPLE = '#5e6ad2'

/**
 * Linear's brand mark ({@link WebPlatformModule.Mark}) — four parallel diagonal
 * bars whose ends ride a circle, drawn here as paths rather than imported as an
 * asset. The bar cluster spans ~68% of the viewBox, so the artwork carries its own
 * padding and honours a full-bleed box uncapped, like Telegram's and Lark's.
 */
export function LinearMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return (
    <svg viewBox="0 0 100 100" style={markBox(fillPct)} fill="none" aria-hidden>
      <g stroke={LINEAR_PURPLE} strokeWidth="9" strokeLinecap="round">
        <path d="M16.1 47.9 47.9 16.1" />
        <path d="M20.7 67.3 67.3 20.7" />
        <path d="M32.7 79.3 79.3 32.7" />
        <path d="M52.1 83.9 83.9 52.1" />
      </g>
    </svg>
  )
}
