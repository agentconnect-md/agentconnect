import { describe, expect, it } from 'vitest'
import { strFromU8, unzipSync } from 'fflate'
import sharp from 'sharp'
import { AgentId } from '../../domain/ids.js'
import type { IconStore } from '../../icons/icon-store.js'
import {
  MSTEAMS_MANIFEST_SCHEMA,
  msTeamsAppIcons,
  msTeamsAppPackage,
  msTeamsManifest,
  msTeamsPackageFingerprint,
  msTeamsPackageId,
  msTeamsPackageVersion,
  uuidV5
} from './app-package.js'

const APP_ID = '00000000-0000-4000-8000-0000000000a1'
const NOW = Date.UTC(2026, 9, 22, 15, 30)
const AGENT = { id: AgentId('00000000-0000-4000-8000-000000000001'), runtime: 'claude' }

const manifestInput = {
  appId: APP_ID,
  relayHost: 'relay.example.test',
  agentName: 'Example agent',
  accentColor: '#1a212b',
  nowMs: NOW
}

describe('Teams package identity', () => {
  it('derives an RFC 9562 UUIDv5', () => {
    // The RFC's DNS-namespace example.
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2'
    )
  })

  it('keeps one package ID per app, whatever its case', () => {
    const id = msTeamsPackageId(APP_ID)
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(msTeamsPackageId(APP_ID.toUpperCase())).toBe(id)
    expect(id).not.toBe(APP_ID)
    expect(msTeamsPackageId('00000000-0000-4000-8000-0000000000a2')).not.toBe(id)
  })

  it('grows the version with each download', () => {
    expect(msTeamsPackageVersion(NOW)).toBe('1.20261022.1530')
    expect(msTeamsPackageVersion(Date.UTC(2026, 9, 22, 0, 5))).toBe('1.20261022.5')
    expect(msTeamsPackageVersion(Date.UTC(2027, 0, 1, 0, 0))).toBe('1.20270101.0')
  })
})

describe('Teams manifest', () => {
  it('names the bot, its scopes, the RSC grants, and the relay as its only domain', () => {
    expect(msTeamsManifest(manifestInput)).toEqual({
      $schema: MSTEAMS_MANIFEST_SCHEMA,
      manifestVersion: '1.30',
      version: '1.20261022.1530',
      id: msTeamsPackageId(APP_ID),
      developer: {
        name: 'AgentConnect',
        websiteUrl: 'https://www.agentconnect.md',
        privacyUrl: 'https://www.agentconnect.md/privacy/',
        termsOfUseUrl: 'https://www.agentconnect.md/terms/'
      },
      name: { short: 'Example agent', full: 'Example agent' },
      description: {
        short: 'AI agent powered by AgentConnect.',
        full: 'Example agent is an AI agent powered by AgentConnect.'
      },
      icons: { color: 'color.png', outline: 'outline.png' },
      accentColor: '#1a212b',
      bots: [
        { botId: APP_ID, scopes: ['personal', 'team', 'groupChat'], supportsFiles: false, isNotificationOnly: false }
      ],
      validDomains: ['relay.example.test'],
      webApplicationInfo: { id: APP_ID, resource: `api://relay.example.test/${APP_ID}` },
      authorization: {
        permissions: {
          resourceSpecific: [
            { name: 'ChannelMessage.Read.Group', type: 'Application' },
            { name: 'ChatMessage.Read.Chat', type: 'Application' },
            { name: 'ChannelSettings.Read.Group', type: 'Application' },
            { name: 'ChannelMember.Read.Group', type: 'Application' },
            { name: 'TeamSettings.Read.Group', type: 'Application' },
            { name: 'OnlineMeeting.ReadBasic.Chat', type: 'Application' },
            { name: 'OnlineMeetingTranscript.Read.Chat', type: 'Application' }
          ]
        }
      },
      supportsChannelFeatures: 'tier1'
    })
  })

  it('fits a long agent name into the short and full name limits', () => {
    const manifest = msTeamsManifest({ ...manifestInput, agentName: 'x'.repeat(120) }) as {
      name: { short: string; full: string }
      description: { short: string }
    }
    expect(manifest.name.short).toHaveLength(30)
    expect(manifest.name.short.endsWith('…')).toBe(true)
    expect(manifest.name.full).toHaveLength(100)
    expect(manifest.description.short.length).toBeLessThanOrEqual(80)
  })
})

describe('Teams package fingerprint', () => {
  const { nowMs: _now, ...input } = manifestInput
  const glyph = { ...AGENT, icon: { kind: 'glyph' as const, glyph: 'bot', color: 'blue' } } as never

  it('ignores the version but follows the name, the icon, and the manifest', () => {
    const fingerprint = msTeamsPackageFingerprint(input, glyph)
    expect(fingerprint).toMatch(/^[\w-]{22}$/)
    expect(msTeamsPackageFingerprint(input, glyph)).toBe(fingerprint)
    expect(msTeamsPackageFingerprint({ ...input, agentName: 'Renamed' }, glyph)).not.toBe(fingerprint)
    expect(msTeamsPackageFingerprint({ ...input, relayHost: 'relay2.example.test' }, glyph)).not.toBe(fingerprint)
    const recolored = { ...AGENT, icon: { kind: 'glyph' as const, glyph: 'bot', color: 'green' } } as never
    expect(msTeamsPackageFingerprint(input, recolored)).not.toBe(fingerprint)
  })

  it('follows the runtime mark only while the agent has no icon of its own', () => {
    const codex = { ...AGENT, runtime: 'codex' }
    expect(msTeamsPackageFingerprint(input, { ...AGENT, icon: null })).not.toBe(
      msTeamsPackageFingerprint(input, { ...codex, icon: null })
    )
  })
})

describe('Teams app package', () => {
  it('zips the manifest and both icons at the archive root', async () => {
    const icons = await msTeamsAppIcons({ ...AGENT, icon: { kind: 'glyph', glyph: 'rocket', color: '#2f6fed' } })
    const files = unzipSync(msTeamsAppPackage(msTeamsManifest(manifestInput), icons))
    expect(Object.keys(files).sort()).toEqual(['color.png', 'manifest.json', 'outline.png'])
    expect(JSON.parse(strFromU8(files['manifest.json']!))).toEqual(msTeamsManifest(manifestInput))

    const color = await sharp(files['color.png']!).metadata()
    expect([color.format, color.width, color.height]).toEqual(['png', 192, 192])
    const outline = sharp(files['outline.png']!)
    const meta = await outline.metadata()
    expect([meta.format, meta.width, meta.height, meta.channels]).toEqual(['png', 32, 32, 4])
    // White strokes on transparent: every pixel is either clear or white.
    const { data } = await outline.raw().toBuffer({ resolveWithObject: true })
    let opaque = 0
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] === 0) continue
      opaque++
      expect([data[i], data[i + 1], data[i + 2]]).toEqual([255, 255, 255])
    }
    expect(opaque).toBeGreaterThan(0)
  })

  it('uses an uploaded icon, and falls back to the generated mark when it cannot be read', async () => {
    const uploaded = await sharp({
      create: { width: 300, height: 200, channels: 3, background: { r: 200, g: 40, b: 40 } }
    })
      .png()
      .toBuffer()
    const store = { get: async () => ({ bytes: uploaded, contentType: 'image/png' }) } as unknown as IconStore
    const image = { ...AGENT, icon: { kind: 'image' as const } }

    const fromUpload = await msTeamsAppIcons(image, store)
    const pixel = await sharp(fromUpload.color).extract({ left: 96, top: 96, width: 1, height: 1 }).raw().toBuffer()
    expect([...pixel.subarray(0, 3)]).toEqual([200, 40, 40])

    const fallback = await msTeamsAppIcons(image)
    expect(await sharp(fallback.color).metadata()).toMatchObject({ format: 'png', width: 192, height: 192 })
  })
})
