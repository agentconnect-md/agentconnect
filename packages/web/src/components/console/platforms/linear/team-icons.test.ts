import { describe, expect, it } from 'vitest'
import { icons } from 'lucide-react'
import { LINEAR_TEAM_ICONS, linearTeamIcon } from './team-icons'

// The same kebab → Pascal read `Icon` in `components/ui.tsx` does, so a target that fails here
// would render nothing there rather than the team's initial.
const toPascal = (name: string) =>
  name
    .split('-')
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .join('')

describe('Linear team icon map', () => {
  it('names only glyphs the console can draw', () => {
    const missing = Object.entries(LINEAR_TEAM_ICONS).filter(([, target]) => !(toPascal(target) in icons))
    expect(missing).toEqual([])
  })

  it('answers the mapped glyph and nothing for an unmapped or absent name', () => {
    expect(linearTeamIcon('Gears')).toBe('settings')
    expect(linearTeamIcon(' Present ')).toBe('gift')
    expect(linearTeamIcon('Dino')).toBeUndefined()
    expect(linearTeamIcon(undefined)).toBeUndefined()
  })
})
