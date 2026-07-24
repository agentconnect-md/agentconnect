/**
 * `RuntimeModelCatalogDto` mirrors the wire `RuntimeModelCatalog`
 * (runtime-model-catalog.md §5): one shape shared by the wire, the CP's JSONB
 * column, and the DTO — a frame-valid catalog must pass the DTO verbatim, so a
 * field rename on either side breaks here first.
 */
import { describe, it, expect } from 'vitest'
import { RuntimeModelCatalog } from '@agentconnect.md/protocol'
import { RuntimeModelCatalogDto } from './index.js'

const catalog = {
  models: [
    {
      id: 'claude-opus-4',
      name: 'Opus',
      efforts: [{ value: 'high', name: 'High', description: 'Slower, deeper reasoning' }],
      defaultEffort: 'high',
      fastMode: true
    },
    { id: 'claude-haiku-4', efforts: [] } // [] = no effort selector (distinct from absent = not discovered)
  ],
  defaultModel: 'claude-opus-4',
  permissionModes: [{ value: 'acceptEdits', name: 'Accept edits', description: 'Ask before running commands.' }],
  source: 'acp',
  observedAt: '2026-07-18T00:00:00.000Z'
}

describe('RuntimeModelCatalogDto — mirrors the wire RuntimeModelCatalog', () => {
  it('accepts a wire-valid catalog verbatim (no renames between layers)', () => {
    const wire = RuntimeModelCatalog.parse(catalog)
    expect(RuntimeModelCatalogDto.parse(wire)).toEqual(wire)
  })

  it('accepts the minimal catalog (models + source + observedAt only)', () => {
    const minimal = { models: [{ id: 'gpt-5' }], source: 'native', observedAt: catalog.observedAt }
    expect(RuntimeModelCatalogDto.parse(RuntimeModelCatalog.parse(minimal))).toEqual(minimal)
  })

  it('rejects a source outside the wire vocabulary', () => {
    expect(RuntimeModelCatalogDto.safeParse({ ...catalog, source: 'guessed' }).success).toBe(false)
  })
})
