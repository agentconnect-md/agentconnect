// The brand-mark BOX contract, shared by `PlatformMark`'s core-kind arms
// (marks.tsx) and every platform module's own `Mark` (§10). A leaf module with no
// React import on purpose: `marks.tsx` is pulled into non-console routes (the login
// page, the invite/activate pages) while the platform marks live under
// `console/platforms/`, so the shared rule has to sit below both rather than in
// either one.
//
// Marks render at 60% of their box to sit inside the `.av` / `.imark` tiles; a
// caller can override that (the Bots row fills a 14px box at `fillPct=100` to match
// the design's full-bleed mark).

/** An inline size for one mark — data-driven, so it stays an inline `style`
 *  (packages/web/STYLE.md rule 8) rather than an assembled class name. */
export interface MarkBox {
  readonly width: string
  readonly height: string
  readonly display: 'block'
}

const box = (pct: number): MarkBox => ({ width: `${pct}%`, height: `${pct}%`, display: 'block' })

/** The requested fill, applied verbatim. */
export function markBox(fillPct: number): MarkBox {
  return box(fillPct)
}

/** The fill a full-bleed square glyph lands on — what a directly-named mark asks for to match it. */
export const SQUARE_MARK_FILL_PCT = 80

/**
 * The requested fill, CAPPED at {@link SQUARE_MARK_FILL_PCT}.
 *
 * Slack / GitHub / Discord ship as full-bleed square glyphs with no internal
 * padding of their own, so a caller asking for a full-bleed box (`fillPct=100`,
 * e.g. the session rail rows) would render them visibly larger than every other
 * mark beside them. Below the cap nothing changes.
 */
export function squareMarkBox(fillPct: number): MarkBox {
  return fillPct > SQUARE_MARK_FILL_PCT ? box(SQUARE_MARK_FILL_PCT) : box(fillPct)
}

/** The default fill every mark starts from. */
export const DEFAULT_MARK_FILL_PCT = 60
