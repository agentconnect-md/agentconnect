import { z } from 'zod'
import type { ChatState, Turn } from '@microsoft/agent-host-protocol'
import type { LocalStore } from '../store/local-store.js'
import type { AhpCheckpointStore } from './agent-state.js'

const state = z
  .object({
    resource: z.string(),
    title: z.string(),
    modifiedAt: z.string(),
    status: z.number().int(),
    turns: z.array(z.object({ id: z.string() }).passthrough()),
    activeTurn: z
      .object({
        id: z.string(),
        startedAt: z.string(),
        message: z.object({ text: z.string() }).passthrough(),
        responseParts: z.array(z.unknown())
      })
      .passthrough()
      .optional()
  })
  .passthrough()
const checkpoint = z.object({
  version: z.literal(1),
  state,
  presentation: z.record(z.string(), z.unknown()).optional()
})

export class LocalAhpCheckpoints implements AhpCheckpointStore {
  constructor(
    private readonly store: LocalStore,
    private readonly orgId: string,
    private readonly agentId: string,
    readonly running: (sessionId: string) => boolean,
    private readonly now: () => number = Date.now
  ) {}

  async load(sessionId: string): Promise<ChatState | undefined> {
    const value = await this.read(sessionId)
    return value?.state as ChatState | undefined
  }

  async presentation(sessionId: string): Promise<Record<string, unknown> | undefined> {
    return (await this.read(sessionId))?.presentation
  }

  save(
    sessionId: string,
    value: ChatState,
    epoch: number,
    revision: number,
    archive: readonly Turn[] = [],
    presentation?: Record<string, unknown>
  ): Promise<void> {
    return this.store.saveAhpCheckpoint({
      orgId: this.orgId,
      agentId: this.agentId,
      sessionId,
      epoch,
      revision,
      value: JSON.stringify({ version: 1, state: value, presentation }),
      now: this.now(),
      turns: archive.map((turn) => ({ turnId: turn.id, value: JSON.stringify(turn) }))
    })
  }

  async page(sessionId: string, cursor: string): Promise<{ turns: Turn[]; nextCursor?: string }> {
    if (!/^archive:[A-Za-z0-9_-]+$/.test(cursor) || cursor.length > 2048) throw new Error('Invalid AHP archive cursor')
    const encoded = cursor.slice('archive:'.length)
    const decoded = Buffer.from(encoded, 'base64url')
    if (decoded.toString('base64url') !== encoded) throw new Error('Invalid AHP archive cursor')
    const page = await this.store.ahpTurnPage(this.orgId, this.agentId, sessionId, decoded.toString('utf8'))
    const saved = await this.load(sessionId)
    const history = saved?._meta?.['agentconnect.md'] as { historyCursor?: unknown } | undefined
    const nextCursor = page.nextCursor
      ? `archive:${Buffer.from(page.nextCursor).toString('base64url')}`
      : typeof history?.historyCursor === 'string'
        ? history.historyCursor
        : undefined
    return { turns: page.values.map((value) => JSON.parse(value) as Turn), ...(nextCursor ? { nextCursor } : {}) }
  }

  private async read(sessionId: string): Promise<z.infer<typeof checkpoint> | undefined> {
    const value = await this.store.loadAhpCheckpoint(this.orgId, this.agentId, sessionId)
    if (!value) return
    return checkpoint.parse(JSON.parse(value))
  }
}
