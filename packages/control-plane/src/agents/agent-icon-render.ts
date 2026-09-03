/**
 * Server-side SVG composition for the public agent-icon endpoint
 * (`GET /v1/agents/:id/icon`). The composed square SVG is rasterized to PNG by
 * the route so Slack can use it as a per-message `icon_url` (Slack does not render
 * SVG avatars), and reused when platform profile APIs require raster bytes. The
 * console renders the same descriptor client-side.
 *
 * Glyph inner-SVGs are derived at load from the framework-agnostic `lucide` core
 * package — the same icon data (and version) the web console renders via
 * `lucide-react`, so the PNG and the console match without any hand-copied paths.
 * Keep the `lucide` dependency pinned to the same version as web's `lucide-react`.
 * The 3 runtime marks mirror `packages/web/src/components/marks.tsx` (`AgentMark`).
 */
import type { AgentIcon } from '@agentconnect.md/protocol'
import { AGENT_ICON_GLYPHS } from '@agentconnect.md/protocol'
import { icons, type IconNode } from 'lucide'
import { HEX_COLOR_RE, AGENT_ICON_DARK_PLATE as DARK_PLATE } from './agent-icon.js'

/** lucide's `icons` is typed with literal PascalCase keys; view it as a plain lookup
 *  so a computed glyph name resolves to its node data (or `undefined` if absent). */
const LUCIDE_ICONS = icons as unknown as Record<string, IconNode | undefined>

/** kebab-case glyph name (the enum/wire form) → PascalCase key in lucide's `icons` map. */
function toPascalCase(name: string): string {
  return name
    .split('-')
    .map((s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s))
    .join('')
}

/** Serialize a lucide `IconNode` ([tag, attrs][]) to inner SVG markup — the 24×24,
 *  stroke-based children our composed `<svg>` wraps. Drops lucide's `key` attr. */
function serializeIconNode(node: IconNode): string {
  return node
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k, v]) => k !== 'key' && v !== undefined)
        .map(([k, v]) => `${k}="${v}"`)
        .join(' ')
      return `<${tag} ${a}/>`
    })
    .join('')
}

/** The AgentConnect brand diamond (24×24 fills) — the built-in preset agents'
 *  fixed identity. NOT a Lucide stroke glyph: it carries its own facet fills, so
 *  the composer renders it without the white-stroke group treatment. Mirrors web
 *  `LogoMark` (marks.tsx) at half scale (48-box → 24-box). */
export const BRAND_GLYPH_INNER =
  '<polygon points="12,2.5 21.5,12 12,12" fill="#f2c64a"/>' +
  '<polygon points="21.5,12 12,21.5 12,12" fill="#f4793a"/>' +
  '<polygon points="12,21.5 2.5,12 12,12" fill="#7c3ca2"/>' +
  '<polygon points="2.5,12 12,2.5 12,12" fill="#d83f96"/>'

/** Inner Lucide markup for each curated glyph, derived from `lucide` core keyed by
 *  {@link AGENT_ICON_GLYPHS}. The brand diamond is hand-carried (lucide has no such
 *  icon). Any other name lucide doesn't ship is skipped here and degrades to the
 *  `bot` fallback at render (a test asserts every enum glyph is present). */
export const GLYPH_SVG_INNER: Record<string, string> = Object.fromEntries(
  AGENT_ICON_GLYPHS.flatMap((g): [string, string][] => {
    if (g === 'agentconnect') return [[g, BRAND_GLYPH_INNER]]
    const node = LUCIDE_ICONS[toPascalCase(g)]
    return node ? [[g, serializeIconNode(node)]] : []
  })
)

/** Runtime brand marks (24×24), mirroring web `AgentMark`. Each fills its box. */
function runtimeMarkInner(runtime: string): string {
  const m = (runtime || '').toLowerCase()
  if (m.includes('codex') || m.includes('gpt') || m.includes('openai'))
    return '<circle cx="12" cy="12" r="11" fill="#10A37F"/><path d="M12 6.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zm0 2a3.5 3.5 0 110 7 3.5 3.5 0 010-7z" fill="#fff"/>'
  if (m.includes('opencode'))
    return '<rect x="1" y="1" width="22" height="22" rx="6" fill="#c62a78"/><path d="M7 9l3.2 3-3.2 3M12.5 15.4H17" stroke="#fff" stroke-width="1.9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
  // Claude (default / fallback runtime): the starburst.
  return '<path d="M12 2C12.8 8 16 11.2 22 12 16 12.8 12.8 16 12 22 11.2 16 8 12.8 2 12 8 11.2 11.2 8 12 2Z" fill="#D97757"/>'
}

/** A full-bleed 64×64 group placing a 24×24 mark centered at ~`fraction` of the box. */
function centered(inner24: string, fraction: number, extraGroupAttrs = ''): string {
  const target = 64 * fraction
  const scale = target / 24
  const offset = (64 - target) / 2
  return `<g transform="translate(${offset.toFixed(2)} ${offset.toFixed(2)}) scale(${scale.toFixed(3)})"${extraGroupAttrs}>${inner24}</g>`
}

/**
 * Compose the square SVG for an agent icon. `runtime`/`glyph` render to a plate;
 * `image`/null map elsewhere (image → redirect at the route; null → runtime mark).
 * `runtime` may be null (an unplaced deferred-config agent): the mark falls back
 * to the default starburst — presets carry a glyph icon and never reach it.
 */
export function buildAgentIconSvg(icon: AgentIcon | null, runtime: string | null): string {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
  if (icon?.kind === 'glyph') {
    if (icon.glyph === 'agentconnect') {
      // Brand diamond: the native logo, plateless — transparent background,
      // `color` inert, no white-stroke treatment (it carries its own facet fills).
      return `${open}${centered(BRAND_GLYPH_INNER, 1)}</svg>`
    }
    const color = HEX_COLOR_RE.test(icon.color) ? icon.color : DARK_PLATE
    const glyph = GLYPH_SVG_INNER[icon.glyph] ?? GLYPH_SVG_INNER.bot ?? ''
    const stroke = ' fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    return `${open}<rect width="64" height="64" fill="${color}"/>${centered(glyph, 0.56, stroke)}</svg>`
  }
  // runtime kind (and null/legacy default): the brand mark on a dark plate.
  return `${open}<rect width="64" height="64" fill="${DARK_PLATE}"/>${centered(runtimeMarkInner(runtime ?? ''), 0.62)}</svg>`
}

/** Composed icon SVGs are shapes only, never `<text>`, so skip resvg's system-font scan — it costs ~180ms of every render. */
export const ICON_RENDER_FONT = { loadSystemFonts: false }

/** Rasterize the console descriptor for consumers that require uploaded image
 * bytes rather than an SVG or public URL (the icon endpoint and bot profile setup).
 * Keep the native module lazy so a load failure degrades only the calling feature,
 * never Control Plane boot. */
export async function renderAgentIconPng(icon: AgentIcon | null, runtime: string | null, width = 128): Promise<Buffer> {
  const { Resvg } = await import('@resvg/resvg-js')
  const svg = buildAgentIconSvg(icon, runtime)
  return Buffer.from(
    new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: ICON_RENDER_FONT }).render().asPng()
  )
}
