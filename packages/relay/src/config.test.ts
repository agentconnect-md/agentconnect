import { describe, it, expect } from 'vitest'
import { RelayConfigSchema, resolveAuth, toWsOrigin } from './config.js'

const BASE = {
  CP_URL: 'https://cp.example',
  RELAY_NAME: 'pod-0',
  DAEMON_DIAL_URL: 'wss://relay-0.example.test'
}
const TOKEN = 'r'.repeat(48)
const APIKEY = 'a'.repeat(49)

describe('RelayConfigSchema — exactly-one-credential boot guard (§8)', () => {
  it('rejects the removed PUBLIC_DAEMON_URL name', () => {
    expect(
      RelayConfigSchema.safeParse({
        CP_URL: BASE.CP_URL,
        RELAY_NAME: BASE.RELAY_NAME,
        PUBLIC_DAEMON_URL: 'wss://relay-0.example.test',
        RELAY_TOKEN: TOKEN
      }).success
    ).toBe(false)
  })
  it('accepts RELAY_TOKEN alone', () => {
    expect(RelayConfigSchema.safeParse({ ...BASE, RELAY_TOKEN: TOKEN }).success).toBe(true)
  })
  it('accepts RELAY_API_KEY alone', () => {
    expect(RelayConfigSchema.safeParse({ ...BASE, RELAY_API_KEY: APIKEY }).success).toBe(true)
  })
  it('rejects NEITHER credential', () => {
    expect(RelayConfigSchema.safeParse({ ...BASE }).success).toBe(false)
  })
  it('rejects BOTH credentials (ambiguous)', () => {
    expect(RelayConfigSchema.safeParse({ ...BASE, RELAY_TOKEN: TOKEN, RELAY_API_KEY: APIKEY }).success).toBe(false)
  })
  it('rejects a too-short RELAY_TOKEN (<32)', () => {
    expect(RelayConfigSchema.safeParse({ ...BASE, RELAY_TOKEN: 'short' }).success).toBe(false)
  })
  it('keeps model-facing MCP and memory-plugin private-upstream exceptions separate', () => {
    const mcpOnly = RelayConfigSchema.parse({
      ...BASE,
      RELAY_TOKEN: TOKEN,
      RELAY_MCP_ALLOWED_UPSTREAMS: 'mcp.example.test'
    })
    expect(mcpOnly.RELAY_MCP_ALLOWED_UPSTREAMS).toBe('mcp.example.test')
    expect(mcpOnly.RELAY_MEMORY_ALLOWED_UPSTREAMS).toBeUndefined()
    const memoryOnly = RelayConfigSchema.parse({
      ...BASE,
      RELAY_TOKEN: TOKEN,
      RELAY_MEMORY_ALLOWED_UPSTREAMS: 'memory.example.test'
    })
    expect(memoryOnly.RELAY_MEMORY_ALLOWED_UPSTREAMS).toBe('memory.example.test')
    expect(memoryOnly.RELAY_MCP_ALLOWED_UPSTREAMS).toBeUndefined()
  })
  it('serves STUN only with a port, and advertises a stun: URL only alongside one', () => {
    const off = RelayConfigSchema.parse({ ...BASE, RELAY_TOKEN: TOKEN })
    expect(off.RELAY_STUN_PORT).toBeUndefined()
    const on = RelayConfigSchema.parse({
      ...BASE,
      RELAY_TOKEN: TOKEN,
      RELAY_STUN_PORT: '3478',
      RELAY_STUN_URL: 'stun:stun-0.example.test:3478'
    })
    expect(on).toMatchObject({ RELAY_STUN_PORT: 3478, RELAY_STUN_HOST: '0.0.0.0' })
    expect(
      RelayConfigSchema.safeParse({ ...BASE, RELAY_TOKEN: TOKEN, RELAY_STUN_URL: 'stun:stun.example.test:3478' })
        .success
    ).toBe(false)
    expect(
      RelayConfigSchema.safeParse({
        ...BASE,
        RELAY_TOKEN: TOKEN,
        RELAY_STUN_PORT: '3478',
        RELAY_STUN_URL: 'turn:stun.example.test:3478'
      }).success
    ).toBe(false)
  })
  it('serves TURN only with a port and the public URLs that reach it, and TLS only in full', () => {
    const off = RelayConfigSchema.parse({ ...BASE, RELAY_TOKEN: TOKEN })
    expect(off).toMatchObject({ RELAY_TURN_URLS: [], RELAY_TURN_MAX_BPS: 10_000_000, RELAY_TURN_IDLE_TIMEOUT_SEC: 120 })
    const urls = 'turn:turn-0.example.test:3478?transport=udp, turns:turn-0.example.test:443?transport=tcp'
    const on = RelayConfigSchema.parse({ ...BASE, RELAY_TOKEN: TOKEN, RELAY_TURN_PORT: '3480', RELAY_TURN_URLS: urls })
    expect(on.RELAY_TURN_URLS).toEqual([
      'turn:turn-0.example.test:3478?transport=udp',
      'turns:turn-0.example.test:443?transport=tcp'
    ])
    const parse = (extra: Record<string, string>) =>
      RelayConfigSchema.safeParse({ ...BASE, RELAY_TOKEN: TOKEN, ...extra }).success
    expect(parse({ RELAY_TURN_URLS: urls })).toBe(false)
    expect(parse({ RELAY_TURN_PORT: '3480' })).toBe(false)
    expect(parse({ RELAY_TURN_PORT: '3480', RELAY_TURN_URLS: 'stun:turn.example.test:3478' })).toBe(false)
    expect(parse({ RELAY_TURN_PORT: '3480', RELAY_TURN_URLS: urls, RELAY_TURN_TLS_PORT: '5349' })).toBe(false)
    expect(
      parse({
        RELAY_TURN_PORT: '3480',
        RELAY_TURN_URLS: urls,
        RELAY_TURN_TLS_PORT: '5349',
        RELAY_TURN_TLS_CERT_FILE: '/tls/tls.crt',
        RELAY_TURN_TLS_KEY_FILE: '/tls/tls.key'
      })
    ).toBe(true)
    expect(parse({ RELAY_TURN_PORT: '3478', RELAY_TURN_URLS: urls, RELAY_STUN_PORT: '3478' })).toBe(false)
    expect(parse({ RELAY_TURN_PORT: '3480', RELAY_TURN_URLS: urls, RELAY_TURN_HOST: '::' })).toBe(false)
  })
  it('probes credentials hourly unless RELAY_CREDENTIAL_PROBE_INTERVAL_SEC overrides it', () => {
    expect(RelayConfigSchema.parse({ ...BASE, RELAY_TOKEN: TOKEN }).RELAY_CREDENTIAL_PROBE_INTERVAL_SEC).toBe(3600)
    const tuned = RelayConfigSchema.parse({ ...BASE, RELAY_TOKEN: TOKEN, RELAY_CREDENTIAL_PROBE_INTERVAL_SEC: '600' })
    expect(tuned.RELAY_CREDENTIAL_PROBE_INTERVAL_SEC).toBe(600)
    expect(
      RelayConfigSchema.safeParse({ ...BASE, RELAY_TOKEN: TOKEN, RELAY_CREDENTIAL_PROBE_INTERVAL_SEC: '0' }).success
    ).toBe(false)
  })
})

describe('resolveAuth', () => {
  it('maps RELAY_TOKEN → method:token', () => {
    const c = RelayConfigSchema.parse({ ...BASE, RELAY_TOKEN: TOKEN })
    expect(resolveAuth(c)).toEqual({ method: 'token', credential: TOKEN })
  })
  it('maps RELAY_API_KEY → method:apikey', () => {
    const c = RelayConfigSchema.parse({ ...BASE, RELAY_API_KEY: APIKEY })
    expect(resolveAuth(c)).toEqual({ method: 'apikey', credential: APIKEY })
  })
})

describe('toWsOrigin', () => {
  it('rewrites http(s) → ws(s)', () => {
    expect(toWsOrigin('https://cp.example')).toBe('wss://cp.example')
    expect(toWsOrigin('http://cp.example:8080')).toBe('ws://cp.example:8080')
  })
  it('passes ws(s) through unchanged', () => {
    expect(toWsOrigin('wss://cp.example')).toBe('wss://cp.example')
    expect(toWsOrigin('ws://cp.example')).toBe('ws://cp.example')
  })
})
