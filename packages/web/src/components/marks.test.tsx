import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentIconView, GitlabMark, OrgIconView, PlatformMark, modelProviderSlug } from './marks'

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
    // Org logos keep their white plate on dark — otherwise the tile is just its ring.
    expect(uploaded).toContain('bg-white')
    expect(uploaded).not.toContain('bg-transparent')
    expect(legacy).toContain('background:#0f7a48')
    expect(legacy).toContain('>A<')
  })
})

describe('GitlabMark', () => {
  it('renders the official multi-color tanuki rather than a monochrome glyph', () => {
    const markup = renderToStaticMarkup(<GitlabMark />)

    expect(markup).toContain('<svg')
    // The brand triad, straight from the official logo artwork; the artwork's hex case is upstream's.
    const hex = markup.toUpperCase()
    expect(hex).toContain('#E24329')
    expect(hex).toContain('#FC6D26')
    expect(hex).toContain('#FCA326')
    expect(markup).not.toContain('currentColor')
    expect(markup).toContain('width:60%')
    // The logotype carries the triad too, so pin the SHAPE: a mark is roughly square, it is ~4.6:1.
    const viewBox = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(markup)
    expect(viewBox).not.toBeNull()
    expect(Number(viewBox?.[1]) / Number(viewBox?.[2])).toBeLessThan(1.5)
  })

  it('applies a caller fill verbatim so it matches the GitHub mark beside it', () => {
    // Only PlatformMark caps a full-bleed request; both code-host marks pass it through.
    expect(renderToStaticMarkup(<GitlabMark fillPct={100} />)).toContain('width:100%')
    expect(renderToStaticMarkup(<GitlabMark fillPct={90} />)).toContain('width:90%')
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
    // The full-bleed request is CAPPED at 80% for this mark — see the square-glyph
    // note in PlatformMark. The style is still applied exactly once.
    expect(full).toContain('width:80%')
    expect(full).toContain('height:80%')
    expect(full).toContain('display:block')
    expect(full).not.toContain('width:60%')
  })

  it('caps the square brand glyphs at 80% while other marks honour a full-bleed box', () => {
    // No padding inside this artwork, so an uncapped fillPct=100 would outsize the marks beside it.
    for (const platform of ['github', 'gitlab', 'discord', 'linear']) {
      // Slack belongs here too, but renders without `ssr`, so SSR gives it an empty <span>.
      const markup = renderToStaticMarkup(<PlatformMark platform={platform} fillPct={100} />)
      expect(markup, platform).toContain('width:80%')
      expect(markup, platform).not.toContain('width:100%')
    }
    // Below the cap nothing changes, and an uncapped mark still fills its box.
    expect(renderToStaticMarkup(<PlatformMark platform="discord" fillPct={70} />)).toContain('width:70%')
    expect(renderToStaticMarkup(<PlatformMark platform="telegram" fillPct={100} />)).toContain('width:100%')
  })

  it('uses the filled Lark brand asset for the shared Lark and Feishu platform family', () => {
    const lark = renderToStaticMarkup(<PlatformMark platform="lark" />)
    const feishu = renderToStaticMarkup(<PlatformMark platform="feishu" />)

    expect(lark).toContain('src="/brands/lark.svg"')
    expect(feishu).toContain('src="/brands/lark.svg"')
  })
})
