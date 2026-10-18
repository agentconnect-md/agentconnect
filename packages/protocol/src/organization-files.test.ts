import { describe, expect, it } from 'vitest'
import { KNOWN_PLATFORMS, SESSION_IDENTITY_PLATFORMS } from './frames/route.js'
import { CHANNEL_PLATFORMS, parseOrganizationFile } from './organization-files.js'

describe('channels.md platforms', () => {
  it('are the known chat platforms, so a new one cannot be missing from the shape', () => {
    const chat = KNOWN_PLATFORMS.filter((p) => !(SESSION_IDENTITY_PLATFORMS as readonly string[]).includes(p))
    expect([...CHANNEL_PLATFORMS].sort()).toEqual([...chat].sort())
  })

  it('parses each line into its platform, name and purpose', () => {
    const parsed = parseOrganizationFile(
      'channels.md',
      '# Channels\n- [slack] release: release trains — (#release, 2026-10-17)\n- [telegram] Ops Room: incidents (#release, 2026-10-16) (inferred)\n'
    )
    expect(parsed.ok && parsed.parsed.file === 'channels.md' && parsed.parsed.channels).toMatchObject([
      { platform: 'slack', channel: 'release', text: 'release trains', inferred: false },
      { platform: 'telegram', channel: 'Ops Room', text: 'incidents', inferred: true }
    ])
  })
})
