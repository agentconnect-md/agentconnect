// How a team row prints its name: the team's NAME, linked to the team in Linear, then its KEY
// in muted text. The rule this pins is that only the NAME is the anchor — the key sits outside
// it, so it can be read and copied without being a navigation target.

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LinearTeamName } from './team-name'

const html = (props: Parameters<typeof LinearTeamName>[0]) => renderToStaticMarkup(<LinearTeamName {...props} />)

const TEAM_URL = 'https://linear.app/example-workspace/team/ENG'

describe('the Linear team row’s name', () => {
  it('prints the key after the name, in the muted token', () => {
    const out = html({ name: 'Engineering', channelKey: 'ENG', url: TEAM_URL })
    expect(out).toContain('Engineering')
    expect(out).toContain('>ENG<')
    expect(out).toContain('text-(--text-tertiary)')
  })

  it('links only the NAME, never the key', () => {
    const out = html({ name: 'Engineering', channelKey: 'ENG', url: TEAM_URL })
    const anchor = out.slice(out.indexOf('<a'), out.indexOf('</a>'))
    expect(anchor).toContain('Engineering')
    expect(anchor).not.toContain('>ENG<')
  })

  it('opens the team in a new tab, without handing Linear the referrer or the opener', () => {
    const out = html({ name: 'Engineering', channelKey: 'ENG', url: TEAM_URL })
    expect(out).toContain(`href="${TEAM_URL}"`)
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    // The console's external-link affordance, so the row says where the name goes.
    expect(out).toContain('lucide-external-link')
  })

  it('prints the name plainly when the row carries no link, and still prints the key', () => {
    const out = html({ name: 'Engineering', channelKey: 'ENG' })
    expect(out).not.toContain('<a')
    expect(out).toContain('Engineering')
    expect(out).toContain('>ENG<')
  })

  it('is the bare name where the platform gave neither', () => {
    expect(html({ name: 'Engineering' })).toBe('<span class="min-w-0 truncate">Engineering</span>')
  })
})
