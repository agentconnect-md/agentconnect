import type { ActionEnvelope, ActionOrigin, StateAction } from '@microsoft/agent-host-protocol'

export interface AhpSequenceRange {
  start: number
  end: number
}

export interface AhpJournalOptions {
  reserve(size: number): Promise<AhpSequenceRange>
  blockSize?: number
  maxEvents?: number
  maxBytes?: number
}

type Entry = { envelope: ActionEnvelope; bytes: number }
type Listener = { next(envelope: ActionEnvelope): void; error(error: unknown): void }

export class AhpActionJournal {
  private sequence: number
  private end: number
  private floor: number
  private bytes = 0
  private entries: Entry[] = []
  private listeners = new Set<Listener>()
  private pending: Promise<unknown> = Promise.resolve()
  private failure: unknown
  private failed = false

  private constructor(
    private readonly options: Required<AhpJournalOptions>,
    range: AhpSequenceRange
  ) {
    this.sequence = range.start
    this.floor = range.start
    this.end = range.end
  }

  static async create(options: AhpJournalOptions): Promise<AhpActionJournal> {
    const config = { blockSize: 1024, maxEvents: 256, maxBytes: 1024 * 1024, ...options }
    for (const value of [config.blockSize, config.maxEvents, config.maxBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid AHP journal limit')
    }
    const range = await config.reserve(config.blockSize)
    validateRange(range, 0)
    return new AhpActionJournal(config, range)
  }

  get currentSequence(): number {
    return this.sequence
  }

  append(input: {
    channel: string
    action: StateAction
    origin?: ActionOrigin
    rejectionReason?: string
  }): Promise<ActionEnvelope> {
    const captured = structuredClone(input)
    const operation = this.pending.then(async () => {
      if (this.failed) throw this.failure
      try {
        if (this.sequence === this.end) {
          const range = await this.options.reserve(this.options.blockSize)
          validateRange(range, this.end)
          this.sequence = range.start - 1
          this.end = range.end
        }
        const envelope: ActionEnvelope = { ...captured, origin: captured.origin, serverSeq: ++this.sequence }
        // Rejections are delivered only to their origin, never to another subscriber or replay.
        if (envelope.rejectionReason === undefined) {
          const bytes = Buffer.byteLength(JSON.stringify(envelope))
          this.entries.push({ envelope, bytes })
          this.bytes += bytes
          while (this.entries.length > this.options.maxEvents || this.bytes > this.options.maxBytes) {
            const removed = this.entries.shift()!
            this.bytes -= removed.bytes
            this.floor = removed.envelope.serverSeq
          }
          for (const listener of [...this.listeners]) {
            try {
              listener.next(structuredClone(envelope))
            } catch (error) {
              this.listeners.delete(listener)
              try {
                listener.error(error)
              } catch {
                /* A broken consumer cannot affect the journal. */
              }
            }
          }
        }
        return structuredClone(envelope)
      } catch (error) {
        this.failed = true
        this.failure = error
        for (const listener of [...this.listeners]) {
          try {
            listener.error(error)
          } catch {
            /* Continue closing other consumers. */
          }
        }
        this.listeners.clear()
        throw error
      }
    })
    this.pending = operation.catch(() => {})
    return operation
  }

  replay(after: number, channels: ReadonlySet<string>): ActionEnvelope[] | undefined {
    if (this.failed || !Number.isSafeInteger(after) || after < this.floor || after > this.sequence) return undefined
    return this.entries
      .filter(({ envelope }) => envelope.serverSeq > after && channels.has(envelope.channel))
      .map(({ envelope }) => structuredClone(envelope))
  }

  subscribe(next: Listener['next'], error: Listener['error'] = () => {}): () => void {
    if (this.failed) {
      error(this.failure)
      return () => {}
    }
    const listener = { next, error }
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function validateRange(range: AhpSequenceRange, previous: number): void {
  if (
    !Number.isSafeInteger(range.start) ||
    !Number.isSafeInteger(range.end) ||
    range.start <= previous ||
    range.end < range.start
  ) {
    throw new Error('Invalid durable AHP sequence reservation')
  }
}
