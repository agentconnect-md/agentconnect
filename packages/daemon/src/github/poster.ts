/**
 * GithubFinalPoster — the P3 outbound reply pipe
 * (webhook-triggers-and-github-events.md §Sessionization Design · Outbound).
 *
 * One turn = at most ONE comment on the triggering issue/PR thread. The daemon
 * collects final-answer chunks in memory while the prompt and its tools run;
 * only `publish()` sends the complete authoritative body after the turn ends.
 * Commentary / compaction chrome stays in the local transcript. A turn with no
 * completed final output posts NOTHING.
 *
 * This is deliberately NOT a platform adapter: no inbound, no long-lived
 * connection — a thin outbound REST client owned by the turn's `Pending`.
 * Loop safety is upstream: the App's own comments arrive as `sender.type ===
 * 'Bot'` and are vetoed at the relay match (decision 10), so the poster can
 * never re-trigger the hook that spawned it.
 *
 * Tokens come from the gitcred channel (purpose=github_hook_reply,
 * repo-targeted, issues/PR write only, NO contents) and stay in daemon memory;
 * they are never injected into the agent's environment. Failures degrade to warnings:
 * a lost comment never fails the turn (the transcript remains authoritative).
 */

import type { GithubPublishedComment } from '@agentconnect.md/protocol'
import { renderAttributionMessage } from '../messages/attribution.js'
import { isNoResponseBody } from '../session/no-response.js'

/** Minimal timer seam so tests drive the bounded publish deadline deterministically. */
export interface PosterScheduler {
  now(): number
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export interface GithubFinalPosterDeps {
  /** Repo-scoped comment token (cached/coalesced upstream in GitCredentialCache). */
  token: () => Promise<string>
  /** Evict a rejected cached token so one 401/403 can retry with a fresh grant. */
  invalidateToken?: (token: string) => void
  log: { warn: (msg: string) => void }
  fetchImpl?: typeof fetch
  scheduler?: PosterScheduler
  /** Whole publish barrier. On expiry the active request is aborted and the turn degrades cleanly. */
  finalizeTimeoutMs?: number
  baseUrl?: string
}

export interface GithubCommentAttribution {
  agentName: string
  agentUrl: string
  runtime: string
  model: string
  sessionUrl: string
  /** Public agent avatar PNG (the CP's unauthenticated icon endpoint / uploaded-image
   * URL — the same URL Slack uses for icon_url). Absent ⇒ text-only footer. */
  iconUrl?: string
}

export type GithubCommentAttributionSource =
  | GithubCommentAttribution
  | (() => GithubCommentAttribution | undefined | Promise<GithubCommentAttribution | undefined>)

const DEFAULT_FINALIZE_TIMEOUT_MS = 15_000
/** GitHub caps comment bodies at 65536 chars — truncate with a marker well below. */
const MAX_COMMENT_CHARS = 60_000
const TRUNCATION_MARKER = '\n\n_(truncated — see the session transcript for the full reply)_'
const LEGACY_BOUNDARIES = new Set(['agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])
const NO_FINAL_MESSAGE_ID = Symbol('no-final-message-id')
const NO_COMMENTARY_MESSAGE_ID = Symbol('no-commentary-message-id')

type MessageKey = string | typeof NO_FINAL_MESSAGE_ID | typeof NO_COMMENTARY_MESSAGE_ID
type ReplyPhase = 'unknown' | 'commentary' | 'final_answer'

interface ReplyCandidate {
  firstSeen: number
  lastSeen: number
  phase: ReplyPhase
  text: string
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
}

function publicReplyText(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  return trimmed && !isNoResponseBody(trimmed) ? text : undefined
}

/**
 * Select the one human-facing reply from an ACP turn.
 *
 * codex-acp ≥1.1.1 gives us the authoritative `_meta.codex.phase`; older Codex
 * builds still provide messageId, so the last logical message is the fallback.
 * Other ACP runtimes may provide neither — for them the last text run after a
 * thought/tool/plan boundary is the best runtime-agnostic approximation.
 */
export class GithubReplyCollector {
  private readonly messages = new Map<MessageKey, ReplyCandidate>()
  private nextOrder = 0
  private lastCommentarySeen = -1
  private readonly legacyRuns: ReplyCandidate[] = []
  private legacyCurrent?: ReplyCandidate

  /** Consume one raw ACP update; the completed answer is selected by finalText(). */
  onUpdate(update: unknown): void {
    const u = record(update)
    if (!u) return
    const kind = typeof u.sessionUpdate === 'string' ? u.sessionUpdate : undefined
    if (kind !== 'agent_message_chunk') {
      if (kind && LEGACY_BOUNDARIES.has(kind)) this.commitLegacyBoundary()
      return
    }

    const content = record(u.content)
    if (content?.type !== 'text' || typeof content.text !== 'string') return
    const text = content.text
    const seen = this.nextOrder++
    const codex = record(record(u._meta)?.codex)
    const rawPhase = typeof codex?.phase === 'string' ? codex.phase : undefined
    const phase: ReplyPhase = rawPhase === 'commentary' || rawPhase === 'final_answer' ? rawPhase : 'unknown'
    const messageId = typeof u.messageId === 'string' && u.messageId ? u.messageId : undefined

    if (phase === 'commentary' || phase === 'final_answer') {
      if (phase === 'commentary') this.lastCommentarySeen = seen
    }
    if (messageId || phase !== 'unknown') {
      const key: MessageKey = messageId ?? (phase === 'final_answer' ? NO_FINAL_MESSAGE_ID : NO_COMMENTARY_MESSAGE_ID)
      let candidate = this.messages.get(key)
      if (!candidate) {
        const provisional = this.takeProvisionalText()
        candidate = {
          firstSeen: provisional?.firstSeen ?? seen,
          lastSeen: seen,
          phase: 'unknown',
          text: provisional?.text ?? ''
        }
      }
      // A final classification is authoritative even if an adapter only attaches
      // metadata to a later delta. Commentary beats unknown but can never demote final.
      if (phase === 'final_answer' || (phase === 'commentary' && candidate.phase === 'unknown')) {
        candidate.phase = phase
      }
      candidate.text += text
      candidate.lastSeen = seen
      this.messages.set(key, candidate)
    } else if (text && isKnownNonReplyText(text)) {
      this.commitLegacyBoundary()
      this.legacyRuns.push({
        firstSeen: seen,
        lastSeen: seen,
        phase: 'unknown',
        text
      })
    } else if (text) {
      this.legacyCurrent ??= {
        firstSeen: seen,
        lastSeen: seen,
        phase: 'unknown',
        text: ''
      }
      this.legacyCurrent.text += text
      this.legacyCurrent.lastSeen = seen
    }
  }

  finalText(completed = true): string | undefined {
    const explicit = this.explicitFinalText()
    if (explicit || !completed) return publicReplyText(explicit)

    // Some codex-acp versions learn an item's phase only after its final delta,
    // so a real final can remain `unknown`. `exitedReviewMode` is also deliberately
    // user-visible but anonymous. Select the newest unknown after explicit
    // commentary on the same unified timeline, while filtering the adapter's known
    // anonymous status chrome. Phase-less adapters follow the same rule.
    const unknown = [...this.messages.values(), ...this.legacyRuns, ...(this.legacyCurrent ? [this.legacyCurrent] : [])]
      .filter(
        (candidate) =>
          candidate.phase === 'unknown' &&
          candidate.text.trim() &&
          !isKnownNonReplyText(candidate.text) &&
          candidate.lastSeen > this.lastCommentarySeen
      )
      .sort((a, b) => a.lastSeen - b.lastSeen)
      .at(-1)?.text
    return publicReplyText(unknown)
  }

  private explicitFinalText(): string | undefined {
    const text = [...this.messages.values()]
      .filter((candidate) => candidate.phase === 'final_answer' && candidate.text.trim())
      .sort((a, b) => a.firstSeen - b.firstSeen)
      .map((candidate) => candidate.text)
      .join('\n\n')
    return text.trim() ? text : undefined
  }

  private commitLegacyBoundary(): void {
    if (!this.legacyCurrent?.text.trim()) return
    this.legacyRuns.push(this.legacyCurrent)
    this.legacyCurrent = undefined
  }

  /** A phase/messageId can arrive one delta late; claim the immediately preceding
   *  anonymous run so the public reply does not lose its prefix. Known adapter
   *  chrome is deliberately left anonymous and therefore never folded into final. */
  private takeProvisionalText(): ReplyCandidate | undefined {
    const candidate = this.legacyCurrent
    if (!candidate || !candidate.text.trim() || isKnownNonReplyText(candidate.text)) return undefined
    this.legacyCurrent = undefined
    return candidate
  }
}

/** Adapter-generated status text that is neither commentary nor a user-facing
 *  final. These older paths lack messageId/phase, so content is the only signal. */
function isKnownNonReplyText(text: string): boolean {
  const normalized = text.trim()
  return (
    /^\*?context compacted\b/i.test(normalized) ||
    /^(?:config )?warning:/i.test(normalized) ||
    /^\*conversation interrupted\*$/i.test(normalized)
  )
}

function escapeMarkdownText(raw: string): string {
  const flat = raw.replace(/\s+/g, ' ').trim().slice(0, 200) || 'unknown agent'
  return flat.replace(/([\\`*_\[\]~<>])/g, '\\$1')
}

function safeHttpUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    const normalized = url.toString()
    if (normalized.length > 2_048) return undefined
    return normalized
  } catch {
    return undefined
  }
}

function markdownUrl(raw: string): string | undefined {
  const normalized = safeHttpUrl(raw)
  if (normalized === undefined) return undefined
  return `<${normalized.replace(/</g, '%3C').replace(/>/g, '%3E')}>`
}

/** Small inline avatar ahead of the agent name. GitHub's comment sanitizer
 * keeps `img` (src/width/height/alt) and proxies src through camo, so the same
 * public URL Slack fetches for icon_url renders here too. The nested `sub`
 * aligns the icon with the surrounding footer text. Decorative: the agent name
 * follows as text, so a blocked/broken image loses nothing. */
function attributionIconImage(raw: string | undefined): string {
  const src = raw ? safeHttpUrl(raw) : undefined
  if (src === undefined) return ''
  return `<sub><img src="${src.replace(/"/g, '%22')}" width="11" height="11" alt=""></sub> `
}

/** Shared public attribution chrome for both ordinary comments and formal
 * reviews. The caller decides where any resource-specific hidden marker goes. */
export function githubAttributionFooter(attribution?: GithubCommentAttribution): string {
  if (!attribution) return ''
  const name = escapeMarkdownText(attribution.agentName)
  const runtime = escapeMarkdownText(attribution.runtime)
  const model = escapeMarkdownText(attribution.model)
  const agentUrl = markdownUrl(attribution.agentUrl)
  const sessionUrl = markdownUrl(attribution.sessionUrl)
  const agent = `${attributionIconImage(attribution.iconUrl)}${agentUrl ? `[${name}](${agentUrl})` : name}`
  const message = renderAttributionMessage({
    agent,
    runtime,
    model,
    renderSession: sessionUrl ? (label) => `[${escapeMarkdownText(label)}](${sessionUrl})` : undefined
  })
  return `\n\n<sub>${message}\n</sub>`
}

interface MarkdownFence {
  marker: '`' | '~'
  length: number
}

/** Return the fenced-code block left open at the end of `text`, if any. */
function unclosedMarkdownFence(text: string): MarkdownFence | undefined {
  let open: MarkdownFence | undefined
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) continue
    const run = match[1]!
    const marker = run[0] as '`' | '~'
    const rest = match[2]!
    if (!open) {
      // CommonMark forbids a backtick in a backtick fence's info string.
      if (marker === '`' && rest.includes('`')) continue
      open = { marker, length: run.length }
    } else if (marker === open.marker && run.length >= open.length && !rest.trim()) {
      open = undefined
    }
  }
  return open
}

function fenceCloser(text: string): string {
  const open = unclosedMarkdownFence(text)
  if (!open) return ''
  return `${text.endsWith('\n') ? '' : '\n'}${open.marker.repeat(open.length)}`
}

/** Append daemon-authored Markdown chrome outside any model-authored code
 * fence. Shared by ordinary comments and formal reviews so attribution and
 * hidden correlation markers remain structural, not fenced code text. */
export function appendGithubMarkdownChrome(text: string, chrome: string): string {
  if (!chrome) return text
  return `${text}${fenceCloser(text)}${chrome}`
}

/** UTF-16-safe prefix: never leave a high surrogate separated from its pair. */
function safePrefix(text: string, maxChars: number): string {
  let end = Math.min(text.length, Math.max(0, maxChars))
  if (
    end > 0 &&
    end < text.length &&
    text.charCodeAt(end - 1) >= 0xd800 &&
    text.charCodeAt(end - 1) <= 0xdbff &&
    text.charCodeAt(end) >= 0xdc00 &&
    text.charCodeAt(end) <= 0xdfff
  ) {
    end -= 1
  }
  return text.slice(0, end)
}

/** Fit a reply prefix into `budget`, closing a fence before marker/footer chrome. */
export function truncatedMarkdownPrefix(text: string, budget: number): string {
  let contentBudget = Math.max(0, budget)
  for (;;) {
    const prefix = safePrefix(text, contentBudget)
    const closer = fenceCloser(prefix)
    if (prefix.length + closer.length <= budget) return prefix + closer
    const nextBudget = Math.max(0, budget - closer.length)
    if (nextBudget >= contentBudget) return safePrefix(text, budget)
    contentBudget = nextBudget
  }
}

export class GithubFinalPoster {
  private abandoned = false
  private publishPromise?: Promise<GithubPublishedComment | undefined>
  private readonly abort = new AbortController()
  private readonly sched: PosterScheduler
  private readonly finalizeTimeoutMs: number
  private readonly attribution?: GithubCommentAttributionSource

  constructor(
    private readonly deps: GithubFinalPosterDeps,
    /** 'owner/repo' — display-validated upstream; the token is scoped to it. */
    private readonly repo: string,
    /** The issue/PR number of the triggering thread. */
    private readonly issueNumber: number,
    attribution?: GithubCommentAttributionSource,
    /** Trusted root id of an existing PR review thread; decimal string from the signed webhook. */
    private readonly reviewThreadRootCommentId?: string
  ) {
    this.sched = deps.scheduler ?? {
      now: () => Date.now(),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as NodeJS.Timeout)
    }
    this.finalizeTimeoutMs = deps.finalizeTimeoutMs ?? DEFAULT_FINALIZE_TIMEOUT_MS
    this.attribution = attribution
  }

  /**
   * Publish the completed turn's final body exactly once. Resolves once the POST
   * settles (or the bounded wait expires); never rejects. Idempotent: the first
   * call wins, including an empty final.
   */
  publish(finalBody?: string): Promise<GithubPublishedComment | undefined> {
    if (!this.publishPromise) this.publishPromise = this.publishOnce(finalBody)
    return this.publishPromise
  }

  private async publishOnce(finalBody?: string): Promise<GithubPublishedComment | undefined> {
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
          this.safeWarn(`github poster: publish deadline failed on ${this.repo}#${this.issueNumber} (${String(err)})`)
          resolve(undefined)
        }
      })
      return await Promise.race([this.post(finalBody, deadlineAt), deadline])
    } catch (err) {
      if (!this.abandoned)
        this.safeWarn(`github poster: create failed on ${this.repo}#${this.issueNumber} (${String(err)})`)
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

  private async post(text: string, deadlineAt: number): Promise<GithubPublishedComment | undefined> {
    // Resolve dynamic attribution exactly once, immediately before the public write.
    // A session runtime may only expose its final model after the prompt completes.
    const attribution = typeof this.attribution === 'function' ? await this.attribution() : this.attribution
    const body = this.render(text, githubAttributionFooter(attribution))
    const doFetch = this.deps.fetchImpl ?? fetch
    const commentPath = this.reviewThreadRootCommentId
      ? `/repos/${this.repo}/pulls/${this.issueNumber}/comments/${this.reviewThreadRootCommentId}/replies`
      : `/repos/${this.repo}/issues/${this.issueNumber}/comments`
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const token = await this.deps.token()
      // Token minting cannot be aborted. If it resolves after the deadline, do
      // not depend on the overdue timer getting CPU first: enforce the absolute
      // cutoff before either the first request or an auth-refresh retry.
      if (this.abandoned) return
      if (this.sched.now() >= deadlineAt) {
        this.abandonTimedOut()
        return
      }
      const res = await doFetch(`${this.deps.baseUrl ?? 'https://api.github.com'}${commentPath}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'content-type': 'application/json',
          'x-github-api-version': '2022-11-28'
        },
        signal: this.abort.signal,
        body: JSON.stringify({ body })
      })
      if (res.ok) {
        // Comment ids are control metadata: retaining one lets the CP point the
        // informational Check at this exact public result without reading the
        // comment body. Preserve ids beyond JS's safe integer range.
        let commentId: string | undefined
        try {
          const body = await res.text()
          const parsed = record(JSON.parse(body.replace(/"id"\s*:\s*(\d{15,})/g, '"id":"$1"')))
          const rawId = parsed?.id
          if (typeof rawId === 'string' && /^[1-9]\d*$/.test(rawId)) commentId = rawId
          if (typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0) commentId = String(rawId)
        } catch {
          // The comment already exists. A missing id only loses the deep link;
          // it must not reclassify or retry the public write.
        }
        if (!commentId) {
          this.safeWarn(`github poster: created comment has no usable id on ${this.repo}#${this.issueNumber}`)
          return undefined
        }
        return {
          kind: this.reviewThreadRootCommentId ? 'review_comment' : 'issue_comment',
          commentId
        }
      }

      // Undici requires a failed response body to be cancelled so the
      // connection can be released. Cancellation cannot change the known
      // non-effect response.
      try {
        await res.body?.cancel()
      } catch {
        // Best-effort resource cleanup only.
      }

      const refreshable = attempt === 0 && (res.status === 401 || res.status === 403) && this.deps.invalidateToken
      if (!refreshable) throw new Error(`GitHub POST ${res.status}`)
      try {
        this.deps.invalidateToken!(token)
      } catch {
        // A broken cache invalidator must preserve the poster's no-throw
        // boundary, but retrying the same rejected token would be pointless.
        throw new Error(`GitHub POST ${res.status}`)
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

  private abandon(): boolean {
    if (this.abandoned) return false
    this.abandoned = true
    this.abort.abort()
    return true
  }

  private abandonTimedOut(): void {
    if (!this.abandon()) return
    this.safeWarn(`github poster: final publish timed out on ${this.repo}#${this.issueNumber}`)
  }
}
