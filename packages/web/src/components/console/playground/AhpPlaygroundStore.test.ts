import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@/lib/data'
import type { AhpView } from '@/lib/ahp/attachment'
import type { ChatState, StateAction } from '@microsoft/agent-host-protocol'
const { mint } = vi.hoisted(() => ({ mint: vi.fn() }))
const prior = {
  id: 'legacy-turn',
  startedAt: '2026-01-01T00:00:00.000Z',
  message: { text: 'Earlier prompt', origin: { kind: 'user' } },
  responseParts: [{ kind: 'markdown', id: 'legacy-turn:1', content: 'Earlier reply' }],
  state: 'complete'
}
// Attaches with one already-finished turn and echoes each started turn back as the active one.
class FakeAttachment {
  snapshot: AhpView = { connected: false, uncertain: false }
  listener?: (view: AhpView) => void
  subscribe(listener: (view: AhpView) => void) {
    this.listener = listener
  }
  emit(view: Partial<AhpView>) {
    this.snapshot = { ...this.snapshot, ...view }
    this.listener?.(this.snapshot)
  }
  async attach() {
    this.emit({
      connected: true,
      chat: { resource: 'ahp-chat:/s', title: '', modifiedAt: '', status: 0, turns: [prior] } as unknown as ChatState
    })
  }
  async close() {}
  remainingActionBytes() {
    return 1
  }
  async dispatch(action: StateAction) {
    if (action.type === 'chat/turnStarted')
      this.emit({
        chat: {
          ...this.snapshot.chat!,
          activeTurn: {
            id: action.turnId,
            startedAt: action.startedAt,
            message: action.message,
            responseParts: [],
            usage: undefined
          }
        } as ChatState
      })
  }
}
vi.mock('@/lib/ahp/attachment', () => ({
  AhpAttachment: FakeAttachment,
  AhpRejectedActionError: class extends Error {},
  ahpBrowserTransport: vi.fn()
}))
vi.mock('@/lib/api', () => ({
  mintWebchatToken: mint,
  mintWebchatConversationToken: mint,
  mintWebchatSessionToken: mint,
  addWebchatConversationAgent: vi.fn(),
  removeWebchatConversationAgent: vi.fn()
}))
const { AhpPlaygroundStore } = await import('./AhpPlaygroundStore')
let store: InstanceType<typeof AhpPlaygroundStore>
const agent = { id: 'a', name: 'Alpha' } as Agent
beforeEach(() => {
  mint.mockReset().mockResolvedValue({ protocol: 'legacy' })
  store = new AhpPlaygroundStore('org', vi.fn())
})
afterEach(async () => {
  await store.close()
})
describe('AHP UI store', () => {
  it('retains a draft and image when AHP bootstrap is unavailable without falling back', async () => {
    const ui = store.getValue(),
      id = ui.openPlayground(agent)
    const image = { name: 'image.webp', mimeType: 'image/webp' as const, data: 'YQ==' }
    ui.setPgInput(id, 'Keep my draft')
    ui.setPgImage(id, image)
    expect(ui.pgSend(id, 'a')).toBe(true)
    await vi.waitFor(() => expect(ui.getPgInput(id)).toBe('Keep my draft'))
    expect(ui.getPgImage(id)).toBe(image)
    expect(ui.getPgSession(id)?.steps.at(-1)?.text).toContain('Your draft has been kept')
    expect(mint).toHaveBeenCalledWith('org', 'a', undefined, 'ahp')
  })
  it('does not clear a draft while its file upload is unfinished', () => {
    const ui = store.getValue(),
      id = ui.openPlayground(agent)
    ui.setPgInput(id, 'Draft')
    ui.setPgFiles(id, () => [{ key: 'file', name: 'file.txt', size: 3, status: 'uploading' }])
    expect(ui.pgSend(id, 'a')).toBe(false)
    expect(ui.getPgInput(id)).toBe('Draft')
    expect(ui.getPgFiles(id)).toHaveLength(1)
  })
  it('refuses to change a continuation target while admission is outstanding', async () => {
    mint.mockImplementation(() => new Promise(() => {}))
    const ui = store.getValue()
    ui.markSessionTarget('ui', 'first')
    ui.pgAttach('ui', 'a', 'conversation')
    ui.pgSend('ui', 'a', 'Pending')
    ui.setPgInput('ui', 'Next draft')
    ui.markSessionTarget('ui', 'second')
    expect(ui.pgSend('ui', 'a')).toBe(false)
    expect(ui.getPgInput('ui')).toBe('Next draft')
    expect(mint).toHaveBeenCalledWith('org', 'first', 'ahp')
  })
  it('keeps an adopted session’s replayed turns out of its live tail and labels its own prompt', async () => {
    mint.mockResolvedValue({
      token: 't',
      protocol: 'ahp',
      conversationId: 'c',
      ahp: { url: 'wss://relay.example.test/ahp' }
    })
    const ui = store.getValue()
    ui.markSessionTarget('s')
    ui.pgAttach('s', 'a', 'c')
    await vi.waitFor(() => expect(store.getValue().isPgBusy('s')).toBe(false))
    await vi.waitFor(() => expect(mint).toHaveBeenCalled())
    expect(store.getValue().getLiveSteps('s')).toEqual([])
    expect(ui.pgSend('s', 'a', 'Next prompt')).toBe(true)
    await vi.waitFor(() => expect(store.getValue().getLiveSteps('s')).toHaveLength(1))
    expect(store.getValue().getLiveSteps('s')[0]).toMatchObject({ kind: 'msg', text: 'Next prompt', who: '@you' })
  })
})
