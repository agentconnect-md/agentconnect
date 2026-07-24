/** Hash-only codec for shareable org join links. */
import { createHmac, randomBytes } from 'node:crypto'

const TOKEN_BYTES = 32
const TOKEN_LENGTH = 43 // base64url(32 bytes), without padding
const TOKEN_RE = new RegExp(`^[A-Za-z0-9_-]{${TOKEN_LENGTH}}$`)
const HASH_DOMAIN = 'agentconnect:org-invite:v1\0'

export interface MintedOrgInviteToken {
  token: string
  hash: string
  displayTail: string
}

export class OrgInviteLinkCodec {
  constructor(private readonly pepper: string) {}

  mint(): MintedOrgInviteToken {
    const token = randomBytes(TOKEN_BYTES).toString('base64url')
    return { token, hash: this.hashUnchecked(token), displayTail: `…${token.slice(-6)}` }
  }

  hash(token: string): string | null {
    return TOKEN_RE.test(token) ? this.hashUnchecked(token) : null
  }

  private hashUnchecked(token: string): string {
    return createHmac('sha256', this.pepper).update(HASH_DOMAIN).update(token).digest('hex')
  }
}
