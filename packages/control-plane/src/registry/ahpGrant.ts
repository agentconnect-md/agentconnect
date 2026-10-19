import { createHmac } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { z } from 'zod'
import { AHP_GRANT_MAX_AGE_MS } from '@agentconnect.md/protocol'

const Claims = z
  .object({
    orgId: z.string().min(1),
    agentId: z.string().uuid(),
    userId: z.string().min(1),
    user: z.string(),
    apiKeyId: z.string().optional(),
    conversationId: z.string().uuid().optional(),
    privateSessionOwnerIdentity: z.string().optional()
  })
  .refine((value) => Boolean(value.apiKeyId) !== Boolean(value.conversationId))
export type AhpGrantClaims = z.infer<typeof Claims>
const AUDIENCE = 'agentconnect.ahp-client.v1'

export class AhpGrantService {
  private readonly key: Uint8Array
  constructor(
    pepper: string,
    private readonly now: () => number = Date.now
  ) {
    this.key = createHmac('sha256', pepper).update(AUDIENCE).digest()
  }

  async mint(claims: AhpGrantClaims, validUntilMs = Infinity): Promise<{ token: string; expiresAtMs: number }> {
    const expiresAtMs = Math.floor(Math.min(this.now() + AHP_GRANT_MAX_AGE_MS, validUntilMs) / 1000) * 1000
    if (expiresAtMs <= this.now()) throw new Error('AHP authority expired')
    const token = await new SignJWT(Claims.parse(claims))
      .setProtectedHeader({ alg: 'HS256' })
      .setAudience(AUDIENCE)
      .setIssuedAt(Math.floor(this.now() / 1000))
      .setExpirationTime(expiresAtMs / 1000)
      .sign(this.key)
    return { token, expiresAtMs }
  }

  async verify(token: string): Promise<AhpGrantClaims | null> {
    try {
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['HS256'],
        audience: AUDIENCE,
        currentDate: new Date(this.now()),
        maxTokenAge: '60s'
      })
      const parsed = Claims.safeParse(payload)
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }
}
