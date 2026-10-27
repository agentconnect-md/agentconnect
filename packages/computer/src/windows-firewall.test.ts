import { describe, expect, it } from 'vitest'
import { allowScript, firewallVerdict, parseFirewallRules, profileCovered } from './windows-firewall.js'

describe('windows firewall', () => {
  it('matches Windows network categories against firewall rule profiles', () => {
    expect(profileCovered('Any', 'Public')).toBe(true)
    expect(profileCovered('Private, Public', 'Public')).toBe(true)
    expect(profileCovered('Private', 'Public')).toBe(false)
    expect(profileCovered('Domain', 'DomainAuthenticated')).toBe(true)
  })

  it('reads PowerShell’s answer, including the null it prints for no rules', () => {
    expect(parseFirewallRules('{"rules":null,"profiles":["Public","Public"]}')).toEqual({
      allow: [],
      block: [],
      activeProfiles: ['Public']
    })
    expect(
      parseFirewallRules(
        '{"rules":[{"name":"a","action":"Allow","profile":"Any"},{"name":"b","action":"Block","profile":"Public"}],"profiles":["Private"]}'
      )
    ).toEqual({
      allow: [{ name: 'a', action: 'Allow', profile: 'Any' }],
      block: [{ name: 'b', action: 'Block', profile: 'Public' }],
      activeProfiles: ['Private']
    })
    expect(parseFirewallRules('')).toBeUndefined()
  })

  it('lets a block rule win, then needs an allow rule covering every active network', () => {
    const allow = [{ name: 'a', profile: 'Private' }]
    expect(firewallVerdict({ allow, block: [{ name: 'b', profile: 'Any' }], activeProfiles: ['Private'] })).toEqual({
      state: 'blocked',
      rules: ['b']
    })
    expect(firewallVerdict({ allow: [], block: [], activeProfiles: ['Public'] })).toEqual({ state: 'missing' })
    expect(firewallVerdict({ allow, block: [], activeProfiles: ['Private', 'Public'] })).toEqual({
      state: 'uncovered',
      networks: ['Public']
    })
    expect(firewallVerdict({ allow, block: [], activeProfiles: ['Private'] })).toEqual({
      state: 'allowed',
      profiles: ['Private']
    })
  })

  it('scopes the rule to one program, quoting its path for PowerShell', () => {
    const script = allowScript("C:\\Program Files\\O'Neil\\node.exe")
    expect(script).toContain("$p = 'C:\\Program Files\\O''Neil\\node.exe'")
    expect(script).toContain('New-NetFirewallRule')
    expect(script).toContain('-Program $p -Action Allow -Profile Any')
  })
})
