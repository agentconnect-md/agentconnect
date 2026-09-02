// The team mark: what it draws for each shape of `icon` Linear stores, and what it does with
// the team's color. The rule this pins is that we do NOT vendor Linear's icon set — a named
// icon we ship no glyph for falls back to the team's initial rather than to a missing image.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LinearTeamGlyph } from './team-glyph'

const html = (props: Parameters<typeof LinearTeamGlyph>[0]) => renderToStaticMarkup(<LinearTeamGlyph {...props} />)

describe('the Linear team mark', () => {
  it('renders an emoji icon as itself', () => {
    expect(html({ name: 'Design', icon: '🎨', color: '#5E6AD2' })).toContain('🎨')
  })

  it('falls back to the team’s initial for a Linear icon NAME, rather than a vendored glyph', () => {
    const out = html({ name: 'Engineering', icon: 'Feather' })
    expect(out).toContain('>E<')
    expect(out).not.toContain('Feather')
  })

  it('uses the initial when there is no icon at all, and stays drawn for a nameless row', () => {
    expect(html({ name: 'operations' })).toContain('>O<')
    expect(html({ name: '   ' })).toContain('>?<')
    // A name that leads with an emoji or an accent yields one whole character, not half of one.
    expect(html({ name: '🚀 Launch' })).toContain('🚀')
    expect(html({ name: 'Équipe' })).toContain('>É<')
  })

  it('tints itself with the team’s color, giving back a hash the value lost', () => {
    expect(html({ name: 'Engineering', color: '#5E6AD2' })).toContain('#5E6AD2')
    expect(html({ name: 'Engineering', color: '5E6AD2' })).toContain('#5E6AD2')
  })

  it('falls back to the surface tokens when the team has no color', () => {
    const out = html({ name: 'Engineering', icon: 'Feather' })
    expect(out).toContain('bg-(--surface-sunken)')
    expect(out).toContain('text-(--text-tertiary)')
  })

  it('is decorative — the row prints the name right beside it', () => {
    expect(html({ name: 'Engineering' })).toContain('aria-hidden')
  })
})
