// The FIFO lease wait queue (computer-use.md §4.4): pure decisions over one Computer's waiting sessions.
import type { ComputerLeaseQueued } from '@agentconnect.md/protocol'
import { computerGrantsAgent, type ComputerAgentAccess, type ComputerPolicy } from './computer.js'

/** A waiter that has not asked again for this long has left the queue: its daemon was lost or gave up. */
export const LEASE_WAITER_TTL_MS = 15_000

/** One session waiting for a Computer's lease; times are epoch milliseconds. */
export interface LeaseWaiter {
  computerId: string
  orgId: string
  sessionId: string
  agentId: string
  daemonId: string | null
  /** CP clock: its place in line. */
  enqueuedAt: number
  /** CP clock: its latest ask. */
  polledAt: number
  /** Daemon clock: its latest ask's `requestedAt`; only a turn end stamped at or after it drops the waiter. */
  turnAt: number
  /** CP clock: its turn ended while it waited; the row stays so a late ask of that wait cannot rejoin the line. */
  droppedAt: number | null
}

export interface WaiterRequest {
  sessionId: string
  agentId: string
  daemonId: string | null
  turnAt: number
}

const sameWaiter = (w: LeaseWaiter, who: { sessionId: string; agentId: string }) =>
  w.sessionId === who.sessionId && w.agentId === who.agentId

/** Queue order: first enqueued first, ties broken by identity so every replica agrees. */
export function waiterOrder(a: LeaseWaiter, b: LeaseWaiter): number {
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt
  const ka = `${a.agentId}/${a.sessionId}`
  const kb = `${b.agentId}/${b.sessionId}`
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

/** The waiters still in line at `now`: one that stopped asking, or lost its grant, has left. */
export function keepWaiters(
  queue: readonly LeaseWaiter[],
  computer: { policy: ComputerPolicy; agentAccess: ComputerAgentAccess } | null,
  now: number,
  ttlMs = LEASE_WAITER_TTL_MS
): LeaseWaiter[] {
  return queue
    .filter(
      (w) =>
        now < w.polledAt + ttlMs &&
        (w.droppedAt !== null ||
          (computer !== null && computerGrantsAgent(computer, w.agentId) && computer.policy.agentMode === 'control'))
    )
    .sort(waiterOrder)
}

/** The queue without the session's entry; undefined when it had none. */
export function withoutWaiter(
  queue: readonly LeaseWaiter[],
  who: { sessionId: string; agentId: string }
): LeaseWaiter[] | undefined {
  return queue.some((w) => sameWaiter(w, who)) ? queue.filter((w) => !sameWaiter(w, who)) : undefined
}

export function findWaiter(
  queue: readonly LeaseWaiter[],
  who: { sessionId: string; agentId: string }
): LeaseWaiter | undefined {
  return queue.find((w) => sameWaiter(w, who))
}

/** Live waiters ahead of `entry`, or every live waiter when it has no place yet. */
export function waitersAhead(queue: readonly LeaseWaiter[], entry: LeaseWaiter | undefined): number {
  return queue.filter((w) => w.droppedAt === null && (!entry || (w !== entry && waiterOrder(w, entry) < 0))).length
}

export type JoinOutcome =
  | { kind: 'waiting'; queue: LeaseWaiter[]; queued: ComputerLeaseQueued }
  | { kind: 'timed_out'; queue: LeaseWaiter[]; waitedMs: number }

/** Take or keep the session's place in line; a wait past `leaseWaitSeconds` ends and leaves the line. */
export function joinQueue(
  computerId: string,
  orgId: string,
  queue: readonly LeaseWaiter[],
  req: WaiterRequest,
  policy: ComputerPolicy,
  now: number
): JoinOutcome {
  const mine = findWaiter(queue, req)
  const others = queue.filter((w) => w !== mine)
  const entry: LeaseWaiter =
    mine && mine.droppedAt === null
      ? { ...mine, polledAt: now, turnAt: Math.max(mine.turnAt, req.turnAt), daemonId: req.daemonId ?? mine.daemonId }
      : {
          computerId,
          orgId,
          sessionId: req.sessionId,
          agentId: req.agentId,
          daemonId: req.daemonId,
          enqueuedAt: now,
          polledAt: now,
          turnAt: req.turnAt,
          droppedAt: null
        }
  const deadline = entry.enqueuedAt + policy.leaseWaitSeconds * 1000
  if (now >= deadline) return { kind: 'timed_out', queue: others, waitedMs: now - entry.enqueuedAt }
  const next = [...others, entry].sort(waiterOrder)
  return {
    kind: 'waiting',
    queue: next,
    queued: {
      position: waitersAhead(next, entry) + 1,
      waitedMs: now - entry.enqueuedAt,
      leftMs: deadline - now
    }
  }
}

/** The session's turn ended: its waits from at or before `before` (daemon clock) leave the line; undefined when nothing changed. */
export function dropWaiter(
  queue: readonly LeaseWaiter[],
  who: { sessionId: string; agentId: string },
  before: number,
  now: number
): LeaseWaiter[] | undefined {
  const mine = findWaiter(queue, who)
  if (!mine || mine.droppedAt !== null || mine.turnAt > before) return undefined
  return queue.map((w) => (w === mine ? { ...w, droppedAt: now, polledAt: now } : w))
}

/** A wait the session's turn already ended: a late ask from it gets a final answer instead of a new place. */
export function endedWait(queue: readonly LeaseWaiter[], req: WaiterRequest): LeaseWaiter | undefined {
  const mine = findWaiter(queue, req)
  return mine && mine.droppedAt !== null && req.turnAt <= mine.turnAt ? mine : undefined
}
