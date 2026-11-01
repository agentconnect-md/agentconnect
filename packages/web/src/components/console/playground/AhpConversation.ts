import {
  MessageKind,
  type ActionType,
  type Message,
  type MessageAttachmentKind,
  type PendingMessageKind,
  type StateAction
} from '@microsoft/agent-host-protocol'
import {
  mintWebchatToken,
  mintWebchatConversationToken,
  mintWebchatSessionToken,
  type WebchatTokenDto
} from '@/lib/api'
import { AhpAttachment, AhpRejectedActionError, ahpBrowserTransport } from '@/lib/ahp/attachment'
import { AhpMessageTooLargeError, ahpImageBudget } from '@/lib/ahp/message-size'
import { fitAhpImage } from '@/lib/ahp/image'
import { typedMentionIds } from '@/lib/conversation-addressing'
import { leadingCommandToken } from '@/components/console/runtime-command-menu'
import { randomUuid } from '@/lib/random-uuid'
import type { SessionStep } from '@/lib/data'
import type { QueuedTurn, WebchatRuntimeConfig } from './contract'

export type AhpRoster = Array<{ agentId: string; name: string; primary?: boolean }>
export class AhpConversation {
  readonly peers = new Map<string, AhpAttachment>()
  readonly notices: SessionStep[] = []
  // Turn ids this tab sent, so their prompts render as the viewer's own.
  readonly sent = new Set<string>()
  queue: QueuedTurn[] = []
  pending = false
  conversationId?: string
  targetSessionId?: string
  targetRefused = false
  runtime?: WebchatRuntimeConfig
  worktree?: boolean
  private connecting?: Promise<void>
  private closed = false
  private attached = false
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private reconnectAttempts = 0
  private readonly connectionNotices = new Set<string>()
  constructor(
    readonly orgId: string,
    public agentId: string,
    public roster: AhpRoster,
    private readonly onChange: () => void,
    private readonly onRefused: (turn: QueuedTurn) => void,
    private readonly refresh: () => void
  ) {}
  get busy(): boolean {
    return (
      this.pending ||
      [...this.peers.values()].some((peer) => !!peer.snapshot.chat?.activeTurn || peer.snapshot.uncertain)
    )
  }
  warn(error: unknown, connection = false): void {
    if (this.closed) return
    const text = error instanceof Error ? error.message : 'The conversation could not be updated.'
    if (this.notices.at(-1)?.text !== text) {
      const turnId = `local:${randomUuid()}`
      this.notices.push({ kind: 'notice', turnId, text, standing: true })
      if (connection) this.connectionNotices.add(turnId)
    }
    this.onChange()
  }
  private changed(): void {
    if (!this.closed) {
      this.onChange()
      this.flush()
    }
  }
  private mint(): Promise<WebchatTokenDto> {
    return this.targetSessionId
      ? mintWebchatSessionToken(this.orgId, this.targetSessionId, 'ahp')
      : this.conversationId
        ? mintWebchatConversationToken(this.orgId, { conversationId: this.conversationId }, 'ahp')
        : this.roster.length > 1
          ? mintWebchatConversationToken(this.orgId, { agentIds: this.roster.map((p) => p.agentId) }, 'ahp')
          : mintWebchatToken(this.orgId, this.agentId, undefined, 'ahp')
  }
  async connect(): Promise<void> {
    if (this.closed) return
    if (this.connecting) return this.connecting
    if (this.peers.size && [...this.peers.values()].every((peer) => peer.snapshot.connected)) return
    this.connecting = (async () => {
      const minted = await this.mint()
      if (this.closed) return
      if (minted.protocol !== 'ahp' || !minted.ahp)
        throw new Error(
          'This conversation connection is currently unavailable. Reload to use the current configuration.'
        )
      this.conversationId = minted.conversationId
      const targets = minted.ahp.peers ?? [{ agentId: this.agentId, ...minted.ahp }]
      await Promise.all(
        targets.map(async (target) => {
          let peer = this.peers.get(target.agentId)
          if (!peer) {
            let initial: WebchatTokenDto | undefined = minted
            peer = new AhpAttachment(async () => {
              const grant = initial ?? (await this.mint())
              initial = undefined
              const current =
                grant.ahp?.peers?.find((p) => p.agentId === target.agentId) ??
                (target.agentId === this.agentId ? grant.ahp : undefined)
              if (grant.protocol !== 'ahp' || !current) throw new Error('This participant is no longer available.')
              return ahpBrowserTransport(current.url, grant.token)
            })
            this.peers.set(target.agentId, peer)
            peer.subscribe((view) => {
              if (this.closed) return
              if (view.error) this.warn(new Error(view.error), true)
              this.changed()
              if (!view.connected && this.attached && !this.connecting) this.reconnect()
            })
          }
          await peer.attach(target.sessionUri)
        })
      )
      if (this.closed) return
      this.attached = true
      this.reconnectAttempts = 0
      // A successful reconnect retires the interruption notices it answers.
      for (let index = this.notices.length - 1; index >= 0; index--)
        if (this.connectionNotices.delete(this.notices[index]!.turnId)) this.notices.splice(index, 1)
      this.changed()
    })().finally(() => {
      this.connecting = undefined
    })
    return this.connecting
  }
  private reconnect(): void {
    if (this.closed || this.reconnectTimer || this.reconnectAttempts >= 6) return
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined
        void this.connect().catch((error) => {
          this.warn(error, true)
          this.reconnect()
        })
      },
      Math.min(4000, 500 * 2 ** this.reconnectAttempts++)
    )
  }
  enqueue(turn: QueuedTurn): boolean {
    if (this.closed || this.targetRefused || (!turn.text.trim() && !turn.image && !turn.files?.length)) return false
    if (this.busy || this.queue.length) {
      const peer = this.peers.get(this.agentId)
      const profile = peer?.snapshot.extensions?.['agentconnect.md'] as { steering?: boolean } | undefined
      const live = peer?.snapshot.session?._meta?.['agentconnect.md'] as { steerable?: boolean } | undefined
      if (
        !this.pending &&
        !this.targetSessionId &&
        !this.queue.length &&
        this.roster.length === 1 &&
        !turn.image &&
        !turn.files?.length &&
        !turn.commandPick &&
        peer?.snapshot.connected &&
        !peer.snapshot.uncertain &&
        peer.snapshot.chat?.activeTurn &&
        profile?.steering === true &&
        live?.steerable === true
      )
        void this.steer(peer, turn)
      else {
        this.queue.push(turn)
        this.changed()
      }
    } else void this.send(turn)
    return true
  }
  private flush(): void {
    if (
      this.closed ||
      this.busy ||
      !this.queue.length ||
      !this.peers.size ||
      ![...this.peers.values()].every((peer) => peer.snapshot.connected)
    )
      return
    void this.send(this.queue.shift()!)
  }
  private async send(turn: QueuedTurn): Promise<void> {
    this.pending = true
    this.changed()
    let dispatched = false
    try {
      await this.connect()
      if (this.closed) return
      const typed = typedMentionIds(this.roster, turn.text)
      const command =
        turn.commandPick &&
        leadingCommandToken(turn.text) === turn.commandPick.name &&
        this.roster.some((p) => p.agentId === turn.commandPick!.agentId)
          ? turn.commandPick.agentId
          : undefined
      const targets = command ? [command] : typed.length ? typed : this.roster.map((p) => p.agentId)
      const message: Message = {
        text: turn.text,
        origin: { kind: MessageKind.User },
        ...(turn.image
          ? {
              attachments: [
                {
                  type: 'embeddedResource' as MessageAttachmentKind.EmbeddedResource,
                  data: turn.image.data,
                  contentType: turn.image.mimeType,
                  label: turn.image.name
                }
              ]
            }
          : {})
      }
      const action = {
        type: 'chat/turnStarted' as ActionType.ChatTurnStarted,
        turnId: turn.queueId,
        startedAt: new Date().toISOString(),
        message
      }
      const contextual = {
        ...action,
        message: {
          ...message,
          _meta: {
            'agentconnect.md': {
              mentions: targets,
              timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
              worktree: this.worktree,
              runtimeConfig: this.runtime,
              files: turn.files
            }
          }
        }
      }
      const deliveries = targets.map((agentId) => {
        const peer = this.peers.get(agentId)
        if (!peer) throw new Error('A participant is not connected. Reconnect before sending again.')
        const extension = peer.snapshot.extensions?.['agentconnect.md'] as
          { webchat?: boolean; files?: boolean } | undefined
        if (
          extension?.webchat !== true &&
          (this.worktree !== undefined || Object.keys(this.runtime ?? {}).length || this.roster.length > 1)
        )
          throw new Error('This conversation does not support the selected participants or settings yet.')
        if (turn.files?.length && extension?.files !== true)
          throw new Error('File attachments are not available in this conversation yet.')
        return { peer, action: extension?.webchat === true ? contextual : action }
      })
      if (turn.image && message.attachments?.[0]?.type === 'embeddedResource') {
        const attachment = message.attachments[0]
        attachment.data = ''
        const remaining = Math.min(...deliveries.map(({ peer, action }) => peer.remainingActionBytes(action)))
        const image = await fitAhpImage(turn.image, ahpImageBudget(remaining))
        attachment.data = image.data
        attachment.label = image.name
        attachment.contentType = image.mimeType
      }
      if (this.closed) return
      for (const { peer, action } of deliveries)
        if (peer.remainingActionBytes(action) < 0) throw new AhpMessageTooLargeError()
      dispatched = true
      this.sent.add(turn.queueId)
      await Promise.all(deliveries.map(({ peer, action }) => peer.dispatch(action)))
    } catch (error) {
      if (this.closed) return
      if (!dispatched) {
        this.onRefused(turn)
        this.warn(
          new Error(
            `${error instanceof Error ? error.message : 'This message could not be prepared.'} Your draft has been kept.`
          )
        )
      } else this.warn(error)
    } finally {
      this.pending = false
      this.changed()
      this.refresh()
    }
  }
  private async steer(peer: AhpAttachment, turn: QueuedTurn): Promise<void> {
    this.pending = true
    this.changed()
    try {
      this.sent.add(turn.queueId)
      await peer.dispatch({
        type: 'chat/pendingMessageSet' as ActionType.ChatPendingMessageSet,
        kind: 'steering' as PendingMessageKind.Steering,
        id: turn.queueId,
        message: {
          text: turn.text,
          origin: { kind: MessageKind.User },
          _meta: { 'agentconnect.md': { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } }
        }
      })
    } catch (error) {
      if (this.closed) return
      if (error instanceof AhpRejectedActionError && error.message === 'Turn refused: busy') this.queue.unshift(turn)
      else if (error instanceof AhpMessageTooLargeError) {
        this.onRefused(turn)
        this.warn(new Error(`${error.message} Your draft has been kept.`))
      } else this.warn(error)
    } finally {
      this.pending = false
      this.changed()
    }
  }
  async dispatch(agentId: string, action: StateAction, target: 'chat' | 'session' = 'chat'): Promise<void> {
    await this.connect()
    if (this.closed) return
    const peer = this.peers.get(agentId)
    if (!peer) throw new Error('Reconnect before updating this conversation.')
    await peer.dispatch(action, target)
  }
  async resetPeers(): Promise<void> {
    this.attached = false
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    await Promise.all([...this.peers.values()].map((peer) => peer.close()))
    this.peers.clear()
    await this.connect()
  }
  async close(): Promise<void> {
    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    await Promise.all([...this.peers.values()].map((peer) => peer.close()))
  }
}
