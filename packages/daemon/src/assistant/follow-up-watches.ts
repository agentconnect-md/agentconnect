// What a follow-up watches (assistant-mode.md §5.14): the daemon keeps the URL and the outcome on its watch task, and asks the Control Plane, which only mirrors them by the task's key, to watch.
import {
  FOLLOW_UP_WATCH_MAX,
  followUpWatchLabel,
  parseFollowUpWatchUrl,
  type AssistantFollowUpWatchReq,
  type AssistantFollowUpWatchResult,
  type FollowUpWatchTarget
} from '@agentconnect.md/protocol'
import type { AssistantWatchTasks, WatchedObject } from '../store/assistant-watch-tasks.js'

/** The Control Plane's half; `request` answers undefined while none that takes watches is reachable. */
export interface FollowUpWatchPort {
  request(
    agentId: string,
    req: Pick<AssistantFollowUpWatchReq, 'mode' | 'watches'>
  ): Promise<AssistantFollowUpWatchResult | undefined>
  /** The current link's registration, so a new link is sent the full set again; undefined without one that takes watches. */
  link(): number | undefined
}

/** What taking or changing a watch came to, as a tool says it back. */
export type WatchOutcome =
  { kind: 'watching'; target: string } | { kind: 'pending' } | { kind: 'refused'; reason: string } | { kind: 'none' }

/** Why a follow-up is not watched, in words a person is told. */
export const WATCH_REASONS: Record<string, string> = {
  no_access: 'your code-host access does not cover it',
  not_found: 'there is no such pull request, merge request or issue',
  unsupported: 'events from that host do not reach this deployment',
  limit: `this agent already watches ${FOLLOW_UP_WATCH_MAX} objects`,
  access_lost: 'your code-host access to it was lost'
}

export const watchReasonText = (reason: string | null): string =>
  (reason && WATCH_REASONS[reason]) || 'it is not watched'

/** The URL as a watch target, or the one-line reason a tool refuses it with. */
export function watchTarget(url: string): FollowUpWatchTarget {
  const parsed = parseFollowUpWatchUrl(url)
  if ('error' in parsed)
    throw new Error(
      `argument watch must be the URL of one pull request, merge request or issue (${parsed.error}); nothing was taken`
    )
  return parsed.target
}

type Entry = AssistantFollowUpWatchResult['results'][number]

/** The stored watch an answer leaves: taken, refused, or waiting for a Control Plane that can say. */
function watchFrom(url: string, entry: Entry | undefined): WatchedObject {
  if (entry?.watched)
    return {
      url,
      target: followUpWatchLabel(entry.watched),
      state: 'watching',
      reason: null,
      repoId: entry.watched.repoId ?? null
    }
  if (entry?.refused && entry.refused !== 'unavailable')
    return { url, target: null, state: 'refused', reason: entry.refused }
  return { url, target: null, state: 'pending', reason: null }
}

function outcomeOf(watch: WatchedObject): WatchOutcome {
  if (watch.state === 'watching') return { kind: 'watching', target: watch.target ?? watch.url }
  if (watch.state === 'pending') return { kind: 'pending' }
  return { kind: 'refused', reason: watchReasonText(watch.reason) }
}

export interface FollowUpWatchesHost {
  watchTasks: Pick<AssistantWatchTasks, 'setWatch' | 'watching'>
  port?: FollowUpWatchPort
  log: { warn(message: string): void }
}

/** Takes, moves and ends follow-ups' watches, and sends an agent's full set once per Control Plane link. */
export class FollowUpWatches {
  private readonly synced = new Map<string, number>()

  constructor(private readonly host: FollowUpWatchesHost) {}

  /** One set, removal or full set per agent at a time, so a full set's answer never overwrites a later change. */
  private readonly queues = new Map<string, Promise<unknown>>()

  private serial<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(agentId) ?? Promise.resolve()).then(fn, fn)
    const tail = run.catch(() => undefined)
    this.queues.set(agentId, tail)
    void tail.then(() => {
      if (this.queues.get(agentId) === tail) this.queues.delete(agentId)
    })
    return run
  }

  /** Whether the Control Plane takes watches, so `watch` is offered. */
  offered(): boolean {
    return this.host.port?.link() !== undefined
  }

  /** Watch this URL in place of anything before; a Control Plane out of reach leaves it pending for the next full set. */
  async set(agentId: string, taskKey: string, url: string): Promise<WatchOutcome> {
    const target = watchTarget(url)
    return await this.serial(agentId, async (): Promise<WatchOutcome> => {
      const answer = await this.ask(agentId, { mode: 'set', watches: [{ followUpId: taskKey, target }] })
      const watch = watchFrom(
        url,
        answer?.results.find((entry) => entry.followUpId === taskKey)
      )
      if (!(await this.host.watchTasks.setWatch(agentId, taskKey, watch))) return { kind: 'none' }
      // A pending watch is retried with the next sweep's full set, not left for the next link.
      if (watch.state === 'pending') this.synced.delete(agentId)
      return outcomeOf(watch)
    })
  }

  /** Stop watching an open follow-up. */
  async clear(agentId: string, taskKey: string): Promise<WatchOutcome> {
    return await this.serial(agentId, async (): Promise<WatchOutcome> => {
      await this.host.watchTasks.setWatch(agentId, taskKey, null)
      await this.ask(agentId, { mode: 'remove', watches: [{ followUpId: taskKey }] })
      return { kind: 'none' }
    })
  }

  /** Its follow-up ended: drop the subscription; a lost removal goes with the next full set. */
  async end(agentId: string, taskKey: string): Promise<void> {
    await this.serial(agentId, () => this.ask(agentId, { mode: 'remove', watches: [{ followUpId: taskKey }] }))
  }

  /** The agent's whole set, once per link: the Control Plane drops what it does not name. */
  async sync(agentId: string): Promise<void> {
    await this.serial(agentId, () => this.syncNow(agentId))
  }

  private async syncNow(agentId: string): Promise<void> {
    const link = this.host.port?.link()
    if (link === undefined || this.synced.get(agentId) === link) return
    const open = (await this.host.watchTasks.watching(agentId)).slice(0, FOLLOW_UP_WATCH_MAX)
    const targets: Array<{ taskKey: string; url: string; target: FollowUpWatchTarget }> = []
    for (const item of open) {
      try {
        targets.push({ ...item, target: watchTarget(item.url) })
      } catch {
        // A stored URL that no longer parses is left out, so its subscription goes.
      }
    }
    const answer = await this.ask(agentId, {
      mode: 'full',
      watches: targets.map((item) => ({ followUpId: item.taskKey, target: item.target }))
    })
    if (!answer) return
    let pending = false
    for (const item of targets) {
      const watch = watchFrom(
        item.url,
        answer.results.find((result) => result.followUpId === item.taskKey)
      )
      await this.host.watchTasks.setWatch(agentId, item.taskKey, watch)
      pending ||= watch.state === 'pending'
    }
    // One the Control Plane could not confirm is sent again with the next sweep.
    if (!pending) this.synced.set(agentId, link)
  }

  private async ask(
    agentId: string,
    req: Pick<AssistantFollowUpWatchReq, 'mode' | 'watches'>
  ): Promise<AssistantFollowUpWatchResult | undefined> {
    try {
      return await this.host.port?.request(agentId, req)
    } catch (err) {
      this.host.log.warn(`follow-up watch: agent ${agentId} ${req.mode} failed: ${(err as Error).message}`)
      return undefined
    }
  }
}
