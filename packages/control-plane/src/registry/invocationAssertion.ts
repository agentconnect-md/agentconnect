/**
 * One-time delegated MCP assertion minting.
 *
 * The recognizable prefix keeps this credential out of every other bearer-token
 * parser. Persistence receives only the domain-separated, peppered digest.
 */
import { createHmac, randomBytes } from 'node:crypto'

export const INVOCATION_ASSERTION_PREFIX = 'ac_mcp_assert_v1_'
const ASSERTION_BYTES = 32
const ASSERTION_BODY_LENGTH = 43
const ASSERTION_RE = new RegExp(`^${INVOCATION_ASSERTION_PREFIX}[A-Za-z0-9_-]{${ASSERTION_BODY_LENGTH}}$`)
const HASH_DOMAIN = 'agentconnect:mcp-invocation-assertion:v1\0'

export interface MintedInvocationAssertion {
  /** One-time bearer value. Never spread this object into a persistence call. */
  plaintext: string
  /** The complete persistence-safe projection. */
  persistence: Readonly<{ assertionHash: string }>
}

export class InvocationAssertionCodec {
  constructor(private readonly pepper: string) {}

  mint(): MintedInvocationAssertion {
    const plaintext = `${INVOCATION_ASSERTION_PREFIX}${randomBytes(ASSERTION_BYTES).toString('base64url')}`
    const minted = {
      persistence: Object.freeze({ assertionHash: this.hashUnchecked(plaintext) })
    } as MintedInvocationAssertion
    Object.defineProperty(minted, 'plaintext', {
      value: plaintext,
      enumerable: false,
      writable: false,
      configurable: false
    })
    return Object.freeze(minted)
  }

  /** Validate and hash a presented invocation assertion. */
  hash(assertion: string): string | null {
    return ASSERTION_RE.test(assertion) ? this.hashUnchecked(assertion) : null
  }

  private hashUnchecked(assertion: string): string {
    return createHmac('sha256', this.pepper).update(HASH_DOMAIN).update(assertion).digest('hex')
  }
}
