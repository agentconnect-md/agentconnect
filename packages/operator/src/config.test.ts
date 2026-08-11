import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const REQUIRED = { AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'test-ac-tokenreview' }

describe('loadConfig', () => {
  it('applies defaults around the two required install-time constants', () => {
    const config = loadConfig(REQUIRED)
    expect(config.orgNamespacePrefix).toBe('test-ac-org-')
    expect(config.tokenreviewClusterRole).toBe('test-ac-tokenreview')
    expect(config.masterTemplatePrefix).toBe('ac-runtime-')
    expect(config.resyncIntervalMs).toBe(600_000)
    expect(config.leaseName).toBe('agentconnect-operator')
    expect(config.watchTimeoutSeconds).toBe(300)
  })

  it('fails fast when an install-time constant is missing or empty', () => {
    expect(() => loadConfig({})).toThrow(/AC_ORG_NAMESPACE_PREFIX/)
    expect(() => loadConfig({ ...REQUIRED, AC_ORG_NAMESPACE_PREFIX: '' })).toThrow(/AC_ORG_NAMESPACE_PREFIX/)
    expect(() => loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'p-' })).toThrow(/AC_TOKENREVIEW_CLUSTERROLE/)
  })

  it('coerces numeric overrides', () => {
    const config = loadConfig({ ...REQUIRED, AC_RESYNC_INTERVAL_SECONDS: '60' })
    expect(config.resyncIntervalMs).toBe(60_000)
  })
})
