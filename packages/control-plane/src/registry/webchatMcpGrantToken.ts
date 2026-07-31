import { createHmac, randomBytes } from 'node:crypto'

export const WEBCHAT_MCP_GRANT_PREFIX = 'ac_mcp_grant_v1_'
const TOKEN_RE = new RegExp(`^${WEBCHAT_MCP_GRANT_PREFIX}[A-Za-z0-9_-]{43}$`)
const HASH_DOMAIN = 'agentconnect:webchat-mcp-grant:v1\0'

export class WebchatMcpGrantTokenCodec {
  constructor(private readonly pepper: string) {}

  mint(): { plaintext: string; tokenHash: string } {
    const plaintext = `${WEBCHAT_MCP_GRANT_PREFIX}${randomBytes(32).toString('base64url')}`
    return { plaintext, tokenHash: this.hashUnchecked(plaintext) }
  }

  hash(token: string): string | null {
    return TOKEN_RE.test(token) ? this.hashUnchecked(token) : null
  }

  private hashUnchecked(token: string): string {
    return createHmac('sha256', this.pepper).update(HASH_DOMAIN).update(token).digest('hex')
  }
}
