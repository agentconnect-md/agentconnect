import { z } from 'zod'

// Screenshot storage (computer-use.md §9): the desktop uploads to the object store with a URL the CP signs; no bytes cross the CP.

/** The CP signs screenshot uploads with `computer/screenshot/put`; a desktop stores nothing without it. */
export const COMPUTER_SCREENSHOT_FEATURE = 'computer-screenshot-v1'

/** The longest retention a policy may ask for; 0 means screenshots are never written. */
export const COMPUTER_SCREENSHOT_RETENTION_MAX_DAYS = 3650

/** The largest screenshot a desktop offers for storage; the deployment may cap it lower. */
export const COMPUTER_SCREENSHOT_MAX_BYTES = 32 * 1024 * 1024

export const COMPUTER_SCREENSHOT_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const
export type ComputerScreenshotContentType = (typeof COMPUTER_SCREENSHOT_CONTENT_TYPES)[number]

const REF_PREFIX = 'sha256:'
const SHA256_HEX_RE = /^[0-9a-f]{64}$/

export const ComputerScreenshotSha256 = z.string().regex(SHA256_HEX_RE, 'expected a lower-case hex SHA-256')

/** How a tool result and the session timeline name a stored screenshot: its content hash. */
export function computerScreenshotRef(sha256: string): string {
  return `${REF_PREFIX}${sha256}`
}

/** The hash a screenshot reference names, or undefined for anything else. */
export function parseComputerScreenshotRef(ref: unknown): string | undefined {
  if (typeof ref !== 'string' || !ref.startsWith(REF_PREFIX)) return undefined
  const sha256 = ref.slice(REF_PREFIX.length)
  return SHA256_HEX_RE.test(sha256) ? sha256 : undefined
}

// D→C REQ behind `computer-screenshot-v1`: sign the upload of one screenshot an agent session's call returned.
export const ComputerScreenshotPut = z
  .object({
    sessionId: z.string().min(1).max(256),
    agentId: z.string().uuid(),
    sha256: ComputerScreenshotSha256,
    bytes: z.number().int().positive().max(COMPUTER_SCREENSHOT_MAX_BYTES),
    contentType: z.enum(COMPUTER_SCREENSHOT_CONTENT_TYPES),
    takenAt: z.string().datetime()
  })
  .strict()
export type ComputerScreenshotPut = z.infer<typeof ComputerScreenshotPut>

// C→D REP: PUT the bytes with exactly these headers, or nothing to do (already stored, or not to be stored at all).
export const ComputerScreenshotPutOk = z.object({
  status: z.enum(['upload', 'stored', 'skipped']),
  url: z.string().url().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  expiresAt: z.string().datetime().optional(),
  reason: z.string().max(200).optional()
})
export type ComputerScreenshotPutOk = z.infer<typeof ComputerScreenshotPutOk>

// D→C REQ after the PUT succeeded: the CP checks the object and records it as stored.
export const ComputerScreenshotCommit = z
  .object({ sessionId: z.string().min(1).max(256), sha256: ComputerScreenshotSha256 })
  .strict()
export type ComputerScreenshotCommit = z.infer<typeof ComputerScreenshotCommit>

// C→D REP: whether the CP found exactly the announced bytes.
export const ComputerScreenshotCommitOk = z.object({ stored: z.boolean() })
export type ComputerScreenshotCommitOk = z.infer<typeof ComputerScreenshotCommitOk>
