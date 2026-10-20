import { afterEach, describe, expect, it, vi } from 'vitest'
import { printChecks, profileCovered } from './setup.js'

afterEach(() => vi.restoreAllMocks())

describe('setup helpers', () => {
  it('matches Windows network categories against firewall rule profiles', () => {
    expect(profileCovered('Any', 'Public')).toBe(true)
    expect(profileCovered('Private, Public', 'Public')).toBe(true)
    expect(profileCovered('Private', 'Public')).toBe(false)
    expect(profileCovered('Domain', 'DomainAuthenticated')).toBe(true)
  })

  it('fails the report only on failed checks and prints the fix for anything not ok', () => {
    const lines: string[] = []
    vi.spyOn(console, 'log').mockImplementation((line: string) => void lines.push(line))
    expect(printChecks([{ name: 'a', status: 'warn', detail: 'meh', fix: 'do x' }])).toBe(true)
    expect(lines.some((line) => line.includes('→ do x'))).toBe(true)
    expect(
      printChecks([
        { name: 'b', status: 'fail', detail: 'broken' },
        { name: 'c', status: 'info', detail: 'fyi' }
      ])
    ).toBe(false)
  })
})
