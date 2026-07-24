/**
 * Pure-logic unit tests for the embedded OAuth AS (agent-assistant.md §7) — the
 * PKCE-adjacent predicates that must be exactly right for interop with Claude's
 * OAuth client. No DB.
 */
import { describe, it, expect } from 'vitest'
import { isRegisterableRedirectUri, redirectUriMatches, normalizeScopes, OAUTH_SCOPES } from './oauthService.js'
import {
  protectedResourceMetadata,
  mcpAuthenticateChallenge,
  mcpResourceUrl,
  authorizationServerMetadata
} from '../http/oauth/base.js'

describe('redirect URI registration rules', () => {
  it('accepts https and http loopback, rejects other http and fragments', () => {
    expect(isRegisterableRedirectUri('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isRegisterableRedirectUri('http://localhost/callback')).toBe(true)
    expect(isRegisterableRedirectUri('http://127.0.0.1:51000/callback')).toBe(true)
    expect(isRegisterableRedirectUri('http://evil.example.com/cb')).toBe(false) // non-loopback http
    expect(isRegisterableRedirectUri('https://ok.example.com/cb#frag')).toBe(false) // fragment
    expect(isRegisterableRedirectUri('not-a-url')).toBe(false)
  })
})

describe('redirect URI matching (RFC 8252 loopback port-agnostic)', () => {
  it('exact-matches non-loopback and ignores the port for loopback', () => {
    const reg = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback', 'http://127.0.0.1/callback']
    expect(redirectUriMatches(reg, 'https://claude.ai/api/mcp/auth_callback')).toBe(true)
    // Claude Code binds an ephemeral port each run — must still match the registered loopback.
    expect(redirectUriMatches(reg, 'http://localhost:57321/callback')).toBe(true)
    expect(redirectUriMatches(reg, 'http://127.0.0.1:49999/callback')).toBe(true)
    // A different host or path never matches.
    expect(redirectUriMatches(reg, 'https://claude.ai/evil')).toBe(false)
    expect(redirectUriMatches(reg, 'http://localhost:57321/evil')).toBe(false)
    expect(redirectUriMatches(reg, 'https://phish.example.com/api/mcp/auth_callback')).toBe(false)
  })
})

describe('scope normalization', () => {
  it('intersects with supported scopes and defaults to mcp:read', () => {
    expect(normalizeScopes('mcp:read mcp:write')).toEqual(['mcp:read', 'mcp:write'])
    expect(normalizeScopes('mcp:write offline_access')).toEqual(['mcp:write'])
    expect(normalizeScopes('nonsense')).toEqual(['mcp:read'])
    expect(normalizeScopes(undefined)).toEqual(['mcp:read'])
    expect(normalizeScopes('')).toEqual(['mcp:read'])
  })
})

describe('resource-server discovery (PRM + 401 challenge — AS metadata is the SDK router)', () => {
  const base = 'https://cp.example.com'
  it('PRM points at this AS and the canonical MCP resource URL — the PUBLIC /v1 form', () => {
    const prm = protectedResourceMetadata(base, {})
    expect(prm.resource).toBe(mcpResourceUrl(base, {}))
    // `/v1`, not the internal `/api/v1` (see MCP_PUBLIC_PATH) — RFC 9728 clients
    // validate this byte-for-byte against the URL they dialed.
    expect(prm.resource).toBe(`${base}/v1/mcp`)
    expect(prm.authorization_servers).toEqual([base])
    expect(prm.scopes_supported).toEqual([...OAUTH_SCOPES])
  })
  it('the MCP 401 challenge carries resource_metadata + scope at the public path', () => {
    const challenge = mcpAuthenticateChallenge(base, {})
    expect(challenge).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/v1/mcp"`)
    expect(challenge).toContain('scope="mcp:read mcp:write"')
  })
  it('a dedicated MCP origin (PUBLIC_MCP_URL) carries the WHOLE OAuth surface: root resource + AS', () => {
    // The URL users paste is just the host. The RESOURCE is the BARE ORIGIN (no
    // trailing slash) — the MCP spec's canonical-URI form (2025-06-18 §Canonical Server
    // URI: "use the form without the trailing slash"), which is what claude.ai stores
    // for the connector and binds the token to; a slashed value mismatches it and the
    // client aborts post-token at audience binding. A slash on PUBLIC_MCP_URL itself is
    // normalized away (new URL(...).origin). The AS issuer/endpoints ride the same
    // origin — the embedded AS exists solely for MCP, so the api host serves no OAuth.
    const config = { PUBLIC_MCP_URL: 'https://mcp.example.test/' }
    const prm = protectedResourceMetadata(base, config)
    expect(prm.resource).toBe('https://mcp.example.test')
    expect(prm.authorization_servers).toEqual(['https://mcp.example.test'])
    const challenge = mcpAuthenticateChallenge(base, config)
    expect(challenge).toContain('resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"')
    const as = authorizationServerMetadata(base, config)
    expect(as.issuer).toBe('https://mcp.example.test')
    expect(as.authorization_endpoint).toBe('https://mcp.example.test/oauth/authorize')
    expect(as.token_endpoint).toBe('https://mcp.example.test/oauth/token')
    expect(as.registration_endpoint).toBe('https://mcp.example.test/oauth/register')
  })
})
