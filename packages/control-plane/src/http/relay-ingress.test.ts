import { describe, it, expect } from 'vitest'
import { relayHttpBase, unreachableIngressOrigin, publicRelayIngress } from './relay-ingress.js'

describe('relayHttpBase', () => {
  it('normalizes ws(s) to http(s) and trims a trailing slash', () => {
    expect(relayHttpBase('wss://relay.example.test/')).toBe('https://relay.example.test')
    expect(relayHttpBase('ws://relay.example.test')).toBe('http://relay.example.test')
    expect(relayHttpBase('https://relay.example.test/')).toBe('https://relay.example.test')
  })

  it('is null when PUBLIC_RELAY_URL is unset', () => {
    expect(relayHttpBase(undefined)).toBeNull()
    expect(relayHttpBase('')).toBeNull()
  })
})

describe('unreachableIngressOrigin', () => {
  it('accepts an origin a platform could dial', () => {
    expect(unreachableIngressOrigin('https://relay.example.test')).toBe(false)
    expect(unreachableIngressOrigin('https://relay.example.test:8443/relay')).toBe(false)
    expect(unreachableIngressOrigin('https://203.0.113.10')).toBe(false)
    expect(unreachableIngressOrigin('https://[2606:4700:4700::1111]')).toBe(false)
  })

  it('rejects loopback and special-use names', () => {
    expect(unreachableIngressOrigin('http://localhost:8090')).toBe(true)
    expect(unreachableIngressOrigin('http://LOCALHOST:8090')).toBe(true)
    expect(unreachableIngressOrigin('http://relay.localhost:8090')).toBe(true)
    expect(unreachableIngressOrigin('http://relay.local')).toBe(true)
    expect(unreachableIngressOrigin('https://relay.internal')).toBe(true)
    expect(unreachableIngressOrigin('https://relay.home.arpa')).toBe(true)
  })

  it('rejects literal private, loopback and link-local addresses', () => {
    for (const origin of [
      'http://127.0.0.1:8090',
      'http://10.1.2.3:8090',
      'http://172.16.0.9',
      'http://192.168.1.4:8090',
      'http://169.254.169.254',
      'http://100.64.0.1',
      'http://[::1]:8090',
      'http://[fd00::1]',
      'http://[fe80::1]'
    ]) {
      expect(unreachableIngressOrigin(origin), origin).toBe(true)
    }
  })

  it('does not mistake a public name that merely contains a private suffix', () => {
    expect(unreachableIngressOrigin('https://relay.localhost.example.test')).toBe(false)
    expect(unreachableIngressOrigin('https://internal.example.test')).toBe(false)
  })
})

describe('publicRelayIngress', () => {
  it('hands back the request_url base when a public relay is connected', () => {
    expect(publicRelayIngress('wss://relay.example.test/', true)).toEqual({
      ok: true,
      base: 'https://relay.example.test'
    })
  })

  it('names which half of the deployment is missing', () => {
    const noUrl = publicRelayIngress(undefined, true)
    const noRelay = publicRelayIngress('https://relay.example.test', false)
    expect(noUrl).toEqual({
      ok: false,
      message:
        'HTTP callback delivery is unavailable on this deployment — the relay pool has no public origin (set PUBLIC_RELAY_URL).'
    })
    expect(noRelay).toEqual({
      ok: false,
      message: 'HTTP callback delivery is unavailable on this deployment — no relay is connected.'
    })
  })

  it('refuses a connected relay no platform can reach, naming the origin', () => {
    // The issue's default Compose stack: a healthy, registered, loopback-only relay.
    const result = publicRelayIngress('http://localhost:8090', true)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('http://localhost:8090')
    expect(result.ok === false && result.message).toContain('socket')
  })
})
