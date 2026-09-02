'use client'

// The team mark ({@link WebChannelListSemantics.RowMark}, §4.5): the colored glyph Linear's own
// team picker leads a team with. Linear names the icon out of an icon set we deliberately do NOT
// vendor — shipping someone else's icon font to fill a 16px square is a poor trade, and it would
// go stale the moment they add one — so the mark renders the team's EMOJI when the icon is one,
// and otherwise the team's initial. Either way it sits on the team's own color, which is the half
// of the pair that actually tells two teams apart at a glance.

/** An icon Linear stores as a picture rather than as a name — anything else is a set member. */
const EMOJI = /\p{Extended_Pictographic}/u

/** Linear stores `#rrggbb`; a value that lost its hash is still a color, so it is given one back. */
const hexColor = (color?: string): string | undefined =>
  color ? (color.startsWith('#') ? color : `#${color}`) : undefined

/** The team's initial — code points, so an emoji-led or accented name yields one whole character. */
const initial = (name: string): string => [...name.trim()][0]?.toUpperCase() ?? '?'

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
  const glyph = icon && EMOJI.test(icon) ? icon : initial(name)
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
