// No 'use client' here: `PlatformMark` and the ModalProvider tree are already client boundaries.

import { SiMattermost } from 'react-icons/si'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** Mattermost's brand mark ({@link WebPlatformModule.Mark}): Simple Icons' Mattermost glyph, which spans its box, so it takes the 80% cap. */
export function MattermostMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <SiMattermost style={squareMarkBox(fillPct)} color="#0058CC" aria-hidden />
}
