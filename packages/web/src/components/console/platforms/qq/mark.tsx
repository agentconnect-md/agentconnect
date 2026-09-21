import { SiQq } from 'react-icons/si'
import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** QQ's brand mark in its Simple Icons color; the glyph spans its viewBox, so it takes the square cap. */
export function QQMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <SiQq style={squareMarkBox(fillPct)} color="#1EBAFC" aria-hidden />
}
