import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  authenticate,
  configPath,
  DesktopConfig,
  isLoopbackHost,
  isWildcardHost,
  issueClientToken,
  loadConfig,
  saveConfig
} from './config.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'ac-desktop-config-'))
  dirs.push(dir)
  return dir
}

describe('desktop config', () => {
  it('listens on loopback unless another host is configured', () => {
    expect(DesktopConfig.parse({}).host).toBe('127.0.0.1')
    expect(loadConfig(tempDir()).host).toBe('127.0.0.1')
    expect(DesktopConfig.parse({ host: '0.0.0.0' }).host).toBe('0.0.0.0')
  })

  it('classifies loopback and wildcard listen addresses', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', '::1', 'localhost']) expect(isLoopbackHost(host)).toBe(true)
    for (const host of ['0.0.0.0', '::', '192.168.1.2', '127.0.0.1.example.com']) {
      expect(isLoopbackHost(host)).toBe(false)
    }
    expect(isWildcardHost('0.0.0.0')).toBe(true)
    expect(isWildcardHost('::')).toBe(true)
    expect(isWildcardHost('127.0.0.1')).toBe(false)
  })

  it('stores only the token hash and authenticates the bearer that holds it', () => {
    const dir = tempDir()
    const { config, token } = issueClientToken(DesktopConfig.parse({}), 'claude')
    saveConfig(config, dir)
    const loaded = loadConfig(dir)
    expect(JSON.stringify(loaded)).not.toContain(token)
    expect(authenticate(loaded, `Bearer ${token}`)).toBe('claude')
    expect(authenticate(loaded, 'Bearer acd_wrong')).toBeUndefined()
    expect(authenticate(loaded, undefined)).toBeUndefined()
    if (process.platform !== 'win32') expect(statSync(configPath(dir)).mode & 0o777).toBe(0o600)
  })

  it('rotates a client token in place', () => {
    const first = issueClientToken(DesktopConfig.parse({}), 'claude')
    const second = issueClientToken(first.config, 'claude')
    expect(second.config.clients).toHaveLength(1)
    expect(authenticate(second.config, `Bearer ${first.token}`)).toBeUndefined()
    expect(authenticate(second.config, `Bearer ${second.token}`)).toBe('claude')
  })
})
