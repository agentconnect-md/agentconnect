import { describe, expect, it } from 'vitest'
import { configFitsFields, configFromValues, settingsFields, valuesFromConfig } from './memory-config-schema'

const SCHEMA = {
  type: 'object',
  properties: {
    projectId: { type: 'string', title: 'Project', minLength: 1 },
    region: { type: 'string', enum: ['us', 'eu'], description: 'Where records are stored.' },
    batch: { type: 'integer', minimum: 1 },
    verbose: { type: 'boolean', default: true }
  },
  required: ['projectId'],
  additionalProperties: false
}

describe('memory connection settings schema', () => {
  it('turns the bounded schema into typed fields, required first and the rest by label', () => {
    const fields = settingsFields(SCHEMA)!
    expect(fields.map((field) => [field.name, field.kind, field.required, field.label])).toEqual([
      ['projectId', 'string', true, 'Project'],
      ['batch', 'number', false, 'batch'],
      ['region', 'enum', false, 'region'],
      ['verbose', 'boolean', false, 'verbose']
    ])
    expect(fields[2]!.options.map((option) => option.key)).toEqual(['"us"', '"eu"'])
    expect(fields[1]!.integer).toBe(true)
  })

  it('reports an empty schema as no fields and an unrenderable one as null', () => {
    expect(settingsFields({ type: 'object', properties: {}, additionalProperties: false })).toEqual([])
    expect(settingsFields({ type: 'object', properties: { nested: { type: 'object', properties: {} } } })).toBeNull()
    expect(
      settingsFields({ type: 'object', properties: { tags: { type: 'array', items: { type: 'string' } } } })
    ).toBeNull()
    expect(settingsFields({ type: 'object', properties: { mixed: { type: ['string', 'number'] } } })).toBeNull()
    expect(settingsFields(null)).toBeNull()
    // A nullable scalar still renders as its scalar.
    expect(settingsFields({ type: 'object', properties: { note: { type: ['string', 'null'] } } })?.[0]?.kind).toBe(
      'string'
    )
  })

  it('round-trips a config through form values, applying schema defaults on the way in', () => {
    const fields = settingsFields(SCHEMA)!
    const values = valuesFromConfig(fields, { projectId: 'p1', region: 'eu', batch: 20 })
    expect(values).toEqual({ projectId: 'p1', region: '"eu"', batch: '20', verbose: true })
    expect(configFromValues(fields, values)).toEqual({
      config: { projectId: 'p1', region: 'eu', batch: 20, verbose: true }
    })
    // Optional empties are omitted rather than sent as empty strings.
    expect(configFromValues(fields, { projectId: 'p1', region: '', batch: '', verbose: false })).toEqual({
      config: { projectId: 'p1', verbose: false }
    })
  })

  it('names the field and the reason when a value cannot become config', () => {
    const fields = settingsFields(SCHEMA)!
    expect(configFromValues(fields, { projectId: ' ', verbose: false })).toMatchObject({
      error: { field: { name: 'projectId' }, reason: 'required' }
    })
    expect(configFromValues(fields, { projectId: 'p1', batch: 'ten', verbose: false })).toMatchObject({
      error: { field: { name: 'batch' }, reason: 'number' }
    })
    expect(configFromValues(fields, { projectId: 'p1', batch: '1.5', verbose: false })).toMatchObject({
      error: { field: { name: 'batch' }, reason: 'integer' }
    })
  })

  it('keeps a config with keys outside the schema on the JSON fallback', () => {
    const fields = settingsFields(SCHEMA)!
    expect(configFitsFields({ projectId: 'p1' }, fields)).toBe(true)
    expect(configFitsFields({ projectId: 'p1', legacy: 1 }, fields)).toBe(false)
  })
})
