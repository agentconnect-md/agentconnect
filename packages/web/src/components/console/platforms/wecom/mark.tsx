// No 'use client' here: `PlatformMark` and the ModalProvider tree are already client boundaries.

import { AiOutlineWechatWork } from 'react-icons/ai'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** WeCom's brand mark ({@link WebPlatformModule.Mark}): Ant Design Icons' WeCom glyph, which spans its box, so it takes the 80% cap. */
export function WeComMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <AiOutlineWechatWork style={squareMarkBox(fillPct)} color="#0082EF" aria-hidden />
}
