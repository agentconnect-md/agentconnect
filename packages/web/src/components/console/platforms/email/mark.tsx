// No 'use client' here: `PlatformMark` and the ModalProvider tree are already client boundaries.

import envelopeSimpleFillIcon from '@iconify-icons/ph/envelope-simple-fill'
import { Icon as IconifyIcon } from '@iconify/react'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** One blue for both themes: mail is no one's brand, so it takes a filled glyph like Webhook's, in a hue apart from its magenta. */
const EMAIL_MARK_COLOR = '#3d7ff2'

/** Email's mark ({@link WebPlatformModule.Mark}): a filled envelope. */
export function EmailMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return (
    <IconifyIcon icon={envelopeSimpleFillIcon} style={squareMarkBox(fillPct)} color={EMAIL_MARK_COLOR} aria-hidden />
  )
}
