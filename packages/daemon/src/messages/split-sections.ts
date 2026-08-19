/**
 * Length-chunking for outbound chat text: break a body into sections no longer than the
 * target platform's per-message limit, preferring line boundaries.
 *
 * Distinct from stream-boundary.ts, which answers a different question — WHEN a still
 * streaming buffer may be cut at all (paragraph breaks outside fences). That one decides
 * timing, this one decides size; a renderer typically uses both, in that order.
 *
 * Platform-specific knowledge stays with the platform: the limit itself, which character
 * spans are indivisible (Slack's `<@U123>` addresses), and how an unsplittable span is
 * reported. This module only takes the spans and honors them.
 */

/** A half-open character range `[start, end)` a section boundary must not fall inside. */
export interface ProtectedSpan {
  start: number
  end: number
}

/** Thrown when one protected span is itself longer than a section can hold: delivery FAILS
 *  rather than publishing a cut-in-half token. Platforms may supply their own error. */
export class UnsplittableSpanError extends Error {
  constructor(readonly fragment: string) {
    super(`split: protected span (${fragment.length} chars) exceeds one message and cannot be split`)
    this.name = 'UnsplittableSpanError'
  }
}

export interface SplitSectionsOptions {
  /** Indivisible ranges, sorted by start and non-overlapping (callers merge overlaps). */
  protectedSpans?: readonly ProtectedSpan[]
  /** Builds the error thrown when a protected span cannot fit in one section. */
  unsplittable?: (fragment: string) => Error
}

/**
 * Split text into sections no longer than maxLen, preferring line boundaries; a single line
 * longer than maxLen is hard-cut. Whitespace-only input yields no sections. Content is never
 * lost across sections — `sections.join('')` reproduces the input byte for byte, including
 * boundary newlines and the whitespace around a protected span.
 *
 * A boundary that would fall INSIDE a protected span is moved back to the start of that span,
 * so the following section begins with the complete token. Moving back can only shorten a
 * section, never grow one past `maxLen`.
 */
export function splitIntoSections(text: string, maxLen: number, options: SplitSectionsOptions = {}): string[] {
  if (!text.trim()) return []
  if (text.length <= maxLen) return [text]
  const spans = options.protectedSpans ?? []
  const unsplittable = options.unsplittable ?? ((fragment: string) => new UnsplittableSpanError(fragment))
  for (const span of spans) {
    if (span.end - span.start > maxLen) throw unsplittable(text.slice(span.start, span.end))
  }
  const sections: string[] = []
  let consumed = 0
  while (text.length - consumed > maxLen) {
    const remaining = text.slice(consumed)
    // Prefer ending immediately after the last newline that fits. If none fits (an overlong
    // line, or a newline exactly at maxLen), hard-cut at the limit. Slicing the original
    // string rather than reconstructing lines guarantees join('') is byte-for-byte identical
    // to the input, including boundary newlines.
    const newline = remaining.lastIndexOf('\n', maxLen - 1)
    let end = consumed + (newline >= 0 ? newline + 1 : maxLen)
    // Absolute-offset spans and an absolute boundary, so the retreat below stays correct no
    // matter how many sections have already been emitted.
    const straddled = spans.find((span) => span.start < end && end < span.end)
    if (straddled) {
      end = straddled.start
      // Retreating to a span that starts at (or before) this section's own start would emit
      // an empty section and loop forever. It means the section begins inside the span —
      // impossible, since the previous iteration ended at a span start and no span is longer
      // than maxLen. Fail loudly instead of hanging.
      if (end <= consumed) throw unsplittable(text.slice(straddled.start, straddled.end))
    }
    sections.push(text.slice(consumed, end))
    consumed = end
  }
  if (consumed < text.length) sections.push(text.slice(consumed))
  return sections
}
