import { describe, expect, it } from 'vitest'
import { MSTEAMS_RELAY_EGRESS_V1_FEATURE } from '@agentconnect.md/protocol'
import type { DaemonPlatformModule } from '../src/platforms/contract.js'
import { msTeamsPlatformModule } from '../src/platforms/msteams/module.js'
import { PlatformModuleRegistry } from '../src/platforms/registry.js'

const module = (platformId: string): DaemonPlatformModule => ({ platformId })

describe('PlatformModuleRegistry', () => {
  it('answers a registered platform by id and nobody else', () => {
    const registry = new PlatformModuleRegistry([module('alpha'), module('beta')])
    expect(registry.get('alpha')?.platformId).toBe('alpha')
    expect(registry.get('beta')?.platformId).toBe('beta')
    expect(registry.get('gamma')).toBeUndefined()
  })

  it('refuses a duplicate platform id at construction', () => {
    expect(() => new PlatformModuleRegistry([module('alpha'), module('alpha')])).toThrow(
      'duplicate daemon platform module: alpha'
    )
  })

  it('aggregates the registration features each module declares, once each', () => {
    const registry = new PlatformModuleRegistry([
      { platformId: 'alpha', registrationFeatures: ['alpha-v1', 'shared-v1'] },
      module('beta'),
      { platformId: 'gamma', registrationFeatures: ['shared-v1'] }
    ])
    expect(registry.registrationFeatures()).toEqual(['alpha-v1', 'shared-v1'])
  })

  it('carries the Teams relay egress feature from the Teams module, not from daemon core', () => {
    const teams = msTeamsPlatformModule({} as never)
    expect(teams.registrationFeatures).toEqual([MSTEAMS_RELAY_EGRESS_V1_FEATURE])
  })
})
