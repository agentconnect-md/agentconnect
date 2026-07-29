import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentIconPicker } from './AgentIconPicker'

describe('AgentIconPicker', () => {
  it('matches the outer plate to image and glyph backgrounds', () => {
    const image = renderToStaticMarkup(
      <AgentIconPicker value={{ kind: 'image', url: 'https://cdn.example.test/org.webp' }} runtime="" size={44} />
    )
    const glyph = renderToStaticMarkup(
      <AgentIconPicker value={{ kind: 'glyph', glyph: 'bot', color: '#c62a78' }} runtime="" size={44} />
    )

    expect(image).toContain('bg-white')
    expect(image).not.toContain('bg-(--surface-inverse)')
    expect(glyph).toContain('background:#c62a78')
    expect(glyph).not.toContain('bg-(--surface-inverse)')
  })

  it('keeps the brand diamond plateless (no painted background, color inert)', () => {
    const brand = renderToStaticMarkup(
      <AgentIconPicker value={{ kind: 'glyph', glyph: 'agentconnect', color: '#1a212b' }} runtime="" size={44} />
    )

    expect(brand).not.toContain('background:#1a212b')
    expect(brand).not.toContain('bg-(--surface-inverse)')
    expect(brand).toContain('#f2c64a') // the native logo's facet fill renders
  })

  it('disabled renders a display-only avatar — no pencil, no picker button (built-ins)', () => {
    const markup = renderToStaticMarkup(
      <AgentIconPicker
        value={{ kind: 'glyph', glyph: 'agentconnect', color: '#1a212b' }}
        runtime=""
        size={44}
        disabled
      />
    )

    expect(markup).toContain('#f2c64a') // the avatar itself still shows
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('Choose icon')
  })
})
