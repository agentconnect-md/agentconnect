import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

describe('loadConfig', () => {
  it('applies defaults around the one required install-time constant', () => {
    const config = loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-' })
    expect(config.orgNamespacePrefix).toBe('test-ac-org-')
    expect(config.resyncIntervalMs).toBe(600_000)
    expect(config.leaseName).toBe('agentconnect-operator')
    expect(config.watchTimeoutSeconds).toBe(300)
  })

  it('fails fast when the prefix is missing or empty', () => {
    expect(() => loadConfig({})).toThrow(/AC_ORG_NAMESPACE_PREFIX/)
    expect(() => loadConfig({ AC_ORG_NAMESPACE_PREFIX: '' })).toThrow(/AC_ORG_NAMESPACE_PREFIX/)
  })

  it('coerces numeric overrides', () => {
    const config = loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'p-', AC_RESYNC_INTERVAL_SECONDS: '60' })
    expect(config.resyncIntervalMs).toBe(60_000)
  })
})
