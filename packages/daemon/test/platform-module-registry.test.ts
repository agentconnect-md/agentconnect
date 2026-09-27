import { describe, expect, it } from 'vitest'
import type { DaemonPlatformModule } from '../src/platforms/contract.js'
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
})
