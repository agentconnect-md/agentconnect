// The Teams app package an admin uploads (teams-integration.md §5): manifest.json and two icons, built from the integration's rows on each download.
import { createHash } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { PLATFORM_APP_DESCRIPTION } from '../../http/platform-app-description.js'
import { loadBotProfileIcon, type BotProfileIconAgent } from '../../http/bot-profile-icon.js'
import { renderAgentIconPng, GLYPH_SVG_INNER, ICON_RENDER_FONT } from '../../agents/agent-icon-render.js'
import type { IconStore } from '../../icons/icon-store.js'

export const MSTEAMS_MANIFEST_SCHEMA =
  'https://developer.microsoft.com/json-schemas/teams/v1.30/MicrosoftTeams.schema.json'
export const MSTEAMS_MANIFEST_VERSION = '1.30'
export const MSTEAMS_APP_PACKAGE_FILENAME = 'agentconnect-teams.zip'

// The publisher Teams shows on the app's details page.
export const MSTEAMS_DEVELOPER = {
  name: 'AgentConnect',
  websiteUrl: 'https://www.agentconnect.md',
  privacyUrl: 'https://www.agentconnect.md/privacy/',
  termsOfUseUrl: 'https://www.agentconnect.md/terms/'
} as const

// The RSC grants that deliver every message in a team's channels and a group chat, without a mention (§4.1).
export const MSTEAMS_RSC_PERMISSIONS = [
  { name: 'ChannelMessage.Read.Group', type: 'Application' },
  { name: 'ChatMessage.Read.Chat', type: 'Application' }
] as const

// The UUIDv5 namespace of package IDs; changing it would turn every re-download into a new Teams app.
const PACKAGE_ID_NAMESPACE = '0cc55bcd-23e6-454c-af9c-2026d6684b66'

/** RFC 9562 UUIDv5 of `name` under `namespace`. */
export function uuidV5(name: string, namespace: string): string {
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** The manifest `id`, derived from the bot's app ID so every download, even after a reinstall, updates the same Teams app. */
export function msTeamsPackageId(appId: string): string {
  return uuidV5(appId.toLowerCase(), PACKAGE_ID_NAMESPACE)
}

/** A version that grows with every download (`1.<UTC date>.<UTC hhmm>`), which Teams requires of an updated package. */
export function msTeamsPackageVersion(nowMs: number): string {
  const d = new Date(nowMs)
  const date = d.getUTCFullYear() * 10_000 + (d.getUTCMonth() + 1) * 100 + d.getUTCDate()
  return `1.${date}.${d.getUTCHours() * 100 + d.getUTCMinutes()}`
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export interface MsTeamsManifestInput {
  appId: string
  /** The relay's public host, the bot's only web domain. */
  relayHost: string
  agentName: string
  accentColor: string
  nowMs: number
}

/** The manifest Teams validates on upload; every field below is required for a bot with the `team` scope (§5). */
export function msTeamsManifest(input: MsTeamsManifestInput): Record<string, unknown> {
  const name = input.agentName.trim() || 'AgentConnect agent'
  return {
    $schema: MSTEAMS_MANIFEST_SCHEMA,
    manifestVersion: MSTEAMS_MANIFEST_VERSION,
    version: msTeamsPackageVersion(input.nowMs),
    id: msTeamsPackageId(input.appId),
    developer: { ...MSTEAMS_DEVELOPER },
    name: { short: clip(name, 30), full: clip(name, 100) },
    description: { short: PLATFORM_APP_DESCRIPTION, full: clip(`${name} is an ${PLATFORM_APP_DESCRIPTION}`, 4000) },
    icons: { color: 'color.png', outline: 'outline.png' },
    accentColor: input.accentColor,
    bots: [
      {
        botId: input.appId,
        scopes: ['personal', 'team', 'groupChat'],
        supportsFiles: false,
        isNotificationOnly: false
      }
    ],
    validDomains: [input.relayHost],
    webApplicationInfo: { id: input.appId, resource: `api://${input.relayHost}/${input.appId}` },
    authorization: { permissions: { resourceSpecific: MSTEAMS_RSC_PERMISSIONS.map((p) => ({ ...p })) } },
    // Teams refuses a v1.25+ manifest with the `team` scope without it (measured).
    supportsChannelFeatures: 'tier1'
  }
}

const COLOR_SIZE = 192
const OUTLINE_SIZE = 32

/** The agent's icon on its plate at 192×192; an uploaded image that cannot be read falls back to the generated runtime mark. */
async function colorIcon(agent: BotProfileIconAgent, iconStore?: IconStore): Promise<Buffer> {
  const source = await loadBotProfileIcon(agent, iconStore, COLOR_SIZE).catch(async () => ({
    bytes: await renderAgentIconPng(null, agent.runtime, COLOR_SIZE)
  }))
  const { default: sharp } = await import('sharp')
  return sharp(source.bytes).resize(COLOR_SIZE, COLOR_SIZE, { fit: 'cover' }).png().toBuffer()
}

const DIAMOND_OUTLINE = '<polygon points="12,2.5 21.5,12 12,21.5 2.5,12"/>'

/** The agent's glyph, or the bot glyph, stroked white on transparent at 32×32 as Teams requires of an outline icon. */
async function outlineIcon(agent: BotProfileIconAgent): Promise<Buffer> {
  const icon = agent.icon
  const inner =
    icon?.kind === 'glyph' && icon.glyph === 'agentconnect'
      ? DIAMOND_OUTLINE
      : ((icon?.kind === 'glyph' ? GLYPH_SVG_INNER[icon.glyph] : undefined) ?? GLYPH_SVG_INNER.bot ?? '')
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24">' +
    `<g fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</g></svg>`
  const { Resvg } = await import('@resvg/resvg-js')
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: OUTLINE_SIZE }, font: ICON_RENDER_FONT }).render().asPng()
  return Buffer.from(png)
}

/** Both package icons for an agent. */
export async function msTeamsAppIcons(
  agent: BotProfileIconAgent,
  iconStore?: IconStore
): Promise<{ color: Uint8Array; outline: Uint8Array }> {
  const [color, outline] = await Promise.all([colorIcon(agent, iconStore), outlineIcon(agent)])
  return { color, outline }
}

/** The zip Teams accepts: the three files at the archive root. */
export function msTeamsAppPackage(
  manifest: Record<string, unknown>,
  icons: { color: Uint8Array; outline: Uint8Array }
): Uint8Array {
  return zipSync(
    {
      'manifest.json': strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
      'color.png': [icons.color, { level: 0 }],
      'outline.png': [icons.outline, { level: 0 }]
    },
    { level: 6 }
  )
}
