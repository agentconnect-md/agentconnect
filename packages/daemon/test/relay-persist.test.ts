import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '../src/config/config-schema.js'
import { loadConfig, persistRelays } from '../src/config/load-config.js'
import { configPath } from '../src/paths.js'

const RELAY_A = { relayId: '11111111-1111-4111-8111-111111111111', url: 'wss://relay-a.example/daemon' }
const RELAY_B = { relayId: '22222222-2222-4222-8222-222222222222', url: 'wss://relay-b.example/daemon' }

describe('relay roster persistence (config.json)', () => {
  it('defaults relays to [] when absent', () => {
    expect(ConfigSchema.parse({ version: 1 }).relays).toEqual([])
  })

  it('persistRelays round-trips the roster back through loadConfig (boot re-dial)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-relay-'))
    writeFileSync(configPath(root), JSON.stringify({ version: 1 }) + '\n')

    persistRelays(root, [RELAY_A, RELAY_B])

    expect(loadConfig({ root }).relays).toEqual([RELAY_A, RELAY_B])
    // written to disk under the `relays` key, not just in memory
    expect(JSON.parse(readFileSync(configPath(root), 'utf8')).relays).toEqual([RELAY_A, RELAY_B])
  })

  it('overwrites the whole set — a swept relay is cleared, not merged', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-relay-'))
    writeFileSync(configPath(root), JSON.stringify({ version: 1 }) + '\n')

    persistRelays(root, [RELAY_A, RELAY_B])
    persistRelays(root, [RELAY_A]) // B swept from the roster
    expect(loadConfig({ root }).relays).toEqual([RELAY_A])

    persistRelays(root, []) // all relays gone
    expect(loadConfig({ root }).relays).toEqual([])
  })

  it('preserves other config keys (does not clobber daemonId)', () => {
    const root = mkdtempSync(join(tmpdir(), 'ac-relay-'))
    writeFileSync(configPath(root), JSON.stringify({ version: 1, daemonId: 'keep-me' }) + '\n')

    persistRelays(root, [RELAY_A])

    const cfg = loadConfig({ root })
    expect(cfg.daemonId).toBe('keep-me')
    expect(cfg.relays).toEqual([RELAY_A])
  })
})
