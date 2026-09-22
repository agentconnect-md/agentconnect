import { DEFAULT_MARK_FILL_PCT, markBox } from '@/components/mark-box'

export function QQMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <img src="/brands/qq.svg" alt="" style={markBox(fillPct)} className="object-contain" aria-hidden />
}
