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
})
