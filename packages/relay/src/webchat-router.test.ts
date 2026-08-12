import { describe, it, expect, vi } from 'vitest'
import type { RdChat, RdWebchatPost } from '@agentconnect.md/protocol'
import { WebchatRouter, bindWebchatPostAuthor, type CachedParticipant } from './webchat-router.js'

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

// webchat-multi-agents.md §5.2a: an rd/webchat-post's authorship claim must be bound
// to the AUTHENTICATED source daemon before its context copies may keep the
// activation-capable depth stamp; an unbound claim is stripped to the pre-§5.2a
// transcript-only shape rather than dropped.
describe('bindWebchatPostAuthor', () => {
  const AGENT = '11111111-1111-4111-8111-111111111111'
  const OTHER = '22222222-2222-4222-8222-222222222222'
  const post = (over: Partial<RdWebchatPost['post']['author']> = {}, agentId = AGENT): RdWebchatPost => ({
    conversationId: CHAT_A,
    agentId,
    post: {
      postId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      conversationId: CHAT_A,
      author: { kind: 'agent', agentId: AGENT, hopCount: 3, ...over } as RdWebchatPost['post']['author'],
      text: 'hi',
      at: 1_000
    }
  })
  const roster: CachedParticipant[] = [
    { agentId: AGENT, daemonId: 'daemon-1' },
    { agentId: OTHER, daemonId: 'daemon-2' }
  ]

  it('keeps the depth when outer/inner authors agree and the verified placement is the sending daemon', () => {
    const p = post()
    const bound = bindWebchatPostAuthor(p, 'daemon-1', roster)
    expect(bound.authorBound).toBe(true)
    expect(bound.post).toBe(p) // verbatim — nothing rewritten on the bound path
  })

  it('strips the depth when the frame arrives from a daemon that does not own the claimed author', () => {
    const bound = bindWebchatPostAuthor(post(), 'daemon-2', roster)
    expect(bound.authorBound).toBe(false)
    expect(bound.post.post.author).toEqual({ kind: 'agent', agentId: AGENT }) // transcript-only shape
  })

  it('strips the depth when the outer and inner author fields disagree', () => {
    const bound = bindWebchatPostAuthor(post({ agentId: OTHER }), 'daemon-1', roster)
    expect(bound.authorBound).toBe(false)
    expect(bound.post.post.author).toEqual({ kind: 'agent', agentId: OTHER })
  })

  it('fails closed on a missing/evicted roster: depth stripped', () => {
    const bound = bindWebchatPostAuthor(post(), 'daemon-1', [])
    expect(bound.authorBound).toBe(false)
    expect(bound.post.post.author).toEqual({ kind: 'agent', agentId: AGENT })
  })

  it('fails closed when the cached participant has no placement daemonId', () => {
    const bound = bindWebchatPostAuthor(post(), 'daemon-1', [{ agentId: AGENT }])
    expect(bound.authorBound).toBe(false)
    expect(bound.post.post.author).toEqual({ kind: 'agent', agentId: AGENT })
  })

  it('leaves a depth-less (pre-parity) post verbatim — nothing to strip, still unbound', () => {
    const p = post({ hopCount: undefined })
    delete (p.post.author as { hopCount?: number }).hopCount
    const bound = bindWebchatPostAuthor(p, 'daemon-2', roster)
    expect(bound.authorBound).toBe(false)
    expect(bound.post).toBe(p)
  })
})
