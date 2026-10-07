import { describe, expect, it } from 'vitest'
import { effectivePlaceTrust, placeTrustSource } from './place-trust.js'

// assistant-mode.md §5.3: the platform can only make a place stricter; an editor fills what it cannot verify.
describe('effectivePlaceTrust', () => {
  it('is undeclared when nobody declared and nothing was detected', () => {
    expect(effectivePlaceTrust({ trustDeclared: null, trustDetected: null })).toBeNull()
    expect(placeTrustSource({})).toBeNull()
  })

  it('lets a detected external outrank a declared internal', () => {
    const row = { trustDeclared: 'internal', trustDetected: 'external' } as const
    expect(effectivePlaceTrust(row)).toBe('external')
    expect(placeTrustSource(row)).toBe('detected')
  })

  it('takes the declaration over a detected internal, so an editor can make a plain channel external', () => {
    const row = { trustDeclared: 'external', trustDetected: 'internal' } as const
    expect(effectivePlaceTrust(row)).toBe('external')
    expect(placeTrustSource(row)).toBe('declared')
  })

  it('auto-fills internal from a detection when the editor has not declared', () => {
    const row = { trustDeclared: null, trustDetected: 'internal' } as const
    expect(effectivePlaceTrust(row)).toBe('internal')
    expect(placeTrustSource(row)).toBe('detected')
  })

  it('takes a declaration where the platform detects nothing', () => {
    expect(effectivePlaceTrust({ trustDeclared: 'internal' })).toBe('internal')
    expect(placeTrustSource({ trustDeclared: 'internal' })).toBe('declared')
  })
})
