// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import slackIcon from '@iconify-icons/logos/slack-icon'
import { Icon as IconifyIcon } from '@iconify/react'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** Slack's brand mark ({@link WebPlatformModule.Mark}) — a square glyph, so it
 *  takes the 80% cap rather than a caller's full-bleed box. */
export function SlackMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <IconifyIcon icon={slackIcon} style={squareMarkBox(fillPct)} aria-hidden />
}
