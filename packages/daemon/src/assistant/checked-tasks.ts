// The tasks a check runs for, by their one id, the task key (assistant-mode.md §5.12, §5.13, §5.18): a watch task in the task store, else a getting-to-know task in the item ledger.
import { checkCoordinate, isGettingToKnowKey } from '../session/subsession-coordinate.js'
import type {
  AssistantGettingToKnowTrigger,
  AssistantItem,
  AssistantItemLedger,
  AssistantPlace
} from '../store/assistant-items.js'
import type {
  AssistantWatchTasks,
  WatchTask,
  WatchTaskObservation,
  WatchTaskStatus
} from '../store/assistant-watch-tasks.js'
import { sessionKey } from '../store/local-store.js'
import { monotonicTs } from '../store/monotonic-ts.js'

/** A task a check runs for, as the check reads it: a watch task, or a getting-to-know task in the same shape. */
export type CheckedTask = Omit<WatchTask, 'owner' | 'running'> & {
  /** How a getting-to-know task was started; null on a watch task. */
  gettingToKnow: AssistantGettingToKnowTrigger | null
  /** A getting-to-know task's row in the item ledger, which its report's round names; a watch task has its task key alone. */
  itemId?: string
}

/** A new follow-up's one id: the key of the session its checks run in, in its place. */
export function followUpTaskKey(agentId: string, place: AssistantPlace): string {
  return sessionKey(place.platform, place.channel, checkCoordinate(monotonicTs()), agentId, place.transportScope)
}

/** Whether a checked task is still open: active with a next check, or waiting without one. */
export const checkedTaskOpen = (task: Pick<CheckedTask, 'status'>): boolean =>
  task.status === 'active' || task.status === 'waiting'

export interface CheckedTaskStores {
  watchTasks: Pick<AssistantWatchTasks, 'get' | 'appendObservation' | 'schedule' | 'setShared'>
  items: Pick<AssistantItemLedger, 'byTaskKey' | 'appendObservation' | 'schedule' | 'setShared'>
}

function fromWatchTask(task: WatchTask): CheckedTask {
  const { owner: _owner, running: _running, ...rest } = task
  return { ...rest, gettingToKnow: null }
}

function fromItem(item: AssistantItem): CheckedTask {
  const latest = item.observations.at(-1)
  return {
    taskKey: item.taskKey,
    agentId: item.agentId,
    title: item.title,
    doneWhen: item.doneWhen,
    nextAt: item.nextCheck,
    status: item.status,
    origin: item.origin,
    asker: item.asker,
    shared: item.shared,
    replyThread: item.replyThread,
    watch: null,
    background: item.summary,
    summary: latest?.text ?? '',
    summaryUpdatedAt: latest?.at ?? null,
    observations: item.observations,
    observationVersion: item.observationVersion,
    version: item.version,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    changedAt: item.changedAt ?? item.updatedAt,
    gettingToKnow: item.gettingToKnow,
    itemId: item.id
  }
}

/** A checked task by its one id: its key names which store holds it. */
export async function readCheckedTask(
  stores: { watchTasks: Pick<AssistantWatchTasks, 'get'>; items: Pick<AssistantItemLedger, 'byTaskKey'> },
  agentId: string,
  taskKey: string
): Promise<CheckedTask | undefined> {
  if (isGettingToKnowKey(taskKey)) {
    const item = await stores.items.byTaskKey(agentId, taskKey)
    return item ? fromItem(item) : undefined
  }
  const task = await stores.watchTasks.get(agentId, taskKey)
  return task ? fromWatchTask(task) : undefined
}

/** One id for every checked task: its key names which store holds it. */
export class CheckedTasks {
  constructor(private readonly stores: CheckedTaskStores) {}

  async get(agentId: string, taskKey: string): Promise<CheckedTask | undefined> {
    return await readCheckedTask(this.stores, agentId, taskKey)
  }

  async appendObservation(
    agentId: string,
    taskKey: string,
    observation: { text: string; author?: string; now?: number }
  ): Promise<WatchTaskObservation | undefined> {
    if (!isGettingToKnowKey(taskKey))
      return await this.stores.watchTasks.appendObservation(agentId, taskKey, observation)
    const item = await this.stores.items.byTaskKey(agentId, taskKey)
    return item ? await this.stores.items.appendObservation(agentId, item.id, observation) : undefined
  }

  /** Set an open task's schedule or end it; false once it has ended. */
  async schedule(
    agentId: string,
    taskKey: string,
    next: { status: WatchTaskStatus; nextAt: number | null },
    now?: number
  ): Promise<boolean> {
    if (!isGettingToKnowKey(taskKey)) return await this.stores.watchTasks.schedule(agentId, taskKey, next, now)
    const item = await this.stores.items.byTaskKey(agentId, taskKey)
    return item
      ? await this.stores.items.schedule(agentId, item.id, { status: next.status, nextCheck: next.nextAt }, now)
      : false
  }

  async setShared(agentId: string, taskKey: string, shared: boolean): Promise<void> {
    if (!isGettingToKnowKey(taskKey)) return await this.stores.watchTasks.setShared(agentId, taskKey, shared)
    const item = await this.stores.items.byTaskKey(agentId, taskKey)
    if (item) await this.stores.items.setShared(agentId, item.id, shared)
  }
}
