// Bounded, provider-neutral REST read helpers shared by the skill acquisition path and source resolution.

/** The longest wait a provider's rate-limit answer may impose on a caller. */
export const MAX_RETRY_AFTER_MS = 15 * 60 * 1000

export async function discardResponse(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

// A read repeats an unreachable host or a 5xx: immediately once, then after 300–600ms; an abort is final.
const READ_RETRY_DELAYS_MS = [0, 300]

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

export async function fetchWithRedirectPolicy(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  init: RequestInit,
  redirect: 'error' | 'manual',
  label: string
): Promise<Response> {
  for (let attempt = 0; ; attempt += 1) {
    const delay = READ_RETRY_DELAYS_MS[attempt]
    let response: Response
    try {
      response = await fetchImpl(url, { ...init, redirect })
    } catch {
      if (delay === undefined || init.signal?.aborted) throw new Error(`${label} request failed`)
      await sleep(delay + Math.floor(Math.random() * delay))
      continue
    }
    // Every caller here is a GET, so a 5xx is safe to repeat; the last answer stays the caller's to classify.
    if (response.status < 500 || delay === undefined) return response
    await discardResponse(response)
    await sleep(delay + Math.floor(Math.random() * delay))
  }
}

export async function readBoundedBody(response: Response, maxBytes: number, label: string): Promise<Buffer> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > maxBytes) {
    await discardResponse(response)
    throw new Error(`${label} exceeded the byte limit`)
  }
  if (!response.body) throw new Error(`${label} returned no body`)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`${label} exceeded the byte limit`)
      }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, total)
  } catch (error) {
    if (error instanceof Error && error.message === `${label} exceeded the byte limit`) throw error
    throw new Error(`${label} response body failed`)
  }
}

/** How long a provider asked us to wait (Retry-After, else an epoch-seconds rate-limit reset), capped at 15 min. */
export function retryAfterMs(response: Response, now: () => number = Date.now): number | undefined {
  const cap = (ms: number): number | undefined =>
    Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_RETRY_AFTER_MS) : undefined
  const retryAfter = response.headers.get('retry-after')?.trim()
  if (retryAfter) {
    if (/^\d+$/.test(retryAfter)) return cap(Number(retryAfter) * 1000)
    const at = Date.parse(retryAfter)
    if (!Number.isNaN(at)) return cap(at - now())
  }
  const reset = (response.headers.get('x-ratelimit-reset') ?? response.headers.get('ratelimit-reset'))?.trim()
  if (reset && /^\d+$/.test(reset)) return cap(Number(reset) * 1000 - now())
  return undefined
}
