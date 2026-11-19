/** The sending token's check (email-integration.md §7): one read that needs the permission a send needs, and nothing sent. */
import { describe, expect, it } from 'vitest'
import { emailTokenProbeUrl, probeEmailSendingToken } from '../src/email-probe.js'

const ACCOUNT = '0123456789abcdef0123456789abcdef'
const TOKEN = 'example-api-token'

function answering(status: number, body: unknown, seen: { url: string; init: RequestInit }[] = []): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(input), init })
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  }) as typeof fetch
}

describe('the Email sending token check', () => {
  it('reads the account’s suppression list with the token and nothing else', async () => {
    const seen: { url: string; init: RequestInit }[] = []
    const probe = await probeEmailSendingToken(
      { accountId: ACCOUNT, apiToken: TOKEN },
      answering(200, { success: true, errors: [], result: [] }, seen)
    )

    expect(probe.status).toBe('ok')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/email/sending/suppressions`)
    expect(seen[0]!.url).toBe(emailTokenProbeUrl(ACCOUNT))
    expect(seen[0]!.init.method).toBe('GET')
    expect(seen[0]!.init.body).toBeUndefined()
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('reads a client error as a refusal, and never repeats the provider’s own text or the token', async () => {
    const detail = 'Authentication error for account example-internal-name'
    for (const status of [400, 401, 403, 404]) {
      const probe = await probeEmailSendingToken(
        { accountId: ACCOUNT, apiToken: TOKEN },
        answering(status, { success: false, errors: [{ code: 10000, message: detail }] })
      )
      expect(probe.status, String(status)).toBe('refused')
      expect(probe.message).not.toContain(detail)
      expect(probe.message).not.toContain(TOKEN)
    }
  })

  it('learns nothing from a rate limit, a server error, an unreadable answer, or no answer', async () => {
    const check = (fetchImpl: typeof fetch) =>
      probeEmailSendingToken({ accountId: ACCOUNT, apiToken: TOKEN }, fetchImpl)
    for (const fetchImpl of [
      answering(429, { success: false }),
      answering(503, 'unavailable'),
      answering(200, '<html></html>'),
      answering(200, { success: false }),
      (async () => {
        throw new TypeError('fetch failed')
      }) as typeof fetch
    ])
      expect((await check(fetchImpl)).status).toBe('unavailable')
  })
})
