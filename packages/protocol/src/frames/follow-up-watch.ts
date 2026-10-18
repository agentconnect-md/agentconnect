import { z } from 'zod'

/** Event wake for follow-ups (assistant-mode.md §5.14): a relay advertising it is sent the watched objects, and a CP advertising it accepts their events and answers `assistant/follow-up-watch`. */
export const FOLLOW_UP_WATCH_FEATURE = 'follow-up-watch-v1'

/** A daemon advertising it answers `assistant/follow-up-wake`; the CP accepts no subscription from one without it and sends it no wake. */
export const FOLLOW_UP_WAKE_FEATURE = 'follow-up-wake-v1'

/** An agent holds at most this many watches, a fixed limit as reminders have. */
export const FOLLOW_UP_WATCH_MAX = 100

/** A daemon sends `assistant/follow-up-watch` single-shot with this ack budget: a new watch reads its object on the code host first. */
export const FOLLOW_UP_WATCH_BUDGET_MS = 30_000

/** What happened on a watched object; the first six are changes of state, the rest discussion. */
export const FollowUpEventKind = z.enum([
  'merged',
  'closed',
  'reopened',
  'approved',
  'changes_requested',
  'checks',
  'comment',
  'review',
  'commits'
])
export type FollowUpEventKind = z.infer<typeof FollowUpEventKind>

const STATE_EVENTS: ReadonlySet<FollowUpEventKind> = new Set([
  'merged',
  'closed',
  'reopened',
  'approved',
  'changes_requested',
  'checks'
])

/** A change of state wakes after one quiet minute; discussion waits five minutes (§5.14 Events). */
export function isFollowUpStateEvent(kind: FollowUpEventKind): boolean {
  return STATE_EVENTS.has(kind)
}

export const FollowUpWatchSubject = z.enum(['pull', 'issue'])
export type FollowUpWatchSubject = z.infer<typeof FollowUpWatchSubject>

/** The one pull request, merge request or issue a follow-up watches, as its URL names it; the CP resolves the numeric identity. */
export const FollowUpWatchTarget = z.object({
  provider: z.enum(['github', 'gitlab']),
  host: z.string().min(1).max(253),
  repoPath: z.string().min(3).max(300),
  subject: FollowUpWatchSubject,
  number: z.number().int().positive()
})
export type FollowUpWatchTarget = z.infer<typeof FollowUpWatchTarget>

const GITHUB_HOSTS = new Set(['github.com', 'www.github.com'])
const GITHUB_PATH = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/(pull|issues)\/([1-9]\d{0,9})(?:\/.*)?$/
const GITLAB_PATH = /^\/((?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+)\/-\/(merge_requests|issues)\/([1-9]\d{0,9})(?:\/.*)?$/

/** Parse a watch URL: GitHub's `/<owner>/<repo>/pull|issues/<n>`, GitLab's `/<path>/-/merge_requests|issues/<iid>`; anything else is refused with a reason. */
export function parseFollowUpWatchUrl(raw: string): { target: FollowUpWatchTarget } | { error: string } {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return { error: 'not a URL' }
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { error: 'not an http(s) URL' }
  const host = url.hostname.toLowerCase()
  const path = decodeURIComponent(url.pathname).replace(/\/+$/, '')
  if (GITHUB_HOSTS.has(host)) {
    const match = GITHUB_PATH.exec(path)
    if (!match) return { error: 'not a GitHub pull request or issue URL' }
    return {
      target: {
        provider: 'github',
        host: 'github.com',
        repoPath: `${match[1]}/${match[2]}`,
        subject: match[3] === 'pull' ? 'pull' : 'issue',
        number: Number(match[4])
      }
    }
  }
  const match = GITLAB_PATH.exec(path)
  if (!match) return { error: 'not a pull request, merge request or issue URL' }
  return {
    target: {
      provider: 'gitlab',
      host: url.port ? `${host}:${url.port}` : host,
      repoPath: match[1]!,
      subject: match[2] === 'merge_requests' ? 'pull' : 'issue',
      number: Number(match[3])
    }
  }
}

/** Why a watch was not taken: not readable with the agent's access, no such object, no events from that host here, the agent's limit, or a transient failure. */
export const FollowUpWatchRefusal = z.enum(['no_access', 'not_found', 'unsupported', 'limit', 'unavailable'])
export type FollowUpWatchRefusal = z.infer<typeof FollowUpWatchRefusal>

/** A taken watch, as the CP resolved it: the canonical path for display, never a numeric id. */
export const FollowUpWatched = FollowUpWatchTarget.pick({
  provider: true,
  repoPath: true,
  subject: true,
  number: true
}).extend({
  // The repository's numeric id, which a check's code-host reads aim at (§5.14).
  repoId: z
    .string()
    .regex(/^[1-9]\d*$/)
    .optional()
})
export type FollowUpWatched = z.infer<typeof FollowUpWatched>

/** How a watched object is named to people: `owner/repo#12`, or a GitLab merge request's `group/project!3`. */
export function followUpWatchLabel(watched: FollowUpWatched): string {
  const mark = watched.provider === 'gitlab' && watched.subject === 'pull' ? '!' : '#'
  return `${watched.repoPath}${mark}${watched.number}`
}

/** A follow-up's watch as the Activity row and the console show it (§5.14). */
export const FollowUpWatchState = z.enum(['pending', 'watching', 'refused', 'ended'])
export type FollowUpWatchState = z.infer<typeof FollowUpWatchState>

const FollowUpId = z.string().min(1).max(200)

/** D→C REQ: `set` subscribes or moves each listed follow-up, `remove` ends each, `full` is the agent's whole set and drops the rest. */
export const AssistantFollowUpWatchReq = z
  .object({
    agentId: z.string().uuid(),
    mode: z.enum(['set', 'remove', 'full']),
    watches: z
      .array(z.object({ followUpId: FollowUpId, target: FollowUpWatchTarget.optional() }))
      .max(FOLLOW_UP_WATCH_MAX)
  })
  .refine((req) => req.mode === 'remove' || req.watches.every((watch) => watch.target !== undefined), {
    message: 'set and full name a target for every watch'
  })
export type AssistantFollowUpWatchReq = z.infer<typeof AssistantFollowUpWatchReq>

/** C→D REP: one entry per listed follow-up, what is watched or why not; `remove` answers each with neither. */
export const AssistantFollowUpWatchResult = z.object({
  results: z
    .array(
      z.object({
        followUpId: FollowUpId,
        watched: FollowUpWatched.optional(),
        refused: FollowUpWatchRefusal.optional()
      })
    )
    .max(FOLLOW_UP_WATCH_MAX)
})
export type AssistantFollowUpWatchResult = z.infer<typeof AssistantFollowUpWatchResult>

/** C→D REQ, body-free: the events that make a follow-up's check due, or a notice that its watch ended; `wakeId` grows per subscription so a retry starts no second check. */
export const AssistantFollowUpWake = z
  .object({
    agentId: z.string().uuid(),
    followUpId: FollowUpId,
    // The subscription's identity: its wakeIds count from a new start whenever it changes.
    subscription: z.number().int().positive().optional(),
    wakeId: z.number().int().positive(),
    kinds: z.array(FollowUpEventKind).max(FollowUpEventKind.options.length),
    latestAt: z.string().datetime().optional(),
    ended: z.enum(['access_lost']).optional()
  })
  .refine((wake) => wake.ended !== undefined || (wake.kinds.length > 0 && wake.latestAt !== undefined), {
    message: 'a wake names its events and when the latest arrived'
  })
export type AssistantFollowUpWake = z.infer<typeof AssistantFollowUpWake>

/** D→C REP: `not_found` ends the subscription; any other refusal holds the wake for a retry. */
export const AssistantFollowUpWakeResult = z.object({
  accepted: z.boolean(),
  reason: z.enum(['not_found', 'not_holder', 'not_ready']).optional()
})
export type AssistantFollowUpWakeResult = z.infer<typeof AssistantFollowUpWakeResult>

/** C→R EVT: one watched GitHub object, by numeric identity; it never says which agent or follow-up watches it. */
export const RcFollowUpWatch = z.object({
  provider: z.enum(['github']),
  installationId: z.string().regex(/^[1-9]\d*$/),
  repoId: z.string().regex(/^[1-9]\d*$/),
  subject: FollowUpWatchSubject,
  number: z.number().int().positive(),
  watched: z.boolean()
})
export type RcFollowUpWatch = z.infer<typeof RcFollowUpWatch>

/** The relay's key for one watched object. */
export function followUpWatchKey(watch: Pick<RcFollowUpWatch, 'provider' | 'repoId' | 'subject' | 'number'>): string {
  return `${watch.provider}:${watch.repoId}:${watch.subject}:${watch.number}`
}
