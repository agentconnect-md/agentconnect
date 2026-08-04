import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PlatformMark } from '@/components/marks'
import { PLATFORM_LABEL_IDS, platformLabel } from '@/lib/platform-labels'
import { PLATFORM_MARK_IDS, platformMark } from './marks'
import { platformRegistry } from './registry'

/**
 * The registry is the single platform-set authority (§10), but two lookups
 * deliberately do NOT read through it — `platforms/marks.ts`, because
 * `PlatformMark` is imported by the signed-out routes and a registry read there
 * would drag the install wizard into their bundles, and `lib/platform-labels.ts`,
 * for the same reason via `lib/data.ts`. Both list the platform ids a second
 * time, so this file is what keeps the copies honest: adding a module without
 * adding its mark or its label fails here rather than shipping a plug glyph and a
 * capitalized id into production.
 */
const ALIASES = ['lark']

describe('platform set', () => {
  it('gives every registered module a mark and a label', () => {
    for (const id of platformRegistry.ids()) {
      expect(platformMark(id), `mark for ${id}`).toBeDefined()
      expect(platformLabel(id), `label for ${id}`).toBeDefined()
    }
  })

  it('adds nothing to the mark and label tables beyond the modules and the known aliases', () => {
    const allowed = [...platformRegistry.ids(), ...ALIASES].sort()
    expect([...PLATFORM_MARK_IDS].sort()).toEqual(allowed)
    expect([...PLATFORM_LABEL_IDS].sort()).toEqual(allowed)
  })

  it('keeps the prose name and the picker label distinct only where they must be', () => {
    // One platform id, two clouds: prose picks the international brand, the
    // picker names both so a Feishu user recognizes their own tile.
    expect(platformLabel('feishu')).toEqual({ name: 'Lark', picker: 'Lark / Feishu' })
    expect(platformLabel('lark')).toEqual(platformLabel('feishu'))
    for (const id of ['slack', 'telegram', 'discord']) {
      const label = platformLabel(id)!
      expect(label.name, id).toBe(label.picker)
    }
  })

  it('renders the same mark through the module and through PlatformMark', () => {
    // The `fillPct` box contract is the regression this guards: the host caps the
    // square glyphs at 80% and the module must cap identically, or the two render
    // paths for one platform disagree on glyph size.
    for (const module of platformRegistry.all()) {
      const { Mark, platformId } = module
      for (const fillPct of [undefined, 60, 70, 100]) {
        const viaModule = renderToStaticMarkup(<Mark {...(fillPct === undefined ? {} : { fillPct })} />)
        const viaHost = renderToStaticMarkup(
          <PlatformMark platform={platformId} {...(fillPct === undefined ? {} : { fillPct })} />
        )
        expect(viaHost, `${platformId} @ ${fillPct ?? 'default'}`).toBe(viaModule)
      }
    }
  })
})
