import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.js'

const REQUIRED = { AC_ORG_NAMESPACE_PREFIX: 'test-ac-org-', AC_TOKENREVIEW_CLUSTERROLE: 'test-ac-tokenreview' }

describe('loadConfig', () => {
  it('applies defaults around the two required install-time constants', () => {
    const config = loadConfig(REQUIRED)
    expect(config.orgNamespacePrefix).toBe('test-ac-org-')
    expect(config.tokenreviewClusterRole).toBe('test-ac-tokenreview')
    expect(config.masterTemplatePrefix).toBe('ac-runtime-')
    expect(config.daemonStorageClass).toBeUndefined()
    expect(config.daemonStorageSize).toBe('10Gi')
    expect(config.resyncIntervalMs).toBe(600_000)
    expect(config.leaseName).toBe('agentconnect-operator')
    expect(config.watchTimeoutSeconds).toBe(300)
    // Unset renders as empty from the chart's own default, which is a real answer: no
    // in-cluster peer, so the daemon egresses on the 443 rule alone.
    expect(config.daemonEgressNamespaces).toEqual([])
  })

  it('reads the daemon egress namespaces as a de-duplicated, trimmed list', () => {
    const config = loadConfig({ ...REQUIRED, AC_DAEMON_EGRESS_NAMESPACES: ' ac-control , relay ,ac-control, ' })
    expect(config.daemonEgressNamespaces).toEqual(['ac-control', 'relay'])
  })

  it('fails fast when an install-time constant is missing or empty', () => {
    expect(() => loadConfig({})).toThrow(/AC_ORG_NAMESPACE_PREFIX/)
    expect(() => loadConfig({ ...REQUIRED, AC_ORG_NAMESPACE_PREFIX: '' })).toThrow(/AC_ORG_NAMESPACE_PREFIX/)
    expect(() => loadConfig({ AC_ORG_NAMESPACE_PREFIX: 'p-' })).toThrow(/AC_TOKENREVIEW_CLUSTERROLE/)
  })

  it('reads a blank storage class as unset so the cluster default still applies', () => {
    expect(loadConfig({ ...REQUIRED, AC_DAEMON_STORAGE_CLASS: '  ' }).daemonStorageClass).toBeUndefined()
    expect(loadConfig({ ...REQUIRED, AC_DAEMON_STORAGE_CLASS: 'cluster-wide' }).daemonStorageClass).toBe('cluster-wide')
  })

  it('coerces numeric overrides', () => {
    const config = loadConfig({ ...REQUIRED, AC_RESYNC_INTERVAL_SECONDS: '60' })
    expect(config.resyncIntervalMs).toBe(60_000)
  })
})
