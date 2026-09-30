// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import { SiTelegram } from 'react-icons/si'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** Telegram's brand mark ({@link WebPlatformModule.Mark}) — a full-bleed circle, so it takes the 80% cap. */
export function TelegramMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <SiTelegram style={squareMarkBox(fillPct)} color="#26A5E4" aria-hidden />
}
