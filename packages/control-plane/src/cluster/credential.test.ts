/**
 * The `config.json` an envelope daemon boots from is a contract with
 * `packages/daemon/src/config/config-schema.ts`, and the pod cannot start
 * without it — so the exact field names matter more than the code around them.
 */
import { describe, expect, it } from 'vitest'
import { buildDaemonConfigJson } from './credential.js'

describe('buildDaemonConfigJson', () => {
  const config = buildDaemonConfigJson({
    controlPlaneUrl: 'wss://api.example.test/daemon/ws',
    apiKey: 'k'.repeat(49),
    daemonId: '0f2f0d0a-0000-4000-8000-000000000001'
  })

  it('emits exactly the fields the daemon config schema names', () => {
    expect(JSON.parse(config)).toEqual({
      version: 1,
      daemonId: '0f2f0d0a-0000-4000-8000-000000000001',
      controlPlane: { enabled: true, url: 'wss://api.example.test/daemon/ws', key: 'k'.repeat(49) }
    })
  })

  it('pins the daemon id rather than letting the pod adopt one', () => {
    // A pod's state volume can be replaced under it; an identity adopted from
    // `auth/ok` and persisted there would not survive that.
    expect(JSON.parse(config).daemonId).toBeDefined()
  })

  it('is a readable file, since an operator may have to inspect it in place', () => {
    expect(config.endsWith('\n')).toBe(true)
    expect(config).toContain('\n  "version": 1')
  })
})
