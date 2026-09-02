'use client'

import { Icon } from '@/components/ui'
import { linearTeamIcon } from './team-icons'

// The team mark ({@link WebChannelListSemantics.RowMark}, §4.5): the colored glyph Linear's own
// team picker leads a team with. Linear names the icon out of its own library, so the mark draws
// the console's counterpart of that name (`team-icons.ts`), the team's EMOJI when the icon is one,
// and otherwise the team's initial. Either way it sits on the team's own color, which is the half
// of the pair that actually tells two teams apart at a glance.
//
// Both emoji and initial are GRAPHEME work, not code-point work: a flag is a pair of regional
// indicators and a keycap is a digit plus a combining mark, so the naive reads split them and
// draw a fragment.

/**
 * Whether one GRAPHEME is a picture rather than a letter. `RGI_Emoji` is a sequence property, so
 * it needs `v` mode and must stand alone in its pattern; it is built once and reused, and an
 * engine without it falls back to the union below.
 */
const RGI_EMOJI = ((): RegExp | null => {
  try {
    return new RegExp('^\\p{RGI_Emoji}$', 'v')
  } catch {
    return null
  }
})()

/** The fallback's three shapes. `Extended_Pictographic` alone matches only the first: a flag is a
 *  PAIR of regional indicators and a keycap is an ASCII digit plus U+20E3, and neither carries it.
 *  Exported because the primary path shadows it wherever `v` mode exists, which is everywhere we
 *  run — a test is the only thing that would ever exercise the shapes it has to cover. */
export const EMOJI_FALLBACK = /^(?:\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]{2}|[0-9#*]\uFE0F?\u20E3)/u

const isPicture = (grapheme: string): boolean => (RGI_EMOJI ? RGI_EMOJI.test(grapheme) : EMOJI_FALLBACK.test(grapheme))

/** Graphemes, not code points: `🇺🇸` is two of them and `1️⃣` is three, so indexing by code point
 *  draws half a flag. One segmenter for the module — constructing one per render is not free. */
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The first whole grapheme of a value, or '' when it has none. */
function firstGrapheme(value: string): string {
  for (const { segment } of GRAPHEMES.segment(value.trim())) return segment
  return ''
}

/** Linear stores `#rrggbb`; a value that lost its hash is still a color, so it is given one back. */
const hexColor = (color?: string): string | undefined =>
  color ? (color.startsWith('#') ? color : `#${color}`) : undefined

/** The team's initial — one grapheme, so an emoji-led or accented name yields a whole character. */
const initial = (name: string): string => firstGrapheme(name).toUpperCase() || '?'

export function LinearTeamGlyph({
  name,
  icon,
  color,
  size = 16
}: {
  name: string
  icon?: string
  color?: string
  size?: number
}) {
  const tint = hexColor(color)
  // A library NAME draws its console counterpart; a picture draws itself; anything else — an
  // unmapped name, or no icon at all — is the initial, which says more than "Dino" in an 18px box.
  const named = linearTeamIcon(icon)
  const picture = icon && !named ? firstGrapheme(icon) : ''
  const glyph = named ? (
    <Icon name={named} size={Math.round(size * 0.72)} color={tint ?? 'var(--text-tertiary)'} strokeWidth={2} />
  ) : picture && isPicture(picture) ? (
    picture
  ) : (
    initial(name)
  )
  return (
    <span
      aria-hidden
      className={`flex flex-none items-center justify-center rounded-xs font-sans font-semibold leading-normal ${
        tint ? '' : 'bg-(--surface-sunken) text-(--text-tertiary)'
      }`}
      // Data-driven: the team's own color and the caller's box, neither expressible as a utility.
      // The ground is the same color at 8-bit alpha — one value, and no second token to keep in
      // step with the theme, since a translucent tint sits correctly on either ground.
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.62),
        ...(tint ? { background: `${tint}2E`, color: tint } : {})
      }}
    >
      {glyph}
    </span>
  )
}
