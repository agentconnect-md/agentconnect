// What every `rd/platform/request` handler needs of its provider call: the one budget's bound and the provider's own backoff.

/** Settle with `undefined` once `ms` pass; the work goes on and may still fill a token cache. */
export async function within<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) {
    work.catch(() => {})
    return undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), ms)))
  try {
    return await Promise.race([work, late])
  } finally {
    clearTimeout(timer)
    work.catch(() => {})
  }
}

/** `Retry-After` as delta-seconds or an HTTP date; absent or unreadable ⇒ undefined. */
export function retryAfterMs(res: Response, now: number): number | undefined {
  const raw = res.headers?.get?.('retry-after')
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000))
  const at = Date.parse(raw)
  return Number.isNaN(at) ? undefined : Math.max(0, at - now)
}
