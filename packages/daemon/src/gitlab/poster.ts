// GitLab final-answer poster (gitlab-com-integration.md 14.1): one note per completed turn as the project service account.
// Single-writer contract — never commentary or a second write after ambiguity; retry once only after a definite auth rejection.
import type { PublishedHookOutput } from '@agentconnect.md/protocol'
import {
  appendGithubMarkdownChrome,
  githubAttributionFooter,
  truncatedMarkdownPrefix,
  type GithubCommentAttributionSource,
  type PosterScheduler
} from '../github/poster.js'

/** GitLab notes accept ~1 MB; keep the GitHub cap — nobody reads more. */
const MAX_NOTE_CHARS = 65536
const TRUNCATION_MARKER = '\n\n…(truncated)'
const DEFAULT_FINALIZE_TIMEOUT_MS = 60_000

/** Bounded normalized reasons the promised note is absent (14.1) — the hook completion reports exactly one. */
export type GitlabPublishFailure = 'publish_timeout' | 'auth_rejected' | 'token_unavailable' | 'post_failed'

export interface GitlabFinalPosterDeps {
  /** Action-time effect lease: the binding's effect PAT via purpose gitlab_hook_reply. */
  token: () => Promise<string>
  /** Drop a cached token GitLab just rejected (401/403) so the retry re-mints. */
  invalidateToken?: (token: string) => void
  log: { warn: (message: string) => void }
  baseUrl?: string
  fetchImpl?: typeof fetch
  scheduler?: PosterScheduler
  finalizeTimeoutMs?: number
}

export class GitlabFinalPoster {
  private abandoned = false
  private failureCode?: GitlabPublishFailure
  private publishPromise?: Promise<PublishedHookOutput | undefined>
  private readonly abort = new AbortController()
  private readonly sched: PosterScheduler
  private readonly finalizeTimeoutMs: number

  constructor(
    private readonly deps: GitlabFinalPosterDeps,
    /** Numeric project id (decimal string) — the rename-stable API target. */
    private readonly projectId: string,
    private readonly subjectKind: 'issue' | 'merge_request',
    private readonly iid: number,
    private readonly attribution?: GithubCommentAttributionSource
  ) {
    this.sched = deps.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
    this.finalizeTimeoutMs = deps.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS
  }

  /** Why this turn's note is missing; undefined when it published or the final was legitimately empty. */
  get failure(): GitlabPublishFailure | undefined {
    return this.failureCode
  }

  /** Publish the completed turn's final body exactly once; never rejects. */
  publish(finalBody?: string): Promise<PublishedHookOutput | undefined> {
    if (!this.publishPromise) this.publishPromise = this.publishOnce(finalBody)
    return this.publishPromise
  }

  private target(): string {
    return `gitlab:${this.projectId} ${this.subjectKind === 'issue' ? '#' : '!'}${this.iid}`
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
          this.safeWarn(`gitlab poster: publish deadline failed on ${this.target()} (${String(err)})`)
          resolve(undefined)
        }
      })
      return await Promise.race([this.post(finalBody, deadlineAt), deadline])
    } catch (err) {
      this.fail('post_failed')
      if (!this.abandoned) this.safeWarn(`gitlab poster: create failed on ${this.target()} (${String(err)})`)
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
    const family = this.subjectKind === 'issue' ? 'issues' : 'merge_requests'
    const notePath = `/projects/${this.projectId}/${family}/${this.iid}/notes`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let token: string
      try {
        token = await this.deps.token()
      } catch (err) {
        // A refused effect lease is its own outcome: nothing was ever sent to GitLab.
        this.fail('token_unavailable')
        throw err
      }
      if (this.abandoned) return
      if (this.sched.now() >= deadlineAt) {
        this.abandonTimedOut()
        return
      }
      const res = await doFetch(`${this.deps.baseUrl ?? 'https://gitlab.com/api/v4'}${notePath}`, {
        method: 'POST',
        headers: {
          'private-token': token,
          'content-type': 'application/json'
        },
        signal: this.abort.signal,
        body: JSON.stringify({ body })
      })
      if (res.ok) {
        // Note ids are control metadata only; preserve ids beyond the safe-integer range.
        let noteId: string | undefined
        try {
          const raw = await res.text()
          const parsed = JSON.parse(raw.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"')) as { id?: unknown }
          const rawId = parsed?.id
          if (typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId)) noteId = rawId
          if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) noteId = String(rawId)
        } catch {
          // The note exists — a missing id only loses the deep link, it must not retry the public write.
        }
        if (!noteId) {
          this.safeWarn(`gitlab poster: created note has no usable id on ${this.target()}`)
          return undefined
        }
        return { provider: 'gitlab', kind: 'note', externalId: noteId }
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
        throw new Error(`GitLab POST ${res.status}`)
      }
      try {
        this.deps.invalidateToken!(token)
      } catch {
        this.fail('auth_rejected')
        throw new Error(`GitLab POST ${res.status}`)
      }
    }
  }

  private render(text: string, footer: string): string {
    if (text.length + footer.length <= MAX_NOTE_CHARS) {
      const rendered = appendGithubMarkdownChrome(text, footer)
      if (rendered.length <= MAX_NOTE_CHARS) return rendered
    }
    const suffix = TRUNCATION_MARKER + footer
    const bodyBudget = Math.max(0, MAX_NOTE_CHARS - suffix.length)
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
  private fail(code: GitlabPublishFailure): void {
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
    this.safeWarn(`gitlab poster: final publish timed out on ${this.target()}`)
  }
}
