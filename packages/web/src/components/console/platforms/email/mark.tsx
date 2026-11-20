// No 'use client' here: `PlatformMark` and the ModalProvider tree are already client boundaries.

import { Mail } from 'lucide-react'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** Email's mark ({@link WebPlatformModule.Mark}): a plain envelope, since mail is no one's brand. */
export function EmailMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <Mail style={squareMarkBox(fillPct)} color="var(--text-secondary)" strokeWidth={1.75} aria-hidden />
}
