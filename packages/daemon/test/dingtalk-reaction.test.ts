import { describe, expect, it, vi } from 'vitest'
import { dingTalkApiError } from '../src/platforms/dingtalk/api.js'
import type { DingTalkReplyPort } from '../src/platforms/dingtalk/connection.js'
import { DINGTALK_QUOTA_NOTICE, DingTalkQuotaNotice } from '../src/platforms/dingtalk/quota.js'
import {
  acknowledgeDingTalkTurn,
  DingTalkReactionClient,
  type DingTalkMessageRef,
  type DingTalkReactionPort
} from '../src/platforms/dingtalk/reaction.js'
import { createDingTalkTurnOutput } from '../src/platforms/dingtalk/surface.js'
import { applyDingTalkAction } from '../src/platforms/dingtalk/turn-output.js'
import type { TurnAcknowledgementEnd } from '../src/platforms/turn-output.js'

const QUOTA = dingTalkApiError('/v1.0/robot/groupMessages/send', 403, 'Forbidden.AccessDenied.ApiCountLimitForOrg')
const REFUSED = dingTalkApiError('/v1.0/robot/emotion/reply', 403, 'Forbidden.AccessDenied.AccessTokenPermissionDenied')

function fakeReactions(opts: { addError?: unknown; removeError?: unknown } = {}) {
  const calls: string[] = []
  const reactions: DingTalkReactionPort = {
    add: vi.fn(async (at: DingTalkMessageRef) => {
      calls.push(`add ${at.openConversationId} ${at.openMsgId}`)
      if (opts.addError) throw opts.addError
    }),
    remove: vi.fn(async (at: DingTalkMessageRef) => {
      calls.push(`remove ${at.openConversationId} ${at.openMsgId}`)
      if (opts.removeError) throw opts.removeError
    }),
    warn: vi.fn()
  }
  return { calls, reactions }
}

const message = (opts: { channel?: string; msgId?: string; source?: string; headless?: boolean } = {}) => ({
  channel: opts.channel ?? 'cid-example-group',
  msgId: opts.msgId ?? 'dingtalk:cid-example-group:msg-1',
  source: opts.source ?? 'user',
  ...(opts.headless ? { headless: true } : {})
})

const ctx = (reactions: DingTalkReactionPort | undefined, mode = 'low', msg = message()) =>
  ({ mode, isDm: false, showFooter: true, message: msg, egress: reactions ? { reactions } : undefined }) as never

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

describe('DingTalkReactionClient', () => {
  it('adds and recalls the thinking reaction on the inbound message', async () => {
    const call = vi.fn(async () => ({ result: true }))
    const client = new DingTalkReactionClient({ call } as never, 'robot-example', { warn: vi.fn() })
    const at = { openConversationId: 'cid-example-group', openMsgId: 'msg-1' }
    await client.add(at)
    await client.remove(at)
    const body = {
      robotCode: 'robot-example',
      openMsgId: 'msg-1',
      openConversationId: 'cid-example-group',
      emotionType: 2,
      emotionName: '🤔思考中',
      textEmotion: { emotionId: '2659900', emotionName: '🤔思考中', text: '🤔思考中', backgroundId: 'im_bg_1' }
    }
    expect(call.mock.calls).toEqual([
      ['POST', '/v1.0/robot/emotion/reply', body],
      ['POST', '/v1.0/robot/emotion/recall', body]
    ])
  })
})

describe('acknowledgeDingTalkTurn', () => {
  it('reacts to a delivered user message in every mode but none', () => {
    const { reactions } = fakeReactions()
    const turn = { rerun: false }
    expect(acknowledgeDingTalkTurn(ctx(reactions, 'none'), turn)).toBeUndefined()
    expect(acknowledgeDingTalkTurn(ctx(undefined), turn)).toBeUndefined()
    expect(acknowledgeDingTalkTurn(ctx(reactions, 'low', message({ headless: true })), turn)).toBeUndefined()
    // An agent call carries no message DingTalk delivered.
    expect(
      acknowledgeDingTalkTurn(ctx(reactions, 'low', message({ source: 'agent', msgId: 'agent:call-1' })), turn)
    ).toBeUndefined()
    expect(acknowledgeDingTalkTurn(ctx(reactions, 'low', message({ msgId: 'agent:call-1' })), turn)).toBeUndefined()
    expect(acknowledgeDingTalkTurn(ctx(reactions, 'minimal'), turn)).toBeDefined()
    expect(reactions.add).toHaveBeenCalledTimes(1)
  })

  it('addresses a DM by its raw conversation id, not its dm: channel', async () => {
    const { calls, reactions } = fakeReactions()
    const dm = message({ channel: 'dm:user-0001', msgId: 'dingtalk:cid-example-dm:msg-2' })
    await acknowledgeDingTalkTurn(ctx(reactions, 'low', dm), { rerun: false })!.end('completed')
    await settle()
    expect(calls).toEqual(['add cid-example-dm msg-2', 'remove cid-example-dm msg-2'])
  })

  it('takes the reaction off on every end kind, once, and never shows a notice', async () => {
    for (const end of ['completed', 'interrupted', 'failed', 'rerun'] satisfies TurnAcknowledgementEnd[]) {
      const { calls, reactions } = fakeReactions()
      const ack = acknowledgeDingTalkTurn(ctx(reactions), { rerun: false })!
      await expect(ack.replace('notice')).resolves.toBe(false)
      await ack.end(end)
      await ack.end(end)
      await settle()
      expect(calls).toEqual(['add cid-example-group msg-1', 'remove cid-example-group msg-1'])
    }
  })

  it('does not wait for the removal to end the turn, but reports it as settling', async () => {
    const { reactions } = fakeReactions()
    let finish = () => {}
    reactions.remove = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)))
    const ack = acknowledgeDingTalkTurn(ctx(reactions), { rerun: false })!
    expect(ack.settled).toBeUndefined()
    await ack.end('completed')
    await settle()
    expect(reactions.remove).toHaveBeenCalledTimes(1)
    let settled = false
    void ack.settled!.then(() => (settled = true))
    await settle()
    expect(settled).toBe(false)
    finish()
    await settle()
    expect(settled).toBe(true)
  })

  it('runs the turn without a reaction when the add is refused, logging once', async () => {
    const { calls, reactions } = fakeReactions({ addError: REFUSED })
    const ack = acknowledgeDingTalkTurn(ctx(reactions), { rerun: false })!
    await ack.end('completed')
    await settle()
    expect(calls).toEqual(['add cid-example-group msg-1'])
    expect(reactions.warn).toHaveBeenCalledTimes(1)
    // A rerun still takes off a reaction an earlier run may have left.
    const rerun = fakeReactions({ addError: REFUSED })
    await acknowledgeDingTalkTurn(ctx(rerun.reactions), { rerun: true })!.end('completed')
    await settle()
    expect(rerun.calls).toEqual(['add cid-example-group msg-1', 'remove cid-example-group msg-1'])
  })

  it('logs a refused removal without failing the end', async () => {
    const { reactions } = fakeReactions({ removeError: REFUSED })
    await expect(acknowledgeDingTalkTurn(ctx(reactions), { rerun: false })!.end('failed')).resolves.toBeUndefined()
    await settle()
    expect(reactions.warn).toHaveBeenCalledTimes(1)
  })
})

describe('DingTalk quota notice', () => {
  const host = { appendTranscript: async () => {}, monotonicTs: () => 'local-1' }
  const turn = {
    plan: { transcriptChannel: 'transcript', statusThread: 'dt:msg-1', agentId: 'agent', sessionKey: 'session' }
  }

  it('posts the notice once per turn, for a quota refusal only', async () => {
    const send = vi.fn(async (_text: string) => 'pqk')
    const quota = new DingTalkQuotaNotice(send)
    await quota.note(REFUSED)
    expect(send).not.toHaveBeenCalled()
    await quota.note(QUOTA)
    await quota.note(QUOTA)
    expect(send).toHaveBeenCalledExactlyOnceWith(DINGTALK_QUOTA_NOTICE)
  })

  it('names a quota refusal of the answer once through the turn state', async () => {
    const sendText = vi.fn(async (_channel: string, _text: string) => 'pqk')
    const conn = {
      sendMarkdown: vi.fn(async () => [{ text: 'answer', error: QUOTA }]),
      sendText
    } satisfies DingTalkReplyPort
    const surface = createDingTalkTurnOutput(host)
    const state = surface.initialTurnState({
      mode: 'low',
      isDm: false,
      showFooter: true,
      message: { channel: 'cid' },
      egress: conn
    } as never) as Parameters<typeof applyDingTalkAction>[2]
    await applyDingTalkAction(host, turn, state, { kind: 'post', text: 'answer' })
    await applyDingTalkAction(host, turn, state, { kind: 'post', text: 'answer' })
    expect(sendText).toHaveBeenCalledExactlyOnceWith('cid', DINGTALK_QUOTA_NOTICE)
  })
})
