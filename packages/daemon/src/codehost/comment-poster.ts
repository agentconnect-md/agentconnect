// The one-comment final poster the note-shaped code hosts share (gitlab-com-integration.md §14.1,
// gitea-integration.md §10.1): one comment per completed turn as the host's acting identity, the
// single-writer contract — never commentary or a second write after ambiguity — a bounded publish
// deadline, and one retry only after a definite auth rejection. A host contributes its request shape
// and how the created comment's id is reported; everything else is this class's.
import type { PublishedHookOutput } from '@agentconnect.md/protocol'
import {
  appendGithubMarkdownChrome,
  githubAttributionFooter,
  truncatedMarkdownPrefix,
  type GithubCommentAttributionSource,
  type PosterScheduler
} from '../github/poster.js'

/** Both hosts accept far more; keep the GitHub cap — nobody reads more. */
const MAX_COMMENT_CHARS = 65536
const TRUNCATION_MARKER = '\n\n…(truncated)'
const DEFAULT_FINALIZE_TIMEOUT_MS = 60_000

/** Bounded normalized reasons the promised comment is absent (§14.1) — the hook completion reports exactly one. */
export type CommentPublishFailure = 'publish_timeout' | 'auth_rejected' | 'token_unavailable' | 'post_failed'

export interface CommentPosterDeps {
  /** Action-time effect lease for the host's hook-reply purpose. */
  token: () => Promise<string>
  /** Drop a cached token the host just rejected (401/403) so the retry re-mints. */
  invalidateToken?: (token: string) => void
  log: { warn: (message: string) => void }
  /** The instance's REST root, resolved per turn from the spec or hook metadata. */
  apiBaseUrl: () => string
  fetchImpl?: typeof fetch
  scheduler?: PosterScheduler
  finalizeTimeoutMs?: number
}

/** What one host contributes: its name and target for log lines, the create request, and the published identity. */
export interface CommentPosterWire {
  provider: string
  target: string
  request(apiBaseUrl: string, token: string, body: string): { url: string; init: RequestInit }
  published(externalId: string): PublishedHookOutput
}

export class CodeHostCommentPoster {
  private abandoned = false
  private failureCode?: CommentPublishFailure
  private publishPromise?: Promise<PublishedHookOutput | undefined>
  private readonly abort = new AbortController()
  private readonly sched: PosterScheduler
  private readonly finalizeTimeoutMs: number

  constructor(
    private readonly deps: CommentPosterDeps,
    private readonly wire: CommentPosterWire,
    private readonly attribution?: GithubCommentAttributionSource
  ) {
    this.sched = deps.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
    this.finalizeTimeoutMs = deps.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS
  }

  /** Why this turn's comment is missing; undefined when it published or the final was legitimately empty. */
  get failure(): CommentPublishFailure | undefined {
    return this.failureCode
  }

  /** Publish the completed turn's final body exactly once; never rejects. */
  publish(finalBody?: string): Promise<PublishedHookOutput | undefined> {
    if (!this.publishPromise) this.publishPromise = this.publishOnce(finalBody)
    return this.publishPromise
  }

  private async publishOnce(finalBody?: string): Promise<PublishedHookOutput | undefined> {
    if (!finalBody?.trim()) return
    let deadlineHandle: unknown
    try {
      const deadlineAt = this.sched.now() + this.finalizeTimeoutMs
      const deadline = new Promise<undefined>((resolve) => {
        try {
          deadlineHandle = this.sched.setTimeout(() => {
            this.abandonTimedOut()
            resolve(undefined)
          }, this.finalizeTimeoutMs)
        } catch (err) {
          this.abandon()
          this.safeWarn(`${this.wire.provider} poster: publish deadline failed on ${this.wire.target} (${String(err)})`)
          resolve(undefined)
        }
      })
      return await Promise.race([this.post(finalBody, deadlineAt), deadline])
    } catch (err) {
      this.fail('post_failed')
      if (!this.abandoned)
        this.safeWarn(`${this.wire.provider} poster: create failed on ${this.wire.target} (${String(err)})`)
      return undefined
    } finally {
      if (deadlineHandle !== undefined) {
        try {
          this.sched.clearTimeout(deadlineHandle)
        } catch {
          // Preserve publish()'s no-throw boundary.
        }
      }
    }
  }

  private async post(text: string, deadlineAt: number): Promise<PublishedHookOutput | undefined> {
    const attribution = typeof this.attribution === 'function' ? await this.attribution() : this.attribution
    const body = this.render(text, githubAttributionFooter(attribution))
    const doFetch = this.deps.fetchImpl ?? fetch
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string
      try {
        token = await this.deps.token()
      } catch (err) {
        // A refused effect lease is its own outcome: nothing was ever sent to the host.
        this.fail('token_unavailable')
        throw err
      }
      if (this.abandoned) return
      if (this.sched.now() >= deadlineAt) {
        this.abandonTimedOut()
        return
      }
      const { url, init } = this.wire.request(this.deps.apiBaseUrl(), token, body)
      const res = await doFetch(url, { ...init, signal: this.abort.signal })
      if (res.ok) {
        // Comment ids are control metadata only; preserve ids beyond the safe-integer range.
        let externalId: string | undefined
        try {
          const raw = await res.text()
          const parsed = JSON.parse(raw.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"')) as { id?: unknown }
          const rawId = parsed?.id
          if (typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId)) externalId = rawId
          if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) externalId = String(rawId)
        } catch {
          // The comment exists — a missing id only loses the deep link, it must not retry the public write.
        }
        if (!externalId) {
          this.safeWarn(`${this.wire.provider} poster: created comment has no usable id on ${this.wire.target}`)
          return undefined
        }
        return this.wire.published(externalId)
      }
      try {
        await res.body?.cancel()
      } catch {
        // Best-effort resource cleanup only.
      }
      const authRejected = res.status === 401 || res.status === 403
      const refreshable = attempt === 0 && authRejected && this.deps.invalidateToken
      if (!refreshable) {
        this.fail(authRejected ? 'auth_rejected' : 'post_failed')
        throw new Error(`${this.wire.provider} POST ${res.status}`)
      }
      try {
        this.deps.invalidateToken!(token)
      } catch {
        this.fail('auth_rejected')
        throw new Error(`${this.wire.provider} POST ${res.status}`)
      }
    }
  }

  private render(text: string, footer: string): string {
    if (text.length + footer.length <= MAX_COMMENT_CHARS) {
      const rendered = appendGithubMarkdownChrome(text, footer)
      if (rendered.length <= MAX_COMMENT_CHARS) return rendered
    }
    const suffix = TRUNCATION_MARKER + footer
    const bodyBudget = Math.max(0, MAX_COMMENT_CHARS - suffix.length)
    return `${truncatedMarkdownPrefix(text, bodyBudget)}${suffix}`
  }

  private safeWarn(message: string): void {
    try {
      this.deps.log.warn(message)
    } catch {
      // A broken logger must not break the poster's failure-degrading boundary.
    }
  }

  /** First cause wins: a deadline that aborted an in-flight POST must not be relabelled by its abort error. */
  private fail(code: CommentPublishFailure): void {
    this.failureCode ??= code
  }

  private abandon(): boolean {
    if (this.abandoned) return false
    this.abandoned = true
    this.fail('publish_timeout')
    this.abort.abort()
    return true
  }

  private abandonTimedOut(): void {
    if (!this.abandon()) return
    this.safeWarn(`${this.wire.provider} poster: final publish timed out on ${this.wire.target}`)
  }
}
