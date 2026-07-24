import { describe, it, expect } from 'vitest'
import { nodeSatisfies } from '../src/node-engines.js'

describe('nodeSatisfies', () => {
  it('accepts the daemon default >=24', () => {
    expect(nodeSatisfies('>=24', '24.14.1')).toBe(true)
    expect(nodeSatisfies('>=24', '25.0.0')).toBe(true)
    expect(nodeSatisfies('>=24', '23.9.0')).toBe(false)
  })
  it('handles full-triple ranges', () => {
    expect(nodeSatisfies('>=24.0.0', '24.0.0')).toBe(true)
    expect(nodeSatisfies('>=24.5.0', '24.4.9')).toBe(false)
    expect(nodeSatisfies('>=24.5.0', '24.5.1')).toBe(true)
  })
  it('supports comparators and OR groups', () => {
    expect(nodeSatisfies('>=20 <25', '24.1.0')).toBe(true)
    expect(nodeSatisfies('>=20 <25', '25.0.0')).toBe(false)
    expect(nodeSatisfies('22 || >=24', '24.0.0')).toBe(true)
    expect(nodeSatisfies('22 || >=24', '23.0.0')).toBe(false)
  })
  it('accepts wildcard / empty / unparseable ranges', () => {
    expect(nodeSatisfies('*', '24.0.0')).toBe(true)
    expect(nodeSatisfies('', '24.0.0')).toBe(true)
    expect(nodeSatisfies(undefined, '24.0.0')).toBe(true)
  })
})
