import { describe, it, expect } from 'vitest'
import {
  AGENT_ICON_COLORS,
  AGENT_ICON_DARK_PLATE,
  AGENT_ICON_GLYPHS,
  agentIconBackgroundColor,
  parseAgentIcon,
  randomGlyphIcon,
  resolveAgentIconUrl
} from './agent-icon.js'
import { buildAgentIconSvg, GLYPH_SVG_INNER } from './agent-icon-render.js'

describe('randomGlyphIcon', () => {
  it('returns a glyph icon drawn from the curated vocabularies', () => {
    const icon = randomGlyphIcon(() => 0)
    expect(icon).toEqual({ kind: 'glyph', glyph: AGENT_ICON_GLYPHS[0], color: AGENT_ICON_COLORS[0] })
  })

  it('maps rand near 1 to the last entries without overflowing', () => {
    const icon = randomGlyphIcon(() => 0.999)
    expect(icon.kind).toBe('glyph')
    if (icon.kind === 'glyph') {
      expect(AGENT_ICON_GLYPHS).toContain(icon.glyph)
      expect(AGENT_ICON_COLORS).toContain(icon.color)
    }
  })
})

describe('agentIconBackgroundColor', () => {
  it("uses a glyph icon's own plate color", () => {
    expect(agentIconBackgroundColor({ kind: 'glyph', glyph: 'bot', color: '#2a6fdb' })).toBe('#2a6fdb')
  })

  it('falls back to the dark plate for runtime / image / null (and invalid glyph colors)', () => {
    expect(agentIconBackgroundColor({ kind: 'runtime' })).toBe(AGENT_ICON_DARK_PLATE)
    expect(agentIconBackgroundColor(null)).toBe(AGENT_ICON_DARK_PLATE)
    expect(agentIconBackgroundColor({ kind: 'glyph', glyph: 'bot', color: 'red' })).toBe(AGENT_ICON_DARK_PLATE)
  })
})

describe('parseAgentIcon', () => {
  it('parses each valid kind', () => {
    expect(parseAgentIcon({ kind: 'runtime' })).toEqual({ kind: 'runtime' })
    expect(parseAgentIcon({ kind: 'glyph', glyph: 'bot', color: '#c62a78' })).toEqual({
      kind: 'glyph',
      glyph: 'bot',
      color: '#c62a78'
    })
    expect(parseAgentIcon({ kind: 'image' })).toEqual({ kind: 'image' })
  })

  it('degrades null / invalid to null (⇒ runtime-mark default)', () => {
    expect(parseAgentIcon(null)).toBeNull()
    expect(parseAgentIcon(undefined)).toBeNull()
    expect(parseAgentIcon({ kind: 'nope' })).toBeNull()
  })

  it('rejects a glyph outside the curated set (⇒ null, not a silent bot fallback)', () => {
    expect(parseAgentIcon({ kind: 'glyph', glyph: 'not-a-lucide-icon', color: '#c62a78' })).toBeNull()
  })
})

describe('glyph vocabulary', () => {
  it('the PNG renderer covers every curated glyph (enum ↔ renderer aligned)', () => {
    for (const g of AGENT_ICON_GLYPHS) expect(GLYPH_SVG_INNER[g], `missing SVG for "${g}"`).toBeTruthy()
  })
})

describe('resolveAgentIconUrl', () => {
  const cp = 'https://cp.example.com'
  const store = 'https://store.example.com'
  it('resolves an image icon to the object store URL for the agent key (cache-busted)', () => {
    expect(resolveAgentIconUrl('a1', { kind: 'image' }, { cp, store }, 5)).toBe(
      'https://store.example.com/icon/agents/a1?v=5'
    )
  })
  it('falls back to the CP endpoint for an image icon when no store base is configured', () => {
    expect(resolveAgentIconUrl('a1', { kind: 'image' }, { cp }, 5)).toBe('https://cp.example.com/v1/agents/a1/icon?v=5')
  })
  it('points glyph/runtime/null at the public icon endpoint with a cache-busting version', () => {
    expect(resolveAgentIconUrl('a1', { kind: 'glyph', glyph: 'bot', color: '#c62a78' }, { cp }, 5)).toBe(
      'https://cp.example.com/v1/agents/a1/icon?v=5'
    )
    expect(resolveAgentIconUrl('a1', { kind: 'runtime' }, { cp }, 7)).toBe(
      'https://cp.example.com/v1/agents/a1/icon?v=7'
    )
    expect(resolveAgentIconUrl('a1', null, { cp: cp + '/' }, 9)).toBe('https://cp.example.com/v1/agents/a1/icon?v=9')
  })
  it('returns null for glyph/runtime when no base is configured', () => {
    expect(resolveAgentIconUrl('a1', { kind: 'glyph', glyph: 'bot', color: '#c62a78' }, {}, 5)).toBeNull()
    expect(resolveAgentIconUrl('a1', null, {}, 5)).toBeNull()
  })
})

describe('buildAgentIconSvg', () => {
  it('renders a glyph on its color plate', () => {
    const svg = buildAgentIconSvg({ kind: 'glyph', glyph: 'terminal', color: '#2a6fdb' }, 'claude')
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('fill="#2a6fdb"')
    expect(svg).toContain('stroke="#fff"')
  })

  it('ignores a non-hex color (no injection) and uses the dark plate', () => {
    const svg = buildAgentIconSvg({ kind: 'glyph', glyph: 'bot', color: '"/><script>' }, 'claude')
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('fill="#1a212b"')
  })

  it('renders the runtime brand mark for runtime/null', () => {
    expect(buildAgentIconSvg({ kind: 'runtime' }, 'codex')).toContain('#10A37F') // OpenAI green
    expect(buildAgentIconSvg(null, 'claude')).toContain('#D97757') // Claude starburst
  })
})
