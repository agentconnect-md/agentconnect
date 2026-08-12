import { describe, expect, it } from 'vitest'
import { namespaceFault, orgNamespace } from './namespace.js'

const PREFIX = 'test-ac-org-'

describe('orgNamespace', () => {
  it('derives the install prefix followed by the CR name when nothing is declared', () => {
    expect(orgNamespace(PREFIX, 'acme')).toBe('test-ac-org-acme')
  })

  it('honours a declared override', () => {
    expect(orgNamespace(PREFIX, 'acme', 'test-ac-org-legacy')).toBe('test-ac-org-legacy')
  })

  // Two CRs in one control namespace cannot share a name, and the prefix is per install.
  it('separates two orgs under one install', () => {
    expect(orgNamespace(PREFIX, 'acme')).not.toBe(orgNamespace(PREFIX, 'globex'))
  })
})

describe('namespaceFault', () => {
  it('accepts a derived name', () => {
    expect(namespaceFault(PREFIX, orgNamespace(PREFIX, 'acme'))).toBeUndefined()
  })

  it('accepts an override inside the install prefix', () => {
    expect(namespaceFault(PREFIX, 'test-ac-org-legacy')).toBeUndefined()
  })

  it('rejects an override outside the install prefix', () => {
    expect(namespaceFault(PREFIX, 'other-prefix-acme')?.reason).toBe('NamespaceOutsidePrefix')
  })

  // Object names are DNS subdomains, so dots reach this check from a perfectly legal CR.
  it('rejects a resolved name that is not a DNS label', () => {
    expect(namespaceFault(PREFIX, orgNamespace(PREFIX, 'acme.example'))?.reason).toBe('InvalidNamespaceName')
  })

  it('rejects a resolved name longer than a DNS label', () => {
    const fault = namespaceFault(PREFIX, orgNamespace(PREFIX, 'a'.repeat(64)))
    expect(fault?.reason).toBe('InvalidNamespaceName')
    expect(fault?.message).toContain('63')
  })
})
