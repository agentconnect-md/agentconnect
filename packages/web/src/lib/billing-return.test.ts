import { describe, expect, it } from 'vitest'
import { billingPathWithReturn, billingReturnTarget } from './billing-return'

describe('billingReturnTarget', () => {
  it('accepts a page inside the active org, query and all', () => {
    expect(billingReturnTarget('/acme/sessions/pg_a_1?cardSetup=cancel', '/acme')).toBe(
      '/acme/sessions/pg_a_1?cardSetup=cancel'
    )
  })

  it.each([
    ['another org', '/other/sessions/s1'],
    ['a slug that only shares a prefix', '/acme-two/sessions/s1'],
    ['another origin', 'https://evil.example.test/acme/sessions'],
    ['a protocol-relative URL', '//evil.example.test/acme'],
    ['a dot segment that climbs out of the org', '/acme/../other/billing'],
    ['an encoded dot segment', '/acme/%2E%2E/other'],
    ['a backslash', '/acme/\\evil'],
    ['nothing', null]
  ])('refuses %s', (_name, value) => {
    expect(billingReturnTarget(value, '/acme')).toBeUndefined()
  })

  it('refuses everything before the org is known', () => {
    expect(billingReturnTarget('/acme/sessions/s1', '/')).toBeUndefined()
  })
})

describe('billingPathWithReturn', () => {
  it('carries an encoded return target, or nothing', () => {
    expect(billingPathWithReturn('/acme/billing', '/acme/sessions/s1?x=1')).toBe(
      '/acme/billing?return=%2Facme%2Fsessions%2Fs1%3Fx%3D1'
    )
    expect(billingPathWithReturn('/acme/billing', undefined)).toBe('/acme/billing')
  })
})
