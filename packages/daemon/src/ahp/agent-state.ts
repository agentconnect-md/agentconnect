import { createHash } from 'node:crypto'
import { AhpMessageText, type AhpSessionBinding } from '@agentconnect.md/protocol'
import {
  ActionType,
  sessionReducer,
  SessionLifecycle,
  type ActionOrigin,
  type AgentInfo,
  type ChatAction,
  type ChatTurnsLoadedAction,
  type ChatState,
  type ChatSummary,
  type SessionConfigState,
  type SessionAction,
  type SessionState,
  type SessionSummary,
  type Snapshot,
  type StateAction,
  type Turn
} from '@microsoft/agent-host-protocol'
import type { MaskedChatEvent } from '../session/chat-events.js'
import type { ChatOutput } from '../session/chat-turn.js'
import type { AhpActionJournal } from './action-journal.js'
import { AhpChatProjection } from './chat-projection.js'
import type { AhpCatalogNotification } from './connection.js'
import { AhpAppsProjection, type AhpAppEntry } from './apps.js'

export class AhpStateCapacityError extends Error {
  constructor() {
    super('AHP state exceeds the wire capacity')
  }
}

export interface AhpCheckpointStore {
  load(sessionId: string): Promise<ChatState | undefined>
  save(
    sessionId: string,
    state: ChatState,
    epoch: number,
    revision: number,
    archive?: readonly Turn[],
    presentation?: Record<string, unknown>
  ): Promise<void>
  running(sessionId: string): boolean
  presentation?(sessionId: string): Promise<Record<string, unknown> | undefined>
}
type Binding = AhpSessionBinding & { sessionId: string }
type Entry = {
  projection: AhpChatProjection
  actions: ChatAction[]
  binding?: Binding
  session?: SessionState
  createdAt: string
  presentation?: Record<string, unknown>
  apps?: AhpAppsProjection
}

// A logical agent owns state and sequence ordering; attachments only own authorization and references.
export class AhpAgentState {
  private readonly entries = new Map<string, Entry>()
  private readonly byUri = new Map<string, string>()
  private readonly references = new Map<string, number>()
  private readonly released = new Set<string>()
  private readonly listeners = new Set<(notification: AhpCatalogNotification) => void>()
  private pending: Promise<unknown> = Promise.resolve()
  private revision = 0
  private readonly epoch: number

  constructor(
    readonly provider: AgentInfo,
    readonly journal: AhpActionJournal,
    private readonly now: () => number,
    private readonly checkpoints?: AhpCheckpointStore,
    private readonly warn: (message: string) => void = () => {}
  ) {
    this.epoch = journal.currentSequence
  }

  serialized<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    this.pending = result.catch(() => {})
    return result
  }

  async add(
    binding: Binding,
    history: readonly MaskedChatEvent[] | ChatState = [],
    config?: SessionConfigState
  ): Promise<void> {
    const current = this.entries.get(binding.sessionId)
    if (current?.binding) {
      if (current.binding.sessionUri !== binding.sessionUri) throw new Error('AHP session identity collision')
      return
    }
    const previousId = this.byUri.get(binding.sessionUri)
    if (previousId && previousId !== binding.sessionId) throw new Error('AHP session identity collision')
    let initial = current?.projection.snapshot() ?? (await this.restore(binding.sessionId))
    if (!initial && !Array.isArray(history)) initial = history as ChatState
    const resource = chatUri(binding.sessionUri)
    const actions: ChatAction[] = current?.actions ?? []
    const projection =
      current?.projection ??
      new AhpChatProjection(
        binding.sessionId,
        resource,
        initial?.title ?? 'Conversation',
        this.now(),
        (action) => actions.push(action),
        initial ? { ...initial, resource } : undefined
      )
    if (current) projection.bindResource(resource)
    if (!initial && Array.isArray(history)) for (const event of history) projection.accept(event)
    actions.length = 0
    const chat = projection.snapshot()
    const presentation = current?.presentation ?? (await this.checkpoints?.presentation?.(binding.sessionId))
    const restored = current?.apps
      ? { presentation, apps: current.apps }
      : this.restoreApps(presentation, binding.sessionId)
    const entry: Entry = {
      presentation: restored.presentation,
      apps: current?.apps ?? restored.apps,
      projection,
      actions,
      binding: structuredClone(binding),
      createdAt: chat.turns[0]?.startedAt ?? chat.modifiedAt,
      session: {
        provider: this.provider.provider,
        title: chat.title,
        status: chat.status,
        lifecycle: SessionLifecycle.Ready,
        activeClients: [],
        chats: [summaryOf(chat)],
        defaultChat: resource,
        config,
        _meta: {
          ...restored.presentation,
          'agentconnect.md': {
            ...(restored.presentation?.['agentconnect.md'] as Record<string, unknown>),
            agentId: this.provider.provider,
            sessionId: binding.sessionId
          }
        }
      }
    }
    this.entries.set(binding.sessionId, entry)
    this.byUri.set(binding.sessionUri, binding.sessionId)
    await this.persist(binding.sessionId, entry)
  }

  binding(channel: string): Binding | undefined {
    return this.entry(channel)?.binding
  }
  sessionUri(sessionId: string): string | undefined {
    return this.entries.get(sessionId)?.binding?.sessionUri
  }
  snapshot(channel: string): Snapshot['state'] | undefined {
    const entry = this.entry(channel)
    if (!entry) return
    return channel === entry.binding?.sessionUri ? structuredClone(entry.session) : entry.projection.snapshot()
  }
  summary(uri: string): SessionSummary | undefined {
    const entry = this.entry(uri)
    if (!entry?.binding || !entry.session) return
    const chat = entry.projection.snapshot()
    return {
      resource: uri,
      provider: this.provider.provider,
      title: entry.session.title,
      status: chat.status,
      createdAt: entry.createdAt,
      modifiedAt: chat.modifiedAt,
      defaultChat: chat.resource,
      chats: [summaryOf(chat)]
    }
  }
  announce(uri: string): void {
    const summary = this.summary(uri)
    if (summary) this.notify({ method: 'root/sessionAdded', params: { channel: 'ahp-root://', summary } })
  }
  subscribeNotifications(listener: (notification: AhpCatalogNotification) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async accept(event: MaskedChatEvent, origin?: ActionOrigin): Promise<void> {
    let entry = this.entries.get(event.sessionId)
    if (!entry) {
      if (event.kind !== 'started') return
      const initial = await this.restore(event.sessionId)
      const actions: ChatAction[] = []
      const restored = this.restoreApps(await this.checkpoints?.presentation?.(event.sessionId), event.sessionId)
      const resource =
        initial?.resource ?? `ahp-chat:/unbound/${createHash('sha256').update(event.sessionId).digest('hex')}/main`
      entry = {
        presentation: restored.presentation,
        apps: restored.apps,
        actions,
        createdAt: new Date(event.at).toISOString(),
        projection: new AhpChatProjection(
          event.sessionId,
          resource,
          'Conversation',
          event.at,
          (action) => actions.push(action),
          initial
        )
      }
      this.entries.set(event.sessionId, entry)
    }
    entry.projection.accept(event)
    if (!entry.actions.length) return
    await this.persist(event.sessionId, entry)
    if (entry.binding) {
      await this.flush(
        entry,
        origin,
        entry.actions.find((action) => action.type === ActionType.ChatTurnStarted)
      )
      this.evict(entry.binding.sessionUri)
    } else {
      entry.actions.length = 0
      if (!entry.projection.snapshot().activeTurn) this.entries.delete(event.sessionId)
    }
  }

  async apply(channel: string, action: StateAction, origin?: ActionOrigin): Promise<void> {
    const entry = this.entry(channel)
    if (!entry?.binding || !entry.session) throw new Error('AHP channel is unavailable')
    if (channel === entry.binding.sessionUri) {
      if (!action.type.startsWith('session/')) throw new Error('Invalid AHP session action')
      entry.session = sessionReducer(entry.session, action as SessionAction)
      await this.persist(entry.binding.sessionId, entry)
      await this.journal.append({ channel, action, origin })
    } else {
      entry.projection.apply(action as ChatAction)
      await this.persist(entry.binding.sessionId, entry)
      await this.flush(entry, origin, action)
    }
    this.evict(entry.binding.sessionUri)
  }

  async fetchTurns(
    channel: string,
    cursor: string | undefined,
    page: (sessionId: string, cursor: string) => Promise<{ turns: Turn[]; nextCursor?: string }>
  ): Promise<ChatTurnsLoadedAction | undefined> {
    const entry = this.entry(channel)
    if (!entry?.binding || channel !== entry.projection.snapshot().resource)
      throw new Error('Unknown AHP history channel')
    const next = cursor ?? entry.projection.snapshot().turnsNextCursor
    if (!next) return
    const result = await page(entry.binding.sessionId, next)
    // The router materializes this page only for its requesting connection.
    return { type: ActionType.ChatTurnsLoaded, turns: result.turns, turnsNextCursor: result.nextCursor }
  }

  async output(sessionId: string, output: ChatOutput): Promise<void> {
    const entry = this.entries.get(sessionId)
    if (!entry) return
    let changed = false
    const previous = entry.session?._meta ?? entry.presentation ?? {}
    const fields = { ...((previous['agentconnect.md'] as Record<string, unknown>) ?? {}) }
    if (output.status) {
      fields.status = structuredClone(output.status)
      if (output.status.steerable !== undefined) fields.steerable = output.status.steerable
      changed = true
    }
    if (output.event) {
      entry.apps ??= new AhpAppsProjection()
      const update = entry.apps.update(output.turnId, output.event)
      if (update) {
        fields.apps = update.apps
        changed = true
      }
    }
    if (!changed) return
    const meta = { ...previous, 'agentconnect.md': { ...fields, agentId: this.provider.provider, sessionId } }
    entry.presentation = meta
    if (!entry.binding || !entry.session) {
      await this.persist(sessionId, entry)
      return
    }
    await this.apply(entry.binding.sessionUri, { type: ActionType.SessionMetaChanged, _meta: meta })
    if (entry.session.config && output.status) {
      const config = Object.fromEntries(
        Object.entries(output.status).filter(
          ([key, value]) => value !== undefined && Object.hasOwn(entry.session!.config!.schema.properties, key)
        )
      )
      if (Object.keys(config).length)
        await this.apply(entry.binding.sessionUri, { type: ActionType.SessionConfigChanged, config })
    }
  }

  private restoreApps(
    presentation: Record<string, unknown> | undefined,
    sessionId: string
  ): { presentation?: Record<string, unknown>; apps?: AhpAppsProjection } {
    const fields = presentation?.['agentconnect.md'] as Record<string, unknown> | undefined
    if (!Array.isArray(fields?.apps)) return { presentation }
    const entries = (fields.apps as AhpAppEntry[]).map((entry) => ({
      ...entry,
      ...(!entry.outcome &&
      (!this.checkpoints?.running(sessionId) || (entry.card.htmlBytes !== undefined && entry.html === undefined))
        ? { outcome: 'expired' as const }
        : {})
    }))
    const apps = new AhpAppsProjection(entries)
    return { apps, presentation: { ...presentation, 'agentconnect.md': { ...fields, apps: apps.snapshot() } } }
  }

  retain(uri: string): void {
    this.references.set(uri, (this.references.get(uri) ?? 0) + 1)
    this.released.delete(uri)
  }
  release(uri: string): void {
    const count = this.references.get(uri) ?? 0
    if (count > 1) {
      this.references.set(uri, count - 1)
      return
    }
    this.references.delete(uri)
    this.released.add(uri)
    this.evict(uri)
  }

  private entry(channel: string): Entry | undefined {
    const uri =
      channel.startsWith('ahp-chat:') && channel.endsWith('/main')
        ? `ahp-session:${channel.slice('ahp-chat:'.length, -'/main'.length)}`
        : channel
    const id = this.byUri.get(uri)
    const entry = id ? this.entries.get(id) : undefined
    return entry && (channel === entry.binding?.sessionUri || channel === entry.projection.snapshot().resource)
      ? entry
      : undefined
  }
  private async restore(sessionId: string): Promise<ChatState | undefined> {
    const saved = await this.checkpoints?.load(sessionId)
    if (!saved?.activeTurn || this.checkpoints?.running(sessionId)) return saved
    const projection = new AhpChatProjection(sessionId, saved.resource, saved.title, this.now(), () => {}, saved)
    projection.accept({
      sessionId,
      turnId: saved.activeTurn.id,
      generation: 0,
      at: this.now(),
      kind: 'finished',
      outcome: 'failed',
      error: 'Daemon restarted before this turn completed'
    })
    return projection.snapshot()
  }
  // Checkpoints are derived recovery data: a refused or failed save never blocks journaling and delivery.
  private async persist(sessionId: string, entry: Entry): Promise<void> {
    const archive = entry.projection.snapshot().turns
    if (this.checkpoints) entry.projection.retainCompleted(32 * 1024)
    for (const state of [entry.projection.snapshot(), entry.session].filter((state) => state !== undefined)) {
      if (
        !AhpMessageText.safeParse(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 'x'.repeat(256),
            result: {
              snapshot: {
                resource: 'resource' in state ? state.resource : entry.binding?.sessionUri,
                state,
                fromSeq: Number.MAX_SAFE_INTEGER
              }
            }
          })
        ).success
      )
        throw new AhpStateCapacityError()
    }
    if (!this.checkpoints) return
    try {
      await this.checkpoints.save(
        sessionId,
        entry.projection.snapshot(),
        this.epoch,
        ++this.revision,
        archive,
        entry.session?._meta ?? entry.presentation
      )
    } catch (error) {
      this.warn(`ahp: checkpoint for session ${sessionId} not saved: ${(error as Error).message}`)
    }
  }
  private async flush(entry: Entry, origin?: ActionOrigin, echoed?: StateAction): Promise<void> {
    const chat = entry.projection.snapshot()
    for (const action of entry.actions.splice(0))
      await this.journal.append({ channel: chat.resource, action, ...(action === echoed ? { origin } : {}) })
    if (!entry.binding || !entry.session) return
    const { resource: _resource, ...changes } = summaryOf(chat)
    const action = { type: ActionType.SessionChatUpdated, chat: chat.resource, changes } as const
    entry.session = sessionReducer(entry.session, action)
    await this.journal.append({ channel: entry.binding.sessionUri, action })
    this.notify({
      method: 'root/sessionSummaryChanged',
      params: {
        channel: 'ahp-root://',
        session: entry.binding.sessionUri,
        changes: { status: chat.status, modifiedAt: chat.modifiedAt, chats: [summaryOf(chat)] }
      }
    })
  }
  private evict(uri: string): void {
    if (!this.released.has(uri)) return
    const id = this.byUri.get(uri)
    if (!id) {
      this.released.delete(uri)
      return
    }
    const entry = this.entries.get(id)
    if (entry?.projection.snapshot().activeTurn) return
    this.entries.delete(id)
    this.byUri.delete(uri)
    this.released.delete(uri)
  }
  private notify(notification: AhpCatalogNotification): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(structuredClone(notification))
      } catch {
        this.listeners.delete(listener)
      }
    }
  }
}

function chatUri(uri: string): string {
  return `ahp-chat:${uri.slice('ahp-session:'.length)}/main`
}
function summaryOf(chat: ChatState): ChatSummary {
  return { resource: chat.resource, title: chat.title, status: chat.status, modifiedAt: chat.modifiedAt }
}
