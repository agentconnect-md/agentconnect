// The sending token's check (email-integration.md §7): one read of the account's Email Sending suppression list, which Cloudflare documents as needing the permission a send needs; nothing is sent or changed.

export const CLOUDFLARE_API_URL = 'https://api.cloudflare.com/client/v4'

/** `ok` the token may send for the account; `refused` Cloudflare answered that it may not; `unavailable` nothing was learned. */
export type EmailTokenProbeStatus = 'ok' | 'refused' | 'unavailable'

export interface EmailTokenProbeResult {
  status: EmailTokenProbeStatus
  message: string
}

/** Give up on a silent provider rather than hold the save request open. */
const PROBE_TIMEOUT_MS = 10_000

/** The read the check makes, for one account. */
export function emailTokenProbeUrl(accountId: string): string {
  return `${CLOUDFLARE_API_URL}/accounts/${encodeURIComponent(accountId)}/email/sending/suppressions`
}

export async function probeEmailSendingToken(
  input: { accountId: string; apiToken: string },
  fetchImpl: typeof fetch
): Promise<EmailTokenProbeResult> {
  let response: Response
  let body: { success?: unknown } | null
  try {
    response = await fetchImpl(emailTokenProbeUrl(input.accountId), {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${input.apiToken}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
    })
    body = (await response.json().catch(() => null)) as typeof body
  } catch {
    return unavailable()
  }
  if (response.ok && body?.success === true) {
    return { status: 'ok', message: 'Cloudflare accepted the token for this account’s Email Sending' }
  }
  // Only a client error other than a rate limit is an answer about the token.
  if (response.status < 400 || response.status === 429 || response.status >= 500) return unavailable()
  // The provider's own error text is never echoed: it can name resources of the account.
  return {
    status: 'refused',
    message:
      'Cloudflare refused this token for the account’s Email Sending. Check the account ID, and create a token with the Email Sending: Edit permission for that account.'
  }
}

function unavailable(): EmailTokenProbeResult {
  return {
    status: 'unavailable',
    message: 'Setup could not reach Cloudflare to check the token. Nothing was saved; try again in a moment.'
  }
}
