import { describe, expect, it } from 'vitest'
import { IssueKeyRequest, IssueKeyResponse, keyGrantViolation, RevokeKeyRequest } from './key-server.js'

const request = IssueKeyRequest.parse({
  orgId: 'org-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  provider: 'anthropic',
  ttlSeconds: 3600
})

describe('agentconnect.key-server/v1 schemas', () => {
  it('accepts a bounded grant and an unbounded one, but not a refresh without or after its expiry', () => {
    const bounded = {
      keyId: 'k-1',
      key: 'jwt…',
      baseUrl: 'https://gateway.example.test',
      expiresInSeconds: 3600,
      refreshInSeconds: 2880
    }
    expect(IssueKeyResponse.parse(bounded)).toEqual(bounded)
    expect(IssueKeyResponse.parse({ keyId: 'k-2', key: 'sk-…' })).toEqual({ keyId: 'k-2', key: 'sk-…' })
    expect(() => IssueKeyResponse.parse({ keyId: 'k-3', key: 'x', refreshInSeconds: 60 })).toThrow()
    expect(() =>
      IssueKeyResponse.parse({ keyId: 'k-4', key: 'x', expiresInSeconds: 60, refreshInSeconds: 3600 })
    ).toThrow()
  })

  it('takes an http(s) baseUrl and nothing else, since it becomes a runtime API base', () => {
    // safeParse, not parse().toThrow(): a rejection must arrive as a zod result, and a
    // predicate that threw natively would satisfy toThrow() while escaping validation.
    const withUrl = (baseUrl: string) => IssueKeyResponse.safeParse({ keyId: 'k', key: 'x', baseUrl })
    // Loopback http is the normal shape for an in-pod gateway, so it stays legal.
    expect(withUrl('http://localhost:8080').success).toBe(true)
    expect(withUrl('https://gateway.example.test').success).toBe(true)
    expect(withUrl('file:///etc/passwd').success).toBe(false)
    expect(withUrl('not a url').success).toBe(false)
    expect(withUrl('').success).toBe(false)
  })

  it('states validity as durations, so ordering never depends on timestamp spelling', () => {
    // An absolute-instant contract compared as text ordered `…00.001Z` before `…00Z`, which
    // let a refresh land after its own expiry. Durations have one ordering, and it is numeric.
    expect(() => IssueKeyResponse.parse({ keyId: 'k', key: 'x', expiresInSeconds: 60, refreshInSeconds: 60 })).toThrow()
    expect(IssueKeyResponse.parse({ keyId: 'k', key: 'x', expiresInSeconds: 60, refreshInSeconds: 59 })).toMatchObject({
      refreshInSeconds: 59
    })
  })

  it('requests omit ttlSeconds to ask for a long-lived key, and reject unknown fields', () => {
    expect(IssueKeyRequest.parse({ ...request, ttlSeconds: undefined }).ttlSeconds).toBeUndefined()
    expect(() => IssueKeyRequest.parse({ ...request, model: 'claude-opus-5' })).toThrow()
    expect(() => RevokeKeyRequest.parse({ keyId: '' })).toThrow()
  })

  it('keyGrantViolation enforces narrow-only validity without reading a clock', () => {
    const grant = (expiresInSeconds?: number) =>
      IssueKeyResponse.parse({ keyId: 'k', key: 'v', ...(expiresInSeconds ? { expiresInSeconds } : {}) })
    expect(keyGrantViolation(request, grant(3600))).toBeNull()
    expect(keyGrantViolation(request, grant(1800))).toBeNull()
    expect(keyGrantViolation(request, grant(7200))).toMatch(/exceeds/)
    expect(keyGrantViolation(request, grant())).toMatch(/unbounded/)
    const unbounded = IssueKeyRequest.parse({ ...request, ttlSeconds: undefined })
    expect(keyGrantViolation(unbounded, grant())).toBeNull()
    expect(keyGrantViolation(unbounded, grant(60))).toBeNull()
  })
})
