/**
 * Agent console avatar (the Console "Agent Avatar" picker).
 *
 * The stored descriptor is the protocol {@link AgentIcon} discriminated union:
 *   - `runtime` — derive the mark from the agent's runtime (also the meaning of a
 *     null/absent icon; the legacy behavior).
 *   - `glyph`   — a Lucide glyph on a solid color plate. The create-time default
 *     is a RANDOM glyph+color (per product: new agents are not runtime-branded).
 *   - `image`   — an external image referenced by public https URL.
 *
 * This module owns the curated glyph/color vocabularies (mirrored by the web
 * picker), the random default, parsing, and the SVG render used by the public
 * icon endpoint. Keep {@link AGENT_ICON_GLYPHS}/{@link AGENT_ICON_COLORS} in sync
 * with `packages/web/src/lib/agent-icon.ts`.
 */
import { AgentIcon, AGENT_ICON_GLYPHS } from '@agentconnect.md/protocol'
import { agentIconKey, orgIconKey, joinPublicUrl } from '../icons/icon-store.js'

// Curated glyph names live in the protocol package (the single source shared with
// the DTO enum + the icon-endpoint renderer). Re-exported here for local callers.
export { AGENT_ICON_GLYPHS }

/** Color plates (hex). Brand magenta first; the rest are the health/accent hues. */
export const AGENT_ICON_COLORS = ['#c62a78', '#2a6fdb', '#2e9e5b', '#e0912f', '#8b5cf6', '#0d9488', '#dc4b4b'] as const

/** Strict `#rrggbb` — enforced on the wire so a glyph color can be inlined into
 *  SVG `fill=` at the icon endpoint without any injection risk. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** Neutral dark plate the icon endpoint renders behind runtime/image marks (the
 *  design's "agents = dark squares"). Shared with the SVG renderer (agent-icon-render). */
export const AGENT_ICON_DARK_PLATE = '#1a212b'

/** The agent icon's background PLATE color (hex), used as the created Slack app's
 *  manifest `background_color` so the app's branding matches the agent's avatar
 *  (the closest an app icon gets — Slack has no API to set the app image itself).
 *  A `glyph` icon uses its own plate color (the common case: new agents default to
 *  a random glyph+color); the plateless brand diamond (`agentconnect`, its `color`
 *  inert) and `runtime`/`image`/null fall back to the neutral dark plate the icon
 *  endpoint draws behind runtime marks. Always a valid `#rrggbb`. */
export function agentIconBackgroundColor(icon: AgentIcon | null): string {
  if (icon?.kind === 'glyph' && icon.glyph !== 'agentconnect' && HEX_COLOR_RE.test(icon.color)) return icon.color
  return AGENT_ICON_DARK_PLATE
}

/**
 * The create-time default: a random glyph+color combo. `rand` is injectable so
 * tests are deterministic; production uses `Math.random`. The brand diamond is
 * excluded — it is the built-in presets' fixed identity, never a random draw.
 */
const RANDOM_GLYPHS = AGENT_ICON_GLYPHS.filter((g) => g !== 'agentconnect')

export function randomGlyphIcon(rand: () => number = Math.random): AgentIcon {
  const glyph = RANDOM_GLYPHS[Math.floor(rand() * RANDOM_GLYPHS.length)] ?? 'bot'
  const color = AGENT_ICON_COLORS[Math.floor(rand() * AGENT_ICON_COLORS.length)] ?? AGENT_ICON_COLORS[0]
  return { kind: 'glyph', glyph, color }
}

/** A deterministic glyph+color for an org with no stored icon (legacy rows). Keyed
 *  off the org id so the "default" avatar is stable across reloads without any
 *  text/font rendering (orgs have no runtime mark to fall back to). */
export function defaultOrgGlyphIcon(orgId: string): AgentIcon {
  let h = 0
  for (let i = 0; i < orgId.length; i++) h = (h * 31 + orgId.charCodeAt(i)) >>> 0
  const glyph = AGENT_ICON_GLYPHS[h % AGENT_ICON_GLYPHS.length] ?? 'bot'
  const color = AGENT_ICON_COLORS[(h >>> 8) % AGENT_ICON_COLORS.length] ?? AGENT_ICON_COLORS[0]
  return { kind: 'glyph', glyph, color }
}

/** Parse a stored JSONB icon into an {@link AgentIcon}; null on absent/invalid so
 *  a corrupt row degrades to the runtime-mark default rather than throwing. */
export function parseAgentIcon(raw: unknown): AgentIcon | null {
  if (raw === null || raw === undefined) return null
  const parsed = AgentIcon.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/** Public path of the icon endpoint. Mirrors `SLACK_OAUTH_CALLBACK_PATH`'s `/v1`
 *  form — the edge rewrites `/v1` → the internal `/api/v1`, and the CP also mounts
 *  a `/v1` alias for direct-hit deploys (see http/server.ts). */
export function agentIconPublicPath(agentId: string): string {
  return `/v1/agents/${agentId}/icon`
}

/** Public path of the org icon endpoint (console-only; never fed to Slack). */
export function orgIconPublicPath(orgId: string): string {
  return `/v1/orgs/${orgId}/icon`
}

/** The public bases the icon-URL resolver draws from. Both optional so a deploy
 *  that configures neither still returns null (Slack keeps its default avatar). */
export interface IconUrlBases {
  /** PUBLIC_CP_URL — where the CP icon endpoint (glyph/runtime PNG) is reachable. */
  cp?: string
  /** S3_PUBLIC_BASE_URL — where uploaded `image` icons are served. */
  store?: string
}

/**
 * Resolve the absolute, publicly-fetchable avatar URL the CP ships to the daemon
 * as {@link AgentSpec.iconUrl} (→ Slack `icon_url`) and surfaces as the DTO `iconUrl`:
 *  - `image`  → the object store's public URL for the agent's key, when the store
 *    (`bases.store`) is configured; else falls back to the CP endpoint.
 *  - `runtime`/`glyph`/null → the public CP icon endpoint, when `bases.cp`
 *    (PUBLIC_CP_URL) is configured; else null (Slack keeps the app default avatar).
 * `version` (e.g. the agent's lastModified epoch) busts the URL-keyed icon cache
 * (Slack, CDN, browser); an uploaded image's opaque generation takes precedence.
 */
export function resolveAgentIconUrl(
  agentId: string,
  icon: AgentIcon | null,
  bases: IconUrlBases,
  version?: string | number
): string | null {
  const cacheVersion = icon?.kind === 'image' ? (icon.generation ?? version) : version
  if (icon?.kind === 'image' && bases.store) {
    return joinPublicUrl(bases.store, agentIconKey(agentId), cacheVersion)
  }
  if (!bases.cp) return null
  const base = bases.cp.replace(/\/+$/, '')
  const v = cacheVersion !== undefined ? `?v=${encodeURIComponent(String(cacheVersion))}` : ''
  return `${base}${agentIconPublicPath(agentId)}${v}`
}

/**
 * Org-icon equivalent of {@link resolveAgentIconUrl} (console-only surface):
 *  - `image` → the object store's public URL for the org's key (when configured).
 *  - `glyph`/null → the public CP org-icon endpoint (`bases.cp`); else null.
 */
export function resolveOrgIconUrl(
  orgId: string,
  icon: AgentIcon | null,
  bases: IconUrlBases,
  version?: string | number
): string | null {
  const cacheVersion = icon?.kind === 'image' ? (icon.generation ?? version) : version
  if (icon?.kind === 'image' && bases.store) {
    return joinPublicUrl(bases.store, orgIconKey(orgId), cacheVersion)
  }
  if (!bases.cp) return null
  const base = bases.cp.replace(/\/+$/, '')
  const v = cacheVersion !== undefined ? `?v=${encodeURIComponent(String(cacheVersion))}` : ''
  return `${base}${orgIconPublicPath(orgId)}${v}`
}
