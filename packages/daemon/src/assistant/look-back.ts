// Looking back at open tasks (assistant-mode.md §5.20): every few hours a place's coordinator is handed its quiet tasks, and settles each.
import type { Agent } from '../agents/agent-schema.js'
import { assistantModeOn } from '../mcp/ops/assistant-items.js'
import { isCoordinatorSessionKey } from '../session/append-coordinate.js'
import type { AssistantSubsessionIndex, PlacedSubsession, TaskLookBack } from '../store/assistant-subsessions.js'

const HOUR_MS = 60 * 60_000

/** A place is looked at no more often than this. */
export const LOOK_BACK_INTERVAL_MS = 4 * HOUR_MS
/** A task is listed only after this long without a round starting or settling, doubled for each time it was sent back to work. */
export const LOOK_BACK_QUIET_MS = 4 * HOUR_MS
/** The quiet a task must show never grows past this. */
export const LOOK_BACK_QUIET_MAX_MS = 24 * HOUR_MS
/** At most this many reminders per task since a person last wrote in its threads. */
export const LOOK_BACK_REMINDERS_MAX = 2
/** A second reminder comes no sooner than this after the one before. */
export const LOOK_BACK_REMINDER_GAP_MS = 24 * HOUR_MS
/** After this many looks in a row that left it, a task is not listed until it changes. */
export const LOOK_BACK_LEAVES_MAX = 6
/** Nothing is listed longer than this after the last person's message in its threads. */
export const LOOK_BACK_WINDOW_MS = 7 * 24 * HOUR_MS
/** At most this many items in one look of a place; the rest wait for the next look. */
export const LOOK_BACK_ITEMS_MAX = 10
/** An item quotes at most this much of the end of the task's last reply. */
export const LOOK_BACK_REPLY_TAIL_CHARS = 400
/** An item quotes at most this much of the summary's first sentence. */
export const LOOK_BACK_SUMMARY_CHARS = 200
/** The task's latest transcript rows an item searches for its last reply. */
export const LOOK_BACK_SCANNED_ROWS = 50

/** The report kind a look-back item carries, as its block names it. */
export const LOOK_BACK_KIND = 'look back'

/** The quiet a task must show before it is listed, after it was sent back to work `sentBack` times: 4 h, 8 h, 16 h, then 24 h. */
export function requiredQuietMs(sentBack: number): number {
  return Math.min(LOOK_BACK_QUIET_MS * 2 ** Math.max(0, sentBack), LOOK_BACK_QUIET_MAX_MS)
}

/** Whether a place is due a look, given when a look last listed any of its tasks. */
export function placeDue(lastLook: number | undefined, now: number): boolean {
  return lastLook === undefined || now - lastLook >= LOOK_BACK_INTERVAL_MS
}

/** What the listing rule reads of a task. "Quiet since" is its row's `changedAt`: when a round last started or settled or its title changed. */
export interface LookBackTask {
  changedAt?: number
  createdAt: number
  lookBack?: TaskLookBack
}

/** Why a task is not listed. */
export type LookBackSkip = 'busy' | 'stopped' | 'window' | 'quiet' | 'reminded' | 'left'

export type LookBackVerdict = { listed: true; remind: boolean; left: number } | { listed: false; why: LookBackSkip }

/** Whether a look lists a task now, whether it may be reminded, and the looks in a row that left it once this one does too. */
export function lookBackVerdict(
  task: LookBackTask,
  now: number,
  live: { busy: boolean; muted: boolean }
): LookBackVerdict {
  const look = task.lookBack
  const reminders = look?.reminders ?? 0
  const quietSince = task.changedAt ?? task.createdAt
  if (live.busy) return { listed: false, why: 'busy' }
  if (live.muted || look?.stoppedAt !== undefined) return { listed: false, why: 'stopped' }
  if (now - (look?.personAt ?? task.createdAt) > LOOK_BACK_WINDOW_MS) return { listed: false, why: 'window' }
  if (now - quietSince < requiredQuietMs(look?.sentBack ?? 0)) return { listed: false, why: 'quiet' }
  // A round since the latest reminder lifts its hold; without one the task waits for a person or the gap.
  const roundSinceReminder = look?.remindedAt !== undefined && quietSince > look.remindedAt
  const gapPassed = look?.remindedAt === undefined || now - look.remindedAt >= LOOK_BACK_REMINDER_GAP_MS
  if (reminders > 0 && !roundSinceReminder && (reminders >= LOOK_BACK_REMINDERS_MAX || !gapPassed))
    return { listed: false, why: 'reminded' }
  // A round since the last look breaks the run of looks that left it.
  const leftInARow = look?.lookedAt !== undefined && quietSince > look.lookedAt ? 0 : (look?.left ?? 0)
  if (leftInARow >= LOOK_BACK_LEAVES_MAX) return { listed: false, why: 'left' }
  return { listed: true, remind: reminders < LOOK_BACK_REMINDERS_MAX && gapPassed, left: leftInARow + 1 }
}

/** Why an item no longer holds for its task as it stands now, as the refusal words it, or undefined while it does. */
export function lookBackStale(
  task: (LookBackTask & { closedAt?: number }) | undefined,
  muted: boolean
): string | undefined {
  if (!task || task.closedAt !== undefined) return 'is no longer open'
  const look = task.lookBack
  if (muted || look?.stoppedAt !== undefined) return 'was stopped by a person since'
  if (look?.lookedAt === undefined) return undefined
  if ((look.personAt ?? 0) > look.lookedAt) return 'has heard from a person since'
  return (task.changedAt ?? task.createdAt) > look.lookedAt ? 'has run a round since' : undefined
}

/** What an item says of its task, all of it already held by the daemon. */
export interface LookBackFacts {
  title?: string
  /** Its row's `changedAt`. */
  quietSince: number
  summary?: string
  summaryAt?: number
  /** The task's last reply, whole; the item quotes its end. */
  lastReply?: string
  failed: boolean
  /** The last person who wrote in its threads; `zone` only where the daemon knows theirs. */
  person?: { name: string; at: number; zone?: string }
  reminders: number
  remindedAt?: number
  sentBack: number
  /** Whether a reminder is open now. */
  remind: boolean
  now: number
}

/** An instant to the minute, in UTC. */
const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`

function ago(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS)
  if (hours < 1) return 'under an hour'
  if (hours < 48) return hours === 1 ? 'an hour' : `${hours} hours`
  return `${Math.floor(hours / 24)} days`
}

/** A person's wall clock at an instant, or undefined for a zone the runtime does not know. */
export function localTime(ms: number, zone: string): string | undefined {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    }).format(new Date(ms))
  } catch {
    return undefined
  }
}

/** The first sentence of a summary, which states the task's status on its own (auto-session-mode.md §6.7). */
export function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const end = /[.!?](?=\s|$)/.exec(flat)
  const sentence = end ? flat.slice(0, end.index + 1) : flat
  const chars = [...sentence]
  return chars.length <= LOOK_BACK_SUMMARY_CHARS ? sentence : `${chars.slice(0, LOOK_BACK_SUMMARY_CHARS - 1).join('')}…`
}

/** The end of a reply, at most {@link LOOK_BACK_REPLY_TAIL_CHARS}, cut at a word. */
export function replyTail(text: string): string {
  const trimmed = text.trim()
  const chars = [...trimmed]
  if (chars.length <= LOOK_BACK_REPLY_TAIL_CHARS) return trimmed
  const tail = chars.slice(chars.length - LOOK_BACK_REPLY_TAIL_CHARS).join('')
  const space = tail.search(/\s/)
  return `…${space > 0 && space < 40 ? tail.slice(space + 1) : tail}`
}

const times = (n: number): string => (n === 1 ? 'once' : n === 2 ? 'twice' : `${n} times`)

/** The text of one look-back item, as the coordinator reads it inside its report block. */
export function lookBackItemText(f: LookBackFacts): string {
  const quoted = (s: string): string => `"${s.replace(/"/g, '\\"')}"`
  const lines = [
    `[look back] Task ${quoted(f.title?.trim() || 'Untitled')} has been quiet since ${iso(f.quietSince)} (${ago(f.now - f.quietSince)}).`
  ]
  if (f.summary?.trim())
    lines.push(
      `Its summary${f.summaryAt !== undefined ? ` (written ${iso(f.summaryAt)})` : ''}: ${firstSentence(f.summary)}`
    )
  if (f.failed) lines.push('Its last round failed.')
  if (f.lastReply?.trim()) lines.push(`The end of its last reply: ${quoted(replyTail(f.lastReply))}`)
  if (f.person) {
    const then = f.person.zone ? localTime(f.person.at, f.person.zone) : undefined
    const now = f.person.zone ? localTime(f.now, f.person.zone) : undefined
    const clock = then && now ? `; their local time then ${then}, now ${now} (${f.person.zone})` : ''
    lines.push(`Last person to write in its threads: ${f.person.name}, at ${iso(f.person.at)}${clock}.`)
  }
  const earlier = [
    ...(f.reminders > 0
      ? [`reminded ${times(f.reminders)}${f.remindedAt !== undefined ? `, last at ${iso(f.remindedAt)}` : ''}`]
      : []),
    ...(f.sentBack > 0 ? [`sent back to work ${times(f.sentBack)}`] : [])
  ]
  if (earlier.length > 0) lines.push(`Since that person wrote, earlier looks ${earlier.join(' and ')}.`)
  if (!f.remind)
    lines.push(
      f.reminders >= LOOK_BACK_REMINDERS_MAX
        ? 'It has had every reminder it may get: do not remind again.'
        : 'Its last reminder is less than a day old: do not remind again yet.'
    )
  lines.push(
    'Settle it with replyToMessage (a reminder), messageTask with this taskId (send it back to work), or ignoreMessage (leave it).'
  )
  return lines.join('\n')
}

/** One item of a look, with the task it speaks for. */
export interface LookBackItem {
  task: PlacedSubsession
  text: string
  remind: boolean
}

/** What looking back needs from its daemon. */
export interface LookBackHost {
  now(): number
  agents(): Iterable<Agent>
  /** The duty holder looks, never for a paused or draining agent, as it checks (§5.9). */
  mayLook(agentId: string): boolean
  draining(): boolean
  index: Pick<AssistantSubsessionIndex, 'lookBackCandidates' | 'lastLooks' | 'markLooked'>
  /** A turn of the session runs or waits, in memory or in the inbox. */
  busy(key: string): Promise<boolean>
  /** A person muted the task's thread, on a platform where a stop mutes. */
  muted(key: string, platform: string): Promise<boolean>
  /** What the item says of a task; undefined leaves it out, as for a task with no session left. */
  facts(agentId: string, task: PlacedSubsession, remind: boolean): Promise<LookBackFacts | undefined>
  /** Hand one place's items to its coordinator as one batch. */
  deliver(agentId: string, place: NonNullable<PlacedSubsession['owner']>, items: LookBackItem[]): Promise<void>
  log: { info(message: string): void; warn(message: string): void }
}

/** The look-back sweep over every assistant-mode agent's coordinated places, run beside the check sweep. */
export class LookBack {
  private sweeping = false

  constructor(private readonly host: LookBackHost) {}

  async sweep(): Promise<void> {
    if (this.sweeping || this.host.draining()) return
    this.sweeping = true
    try {
      for (const agent of this.host.agents()) {
        if (!assistantModeOn(agent) || !this.host.mayLook(agent.id)) continue
        await this.lookAt(agent.id).catch((err: unknown) =>
          this.host.log.warn(`look back: agent ${agent.id} was not looked at: ${(err as Error).message}`)
        )
      }
    } finally {
      this.sweeping = false
    }
  }

  /** One agent's due places: each lists its quiet tasks, and a place with none costs no turn. */
  async lookAt(agentId: string): Promise<void> {
    const now = this.host.now()
    const candidates = await this.host.index.lookBackCandidates(agentId, now - LOOK_BACK_QUIET_MS)
    if (candidates.length === 0) return
    const lastLooks = await this.host.index.lastLooks(agentId)
    const places = new Map<string, PlacedSubsession[]>()
    for (const task of candidates) {
      // Only a coordinator settles items; a webchat conversation runs each report as a turn of its own.
      if (!isCoordinatorSessionKey(task.parentSessionKey) || !task.owner || task.owner.platform === 'webchat') continue
      places.set(task.parentSessionKey, [...(places.get(task.parentSessionKey) ?? []), task])
    }
    for (const [parentKey, tasks] of places) {
      if (!placeDue(lastLooks.get(parentKey), now)) continue
      const items: LookBackItem[] = []
      const looked: { key: string; left: number }[] = []
      for (const task of tasks) {
        if (items.length >= LOOK_BACK_ITEMS_MAX) break
        const key = task.childSessionKey
        // The row alone rules most tasks out; only one it would list is worth asking the store and the platform about.
        if (!lookBackVerdict(task, now, { busy: false, muted: false }).listed) continue
        const verdict = lookBackVerdict(task, now, {
          busy: await this.host.busy(key),
          muted: await this.host.muted(key, task.owner!.platform)
        })
        if (!verdict.listed) continue
        const facts = await this.host.facts(agentId, task, verdict.remind)
        if (!facts) continue
        items.push({ task, text: lookBackItemText(facts), remind: verdict.remind })
        looked.push({ key, left: verdict.left })
      }
      if (items.length === 0) continue
      // Marked before delivery, so a coordinator that answers at once records over it, and a lost turn counts as a leave.
      for (const { key, left } of looked) await this.host.index.markLooked(agentId, key, { now, left })
      this.host.log.info(`look back: ${items.length} quiet task(s) to ${parentKey}`)
      await this.host.deliver(agentId, tasks[0]!.owner!, items)
    }
  }
}

/** What a task sent back to work receives, framed by the daemon around the coordinator's note (assistant-mode.md §5.20). */
export function sentBackText(note?: string): string {
  const frame =
    '[look back] No person sent this: your coordinator looked back at this task, which has been quiet, and sends it ' +
    'back to work. Check where the work stands and go on with what you were already asked or approved to do. A step ' +
    'that needs a decision is asked in your thread and waits there. Update your summary with updateTask.'
  return note?.trim() ? `${frame}\n\nYour coordinator's note: ${note.trim()}` : frame
}
