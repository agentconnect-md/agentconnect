// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import { SiDiscord } from 'react-icons/si'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** Discord's brand mark ({@link WebPlatformModule.Mark}) — a square glyph, so it
 *  takes the 80% cap rather than a caller's full-bleed box. */
export function DiscordMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <SiDiscord style={squareMarkBox(fillPct)} color="#5865F2" aria-hidden />
}
