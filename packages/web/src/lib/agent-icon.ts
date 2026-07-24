// Agent console avatar (the "Agent Avatar" picker). Mirrors the wire/DB descriptor.
// AGENT_ICON_GLYPHS MUST match the protocol enum (`@agentconnect.md/protocol`
// AGENT_ICON_GLYPHS, re-exported by control-plane's agent-icon.ts) — the CP DTO
// validates `glyph` against it and the icon endpoint only renders these, so a glyph
// offered here but absent there would 400 on save. Web can't import protocol; keep
// this list in sync by hand.

/** A stored agent/org icon: a runtime mark, a Lucide glyph on a color plate, or an
 *  uploaded image. The WIRE `image` variant carries no url (the bytes live in the object
 *  store, the URL comes from the DTO's separate `iconUrl`); the web REASSEMBLES it into
 *  `{kind:'image', url}` at the DTO boundary (agentFromDto/orgFromDto) so every renderer
 *  keeps using `icon.url` unchanged. */
export type AgentIcon =
  { kind: 'runtime' } | { kind: 'glyph'; glyph: string; color: string } | { kind: 'image'; url: string }

/** Fold the DTO's separate `iconUrl` back into the icon descriptor: the wire `image`
 *  variant carries no url, so reassemble `{kind:'image', url}` for the renderers. Called
 *  at the fetch boundary (agentFromDto and the org render sites). */
export function withIconUrl(icon: AgentIcon | null | undefined, iconUrl: string | null | undefined): AgentIcon | null {
  if (icon && icon.kind === 'image') return { kind: 'image', url: iconUrl ?? '' }
  return icon ?? null
}

/** Lucide icon names offered by the picker. */
export const AGENT_ICON_GLYPHS = [
  'bot',
  'cpu',
  'terminal',
  'code',
  'rocket',
  'zap',
  'bug',
  'git-branch',
  'message-square',
  'sparkles',
  'brain',
  'wrench',
  'ship',
  'box',
  'hexagon',
  'compass',
  'atom',
  'flame',
  'star',
  'heart',
  'globe',
  'database',
  'shield',
  'feather'
] as const

/** Color plates (hex). Brand magenta first, then the accent/health hues. */
export const AGENT_ICON_COLORS = ['#c62a78', '#2a6fdb', '#2e9e5b', '#e0912f', '#8b5cf6', '#0d9488', '#dc4b4b'] as const

/** `#rrggbb` — the only color shape the CP accepts for a glyph icon. */
export const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/

/** Neutral dark plate rendered behind runtime/image marks (mirrors the CP renderer's
 *  DARK_PLATE). The background_color fallback for non-glyph icons. */
export const AGENT_ICON_DARK_PLATE = '#1a212b'

/** The agent icon's background PLATE color (hex) — used as the created Slack app's
 *  manifest `background_color` so the app's branding matches the agent's avatar.
 *  Mirrors the CP `agentIconBackgroundColor` so the auto and manual install paths
 *  produce the SAME color for a given agent. */
export function agentIconBackgroundColor(icon: AgentIcon | null | undefined): string {
  if (icon?.kind === 'glyph' && HEX_COLOR_RE.test(icon.color)) return icon.color
  return AGENT_ICON_DARK_PLATE
}

/** The create-time default the Add-agent modal pre-fills: a random glyph+color combo. */
export function randomGlyphIcon(): AgentIcon {
  const glyph = AGENT_ICON_GLYPHS[Math.floor(Math.random() * AGENT_ICON_GLYPHS.length)] ?? 'bot'
  const color = AGENT_ICON_COLORS[Math.floor(Math.random() * AGENT_ICON_COLORS.length)] ?? AGENT_ICON_COLORS[0]
  return { kind: 'glyph', glyph, color }
}
