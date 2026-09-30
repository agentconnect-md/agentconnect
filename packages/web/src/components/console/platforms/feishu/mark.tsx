// No 'use client' here: every consumer is already inside a client boundary —
// `PlatformMark` (components/marks.tsx) and the module tree under ModalProvider.

import { DEFAULT_MARK_FILL_PCT, squareMarkBox } from '@/components/mark-box'

/** The brand asset both regional clouds share — one filled glyph, no per-path
 *  recoloring, so it is an `<img>` rather than an icon component. It is the
 *  module's own asset carrier (contract, "MOCK AND ASSET CARRIERS"): it lives in
 *  `public/brands/` because Next serves that directory, and this is the one
 *  reference to it outside the sign-in provider catalog. */
export const LARK_MARK_SRC = '/brands/lark.svg'

/** Lark / Feishu's one brand mark ({@link WebPlatformModule.Mark}); the asset's viewBox is cropped to the artwork, so it takes the 80% cap. */
export function FeishuMark({ fillPct = DEFAULT_MARK_FILL_PCT }: { fillPct?: number }) {
  return <img src={LARK_MARK_SRC} alt="" style={squareMarkBox(fillPct)} className="object-contain" aria-hidden />
}
