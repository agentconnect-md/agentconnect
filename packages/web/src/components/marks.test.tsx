import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentIconView, OrgIconView, PlatformMark, modelProviderSlug } from './marks'

describe('modelProviderSlug', () => {
  it('reads the provider prefix from provider/model ids', () => {
    expect(modelProviderSlug('deepseek/deepseek-v4-flash')).toBe('deepseek')
    expect(modelProviderSlug('anthropic/claude-sonnet-4-5')).toBe('claude')
    expect(modelProviderSlug('x-ai/grok-4')).toBe('grok')
  })
  it('infers the family from a bare model id', () => {
    expect(modelProviderSlug('claude-sonnet-4-5')).toBe('claude')
    expect(modelProviderSlug('gpt-5-mini')).toBe('openai')
    expect(modelProviderSlug('deepseek-v4-flash')).toBe('deepseek')
  })
  it('falls back to the raw prefix for an unknown provider/model, else null', () => {
    expect(modelProviderSlug('acme/whatever-1')).toBe('acme')
    expect(modelProviderSlug('mystery-model')).toBeNull()
    expect(modelProviderSlug('')).toBeNull()
  })
})

describe('icon views', () => {
  it('identifies glyph icons so their parent does not show a dark edge', () => {
    const markup = renderToStaticMarkup(
      <AgentIconView icon={{ kind: 'glyph', glyph: 'cpu', color: '#0d9488' }} runtime="" size={44} />
    )

    expect(markup).toContain('background:#0d9488')
    expect(markup).toContain('data-agent-icon-glyph="true"')
    expect(markup).not.toContain('box-shadow')
  })

  it('renders the brand diamond plateless — the native logo, its stored color inert', () => {
    const markup = renderToStaticMarkup(
      <AgentIconView icon={{ kind: 'glyph', glyph: 'agentconnect', color: '#1a212b' }} runtime="" size={44} />
    )

    expect(markup).toContain('data-agent-icon-glyph="true"')
    expect(markup).toContain('#f2c64a') // a facet fill of the diamond
    expect(markup).not.toContain('background') // no plate behind the native logo
    expect(markup).not.toContain('#1a212b')
  })

  it('renders uploaded images on a white plate so transparent pixels stay neutral', () => {
    const markup = renderToStaticMarkup(
      <AgentIconView icon={{ kind: 'image', url: 'https://cdn.example.test/icon.webp' }} runtime="" size={44} />
    )

    expect(markup).toContain('src="https://cdn.example.test/icon.webp"')
    expect(markup).toContain('bg-white')
    expect(markup).toContain('data-agent-icon-image="true"')
  })

  it('uses the uploaded org icon and keeps an initial fallback for legacy orgs', () => {
    const uploaded = renderToStaticMarkup(
      <OrgIconView
        icon={{ kind: 'image', url: '' }}
        iconUrl="https://cdn.example.test/org.webp"
        label="Acme"
        fallbackColor="#0f7a48"
        size={22}
        className="rounded-[5px] text-[11px]"
      />
    )
    const legacy = renderToStaticMarkup(
      <OrgIconView
        icon={null}
        iconUrl={null}
        label="Acme"
        fallbackColor="#0f7a48"
        size={22}
        className="rounded-[5px] text-[11px]"
      />
    )

    expect(uploaded).toContain('src="https://cdn.example.test/org.webp"')
    expect(uploaded).not.toContain('>A<')
    expect(legacy).toContain('background:#0f7a48')
    expect(legacy).toContain('>A<')
  })
})

describe('PlatformMark', () => {
  it('applies the requested fill once to the GitHub mark', () => {
    const inset = renderToStaticMarkup(<PlatformMark platform="github" />)
    const full = renderToStaticMarkup(<PlatformMark platform="github" fillPct={100} />)

    expect(inset).toContain('width:60%')
    expect(inset).toContain('height:60%')
    expect(inset).toContain('display:block')
    expect(inset.match(/width:60%/g)).toHaveLength(1)
    expect(inset).toContain('<svg')
    expect(inset).not.toContain('<span')
    expect(full).toContain('width:100%')
    expect(full).toContain('height:100%')
    expect(full).toContain('display:block')
    expect(full).not.toContain('width:60%')
  })
})
