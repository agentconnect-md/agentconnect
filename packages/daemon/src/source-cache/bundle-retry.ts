// The dependency-free core of the bundled-acquisition retry contract (source-cache.md §6, §7), shared by the workspace clone and the shim.

/** Git's exit-0 stderr when `--bundle-uri` could not be used; either one makes the attempt a fallback. */
export const BUNDLE_DOWNLOAD_WARNINGS = [
  'failed to download bundle from URI',
  'failed to fetch objects from bundle URI'
] as const

export const BUNDLE_REF_PREFIX = 'refs/bundles/'

/** Names the bundle refs only: a bare `show-ref` of a tag-heavy repository overflows a shim frame. */
export const BUNDLE_REF_LIST_ARGS: readonly string[] = [
  'rev-parse',
  '--symbolic-full-name',
  `--glob=${BUNDLE_REF_PREFIX}*`
]

/** The read-only connectivity check; `--no-dangling` keeps a bundle's unreachable history inside a shim frame. */
export const CONNECTIVITY_CHECK_ARGS: readonly string[] = ['fsck', '--connectivity-only', '--no-dangling']

const MAX_DETAIL_LENGTH = 300

export type BundleFallbackReason =
  | 'clone-failed'
  | 'stderr-unavailable'
  | 'download-warning'
  | 'no-bundle-refs'
  | 'inspect-failed'
  | 'connectivity'
  | 'cleanup-failed'
  | 'acquire-failed'

/** Fallbacks that mean the bundle itself was bad or unusable; a download warning or unseen stderr may be transient and skips. */
export const WRITE_BACK_FALLBACK_REASONS: ReadonlySet<BundleFallbackReason> = new Set([
  'clone-failed',
  'no-bundle-refs',
  'inspect-failed',
  'connectivity',
  'cleanup-failed'
])

/** An in-band failure of a bundled attempt: the caller discards it and retries once without the bundle. */
export class BundleFallback extends Error {
  constructor(
    readonly reason: BundleFallbackReason,
    detail: string
  ) {
    super(detail)
    this.name = 'BundleFallback'
  }
}

/** The ref names under `refs/bundles/` in {@link BUNDLE_REF_LIST_ARGS} output. */
export function bundleRefNamesOf(revParse: string): string[] {
  return revParse
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith(BUNDLE_REF_PREFIX))
}

/** The refs under `refs/bundles/` in `show-ref` output with their object ids, whatever layout the Git that wrote them used. */
export function bundleRefEntriesOf(showRef: string): Array<{ ref: string; oid: string }> {
  const entries: Array<{ ref: string; oid: string }> = []
  for (const line of showRef.split('\n')) {
    const match = /^([0-9a-f]{40,64}) (\S+)$/.exec(line.trim())
    const ref = match?.[2]
    if (ref !== undefined && ref.startsWith(BUNDLE_REF_PREFIX) && !ref.startsWith('-'))
      entries.push({ ref, oid: match![1]! })
  }
  return entries
}

/** The download warning an exit-0 bundled clone printed, if any. */
export function bundleDownloadWarningOf(stderr: string): string | undefined {
  return BUNDLE_DOWNLOAD_WARNINGS.find((text) => stderr.includes(text))
}

/** A presigned URL with its signature and credential material removed, for log lines. */
export function redactPresignedUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return '[invalid url]'
  }
}

/** Flatten and bound `detail` for a log line, with `url` and any stray SigV4 parameter redacted. */
export function scrubBundleDetail(detail: string, url: string | undefined): string {
  const redacted = url === undefined || url === '' ? detail : detail.split(url).join(redactPresignedUrl(url))
  const flat = redacted
    .replace(/X-Amz-[A-Za-z-]+=[^&\s'"]*/g, 'X-Amz-…')
    .replace(/\s+/g, ' ')
    .trim()
  return flat.length > MAX_DETAIL_LENGTH ? `${flat.slice(0, MAX_DETAIL_LENGTH)}…` : flat
}

/** Runs one check of a bundled attempt, turning an in-band failure into a {@link BundleFallback} of `reason`. */
export type BundleStep = <T>(reason: BundleFallbackReason, run: () => Promise<T>) => Promise<T>

export type BundledAttempt<T> =
  { kind: 'hit'; value: T } | { kind: 'fallback'; reason: BundleFallbackReason; detail: string }

/** Run a bundled attempt; an in-band failure is reported as a fallback, an `unretryable` one (timeout, abort, lost channel) propagates. */
export async function attemptWithBundle<T>(
  unretryable: (err: unknown) => boolean,
  attempt: (step: BundleStep) => Promise<T>
): Promise<BundledAttempt<T>> {
  const step: BundleStep = async (reason, run) => {
    try {
      return await run()
    } catch (err) {
      if (err instanceof BundleFallback || unretryable(err)) throw err
      throw new BundleFallback(reason, err instanceof Error ? err.message : String(err))
    }
  }
  try {
    return { kind: 'hit', value: await attempt(step) }
  } catch (err) {
    if (!(err instanceof BundleFallback)) throw err
    return { kind: 'fallback', reason: err.reason, detail: err.message }
  }
}
