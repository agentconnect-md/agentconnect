import { createHash, createHmac } from 'node:crypto'
import { EncryptJWT, jwtDecrypt } from 'jose'
import { z } from 'zod'

const AUDIENCE = 'agentconnect.ahp-catalog-cursor.v1'
const Scope = z.object({ orgId: z.string(), agentId: z.string(), userId: z.string() })
type CatalogScope = z.infer<typeof Scope>
const Cursor = z.object({ scope: z.string().regex(/^[a-f0-9]{64}$/), after: z.string().min(1).max(1024) })
const SessionId = z.string().min(1).max(256)
const scopeKey = (scope: CatalogScope) =>
  createHash('sha256')
    .update(JSON.stringify(Scope.parse(scope)))
    .digest('hex')

/** Pagination may scan hidden sessions, so neither their IDs nor the scanning principal are plaintext. */
export class AhpCatalogCursor {
  private readonly key: Uint8Array
  constructor(
    pepper: string,
    private readonly now: () => number = Date.now
  ) {
    this.key = createHmac('sha256', pepper).update(AUDIENCE).digest()
  }

  async encode(scope: CatalogScope, after: string): Promise<string> {
    const now = Math.floor(this.now() / 1000)
    // Base64 bounds control-character and Unicode expansion before the JWT serializes its payload.
    const encoded = Buffer.from(SessionId.parse(after), 'utf8').toString('base64url')
    return new EncryptJWT({ scope: scopeKey(scope), after: encoded })
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setAudience(AUDIENCE)
      .setIssuedAt(now)
      .setExpirationTime(now + 600)
      .encrypt(this.key)
  }

  async decode(scope: CatalogScope, token: string): Promise<string | null> {
    try {
      if (token.length > 2048) return null
      const { payload } = await jwtDecrypt(token, this.key, {
        keyManagementAlgorithms: ['dir'],
        contentEncryptionAlgorithms: ['A256GCM'],
        audience: AUDIENCE,
        currentDate: new Date(this.now())
      })
      const cursor = Cursor.parse(payload)
      const after = SessionId.parse(Buffer.from(cursor.after, 'base64url').toString('utf8'))
      if (cursor.scope !== scopeKey(scope) || Buffer.from(after, 'utf8').toString('base64url') !== cursor.after)
        return null
      return after
    } catch {
      return null
    }
  }
}
