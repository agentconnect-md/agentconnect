import { describe, it, expect, vi } from 'vitest'
import type { RdChat } from '@agentconnect.md/protocol'
import { WebchatRouter } from './webchat-router.js'

const CHAT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const CHAT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function chat(chatId: string): RdChat {
  return {
    chatId,
    seq: 0,
    event: { kind: 'done', done: { conversationId: chatId, turnId: CHAT_B } }
  }
}
const sink = () => ({ onChat: vi.fn<(chat: RdChat) => void>() })

describe('WebchatRouter', () => {
  it('delivers an rd/chat to the sink registered for its chatId', () => {
    const r = new WebchatRouter()
    const a = sink()
    r.register(CHAT_A, a)
    r.deliver(chat(CHAT_A))
    expect(a.onChat).toHaveBeenCalledWith(chat(CHAT_A))
    expect(r.size()).toBe(1)
  })

  it('drops an rd/chat with no attached browser (no throw)', () => {
    const r = new WebchatRouter()
    expect(() => r.deliver(chat(CHAT_A))).not.toThrow()
  })

  it('routes each chatId to its own sink', () => {
    const r = new WebchatRouter()
    const a = sink()
    const b = sink()
    r.register(CHAT_A, a)
    r.register(CHAT_B, b)
    r.deliver(chat(CHAT_B))
    expect(a.onChat).not.toHaveBeenCalled()
    expect(b.onChat).toHaveBeenCalledOnce()
  })

  it('unregister removes the sink and stops delivery', () => {
    const r = new WebchatRouter()
    const a = sink()
    r.register(CHAT_A, a)
    r.unregister(CHAT_A, a)
    r.deliver(chat(CHAT_A))
    expect(a.onChat).not.toHaveBeenCalled()
    expect(r.size()).toBe(0)
  })

  it('unregister is only-if-still-ours — a stale close must not evict a resumed socket', () => {
    const r = new WebchatRouter()
    const first = sink()
    const second = sink()
    r.register(CHAT_A, first)
    r.register(CHAT_A, second) // a resume reclaims the same chatId
    r.unregister(CHAT_A, first) // the OLD socket's late close fires — must be a no-op
    r.deliver(chat(CHAT_A))
    expect(second.onChat).toHaveBeenCalledOnce() // resumed socket still attached
    expect(first.onChat).not.toHaveBeenCalled()
  })
})
