import { describe, expect, it } from 'vitest'
import { buildSlackManifest } from './slack-manifest'

describe('buildSlackManifest', () => {
  it('brands the app with the given background_color, and omits it otherwise', () => {
    // No color ⇒ no background_color key (mirrors the CP auto-install manifest).
    expect(buildSlackManifest({ name: 'acme' }).display_information.background_color).toBeUndefined()
    // A color (from the owning agent's icon) ⇒ display_information.background_color.
    const branded = buildSlackManifest({ name: 'acme' }, { backgroundColor: '#c62a78' })
    expect(branded.display_information.background_color).toBe('#c62a78')
  })
})
