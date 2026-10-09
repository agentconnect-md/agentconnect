import { describe, expect, it } from 'vitest'
import {
  evaluateSourceCacheLifecycle,
  SOURCE_CACHE_LIFECYCLE_DAYS,
  sourceCacheLifecycleRules
} from '../src/lifecycle.js'

// The bucket lifecycle rules (source-cache.md §10): the document operators apply and the check of what a bucket holds.

const andRule = (opts: {
  id?: string
  value: string
  prefix?: string
  days?: number
  status?: string
  extraTag?: boolean
  size?: boolean
}) =>
  `<Rule><ID>${opts.id ?? `r-${opts.value}`}</ID><Filter><And>${opts.prefix === undefined ? '' : `<Prefix>${opts.prefix}</Prefix>`}<Tag><Key>ac-cache</Key><Value>${opts.value}</Value></Tag>${opts.extraTag ? '<Tag><Key>team</Key><Value>x</Value></Tag>' : ''}${opts.size ? '<ObjectSizeGreaterThan>10</ObjectSizeGreaterThan>' : ''}</And></Filter><Status>${opts.status ?? 'Enabled'}</Status>${opts.days === 0 ? '' : `<Expiration><Days>${opts.days ?? SOURCE_CACHE_LIFECYCLE_DAYS[opts.value as 'pending'] ?? 7}</Days></Expiration>`}</Rule>`

const tagRule = (value: string, days: number) =>
  `<Rule><ID>t-${value}</ID><Filter><Tag><Key>ac-cache</Key><Value>${value}</Value></Tag></Filter><Status>Enabled</Status><Expiration><Days>${days}</Days></Expiration></Rule>`

const config = (...rules: string[]) =>
  `<?xml version="1.0" encoding="UTF-8"?><LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${rules.join('')}</LifecycleConfiguration>`

describe('Source Cache lifecycle rules document', () => {
  it('scopes both tag rules to <prefix>/src/, never snapshots/', () => {
    const doc = sourceCacheLifecycleRules('agentconnect')
    expect(doc).toEqual({
      Rules: [
        {
          ID: 'ac-source-cache-pending',
          Status: 'Enabled',
          Filter: { And: { Prefix: 'agentconnect/src/', Tags: [{ Key: 'ac-cache', Value: 'pending' }] } },
          Expiration: { Days: 2 }
        },
        {
          ID: 'ac-source-cache-unreferenced',
          Status: 'Enabled',
          Filter: { And: { Prefix: 'agentconnect/src/', Tags: [{ Key: 'ac-cache', Value: 'unreferenced' }] } },
          Expiration: { Days: 7 }
        }
      ]
    })
    expect(sourceCacheLifecycleRules('').Rules.map((r) => r.Filter.And.Prefix)).toEqual(['src/', 'src/'])
    expect(JSON.stringify(sourceCacheLifecycleRules('a/b'))).not.toContain('snapshots')
  })

  it('accepts its own document as XML', () => {
    const xml = config(
      andRule({ value: 'pending', prefix: 'agentconnect/src/' }),
      andRule({ value: 'unreferenced', prefix: 'agentconnect/src/' })
    )
    expect(evaluateSourceCacheLifecycle(xml, 'agentconnect')).toEqual({
      pending: true,
      unreferenced: true,
      warnings: []
    })
  })
})

describe('Source Cache lifecycle evaluation', () => {
  it('accepts a Filter.Tag rule and an empty prefix, warning that it also covers snapshots/', () => {
    const result = evaluateSourceCacheLifecycle(
      config(tagRule('pending', 2), tagRule('unreferenced', 7)),
      'agentconnect'
    )
    expect(result.pending).toBe(true)
    expect(result.unreferenced).toBe(true)
    expect(result.warnings).toEqual([
      'lifecycle rule t-pending also covers agentconnect/snapshots/; scope it to agentconnect/src/',
      'lifecycle rule t-unreferenced also covers agentconnect/snapshots/; scope it to agentconnect/src/'
    ])
  })

  it('accepts a broader prefix that still contains src/', () => {
    const xml = config(
      andRule({ value: 'pending', prefix: 'agentconnect/s' }),
      andRule({ value: 'unreferenced', prefix: 'agentconnect/src' })
    )
    expect(evaluateSourceCacheLifecycle(xml, 'agentconnect')).toMatchObject({ pending: true, unreferenced: true })
  })

  it('reads the legacy rule-level Prefix', () => {
    const legacy =
      '<Rule><ID>l</ID><Prefix>src/</Prefix><Status>Enabled</Status><Expiration><Days>2</Days></Expiration></Rule>'
    // A legacy rule cannot filter on a tag, so it expires live bundles too.
    expect(evaluateSourceCacheLifecycle(config(legacy), '').warnings[0]).toMatch(
      /l expires objects under src\/ with no ac-cache filter/
    )
    const other = legacy.replace('src/', 'logs/')
    expect(evaluateSourceCacheLifecycle(config(other), '').warnings).toEqual([])
  })

  it.each([
    ['a disabled rule', { status: 'Disabled' }],
    ['a rule with no expiration days', { days: 0 }],
    ['a rule with an extra tag', { extraTag: true }],
    ['a rule scoped elsewhere', { prefix: 'other/src/' }],
    ['a rule scoped below src/', { prefix: 'agentconnect/src/org_1/' }],
    ['a rule with a size filter', { size: true }]
  ])('rejects %s', (_label, opts) => {
    const xml = config(
      andRule({ value: 'pending', prefix: 'agentconnect/src/', ...opts }),
      andRule({ value: 'unreferenced', prefix: 'agentconnect/src/' })
    )
    expect(evaluateSourceCacheLifecycle(xml, 'agentconnect')).toMatchObject({ pending: false, unreferenced: true })
  })

  it('warns on a rule that keeps objects longer than the design defaults', () => {
    const xml = config(
      andRule({ value: 'pending', prefix: 'src/', days: 30 }),
      andRule({ value: 'unreferenced', prefix: 'src/' })
    )
    const result = evaluateSourceCacheLifecycle(xml, '')
    expect(result).toMatchObject({ pending: true, unreferenced: true })
    expect(result.warnings).toEqual([
      'lifecycle rule r-pending expires ac-cache=pending after 30 days (design default 2)'
    ])
  })

  it('ignores foreign rules and other tag values, and decodes XML entities', () => {
    const foreign =
      '<Rule><ID>logs</ID><Filter><Prefix>logs/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>1</Days></Expiration></Rule>' +
      '<Rule><ID>tmp</ID><Filter><Tag><Key>ac-cache</Key><Value>live</Value></Tag></Filter><Status>Enabled</Status><NoncurrentVersionExpiration><NoncurrentDays>1</NoncurrentDays></NoncurrentVersionExpiration></Rule>'
    const xml = config(
      foreign,
      andRule({ value: 'pending', prefix: 'a&amp;b/src/' }),
      andRule({ value: 'unreferenced', prefix: 'a&amp;b/src/' })
    )
    expect(evaluateSourceCacheLifecycle(xml, 'a&b')).toEqual({ pending: true, unreferenced: true, warnings: [] })
    expect(evaluateSourceCacheLifecycle(config(foreign), 'a&b')).toEqual({
      pending: false,
      unreferenced: false,
      warnings: []
    })
  })

  it('warns on an untagged rule that would expire live bundles under src/', () => {
    const wipe =
      '<Rule><ID>wipe</ID><Filter><Prefix>agentconnect/</Prefix></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule>'
    expect(evaluateSourceCacheLifecycle(config(wipe), 'agentconnect').warnings).toEqual([
      'lifecycle rule wipe expires objects under agentconnect/src/ with no ac-cache filter, live bundles included'
    ])
  })

  it('does not warn on a rule filtered only by a foreign tag, which never matches a bundle', () => {
    const team =
      '<Rule><ID>team</ID><Filter><And><Prefix>agentconnect/</Prefix><Tag><Key>team</Key><Value>x</Value></Tag></And></Filter><Status>Enabled</Status><Expiration><Days>30</Days></Expiration></Rule>'
    expect(evaluateSourceCacheLifecycle(config(team), 'agentconnect').warnings).toEqual([])
  })
})
