import { describe, expect, it } from 'vitest'
import { WEBCHAT_MCP_GRANT_PREFIX, WebchatMcpGrantTokenCodec } from './webchatMcpGrantToken.js'

describe('WebchatMcpGrantTokenCodec', () => {
  it('mints opaque 256-bit credentials and stores only a keyed hash', () => {
    const codec = new WebchatMcpGrantTokenCodec('a'.repeat(32))
    const first = codec.mint()
    const second = codec.mint()

    expect(first.plaintext).toMatch(new RegExp(`^${WEBCHAT_MCP_GRANT_PREFIX}[A-Za-z0-9_-]{43}$`))
    expect(first.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(first.tokenHash).toBe(codec.hash(first.plaintext))
    expect(second.plaintext).not.toBe(first.plaintext)
    expect(second.tokenHash).not.toBe(first.tokenHash)
  })

  it('rejects malformed and legacy credential shapes', () => {
    const codec = new WebchatMcpGrantTokenCodec('b'.repeat(32))

    expect(codec.hash('')).toBeNull()
    expect(codec.hash('ac_mcp_assert_v1_not-a-grant')).toBeNull()
    expect(codec.hash(`${WEBCHAT_MCP_GRANT_PREFIX}${'a'.repeat(42)}`)).toBeNull()
  })

  it('domain-separates hashes by deployment pepper', () => {
    const token = new WebchatMcpGrantTokenCodec('c'.repeat(32)).mint().plaintext

    expect(new WebchatMcpGrantTokenCodec('c'.repeat(32)).hash(token)).not.toBe(
      new WebchatMcpGrantTokenCodec('d'.repeat(32)).hash(token)
    )
  })
})
