import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AhpView } from '@/lib/ahp/attachment'
import type { ChatState, SessionState, StateAction } from '@microsoft/agent-host-protocol'
import { AhpMessageTooLargeError, ahpRemainingActionBytes } from '@/lib/ahp/message-size'
const { mint, attachments, prepare } = vi.hoisted(() => ({
  mint: vi.fn(),
  attachments: [] as FakeAttachment[],
  prepare: vi.fn()
}))
vi.mock('@/lib/api', () => ({
  mintWebchatToken: mint,
  mintWebchatConversationToken: mint,
  mintWebchatSessionToken: mint
}))
vi.mock('@/lib/webchat-image', () => ({ prepareWebchatImage: prepare }))
class FakeAttachment {
  snapshot: AhpView = { connected: false, uncertain: false, extensions: { 'agentconnect.md': { webchat: true } } }
  actions: StateAction[] = []
  listener?: (view: AhpView) => void
  constructor() {
    attachments.push(this)
  }
  subscribe(listener: (view: AhpView) => void) {
    this.listener = listener
  }
  emit(view: Partial<AhpView>) {
    this.snapshot = { ...this.snapshot, ...view }
    this.listener?.(this.snapshot)
  }
  async attach() {
    this.emit({ connected: true })
  }
  async close() {
    this.emit({ connected: false })
  }
  remainingActionBytes(action: StateAction) {
    return ahpRemainingActionBytes('ahp-chat:/test', this.actions.length + 1, action)
  }
  async dispatch(action: StateAction) {
    if (this.remainingActionBytes(action) < 0) throw new AhpMessageTooLargeError()
    this.actions.push(action)
  }
}
class Refused extends Error {}
vi.mock('@/lib/ahp/attachment', () => ({
  AhpAttachment: FakeAttachment,
  AhpRejectedActionError: Refused,
  ahpBrowserTransport: vi.fn()
}))
const { AhpConversation } = await import('./AhpConversation')
beforeEach(() => {
  attachments.length = 0
  mint.mockReset().mockResolvedValue({
    token: 'token',
    protocol: 'ahp',
    conversationId: 'conversation',
    ahp: {
      url: 'wss://relay.test/ahp/agents/a',
      peers: [
        { agentId: 'a', url: 'wss://relay.test/ahp/agents/a' },
        { agentId: 'b', url: 'wss://relay.test/ahp/agents/b' }
      ]
    }
  })
  prepare.mockReset().mockResolvedValue({ name: 'small.webp', mimeType: 'image/webp', data: 'YQ==' })
})
const turn = (text: string) => ({ queueId: text, agentId: 'a', text })
const open = (refused = vi.fn()) =>
  new AhpConversation('org', 'a', [{ agentId: 'a', name: 'Alpha' }], vi.fn(), refused, vi.fn())
describe('AHP conversation engine', () => {
  it('fans one turn identity to the roster and narrows explicit mentions', async () => {
    const entry = open()
    entry.roster.push({ agentId: 'b', name: 'Beta' })
    await entry.connect()
    entry.enqueue(turn('Hello'))
    await vi.waitFor(() => expect(attachments[1]!.actions).toHaveLength(1))
    expect(attachments[0]!.actions[0]).toEqual(attachments[1]!.actions[0])
    entry.enqueue(turn('@Beta please reply'))
    await vi.waitFor(() => expect(attachments[1]!.actions).toHaveLength(2))
    expect(attachments[0]!.actions).toHaveLength(1)
  })
  it('uses negotiated steering but queues a continuation', async () => {
    const entry = open()
    await entry.connect()
    attachments[0]!.emit({
      extensions: { 'agentconnect.md': { webchat: true, steering: true } },
      session: { _meta: { 'agentconnect.md': { steerable: true } } } as unknown as SessionState,
      chat: {
        turns: [],
        activeTurn: { id: 'running', message: { text: 'First' }, responseParts: [] }
      } as unknown as ChatState
    })
    entry.enqueue(turn('Steer'))
    await vi.waitFor(() => expect(attachments[0]!.actions).toHaveLength(1))
    expect(attachments[0]!.actions[0]?.type).toBe('chat/pendingMessageSet')
    entry.targetSessionId = 'existing'
    entry.enqueue(turn('Continue'))
    expect(entry.queue).toHaveLength(1)
  })
  it('requeues only explicit busy steering refusal and never retries unknown delivery', async () => {
    const entry = open()
    await entry.connect()
    const peer = attachments[0]!
    peer.emit({
      extensions: { 'agentconnect.md': { webchat: true, steering: true } },
      session: { _meta: { 'agentconnect.md': { steerable: true } } } as unknown as SessionState,
      chat: { turns: [], activeTurn: { id: 'running' } } as unknown as ChatState
    })
    vi.spyOn(peer, 'dispatch').mockRejectedValueOnce(new Refused('Turn refused: busy'))
    entry.enqueue(turn('Retry'))
    await vi.waitFor(() => expect(entry.queue).toHaveLength(1))
    entry.queue = []
    vi.mocked(peer.dispatch).mockRejectedValueOnce(new Error('Delivery could not be confirmed'))
    entry.enqueue(turn('Unknown'))
    await vi.waitFor(() => expect(entry.pending).toBe(false))
    expect(entry.queue).toEqual([])
  })
  it('recompresses an image using the actual text-adjusted frame budget', async () => {
    const entry = open()
    await entry.connect()
    entry.enqueue({
      ...turn('图片'.repeat(5000)),
      image: { name: 'large.png', mimeType: 'image/png', data: 'YWFh'.repeat(25000) }
    })
    await vi.waitFor(() => expect(attachments[0]!.actions).toHaveLength(1))
    expect(prepare.mock.calls[0]![1]).toBeLessThan(27000)
    expect(attachments[0]!.actions[0]).toMatchObject({ message: { attachments: [{ data: 'YQ==' }] } })
  })
  it('retains a locally oversized turn before any recipient receives it', async () => {
    const refused = vi.fn(),
      entry = open(refused)
    entry.roster.push({ agentId: 'b', name: 'Beta' })
    await entry.connect()
    vi.spyOn(attachments[1]!, 'remainingActionBytes').mockReturnValue(-1)
    entry.enqueue(turn('Draft'))
    await vi.waitFor(() => expect(refused).toHaveBeenCalledWith(turn('Draft')))
    expect(attachments.flatMap((peer) => peer.actions)).toEqual([])
  })
})
