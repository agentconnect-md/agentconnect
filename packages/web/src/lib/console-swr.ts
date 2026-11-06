import type { SWRConfiguration } from 'swr'
import { ApiError } from '@/lib/api'

/** The console's SWR defaults: a transient failure retries with backoff, a refusal does not. */
export const CONSOLE_SWR_CONFIG = {
  dedupingInterval: 2_000,
  focusThrottleInterval: 5_000,
  shouldRetryOnError: (error: unknown) =>
    !(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500
} satisfies SWRConfiguration

/** Waits between reads of a session its daemon has just opened, about 15 seconds in all. */
const UNREGISTERED_RETRY_MS = [1_000, 2_000, 3_000, 4_000, 5_000]

/** A task its daemon just opened is not found until the daemon reports it, so a 404 is read again for a moment before it stands. */
export async function readOnceRegistered<T>(read: () => Promise<T>, delays = UNREGISTERED_RETRY_MS): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (error) {
      const delay = delays[attempt]
      if (!(error instanceof ApiError) || error.status !== 404 || delay === undefined) throw error
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}
