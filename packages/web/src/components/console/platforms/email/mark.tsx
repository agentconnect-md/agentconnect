// No 'use client' here: `PlatformMark` and the ModalProvider tree are already client boundaries.

import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** Email's mark ({@link WebPlatformModule.Mark}): a flat closed envelope in three blues, the same in both themes, since mail is no one's brand. */
export function EmailMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return (
    <svg viewBox="0 0 64 64" style={squareMarkBox(fillPct)} aria-hidden>
      <rect x="6" y="14" width="52" height="38" rx="5" fill="#3d7ff2" />
      <path fill="#9ec3ff" d="M6 19l26 18 26-18v-1a4 4 0 0 0-4-4H10a4 4 0 0 0-4 4Z" />
      <path fill="#2563eb" d="M6 50 26 34l6 4 6-4 20 16a4 4 0 0 1-4 2H10a4 4 0 0 1-4-2Z" />
    </svg>
  )
}
