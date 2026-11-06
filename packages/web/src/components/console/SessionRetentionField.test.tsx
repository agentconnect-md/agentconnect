import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SessionRetentionFields, parseCustomDays } from './SessionRetentionField'

describe('parseCustomDays', () => {
  it('accepts only a complete integer day count', () => {
    expect(parseCustomDays('1')).toBe(1)
    expect(parseCustomDays('3')).toBe(3)
    expect(parseCustomDays('45')).toBe(45)
    expect(parseCustomDays('9999')).toBe(9999)
    expect(parseCustomDays(' 14 ')).toBe(14) // number-input text is trimmed
  })

  it("rejects prefix-parsable text that parseInt would coerce ('1.5' → 1, '1e2' → 1)", () => {
    // A prefix parse would silently save a window the operator didn't type.
    expect(parseCustomDays('1.5')).toBeNull()
    expect(parseCustomDays('1e2')).toBeNull()
    expect(parseCustomDays('7d')).toBeNull()
  })

  it('rejects zero, negatives, and counts past the protocol cap', () => {
    expect(parseCustomDays('0')).toBeNull()
    expect(parseCustomDays('-3')).toBeNull()
    expect(parseCustomDays('10000')).toBeNull() // shared SESSION_RETENTION_RE caps at 4 digits
    expect(parseCustomDays('')).toBeNull()
    expect(parseCustomDays('07')).toBeNull() // no leading zeros — mirrors the wire regex
  })
})

const noop = () => undefined
const render = (session: string, workspace: string) =>
  renderToStaticMarkup(
    <SessionRetentionFields
      session={session as '90d'}
      workspace={workspace as '7d'}
      onSessionChange={noop}
      onWorkspaceChange={noop}
    />
  )

describe('SessionRetentionFields', () => {
  it('renders one group, workspace before session, with a single shared hint', () => {
    const html = render('90d', '7d')
    expect(html).toContain('aria-label="Clean up finished sessions"')
    expect(html.indexOf('aria-label="Clean up workspaces after"')).toBeLessThan(
      html.indexOf('aria-label="Delete finished sessions after"')
    )
    expect(html.match(/The workspace and sandbox go first/g)).toHaveLength(1)
  })

  it('says the session window caps a longer workspace window', () => {
    const html = render('3d', '7d')
    expect(html).toContain('After 7 days') // the stored workspace value stays visible
    expect(html).toContain('A workspace never outlasts its session')
    expect(html).toContain('are all deleted after 3 days.')
    expect(html).not.toContain('The workspace and sandbox go first')
    // Equal windows and a workspace left to follow the session go together too.
    expect(render('7d', '7d')).toContain('are all deleted after 7 days.')
    expect(render('30d', 'never')).toContain('are all deleted after 30 days.')
    // A never-deleted session caps nothing.
    expect(render('never', '7d')).toContain('The workspace and sandbox go first')
  })

  it('marks both defaults and offers each preset list', () => {
    const html = render('90d', '7d')
    expect(html).toContain('After 90 days')
    expect(html).toContain('After 7 days')
    expect(html.match(/· default/g)).toHaveLength(2)
    expect(html).toContain('After 3 days') // workspace-only preset
    expect(html).toContain('With the session') // workspace 'never'
    expect(html).toContain('Never') // session 'never'
    // Preset values ⇒ no custom day inputs.
    expect(html).not.toContain('type="number"')
  })

  it('shows the bounded day input only under the custom column', () => {
    const html = render('45d', '7d')
    expect(html).toContain('After 45 days')
    const input = html.match(/<input[^>]*aria-label="Delete finished sessions after \(days\)"[^>]*>/)?.[0] ?? ''
    expect(input).toContain('type="number"')
    expect(input).toContain('min="1"')
    expect(input).toContain('max="9999"') // client-side mirror of the protocol cap
    expect(input).toContain('value="45"')
    expect(html).not.toContain('aria-label="Clean up workspaces after (days)"')
  })
})
