/**
 * Server-side SVG composition for the public agent-icon endpoint
 * (`GET /v1/agents/:id/icon`). The composed square SVG is rasterized to PNG by
 * the route so Slack can use it as a per-message `icon_url` (Slack does not render
 * SVG avatars). The console renders the same descriptor client-side, so this is
 * the Slack-facing path only.
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

/** Inner Lucide markup for each curated glyph, derived from `lucide` core keyed by
 *  {@link AGENT_ICON_GLYPHS}. A name lucide doesn't ship is skipped here and degrades
 *  to the `bot` fallback at render (a test asserts every enum glyph is present). */
export const GLYPH_SVG_INNER: Record<string, string> = Object.fromEntries(
  AGENT_ICON_GLYPHS.flatMap((g) => {
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
 */
export function buildAgentIconSvg(icon: AgentIcon | null, runtime: string): string {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">'
  if (icon?.kind === 'glyph') {
    const color = HEX_COLOR_RE.test(icon.color) ? icon.color : DARK_PLATE
    const glyph = GLYPH_SVG_INNER[icon.glyph] ?? GLYPH_SVG_INNER.bot ?? ''
    const stroke = ' fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    return `${open}<rect width="64" height="64" fill="${color}"/>${centered(glyph, 0.56, stroke)}</svg>`
  }
  // runtime kind (and null/legacy default): the brand mark on a dark plate.
  return `${open}<rect width="64" height="64" fill="${DARK_PLATE}"/>${centered(runtimeMarkInner(runtime), 0.62)}</svg>`
}
