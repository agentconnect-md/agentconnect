import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** WeChat's brand mark — the twin speech bubbles take the standard cap. */
export function WeixinMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <img src="/brands/weixin.svg" alt="" style={squareMarkBox(fillPct)} className="object-contain" aria-hidden />
}
