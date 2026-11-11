// A channel's Work page (assistant-mode.md §5.19): its own open tasks and the schedules that post there, kept by the daemon.
import { createHash } from 'node:crypto'
import type { Agent } from '../agents/agent-schema.js'
import type { PlatformConnection, WorkPage, WorkPageRef, WorkPageTask } from '../platforms/contract.js'
import { cronLabel, cronNextRunText } from '../scheduler/scheduler.js'
import type { PlacedSubsession } from '../store/assistant-subsessions.js'
import type { WorkCanvasRow, WorkCanvases } from '../store/work-canvases.js'
import { BOARD_TITLE_CHARS, readOpenWork, type BoardStores, type BoardTask } from './work-board.js'

/** At most this many tasks are listed; the rest are counted, with the console a link away. */
export const WORK_PAGE_TASKS = 40

type WorkAgent = Pick<Agent, 'id' | 'name' | 'displayName' | 'assistantMode' | 'integrations' | 'crons'>

/** A conversation the page is kept in, under the bot that reaches it. */
export interface WorkPlace {
  platform: string
  channel: string
  integrationId: string
  transportScope: string | null
}

export interface WorkCanvasDeps {
  stores: BoardStores & { workCanvases: Pick<WorkCanvases, 'list' | 'put' | 'remove' | 'anchors'> }
  agents(): Iterable<WorkAgent>
  /** Whether this member holds the agent's duty, so only one member writes its pages. */
  serves(agentId: string): boolean
  /** A paused agent runs no task and checks no follow-up until it is resumed (assistant-mode.md §1.4). */
  paused(agentId: string): boolean
  /** The bot a stored conversation or a cron target is reached through, with its canonical scope. */
  resolve(
    agentId: string,
    at: { platform: string; transportScope?: string | null; integrationId?: string }
  ): { integrationId: string; transportScope: string | null } | undefined
  connection(integrationId: string): Pick<PlatformConnection, 'putWorkPage' | 'removeWorkPage'> | undefined
  /** A conversation shared with another organization, which follow-ups never reach (§5.3). */
  external(agentId: string, place: WorkPlace): boolean
  /** A task's own page in the console, by its session, when it has one. */
  taskLink(row: PlacedSubsession, place: WorkPlace): string | undefined
  consoleUrl(agentId: string): string | undefined
  now(): number
  warn(message: string): void
}

const NOWHERE = { platform: '', channel: '', transportScope: null }

const placeKey = (place: Pick<WorkPlace, 'platform' | 'channel' | 'integrationId'>): string =>
  `${place.platform}\u001f${place.channel}\u001f${place.integrationId}`

const KINDS: Partial<Record<BoardTask['kind'], WorkPageTask['kind']>> = {
  'delegated task': 'task',
  'follow-up': 'follow-up',
  'approved proposal': 'approved proposal'
}

// A title is model-written: one line, cut to the board's length.
function titleOf(title: string | null): string {
  if (!title) return 'Untitled'
  const chars = [...title.replace(/\s+/g, ' ').trim()]
  return chars.length > BOARD_TITLE_CHARS ? `${chars.slice(0, BOARD_TITLE_CHARS - 1).join('')}…` : chars.join('')
}

/** The digest a settled page is remembered by; the update time is left out so an unchanged page is not rewritten. */
export function workPageDigest(page: WorkPage): string {
  const { updatedAt: _updatedAt, ...content } = page
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 16)
}

interface Composed {
  place: WorkPlace
  tasks: WorkPageTask[]
  schedules: WorkPage['schedules']
  more: number
}

/** Every channel's page content for one agent, keyed by place: its open tasks in board order, then its targeted crons. */
export async function composeWorkPages(
  deps: Pick<WorkCanvasDeps, 'stores' | 'resolve' | 'taskLink'>,
  agent: Pick<Agent, 'id' | 'crons'>,
  now: Date
): Promise<Map<string, Composed>> {
  const pages = new Map<string, Composed>()
  const pageFor = (place: WorkPlace): Composed => {
    const key = placeKey(place)
    let page = pages.get(key)
    if (!page) pages.set(key, (page = { place, tasks: [], schedules: [], more: 0 }))
    return page
  }
  for (const task of await readOpenWork(deps.stores, agent.id, { key: '' }, NOWHERE)) {
    const kind = KINDS[task.kind]
    if (!kind) continue
    const bot = deps.resolve(agent.id, task.place)
    if (!bot) continue
    const place = { platform: task.place.platform, channel: task.place.channel, ...bot }
    const page = pageFor(place)
    if (page.tasks.length >= WORK_PAGE_TASKS) {
      page.more += 1
      continue
    }
    const thread = task.row?.replyThread
    const consoleUrl = task.row ? deps.taskLink(task.row, place) : undefined
    page.tasks.push({
      kind,
      status: task.status,
      ...(task.nextCheck !== undefined ? { nextCheck: task.nextCheck } : {}),
      title: titleOf(task.title),
      ...(thread ? { thread } : {}),
      ...(consoleUrl ? { consoleUrl } : {})
    })
  }
  const anchors = new Map((await deps.stores.workCanvases.anchors(agent.id)).map((a) => [a.cronId, a]))
  for (const cron of agent.crons ?? []) {
    if (cron.enabled === false || !cron.target?.channel) continue
    const bot = deps.resolve(agent.id, {
      platform: cron.target.platform,
      ...(cron.target.integrationId ? { integrationId: cron.target.integrationId } : {})
    })
    if (!bot) continue
    const nextRun = cronNextRunText(cron, now)
    const anchor = anchors.get(cron.id)
    pageFor({ platform: cron.target.platform, channel: cron.target.channel, ...bot }).schedules.push({
      label: cronLabel(cron),
      ...(nextRun ? { nextRun } : {}),
      ...(anchor && anchor.channel === cron.target.channel ? { thread: anchor.thread } : {})
    })
  }
  return pages
}

const refOf = (row: WorkCanvasRow | undefined): WorkPageRef | undefined =>
  row?.canvasId && (row.state === 'live' || row.state === 'failed')
    ? { canvasId: row.canvasId, ...(row.bookmarkId ? { bookmarkId: row.bookmarkId } : {}) }
    : undefined

/** Each minute: write every changed page of the agents this member serves, and take down the pages of agents that left assistant mode or of places now shared outside. */
export async function sweepWorkCanvases(deps: WorkCanvasDeps): Promise<void> {
  for (const agent of deps.agents()) {
    if (!deps.serves(agent.id)) continue
    await sweepAgent(deps, agent).catch((err) =>
      deps.warn(`work canvas sweep failed for agent "${agent.id}": ${(err as Error).message}`)
    )
  }
}

// A page whose removal did not go through keeps its row, so the next sweep tries again.
async function takeDown(deps: WorkCanvasDeps, row: WorkCanvasRow, integrationId: string | undefined): Promise<void> {
  const ref = refOf(row)
  if (ref) {
    const conn = integrationId ? deps.connection(integrationId) : undefined
    if (!conn?.removeWorkPage) return
    try {
      await conn.removeWorkPage(row.channel, ref)
    } catch (err) {
      deps.warn(`work canvas removal failed (ch=${row.channel}): ${(err as Error).message}`)
      return
    }
  }
  await deps.stores.workCanvases.remove(row.agentId, row)
}

async function sweepAgent(deps: WorkCanvasDeps, agent: WorkAgent): Promise<void> {
  const rows = await deps.stores.workCanvases.list(agent.id)
  const rowBot = (row: WorkCanvasRow) => deps.resolve(agent.id, row)
  if (agent.assistantMode?.enabled !== true) {
    // Leaving the mode takes every page down and forgets a person's deletion, so switching it on again starts afresh.
    for (const row of rows) await takeDown(deps, row, rowBot(row)?.integrationId)
    return
  }
  const pages = await composeWorkPages(deps, agent, new Date(deps.now()))
  const stored = new Map<string, WorkCanvasRow>()
  for (const row of rows) {
    const bot = rowBot(row)
    if (bot) stored.set(placeKey({ ...row, integrationId: bot.integrationId }), row)
  }
  const consoleUrl = deps.consoleUrl(agent.id)
  for (const key of new Set([...pages.keys(), ...stored.keys()])) {
    const row = stored.get(key)
    const composed = pages.get(key)
    const place: WorkPlace =
      composed?.place ?? ({ platform: row!.platform, channel: row!.channel, ...rowBot(row!)! } satisfies WorkPlace)
    if (deps.external(agent.id, place)) {
      if (row) await takeDown(deps, row, place.integrationId)
      continue
    }
    if (row?.state === 'deleted') continue
    const page: WorkPage = {
      agentName: agent.displayName?.trim() || agent.name,
      ...(deps.paused(agent.id) ? { paused: true } : {}),
      tasks: composed?.tasks ?? [],
      schedules: composed?.schedules ?? [],
      ...(composed?.more ? { more: composed.more } : {}),
      ...(consoleUrl ? { consoleUrl } : {}),
      updatedAt: deps.now()
    }
    const digest = workPageDigest(page)
    if (row && row.digest === digest) continue
    const conn = deps.connection(place.integrationId)
    if (!conn?.putWorkPage) continue
    const base = {
      agentId: agent.id,
      platform: place.platform,
      channel: place.channel,
      transportScope: place.transportScope,
      digest,
      updatedAt: deps.now()
    }
    try {
      const result = await conn.putWorkPage(place.channel, page, refOf(row))
      await deps.stores.workCanvases.put(
        result.state === 'live'
          ? {
              ...base,
              state: 'live',
              canvasId: result.canvasId,
              ...(result.bookmarkId ? { bookmarkId: result.bookmarkId } : {})
            }
          : { ...base, state: result.state }
      )
    } catch (err) {
      deps.warn(`work canvas write failed (ch=${place.channel}): ${(err as Error).message}`)
      const ref = refOf(row)
      await deps.stores.workCanvases.put({ ...base, state: 'failed', ...(ref ?? {}) })
    }
  }
}
