import { ShimChannelLostError, ShimRequestAbortedError, ShimRequestTimeoutError } from '../shim/channels.js'
import {
  BUNDLE_REF_LIST_ARGS,
  BundleFallback,
  CONNECTIVITY_CHECK_ARGS,
  attemptWithBundle,
  bundleDownloadWarningOf,
  bundleRefEntriesOf,
  bundleRefNamesOf,
  scrubBundleDetail,
  type BundleFallbackReason
} from '../source-cache/bundle-retry.js'
import type { SourceCacheShape } from '../source-cache/keys.js'
import { GitExecError } from './command-git-runner.js'
import { GitTransportError, type GitCloneOutput, type GitRunner } from './git-runner.js'
import { WorkspaceViolationError } from './workspace-files.js'

// A workspace clone seeded from a Source Cache bundle, with the §7 retry contract (source-cache.md §6.1, §7).

export {
  BUNDLE_DOWNLOAD_WARNINGS,
  bundleRefEntriesOf,
  type BundleFallbackReason
} from '../source-cache/bundle-retry.js'

export type BundledCloneReport =
  { kind: 'hit'; tip?: string } | { kind: 'fallback'; reason: BundleFallbackReason; detail: string }

export type BundledCloneResult = 'uncached' | 'hit' | 'fallback'

export interface BundledCloneInput {
  /** The presigned GET and its object key; absent runs exactly today's clone. */
  bundle?: { url: string; key: string }
  shape: SourceCacheShape
  /** The caller's clone with `extra` prepended to its options; `[]` must be today's argv; a bundled attempt must return stderr. */
  clone(extra: string[]): Promise<GitCloneOutput | undefined>
  /** A runner rooted at the new checkout under the local, no-lazy-fetch env. */
  checkout(): GitRunner
  /** Empty the checkout, object database included; throws when it could not. */
  empty(): Promise<void>
  /** Outcome hook for logs and metrics: a hit after success, a fallback before its retry. */
  report?(report: BundledCloneReport): void
  log?: { warn(message: string): void }
}

/** The refs under `refs/bundles/` in `show-ref` output. */
export function bundleRefsOf(showRef: string): string[] {
  return bundleRefEntriesOf(showRef).map((entry) => entry.ref)
}

/** Name the bundle refs before `show-ref` reads them: a bare `show-ref` of a tag-heavy repository overflows a shim frame. */
async function listBundleRefEntries(git: GitRunner): Promise<Array<{ ref: string; oid: string }>> {
  const names = bundleRefNamesOf(await git.raw([...BUNDLE_REF_LIST_ARGS]))
  if (names.length === 0) return []
  try {
    return bundleRefEntriesOf(await git.raw(['show-ref', '--', ...names]))
  } catch (err) {
    if (err instanceof GitExecError && err.code === 1) return []
    throw err
  }
}

async function listBundleRefs(git: GitRunner): Promise<string[]> {
  return (await listBundleRefEntries(git)).map((entry) => entry.ref)
}

/** Delete every listed `refs/bundles/*` ref, never a fixed name (Git 2.50 moved them under `heads/`). */
export async function removeBundleRefs(git: GitRunner, refs?: string[]): Promise<number> {
  const listed = refs ?? (await listBundleRefs(git))
  for (const ref of listed) await git.raw(['update-ref', '-d', ref])
  return listed.length
}

/** An error that says the pod-side Git may still be running, or the daemon is stopping, so no empty-and-retry. */
export function isUnretryableCloneError(err: unknown): boolean {
  return (
    err instanceof GitTransportError ||
    err instanceof ShimChannelLostError ||
    err instanceof ShimRequestTimeoutError ||
    err instanceof ShimRequestAbortedError ||
    err instanceof WorkspaceViolationError ||
    (err instanceof Error && err.name === 'AbortError')
  )
}

/** Clone with `--bundle-uri` when given, verify, drop `refs/bundles/*`, and on any in-band failure empty and clone once without it. */
export async function cloneFromBundle(input: BundledCloneInput): Promise<BundledCloneResult> {
  const { bundle } = input
  if (bundle === undefined) {
    await input.clone([])
    return 'uncached'
  }
  const attempt = await attemptWithBundle(isUnretryableCloneError, async (step) => {
    const output = await step('clone-failed', () => input.clone([`--bundle-uri=${bundle.url}`]))
    // Without stderr a failed download is indistinguishable from a hit, so an unseen attempt is never trusted.
    if (output === undefined) throw new BundleFallback('stderr-unavailable', 'the clone runner reported no stderr')
    const warning = bundleDownloadWarningOf(output.stderr)
    if (warning !== undefined) throw new BundleFallback('download-warning', warning)
    const git = input.checkout()
    const entries = await step('inspect-failed', () => listBundleRefEntries(git))
    const refs = entries.map((entry) => entry.ref)
    if (refs.length === 0) throw new BundleFallback('no-bundle-refs', 'no ref under refs/bundles/ after the clone')
    // The bundle's tip, captured before its refs go, is what a write-back measures the origin delta from.
    const tips = new Set(entries.map((entry) => entry.oid))
    // Both shapes: an incomplete bundle can leave a full clone exit 0 with broken history; dangling objects are not a failure.
    await step('connectivity', () => git.raw([...CONNECTIVITY_CHECK_ARGS]))
    await step('cleanup-failed', () => removeBundleRefs(git, refs))
    return tips
  })
  if (attempt.kind === 'hit') {
    const tips = attempt.value
    input.report?.(tips.size === 1 ? { kind: 'hit', tip: [...tips][0]! } : { kind: 'hit' })
    return 'hit'
  }
  input.report?.({ kind: 'fallback', reason: attempt.reason, detail: scrubBundleDetail(attempt.detail, bundle.url) })
  await input.empty()
  await input.clone([])
  // The origin may advertise its own bundle URIs; nothing they name stays reachable either.
  await removeBundleRefs(input.checkout()).catch((err: unknown) => {
    if (isUnretryableCloneError(err)) throw err
    input.log?.warn(`workspace: could not remove refs/bundles after a cache fallback (${(err as Error).message})`)
  })
  return 'fallback'
}
