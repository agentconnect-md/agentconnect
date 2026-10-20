import {
  Bucket,
  BucketCredentialsSchema,
  ByteQuantity,
  checkSessionDuration,
  DurationSeconds,
  Endpoint,
  parseEnvDocument,
  Prefix,
  Region,
  withSessionDuration
} from '@agentconnect.md/object-store'
import { COMPUTER_SCREENSHOT_MAX_BYTES, COMPUTER_SCREENSHOT_RETENTION_MAX_DAYS } from '@agentconnect.md/protocol'
import { z } from 'zod'

// Computer screenshot storage (computer-use.md §9): the bucket the control plane signs desktop uploads and console reads for.

export const COMPUTER_SCREENSHOTS_ENV = 'AC_COMPUTER_SCREENSHOTS'

const Limits = z
  .strictObject({
    // The largest screenshot stored, how long a desktop's PUT stays valid, and how long a console read link does.
    maxBytes: ByteQuantity.default(8 * 1024 ** 2),
    putUrlSeconds: DurationSeconds.default(300),
    getUrlSeconds: DurationSeconds.default(300)
  })
  .prefault({})

const Retention = z
  .strictObject({
    // Days a Computer without its own `screenshotRetentionDays` keeps screenshots; 0 stores none by default.
    defaultDays: z.number().int().min(0).max(COMPUTER_SCREENSHOT_RETENTION_MAX_DAYS).default(30),
    // The most any Computer's policy may ask for.
    maxDays: z.number().int().min(1).max(COMPUTER_SCREENSHOT_RETENTION_MAX_DAYS).default(365)
  })
  .prefault({})

export const ComputerScreenshotsConfigSchema = z
  .strictObject({
    version: z.literal(1),
    // The origin the control plane reaches the bucket at; the AWS regional endpoint when omitted.
    endpoint: Endpoint.optional(),
    // The origin desktops and browsers reach it at, when it differs from `endpoint`.
    publicEndpoint: Endpoint.optional(),
    region: Region,
    bucket: Bucket,
    prefix: Prefix,
    forcePathStyle: z.boolean().default(false),
    credentials: BucketCredentialsSchema,
    limits: Limits,
    retention: Retention
  })
  .superRefine((config, ctx) => {
    const { limits, retention } = config
    for (const key of ['putUrlSeconds', 'getUrlSeconds'] as const) {
      if (limits[key] < 60 || limits[key] > 3600) {
        ctx.addIssue({ code: 'custom', path: ['limits', key], message: 'must be between 1m and 1h' })
      }
    }
    if (limits.maxBytes > COMPUTER_SCREENSHOT_MAX_BYTES) {
      ctx.addIssue({ code: 'custom', path: ['limits', 'maxBytes'], message: 'must not exceed 32Mi' })
    }
    if (retention.defaultDays > retention.maxDays) {
      ctx.addIssue({ code: 'custom', path: ['retention', 'defaultDays'], message: 'must not exceed maxDays' })
    }
    checkSessionDuration(config.credentials, longestUrl(limits), ['limits', 'getUrlSeconds'], ctx)
  })
  .transform((config) => ({
    ...config,
    credentials: withSessionDuration(config.credentials, longestUrl(config.limits))
  }))

function longestUrl(limits: { putUrlSeconds: number; getUrlSeconds: number }): number {
  return Math.max(limits.putUrlSeconds, limits.getUrlSeconds)
}

export type ComputerScreenshotsConfig = z.output<typeof ComputerScreenshotsConfigSchema>

/** Parse the screenshot storage document; undefined when unset, a thrown error (never echoing values) when invalid. */
export function loadComputerScreenshotsConfig(env: NodeJS.ProcessEnv): ComputerScreenshotsConfig | undefined {
  return parseEnvDocument(env, COMPUTER_SCREENSHOTS_ENV, ComputerScreenshotsConfigSchema)
}
