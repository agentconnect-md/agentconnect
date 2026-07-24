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
