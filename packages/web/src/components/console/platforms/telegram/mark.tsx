// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import { SiTelegram } from 'react-icons/si'
import { DEFAULT_MARK_FILL_PCT, markBox } from '@/components/mark-box'

/** Telegram's brand mark ({@link WebPlatformModule.Mark}). The artwork carries its
 *  own padding, so it honours a full-bleed box uncapped. */
export function TelegramMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <SiTelegram style={markBox(fillPct)} color="#26A5E4" aria-hidden />
}
