import { describe, expect, it } from 'vitest'
import { intersectRuntimes, unionRuntimes } from './FleetDetail'
import type { DaemonRow } from '@/lib/data'

/** The set-level runtime views a detail page renders. Their model lists are ids — and for a
 *  claude runtime those are ALIASES — so what a member's catalog says about each id has to
 *  survive the aggregation, or the card can only ever show `opus[1m]`. */

const member = (over: Partial<DaemonRow['runtimeModels'][number]> = {}): DaemonRow =>
  ({
    runtimeModels: [
      {
        runtime: 'claude',
        version: '0.73.0',
        models: ['opus[1m]', 'haiku'],
        modelCatalog: {
          models: [
            { id: 'opus[1m]', name: 'Opus (1M context)', description: 'Opus 5 with 1M context' },
            { id: 'haiku' }
          ],
          source: 'acp',
          observedAt: '2026-09-03T00:00:00.000Z'
        },
        ...over
      }
    ]
  }) as unknown as DaemonRow

describe('runtime aggregation carries model display metadata', () => {
  it('unions the catalog names and blurbs alongside the ids', () => {
    const [rt] = unionRuntimes([member()])
    expect(rt!.models).toEqual(['opus[1m]', 'haiku'])
    expect(rt!.modelInfo).toEqual({ 'opus[1m]': { name: 'Opus (1M context)', description: 'Opus 5 with 1M context' } })
  })

  it('keeps a describing member’s answer when a peer reports no catalog', () => {
    const [rt] = unionRuntimes([member(), member({ modelCatalog: null })])
    expect(rt!.modelInfo?.['opus[1m]']?.name).toBe('Opus (1M context)')
    const [flipped] = unionRuntimes([member({ modelCatalog: null }), member()])
    expect(flipped!.modelInfo?.['opus[1m]']?.name).toBe('Opus (1M context)')
  })

  it('carries them through the intersection too', () => {
    const [rt] = intersectRuntimes([member(), member()])
    expect(rt!.modelInfo?.['opus[1m]']?.description).toBe('Opus 5 with 1M context')
  })
})
