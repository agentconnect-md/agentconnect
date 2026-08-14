import { describe, expect, it } from 'vitest'
import { GetKeyRequest, GetKeyResponse, keyGrantViolation, RevokeKeyRequest } from './key-server.js'

const request = GetKeyRequest.parse({
  orgId: 'org-1',
  agentId: 'agent-1',
  sessionId: 'session-1',
  provider: 'anthropic',
  ttlSeconds: 3600
})

describe('agentconnect.key-server/v1 schemas', () => {
  it('accepts a bounded grant and an unbounded one, but not refreshAfter without expiry', () => {
    const bounded = {
      keyId: 'k-1',
      key: 'jwt…',
      baseUrl: 'https://gateway.example.test',
      expiresAt: '2026-08-14T13:00:00Z',
      refreshAfter: '2026-08-14T12:45:00Z'
    }
    expect(GetKeyResponse.parse(bounded)).toEqual(bounded)
    expect(GetKeyResponse.parse({ keyId: 'k-2', key: 'sk-…' })).toEqual({ keyId: 'k-2', key: 'sk-…' })
    expect(() => GetKeyResponse.parse({ keyId: 'k-3', key: 'x', refreshAfter: '2026-08-14T12:45:00Z' })).toThrow()
    expect(() =>
      GetKeyResponse.parse({
        keyId: 'k-4',
        key: 'x',
        expiresAt: '2026-08-14T12:00:00Z',
        refreshAfter: '2026-08-14T13:00:00Z'
      })
    ).toThrow()
  })

  it('requests omit ttlSeconds to ask for a long-lived key, and reject unknown fields', () => {
    expect(GetKeyRequest.parse({ ...request, ttlSeconds: undefined }).ttlSeconds).toBeUndefined()
    expect(() => GetKeyRequest.parse({ ...request, model: 'claude-opus-5' })).toThrow()
    expect(() => RevokeKeyRequest.parse({ keyId: '' })).toThrow()
  })

  it('keyGrantViolation enforces narrow-only validity', () => {
    const issuedAt = new Date('2026-08-14T12:00:00Z')
    const grant = (expiresAt?: string) => ({ keyId: 'k', key: 'v', ...(expiresAt ? { expiresAt } : {}) })
    expect(keyGrantViolation(request, GetKeyResponse.parse(grant('2026-08-14T13:00:00Z')), issuedAt)).toBeNull()
    expect(keyGrantViolation(request, GetKeyResponse.parse(grant('2026-08-14T12:30:00Z')), issuedAt)).toBeNull()
    expect(keyGrantViolation(request, GetKeyResponse.parse(grant('2026-08-14T14:00:00Z')), issuedAt)).toMatch(/exceeds/)
    expect(keyGrantViolation(request, GetKeyResponse.parse(grant()), issuedAt)).toMatch(/unbounded/)
    const unbounded = GetKeyRequest.parse({ ...request, ttlSeconds: undefined })
    expect(keyGrantViolation(unbounded, GetKeyResponse.parse(grant()), issuedAt)).toBeNull()
  })
})
