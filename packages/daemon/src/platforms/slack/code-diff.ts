import { createHash } from 'node:crypto'
import { TaskDiffUnavailable, type TaskDiff } from '../../workspace/task-diff.js'

const SYNC_INTERVAL_MS = 5000

export interface CodeDiffOutput {
  stop(): void
  settle(): Promise<void>
}

export interface CodeDiffHost {
  authorize(): Promise<void>
  open(): Promise<TaskDiff>
  active(): boolean
  mask(content: string): string
  publish(content: string, signal: AbortSignal): Promise<void>
  hasPublished?: boolean
  notice(text: string): Promise<void>
  debug(message: string): void
}

// One serialized publisher per turn; the task baseline lives beyond the turn in its repository.
export async function startCodeDiff(host: CodeDiffHost): Promise<CodeDiffOutput | undefined> {
  let source: TaskDiff
  const notice = async (error: unknown): Promise<void> => {
    const reason = error instanceof TaskDiffUnavailable ? error.message : 'The workspace or Slack could not be reached.'
    host.debug(`slack: automatic code diff unavailable (${error instanceof Error ? error.name : 'unknown'})`)
    if (host.active()) await host.notice(`Code diff is not updating. ${reason}`).catch(() => {})
  }
  try {
    await host.authorize()
    source = await host.open()
  } catch (error) {
    await notice(error)
    return undefined
  }
  let stopped = false
  const abort = new AbortController()
  let timer: NodeJS.Timeout | undefined
  let running: Promise<void> = Promise.resolve()
  let lastDigest: string | undefined
  const sync = async (): Promise<void> => {
    if (stopped || !host.active()) return
    try {
      const content = host.mask(await source.read(abort.signal))
      if (stopped || !host.active()) return
      const digest = createHash('sha256').update(content).digest('hex')
      if (digest === lastDigest || (!content && lastDigest === undefined && !host.hasPublished)) return
      await host.authorize()
      if (stopped || !host.active()) return
      await host.publish(content, abort.signal)
      lastDigest = digest
    } catch (error) {
      if (stopped || !host.active()) return
      stopped = true
      await notice(error)
    }
  }
  const arm = (): void => {
    if (stopped || !host.active()) return
    timer = setTimeout(() => {
      timer = undefined
      running = sync().finally(arm)
    }, SYNC_INTERVAL_MS)
    timer.unref()
  }
  arm()
  return {
    stop() {
      stopped = true
      abort.abort()
      clearTimeout(timer)
    },
    async settle() {
      clearTimeout(timer)
      await running
      clearTimeout(timer)
      await sync()
      stopped = true
    }
  }
}
