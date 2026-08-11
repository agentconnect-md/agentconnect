import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { InClusterConfigError, loadInClusterConfig } from './config.js'

describe('in-cluster config', () => {
  it('builds the API server URL and reads the token per call, not once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sa-'))
    writeFileSync(join(dir, 'token'), 'first\n')
    writeFileSync(join(dir, 'namespace'), 'org-abc\n')
    writeFileSync(join(dir, 'ca.crt'), '-----BEGIN CERTIFICATE-----\n')
    const config = loadInClusterConfig({ KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' }, dir)
    expect(config.server).toBe('https://10.96.0.1:443')
    expect(config.namespace).toBe('org-abc')
    expect(config.ca).toContain('BEGIN CERTIFICATE')
    expect(config.token()).toBe('first')
    // The kubelet rotates the projected token in place; a long-lived process must
    // observe the new value rather than a boot-time snapshot.
    writeFileSync(join(dir, 'token'), 'rotated\n')
    expect(config.token()).toBe('rotated')
  })

  it('brackets an IPv6 API server address', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sa-'))
    writeFileSync(join(dir, 'token'), 't')
    writeFileSync(join(dir, 'namespace'), 'n')
    const config = loadInClusterConfig({ KUBERNETES_SERVICE_HOST: 'fd00::1', KUBERNETES_SERVICE_PORT: '443' }, dir)
    expect(config.server).toBe('https://[fd00::1]:443')
  })

  it('names the missing piece instead of returning a half-configured client', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sa-'))
    expect(() => loadInClusterConfig({}, dir)).toThrow(InClusterConfigError)
    expect(() => loadInClusterConfig({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, dir)).toThrow(/token not found/)
    writeFileSync(join(dir, 'token'), 't')
    expect(() => loadInClusterConfig({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, dir)).toThrow(/namespace not found/)
  })
})
