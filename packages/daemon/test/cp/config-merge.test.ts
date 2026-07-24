import { describe, it, expect } from 'vitest'
import { ConfigSchema, type Config } from '../../src/config/config-schema.js'
import { mergeConfigPush } from '../../src/cp/config-apply.js'

const baseCfg = (): Config => ConfigSchema.parse({ version: 1 })

describe('mergeConfigPush', () => {
  it('applies whitelisted keys and reports them', () => {
    const cfg = baseCfg()
    const r = mergeConfigPush(cfg, { 'logging.level': 'debug', 'limits.maxAgents': 16 })
    expect(cfg.logging.level).toBe('debug')
    expect(cfg.limits.maxAgents).toBe(16)
    expect(r.applied.sort()).toEqual(['limits.maxAgents', 'logging.level'])
    expect(r.ignored).toEqual([])
  })

  it('ignores non-whitelisted or wrongly-typed keys without throwing', () => {
    const cfg = baseCfg()
    const r = mergeConfigPush(cfg, { 'controlPlane.key': 'leak', 'logging.level': 123 })
    expect(cfg.controlPlane.key).toBeUndefined()
    expect(cfg.logging.level).toBe('info') // unchanged — wrong type
    expect(r.applied).toEqual([])
    expect(r.ignored.sort()).toEqual(['controlPlane.key', 'logging.level'])
  })

  it('ignores controlPlane.heartbeatMs (CP-authoritative via auth/ok, not config/push)', () => {
    const cfg = baseCfg()
    const defaultMs = cfg.controlPlane.heartbeatMs
    const r = mergeConfigPush(cfg, { 'controlPlane.heartbeatMs': 5000 })
    expect(cfg.controlPlane.heartbeatMs).toBe(defaultMs) // not written
    expect(r.applied).toEqual([])
    expect(r.ignored).toEqual(['controlPlane.heartbeatMs'])
  })
})
