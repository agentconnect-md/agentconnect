import type { SWRConfiguration } from 'swr'
import { ApiError } from '@/lib/api'

/** The console's SWR defaults: a transient failure retries with backoff, a refusal does not. */
export const CONSOLE_SWR_CONFIG = {
  dedupingInterval: 2_000,
  focusThrottleInterval: 5_000,
  shouldRetryOnError: (error: unknown) =>
    !(error instanceof ApiError) || error.status === 408 || error.status === 429 || error.status >= 500
} satisfies SWRConfiguration
