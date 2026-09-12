// Daemon-signed hidden attempt markers for formal reviews (gitlab §15.1, gitea §10.3); ordinal 0 is the summary, 1..n the inline comments.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const MARKER_VERSION = '1'
const SIGNATURE_CHARS = 32
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MARKER = /<!-- agentconnect-review:(\d+):([0-9a-fA-F-]{36}):(\d+):([A-Za-z0-9_-]+) -->/g

export interface ReviewMarker {
  attemptId: string
  ordinal: number
}

/** One attempt's marker minting and verification; the key never leaves the daemon. */
export class ReviewMarkerSigner {
  private readonly key: Buffer

  constructor(key?: Buffer) {
    this.key = key ?? randomBytes(32)
  }

  /** The hidden marker chrome for one draft of one attempt at one head. */
  mint(attemptId: string, ordinal: number, headSha: string): string {
    const signature = this.sign(attemptId, ordinal, headSha)
    return `<!-- agentconnect-review:${MARKER_VERSION}:${attemptId}:${ordinal}:${signature} -->`
  }

  /** The verified marker in one body, or undefined when it carries none, several, or one this daemon cannot verify. */
  read(body: string | undefined, headSha: string): ReviewMarker | undefined {
    if (!body) return undefined
    const found = [...body.matchAll(MARKER)]
    if (found.length !== 1) return undefined
    const [, version, attemptId, ordinal, signature] = found[0]!
    if (version !== MARKER_VERSION || !UUID.test(attemptId!)) return undefined
    const index = Number(ordinal)
    if (!Number.isSafeInteger(index) || index < 0) return undefined
    if (!this.matches(this.sign(attemptId!, index, headSha), signature!)) return undefined
    return { attemptId: attemptId!.toLowerCase(), ordinal: index }
  }

  /** Defang marker-shaped text the model authored so it can never shadow our chrome. */
  static neutralize(body: string): string {
    return body.replace(/agentconnect-review:/gi, 'agentconnect-review​:')
  }

  private sign(attemptId: string, ordinal: number, headSha: string): string {
    return createHmac('sha256', this.key)
      .update(`${MARKER_VERSION}|${attemptId.toLowerCase()}|${ordinal}|${headSha}`)
      .digest('base64url')
      .slice(0, SIGNATURE_CHARS)
  }

  private matches(expected: string, actual: string): boolean {
    if (expected.length !== actual.length) return false
    return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(actual, 'utf8'))
  }
}
