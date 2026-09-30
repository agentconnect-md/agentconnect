import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** QQ's brand mark; the penguin spans its viewBox top to bottom, so it takes the 80% cap. */
export function QQMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <img src="/brands/qq.svg" alt="" style={squareMarkBox(fillPct)} className="object-contain" aria-hidden />
}
