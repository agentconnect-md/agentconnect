// Windows administrator (UAC) prompts (computer-use.md §4.2.1): the SYSTEM helper (windows/admin-prompts.cs) reports and answers them.
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'

/** A prompt waiting on the secure desktop, as its dialog shows it. */
export interface AdminPrompt {
  id: string
  // `credentials` asks for an administrator's password: only a person can approve it.
  kind: 'consent' | 'credentials'
  app?: string
  publisher?: string
  command?: string
  lines: string[]
}

export type AdminPromptAnswer = 'approve' | 'deny'

/** What the Computer reads and does; the helper process behind it is replaceable in tests. */
export interface AdminPromptSource {
  pending(): AdminPrompt | undefined
  answer(id: string, answer: AdminPromptAnswer): Promise<void>
  // Undefined while the helper watches; otherwise why it cannot.
  readonly problem: string | undefined
}

export interface AdminPromptHelperOptions {
  // A prompt appeared or went away, or the helper's problem changed.
  onChange: () => void
  log: (line: string) => void
  spawnHelper?: (path: string) => ChildProcess
  restartMs?: number
}

const ANSWER_TIMEOUT_MS = 10_000
const RESTART_MS = 5_000

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export class AdminPromptHelper implements AdminPromptSource {
  problem: string | undefined
  private current: AdminPrompt | undefined
  private child: ChildProcess | undefined
  private closed = false
  private readonly waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()

  private constructor(
    private readonly path: string,
    private readonly options: AdminPromptHelperOptions
  ) {}

  static start(path: string, options: AdminPromptHelperOptions): AdminPromptHelper {
    const helper = new AdminPromptHelper(path, options)
    helper.spawn()
    return helper
  }

  pending(): AdminPrompt | undefined {
    return this.current
  }

  answer(id: string, answer: AdminPromptAnswer): Promise<void> {
    const child = this.child
    if (!child?.stdin || this.problem)
      return Promise.reject(new Error(this.problem ?? 'the prompt helper is not running'))
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id)
        reject(new Error('the prompt helper did not answer in time'))
      }, ANSWER_TIMEOUT_MS)
      timer.unref()
      this.waiting.set(id, {
        resolve: () => (clearTimeout(timer), resolve()),
        reject: (error) => (clearTimeout(timer), reject(error))
      })
      child.stdin!.write(`${JSON.stringify({ id, answer })}\n`)
    })
  }

  close(): void {
    this.closed = true
    // The helper exits when its stdin closes.
    this.child?.stdin?.end()
  }

  private spawn(): void {
    const child = (
      this.options.spawnHelper ?? ((file) => spawn(file, [], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true }))
    )(this.path)
    this.child = child
    child.stdin?.on('error', () => undefined)
    child.on('error', (error) => this.gone(`cannot start the administrator prompt helper: ${error.message}`))
    child.on('exit', (code, signal) =>
      this.gone(`the administrator prompt helper exited (${signal ?? `code ${code}`})`)
    )
    if (child.stdout) createInterface({ input: child.stdout }).on('line', (line) => this.received(line))
  }

  private received(line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    const id = str(message.id)
    switch (message.event) {
      case 'prompt': {
        if (!id) return
        this.current = {
          id,
          kind: message.kind === 'credentials' ? 'credentials' : 'consent',
          ...(str(message.app) ? { app: str(message.app)! } : {}),
          ...(str(message.publisher) ? { publisher: str(message.publisher)! } : {}),
          ...(str(message.command) ? { command: str(message.command)! } : {}),
          lines: Array.isArray(message.lines) ? message.lines.filter((l): l is string => typeof l === 'string') : []
        }
        this.options.log(`administrator prompt: ${this.current.app ?? 'an app'} asks to run as administrator`)
        return this.options.onChange()
      }
      case 'gone':
        if (id && this.current?.id === id) {
          this.current = undefined
          this.options.onChange()
        }
        return
      case 'answered': {
        const waiter = id ? this.waiting.get(id) : undefined
        if (!waiter || !id) return
        this.waiting.delete(id)
        if (message.ok === true) waiter.resolve()
        else waiter.reject(new Error(str(message.error) ?? 'the prompt could not be answered'))
        return
      }
      case 'problem': {
        const problem = str(message.message)
        if (problem === this.problem) return
        this.problem = problem
        if (problem) this.options.log(`administrator prompts: ${problem}`)
        return this.options.onChange()
      }
    }
  }

  private gone(problem: string): void {
    if (this.closed) return
    this.problem = problem
    this.current = undefined
    for (const waiter of this.waiting.values()) waiter.reject(new Error(problem))
    this.waiting.clear()
    this.options.log(`administrator prompts: ${problem}; starting it again`)
    this.options.onChange()
    const child = this.child
    this.child = undefined
    if (child)
      setTimeout(() => {
        if (this.closed) return
        this.problem = undefined
        this.spawn()
      }, this.options.restartMs ?? RESTART_MS).unref()
  }
}
