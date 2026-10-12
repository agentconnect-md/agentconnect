// Bound a callback's handling so the route still answers inside the provider's window; the work keeps running past an expiry.
export type Settled<T> = { kind: 'handled'; handled: T } | { kind: 'expired' } | { kind: 'failed' }

export function settleWithin<T>(work: Promise<T>, deadlineMs: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ kind: 'expired' }), deadlineMs)
    work.then(
      (handled) => {
        clearTimeout(timer)
        resolve({ kind: 'handled', handled })
      },
      () => {
        clearTimeout(timer)
        resolve({ kind: 'failed' })
      }
    )
  })
}
