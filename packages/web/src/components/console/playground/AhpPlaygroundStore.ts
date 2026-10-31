import type { ActionType } from '@microsoft/agent-host-protocol'
import {
  agentLabel,
  isGitWorkspace,
  type Agent,
  type Session,
  type SessionImage,
  type SessionStep,
  type SessionUsage
} from '@/lib/data'
import { addWebchatConversationAgent, removeWebchatConversationAgent, type SessionMessageDto } from '@/lib/api'
import { randomUuid } from '@/lib/random-uuid'
import { reconcilePersistedLiveSteps } from '@/lib/session-transcript'
import { ahpAnswer, ahpSteps, ahpUsageFields } from '@/lib/ahp/view'
import type { ComposerFile } from '@/lib/webchat-file'
import type { PlaygroundData, QueuedTurn, WebchatRuntimeConfig } from './contract'
import { AhpConversation } from './AhpConversation'

type Entry = {
  connection: AhpConversation
  session?: Session
  steps: SessionStep[]
  persisted?: { rows: SessionMessageDto[]; agentId: string; prompts?: SessionMessageDto[] }
  // Turns an adopted session's first attach replayed per peer; its fetched transcript already renders them.
  replayed?: Map<string, Set<string>>
}
const rowKey = (row: SessionMessageDto) => JSON.stringify([row.sender, row.seq, row.ts, row.kind])
function unionRows(prior: SessionMessageDto[] | undefined, rows: SessionMessageDto[]): SessionMessageDto[] {
  if (!prior?.length) return rows
  const keys = new Set(prior.map(rowKey))
  const added = rows.filter((row) => !keys.has(rowKey(row)))
  return added.length ? [...prior, ...added] : prior
}
const NO_STEPS: SessionStep[] = [],
  NO_FILES: ComposerFile[] = [],
  NO_QUEUE: QueuedTurn[] = []
export class AhpPlaygroundStore {
  private readonly entries = new Map<string, Entry>()
  private readonly drafts = new Map<string, string>()
  private readonly images = new Map<string, SessionImage>()
  private readonly files = new Map<string, ComposerFile[]>()
  private readonly listeners = new Set<() => void>()
  private readonly draftListeners = new Set<() => void>()
  private version = 0
  constructor(
    private readonly orgId: string,
    private readonly refresh: () => void
  ) {}
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  snapshot = (): number => this.version
  private changed = (): void => {
    this.version++
    for (const listener of this.listeners) listener()
  }
  owns = (id: string): boolean =>
    this.entries.has(id) || [...this.entries.values()].some((entry) => entry.session?.realSessionId === id)
  private entry(id: string, agentId: string, conversationId?: string): Entry {
    let entry = this.entries.get(id) ?? [...this.entries.values()].find((entry) => entry.session?.realSessionId === id)
    if (!entry) {
      const connection = new AhpConversation(
        this.orgId,
        agentId,
        [{ agentId, name: agentId }],
        () => {
          if (this.entries.get(id) === entry) this.project(id, entry!)
        },
        (turn) => this.restoreDraft(id, turn),
        this.refresh
      )
      entry = { connection, steps: [] }
      this.entries.set(id, entry)
    }
    const connection = entry.connection
    if (agentId) {
      if (!connection.agentId && connection.roster.length === 1) connection.roster = [{ agentId, name: agentId }]
      connection.agentId = agentId
    }
    if (conversationId) connection.conversationId = conversationId
    return entry
  }
  private project(id: string, entry: Entry): void {
    const prompts = new Set<string>(),
      connection = entry.connection
    let steps = [...connection.peers]
      .flatMap(([agentId, peer]) => {
        const chat = peer.snapshot.chat
        if (!chat) return []
        const replayed = entry.session ? undefined : (entry.replayed ??= new Map())
        if (replayed && !replayed.has(agentId)) replayed.set(agentId, new Set(chat.turns.map((turn) => turn.id)))
        const seen = replayed?.get(agentId)
        return ahpSteps(
          seen ? { ...chat, turns: chat.turns.filter((turn) => !seen.has(turn.id)) } : chat,
          agentId,
          peer.snapshot.session
        )
          .map((step) => ({
            ...step,
            ...(step.kind !== 'msg'
              ? { who: connection.roster.find((p) => p.agentId === agentId)?.name }
              : connection.sent.has(step.turnId)
                ? { who: '@you' }
                : {})
          }))
          .filter((step) => {
            if (step.kind !== 'msg') return true
            if (prompts.has(step.turnId)) return false
            prompts.add(step.turnId)
            return true
          })
      })
      .sort((a, b) => (a.observedAtMs ?? 0) - (b.observedAtMs ?? 0))
    if (entry.persisted)
      steps = reconcilePersistedLiveSteps(steps, entry.persisted.rows, entry.persisted.agentId, entry.persisted.prompts)
    entry.steps = [...steps, ...connection.notices]
    if (entry.session) {
      const primary = connection.peers.get(connection.agentId)?.snapshot
      const meta = primary?.session?._meta?.['agentconnect.md'] as
        | {
            sessionId?: string
            steerable?: boolean
            status?: SessionUsage
          }
        | undefined
      const config = primary?.session?.config,
        values = config?.values ?? {}
      const choices = (key: string) =>
        config?.schema.properties[key]?.enum?.filter((value): value is string => typeof value === 'string')
      entry.session = {
        ...entry.session,
        steps: entry.steps,
        title: primary?.session?.title || entry.session.title,
        lastActivityAt: primary?.chat?.modifiedAt ?? entry.session.lastActivityAt,
        channelId: connection.conversationId,
        realSessionId: meta?.sessionId ?? entry.session.realSessionId,
        participants: connection.roster.length > 1 ? connection.roster : undefined,
        availableModels: choices('model'),
        availableEfforts: choices('effort'),
        availablePermissionModes: choices('permissionMode'),
        fastModeAvailable: !!config?.schema.properties.fastMode,
        steerable: meta?.steerable,
        ...ahpUsageFields(meta?.status, entry.session.usage),
        ...(typeof values.model === 'string' ? { model: values.model } : {}),
        ...(typeof values.runtime === 'string' ? { runtime: values.runtime, runtimePending: false } : {}),
        ...(typeof values.effort === 'string' ? { effort: values.effort } : {}),
        ...(typeof values.permissionMode === 'string' ? { permissionMode: values.permissionMode } : {}),
        ...(typeof values.fastMode === 'boolean' ? { fastMode: values.fastMode } : {})
      }
    }
    this.changed()
  }
  private restoreDraft(id: string, turn: QueuedTurn): void {
    this.drafts.set(id, [turn.text, this.drafts.get(id)].filter(Boolean).join('\n\n'))
    if (turn.image && !this.images.has(id)) this.images.set(id, turn.image)
    if (turn.files?.length)
      this.files.set(id, [
        ...(this.files.get(id) ?? []),
        ...turn.files.map((attachment) => ({
          key: attachment.uploadId,
          name: attachment.name,
          size: attachment.size,
          status: 'ready' as const,
          attachment
        }))
      ])
    for (const listener of this.draftListeners) listener()
  }
  private enqueue(
    id: string,
    agentId: string,
    text: string,
    conversationId?: string,
    participants?: QueuedTurn['participants'],
    image?: SessionImage,
    commandPick?: QueuedTurn['commandPick'],
    files?: QueuedTurn['files']
  ): boolean {
    const entry = this.entry(id, agentId, conversationId)
    if (participants?.length) entry.connection.roster = participants
    return entry.connection.enqueue({
      queueId: randomUuid(),
      agentId,
      text,
      conversationId,
      participants,
      image,
      commandPick,
      files
    })
  }
  private updateConfig(id: string, agentId: string, config: WebchatRuntimeConfig, conversationId?: string): void {
    const connection = this.entry(id, agentId, conversationId).connection
    void connection
      .connect()
      .then(async () => {
        const schema = connection.peers.get(agentId)?.snapshot.session?.config?.schema
        if (!schema || Object.keys(config).some((key) => !schema.properties[key]))
          throw new Error('This conversation does not support changing these settings.')
        await connection.dispatch(
          agentId,
          { type: 'session/configChanged' as ActionType.SessionConfigChanged, config },
          'session'
        )
      })
      .catch((error) => connection.warn(error))
  }
  private async rosterChange(id: string, change: (connection: AhpConversation) => Promise<void>): Promise<boolean> {
    const entry = this.entries.get(id)
    if (!entry || entry.connection.busy || entry.connection.queue.length) return false
    const connection = entry.connection
    try {
      await connection.connect()
      await change(connection)
      await connection.resetPeers()
      return true
    } catch (error) {
      connection.warn(error)
      return false
    }
  }
  getValue(): PlaygroundData {
    return {
      getPgInput: (id) => this.drafts.get(id) ?? '',
      setPgInput: (id, value) => {
        this.drafts.set(id, value)
        for (const listener of this.draftListeners) listener()
      },
      subscribePgDraft: (listener) => {
        this.draftListeners.add(listener)
        return () => this.draftListeners.delete(listener)
      },
      getPgImage: (id) => this.images.get(id),
      setPgImage: (id, image) => {
        if (image) this.images.set(id, image)
        else this.images.delete(id)
        this.changed()
      },
      getPgFiles: (id) => this.files.get(id) ?? NO_FILES,
      setPgFiles: (id, update) => {
        this.files.set(id, update(this.files.get(id) ?? []))
        this.changed()
      },
      getPgWorktree: (id) => this.entries.get(id)?.connection.worktree,
      pgSetWorktree: (id, value) => {
        const entry = this.entries.get(id)
        if (entry) entry.connection.worktree = value
        this.changed()
      },
      isPgBusy: (id) => this.entries.get(id)?.connection.busy ?? false,
      openPlayground: (agent, members, options) => this.open(agent, members, options),
      pgSend: (id, agentId, text, conversationId, participants, image, commandPick, files) => {
        const staged = this.files.get(id) ?? []
        if (staged.some((file) => file.status !== 'ready' || !file.attachment)) {
          this.entry(id, agentId).connection.warn(
            new Error('Wait for file uploads to finish. Your draft has been kept.')
          )
          return false
        }
        const accepted = this.enqueue(
          id,
          agentId,
          text ?? this.drafts.get(id) ?? '',
          conversationId,
          participants,
          image ?? this.images.get(id),
          commandPick,
          files ?? staged.flatMap((file) => (file.attachment ? [file.attachment] : []))
        )
        if (accepted) {
          this.drafts.delete(id)
          this.images.delete(id)
          this.files.delete(id)
          for (const listener of this.draftListeners) listener()
        }
        return accepted
      },
      pgNotice: (id, agentId, text, conversationId, participants) =>
        this.enqueue(id, agentId, text, conversationId, participants),
      pgAttach: (id, agentId, conversationId) => {
        const connection = this.entry(id, agentId, conversationId).connection
        void connection.connect().catch((error) => connection.warn(error))
      },
      markSessionTarget: (id, target = id) => {
        const entry = this.entry(id, ''),
          old = entry.connection
        old.targetRefused = false
        if (old.targetSessionId === target) return
        if (old.targetSessionId !== undefined && (old.busy || old.queue.length)) {
          old.targetRefused = true
          old.warn(new Error('Wait for the current conversation to finish before changing the recipient.'))
          return
        }
        if (old.targetSessionId !== undefined) {
          this.entries.delete(id)
          void old.close()
          this.entry(id, old.agentId).connection.targetSessionId = target
        } else old.targetSessionId = target
      },
      pgAddAgent: (id, agent) =>
        this.rosterChange(id, async (connection) => {
          await addWebchatConversationAgent(this.orgId, connection.conversationId!, agent.id)
          connection.roster.push({ agentId: agent.id, name: agentLabel(agent) })
        }),
      pgRemoveAgent: (id, agentId) =>
        this.rosterChange(id, async (connection) => {
          await removeWebchatConversationAgent(this.orgId, connection.conversationId!, agentId)
          connection.roster = connection.roster.filter((p) => p.agentId !== agentId)
        }),
      getPgQueue: (id) => this.entries.get(id)?.connection.queue ?? NO_QUEUE,
      pgCancelQueued: (id, queueId) => {
        const entry = this.entries.get(id)
        if (entry) entry.connection.queue = entry.connection.queue.filter((turn) => turn.queueId !== queueId)
        this.changed()
      },
      pgStageRuntime: (id, runtime) => {
        const entry = this.entries.get(id)
        if (entry) {
          entry.connection.runtime = runtime
          if (entry.session) entry.session = { ...entry.session, ...runtime }
        }
        this.changed()
      },
      pgSetModel: (id, agentId, model, conversationId) => this.updateConfig(id, agentId, { model }, conversationId),
      pgSetEffort: (id, agentId, effort, conversationId) => this.updateConfig(id, agentId, { effort }, conversationId),
      pgSetPermissionPreset: (id, agentId, permissionMode, conversationId) =>
        this.updateConfig(id, agentId, { permissionMode }, conversationId),
      pgSetFast: (id, agentId, fastMode, conversationId) =>
        this.updateConfig(id, agentId, { fastMode }, conversationId),
      pgCancel: (id) => {
        const connection = this.entries.get(id)?.connection
        for (const [agentId, peer] of connection?.peers ?? []) {
          const turn = peer.snapshot.chat?.activeTurn
          if (turn)
            void connection!
              .dispatch(agentId, {
                type: 'chat/turnCancelled' as ActionType.ChatTurnCancelled,
                turnId: turn.id,
                duration: 0
              })
              .catch((error) => connection!.warn(error))
        }
      },
      pgAnswerElicitation: (id, agentId, requestId, value) => {
        const connection = this.entries.get(id)?.connection,
          peer = connection?.peers.get(agentId)
        if (!connection || !peer?.snapshot.chat) return
        try {
          void connection
            .dispatch(agentId, ahpAnswer(peer.snapshot.chat, requestId, value))
            .catch((error) => connection.warn(error))
        } catch (error) {
          connection.warn(error)
        }
      },
      pgAppRpc: async (id, agentId, appId, rpc) => {
        const peer = this.entries.get(id)?.connection.peers.get(agentId)
        if (!peer) return { ok: false, error: 'Reconnect to use this app.' }
        try {
          return await peer.appRpc(appId, randomUuid(), rpc)
        } catch (error) {
          return {
            ok: false,
            error: error instanceof Error ? error.message : 'The app request could not be completed.'
          }
        }
      },
      pgCloseApp: (id, agentId, appId) => {
        const connection = this.entries.get(id)?.connection
        const peer = connection?.peers.get(agentId)
        if (peer) void peer.closeApp(appId).catch((error) => connection!.warn(error))
      },
      getPgSession: (id) =>
        this.entries.get(id)?.session ??
        [...this.entries.values()].find((entry) => entry.session?.realSessionId === id)?.session,
      pgSessionList: [...this.entries.values()].flatMap((entry) => (entry.session ? [entry.session] : [])),
      getLiveSteps: (id) => this.entries.get(id)?.steps ?? NO_STEPS,
      getBusyLaneAgentIds: (id) =>
        [...(this.entries.get(id)?.connection.peers ?? [])].flatMap(([agentId, peer]) =>
          peer.snapshot.chat?.activeTurn ? [agentId] : []
        ),
      reconcileLiveSteps: (id, rows, agentId, prompts) => {
        const entry = this.entries.get(id)
        if (entry) {
          // A tail refresh passes only rows since its cursor, and the tail is re-derived from the snapshot, so rows accumulate.
          const prior = entry.persisted
          entry.persisted = {
            rows: unionRows(prior?.rows, rows),
            agentId,
            prompts: unionRows(prior ? (prior.prompts ?? prior.rows) : undefined, prompts ?? rows)
          }
          this.project(id, entry)
        }
      }
    }
  }
  private open(agent: Agent, members?: Agent[], options?: { worktree?: boolean }): string {
    const id = `pg_${agent.id}_${randomUuid()}`,
      entry = this.entry(id, agent.id),
      connection = entry.connection
    connection.roster = [agent, ...(members ?? []).filter((member) => member.id !== agent.id)].map((member, i) => ({
      agentId: member.id,
      name: agentLabel(member),
      ...(i === 0 ? { primary: true } : {})
    }))
    if (agent.workspace && isGitWorkspace(agent.workspace))
      connection.worktree = options?.worktree ?? agent.workspace.worktree === true
    entry.session = {
      id,
      title: 'Playground · ' + connection.roster.map((p) => p.name).join(', '),
      status: 'online',
      platform: 'playground',
      channel: 'Playground',
      user: '@you',
      agentId: agent.id,
      agentName: agentLabel(agent),
      model: agent.model,
      runtime: agent.runtime,
      runtimePending: !!agent.modelSelection,
      permissionMode: agent.permissionMode,
      duration: 'live',
      tokens: '0',
      cost: '—',
      toolCount: '0',
      statusLabel: 'Live',
      time: '',
      steps: []
    }
    this.project(id, entry)
    void connection.connect().catch((error) => connection.warn(error))
    return id
  }
  async close(): Promise<void> {
    await Promise.all([...this.entries.values()].map((entry) => entry.connection.close()))
  }
}
