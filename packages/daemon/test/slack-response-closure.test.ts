/**
 * send-message-routing-rework.md §5.5 — closing a response WITHOUT the closing edit.
 *
 * The invariants pinned here: a terminal section posted at finalization is BORN
 * `delivery_state: 'final'` (carrying the prepared recipients and addressed-anyone bit),
 * exactly one physical message of a split answer is terminal, a mid-stream post or settle
 * edit never earns the stamp, and `finalizeSlackResponse` re-edits only when no post
 * already closed the response — because that chat.update marks the visible reply
 * "(edited)", it must remain the fallback, never the default.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SlackConnection, SlackPostOptions } from '../src/slack/connection.js'
import type { SlackAction } from '../src/slack/render.js'
import {
  applySlackAction,
  finalizeSlackResponse,
  type SlackTurn,
  type SlackTurnHost,
  type SlackTurnState
} from '../src/platforms/slack/turn-output.js'

const ROUTING = { mentionedAgentIds: ['bot-b'], addressedAnyone: true, hasPeers: true, peerSharesBot: false }

function fixture(reply: SlackTurn['reply'] = { responseId: 'resp-1' }, over: Record<string, unknown> = {}) {
  let seq = 0
  const posts: { text: string; options?: SlackPostOptions }[] = []
  const conn = {
    postMessage: vi.fn(async (_channel: string, text: string, _thread?: string, options?: SlackPostOptions) => {
      posts.push({ text, options })
      return `ts-${++seq}`
    }),
    updateMessage: vi.fn(async () => true),
    updateBlocks: vi.fn(async () => true),
    ...over
  }
  const turn: SlackTurn = {
    conn,
    plan: {
      channel: 'C1',
      thread: 'T1',
      statusThread: 'T1',
      transcriptChannel: 'C1',
      agentId: 'bot-a',
      agentName: 'Bot A',
      sessionKey: 'k',
      platform: 'slack',
      isDm: false,
      sourceHopCount: 1
    },
    chrome: {},
    reply
  }
  const state: SlackTurnState = {}
  const host: SlackTurnHost<typeof turn> = {
    recordReplySegment: vi.fn(),
    appendTranscript: vi.fn(),
    getStatusBarTs: vi.fn(async () => undefined),
    setStatusBarTs: vi.fn(),
    clearStatusBarTs: vi.fn(),
    monotonicTs: () => '1',
    debug: vi.fn()
  }
  return {
    conn,
    turn,
    posts,
    apply: (action: SlackAction) => applySlackAction(host, turn as never, state, action)
  }
}

describe('born-final terminal posts (§5.5)', () => {
  it('stamps a terminal post `final` with the prepared recipients, and records the ts', async () => {
    const { apply, turn, posts } = fixture({ responseId: 'resp-1', finalRouting: ROUTING })
    await apply({ kind: 'post', text: 'done <@UBOTB>', terminal: true })
    expect(posts[0]?.options?.response).toEqual({
      responseId: 'resp-1',
      deliveryState: 'final',
      hopCount: 1,
      mentionedAgentIds: ['bot-b'],
      addressedAnyone: true
    })
    expect(turn.reply.finalStamped).toBe('ts-1')
    expect(turn.reply.lastResponse).toEqual({ ts: 'ts-1', text: 'done <@UBOTB>' })
  })

  it('keeps a terminal post `streaming` when no routing was prepared (no org/snapshot)', async () => {
    const { apply, turn, posts } = fixture()
    await apply({ kind: 'post', text: 'done', terminal: true })
    expect(posts[0]?.options?.response).toMatchObject({ deliveryState: 'streaming', mentionedAgentIds: [] })
    expect(turn.reply.finalStamped).toBeUndefined()
  })

  it('keeps a terminal post `streaming` when a peer shares the sending bot', async () => {
    // A shared-bot peer's ingress admits only the closing `message_changed` edit past
    // its self-echo filter — a fresh own-bot post would never reach it — so these
    // conversations keep the re-stamp instead of closing at post time.
    const { apply, turn, posts } = fixture({
      responseId: 'resp-1',
      finalRouting: { ...ROUTING, peerSharesBot: true }
    })
    await apply({ kind: 'post', text: 'done <@UBOTB>', terminal: true })
    expect(posts[0]?.options?.response).toMatchObject({ deliveryState: 'streaming' })
    expect(turn.reply.finalStamped).toBeUndefined()
  })

  it('never stamps a non-terminal post, even with routing prepared', async () => {
    const { apply, turn, posts } = fixture({ responseId: 'resp-1', finalRouting: ROUTING })
    await apply({ kind: 'post', text: 'section one' })
    expect(posts[0]?.options?.response).toMatchObject({ deliveryState: 'streaming' })
    expect(turn.reply.finalStamped).toBeUndefined()
  })

  it('does not record a stamp when the terminal post itself fails', async () => {
    const { apply, turn } = fixture(
      { responseId: 'resp-1', finalRouting: ROUTING },
      { postMessage: vi.fn(async () => undefined) }
    )
    await apply({ kind: 'post', text: 'done', terminal: true })
    expect(turn.reply.finalStamped).toBeUndefined()
  })

  it('final-live-reply: a fresh single-section answer is born final', async () => {
    const { apply, turn, posts } = fixture({ responseId: 'resp-1', finalRouting: ROUTING })
    await apply({ kind: 'final-live-reply', text: 'the whole answer' })
    expect(posts).toHaveLength(1)
    expect(posts[0]?.options?.response).toMatchObject({ deliveryState: 'final', mentionedAgentIds: ['bot-b'] })
    expect(turn.reply.finalStamped).toBe('ts-1')
  })

  it('final-live-reply: only the LAST overflow section carries the stamp', async () => {
    // Three sections: each paragraph is close to Slack's one-block cap, so the splitter
    // must cut at the paragraph boundaries.
    const text = ['a'.repeat(11000), 'b'.repeat(11000), 'c'.repeat(11000)].join('\n\n')
    const { apply, turn, posts } = fixture({ responseId: 'resp-1', finalRouting: ROUTING })
    await apply({ kind: 'final-live-reply', text })
    expect(posts).toHaveLength(3)
    expect(posts.map((p) => p.options?.response?.deliveryState)).toEqual(['streaming', 'streaming', 'final'])
    expect(turn.reply.finalStamped).toBe('ts-3')
    expect(turn.reply.lastResponse?.ts).toBe('ts-3')
  })

  it('final-live-reply: the settle EDIT of an already-posted answer earns no stamp', async () => {
    const { apply, turn, conn } = fixture({ responseId: 'resp-1', finalRouting: ROUTING })
    turn.chrome.liveReplyTs = 'ts-live'
    turn.chrome.liveReplyText = 'partial'
    await apply({ kind: 'final-live-reply', text: 'partial, now complete' })
    expect(conn.updateMessage).toHaveBeenCalled()
    expect(conn.postMessage).not.toHaveBeenCalled()
    expect(turn.reply.finalStamped).toBeUndefined()
  })
})

describe('finalizeSlackResponse skips a response already closed at post time', () => {
  const closeArgs = (turn: SlackTurn) => {
    const finalizeResponse = vi.fn(async () => true)
    ;(turn.conn as Record<string, unknown>).finalizeResponse = finalizeResponse
    return finalizeResponse
  }

  it('does not re-edit when the stamped message is still the last response', async () => {
    const { turn } = fixture({
      responseId: 'resp-1',
      lastResponse: { ts: 'ts-1', text: 'done' },
      finalStamped: 'ts-1'
    })
    const finalizeResponse = closeArgs(turn)
    await finalizeSlackResponse(turn.conn as SlackConnection, turn, [], false, () => {})
    expect(finalizeResponse).not.toHaveBeenCalled()
  })

  it('still re-edits when a later post displaced the stamped message', async () => {
    const { turn } = fixture({
      responseId: 'resp-1',
      lastResponse: { ts: 'ts-2', text: 'trailing section' },
      finalStamped: 'ts-1'
    })
    const finalizeResponse = closeArgs(turn)
    await finalizeSlackResponse(turn.conn as SlackConnection, turn, ['bot-b'], true, () => {})
    expect(finalizeResponse).toHaveBeenCalledOnce()
  })
})
