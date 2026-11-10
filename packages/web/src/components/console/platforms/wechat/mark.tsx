// No 'use client' here: `PlatformMark` and the ModalProvider tree are already client boundaries.

import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

// An original glyph, not Tencent's artwork: one white speech bubble on a WeChat-green disc.
const BUBBLE =
  'M24 12.5c-7.18 0-13 4.7-13 10.5 0 3.3 1.88 6.25 4.83 8.17L14.5 36l5.43-2.72c1.29.3 2.65.47 4.07.47 7.18 0 13-4.7 13-10.5S31.18 12.5 24 12.5Z'

/** WeChat's mark ({@link WebPlatformModule.Mark}): full-bleed, so it takes the 80% cap. */
export function WeChatMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return (
    <svg viewBox="0 0 48 48" style={squareMarkBox(fillPct)} aria-hidden>
      <circle cx="24" cy="24" r="24" fill="#07C160" />
      <path fill="#fff" d={BUBBLE} />
      <circle cx="19.5" cy="22.5" r="1.9" fill="#07C160" />
      <circle cx="28.5" cy="22.5" r="1.9" fill="#07C160" />
    </svg>
  )
}
