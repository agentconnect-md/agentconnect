/**
 * `daemonWsUrl` unit coverage (the fast `test:unit` project — pure logic, no DB).
 *
 * The onboarding start command must dial the *externally-reachable* daemon WS URL.
 * The tricky case is an ingress that mounts the CP under a path prefix (e.g. `/cp`
 * with the prefix stripped before the CP): `WS_PATH` has to be appended UNDER that
 * prefix, not overwrite it, or the copy-pasted command 404s at the gateway.
 */
import { describe, it, expect } from 'vitest'
import { daemonWsUrl, daemonStartCommand, daemonPkgSpec } from './onboarding.js'
import type { HttpServerConfig } from './deps.js'

const cfg = (over: Partial<HttpServerConfig>): HttpServerConfig => ({
  DEFAULT_OWNER_ID: 'owner',
  ...over
})

describe('daemonWsUrl', () => {
  it('appends WS_PATH to a bare https origin (https → wss)', () => {
    expect(daemonWsUrl(cfg({ PUBLIC_CP_URL: 'https://cp.example.com' }))).toBe('wss://cp.example.com/daemon/ws')
  })

  it('preserves an ingress path prefix and appends WS_PATH under it', () => {
    // `/cp` is the gateway mount the edge strips before the CP — keep it on the
    // dialled URL so `wss://app.example.com/cp/daemon/ws` routes, then arrives as `/daemon/ws`.
    expect(daemonWsUrl(cfg({ PUBLIC_CP_URL: 'https://app.example.com/cp' }))).toBe('wss://app.example.com/cp/daemon/ws')
  })

  it('tolerates a trailing slash on the prefix (no doubled slash)', () => {
    expect(daemonWsUrl(cfg({ PUBLIC_CP_URL: 'https://cp.example.com/cp/' }))).toBe('wss://cp.example.com/cp/daemon/ws')
  })

  it('maps http → ws', () => {
    expect(daemonWsUrl(cfg({ PUBLIC_CP_URL: 'http://localhost:8080' }))).toBe('ws://localhost:8080/daemon/ws')
  })

  it('honours a custom WS_PATH under the prefix', () => {
    expect(daemonWsUrl(cfg({ PUBLIC_CP_URL: 'https://cp.example.com/cp', WS_PATH: '/edge/socket' }))).toBe(
      'wss://cp.example.com/cp/edge/socket'
    )
  })

  it('drops any query string on PUBLIC_CP_URL', () => {
    expect(daemonWsUrl(cfg({ PUBLIC_CP_URL: 'https://cp.example.com/cp?foo=1' }))).toBe(
      'wss://cp.example.com/cp/daemon/ws'
    )
  })

  it('falls back to HOST:PORT when PUBLIC_CP_URL is unset, rendering 0.0.0.0 as 127.0.0.1', () => {
    expect(daemonWsUrl(cfg({ HOST: '0.0.0.0', PORT: 8080 }))).toBe('ws://127.0.0.1:8080/daemon/ws')
  })

  it('uses the configured HOST when it is not the wildcard', () => {
    expect(daemonWsUrl(cfg({ HOST: 'cp.example.com', PORT: 9000 }))).toBe('ws://cp.example.com:9000/daemon/ws')
  })
})

describe('daemonPkgSpec', () => {
  it('renders the bare package when no dist-tag is set', () => {
    expect(daemonPkgSpec()).toBe('@agentconnect.md/daemon')
    expect(daemonPkgSpec('')).toBe('@agentconnect.md/daemon')
    expect(daemonPkgSpec('  ')).toBe('@agentconnect.md/daemon')
  })

  it('appends a configured dist-tag (or version)', () => {
    expect(daemonPkgSpec('rc')).toBe('@agentconnect.md/daemon@rc')
    expect(daemonPkgSpec('1.2.3')).toBe('@agentconnect.md/daemon@1.2.3')
  })

  it('tolerates a leading @ and surrounding whitespace, so `@rc` works too', () => {
    expect(daemonPkgSpec('@rc')).toBe('@agentconnect.md/daemon@rc')
    expect(daemonPkgSpec(' rc ')).toBe('@agentconnect.md/daemon@rc')
  })
})

describe('daemonStartCommand', () => {
  it('renders a copy-pasteable npx command with url + key (no --daemon-id)', () => {
    const cmd = daemonStartCommand('wss://cp.example.com/cp/daemon/ws', 'test-api-key')
    expect(cmd).toBe(
      'npx -y @agentconnect.md/daemon run --api-url wss://cp.example.com/cp/daemon/ws --api-key test-api-key'
    )
    expect(cmd).not.toContain('--daemon-id')
  })

  it('pins the configured dist-tag on the package (e.g. @rc on the test CP)', () => {
    const cmd = daemonStartCommand('wss://cp.example.com/cp/daemon/ws', 'test-api-key', 'rc')
    expect(cmd).toBe(
      'npx -y @agentconnect.md/daemon@rc run --api-url wss://cp.example.com/cp/daemon/ws --api-key test-api-key'
    )
  })
})
