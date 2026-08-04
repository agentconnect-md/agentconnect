import { describe, it, expect } from 'vitest'
import {
  AGENTCONNECT_THREAD_EVENT_TYPE,
  normalizeSlackMessage,
  normalizeSlackResponseFinalization,
  readAgentAuthorshipClaim,
  slackTextAddressesAnyone,
  SLACK_RESPONSE_FINAL_MSG_ID_SUFFIX
} from '../src/index.js'

const AUTHOR = 'agent-author'
const PEER = 'agent-peer'

function claim(overrides: Record<string, unknown> = {}) {
  return {
    metadata: {
      event_type: AGENTCONNECT_THREAD_EVENT_TYPE,
      event_payload: {
        author_agent_id: AUTHOR,
        response_id: 'r-1',
        delivery_state: 'final',
        hop_count: 2,
        mentioned_agent_ids: [PEER],
        ...overrides
      }
    }
  }
}

describe('readAgentAuthorshipClaim (§4/§8.1)', () => {
  it('reads a complete claim', () => {
    expect(readAgentAuthorshipClaim(claim())).toEqual({
      authorAgentId: AUTHOR,
      responseId: 'r-1',
      deliveryState: 'final',
      hopCount: 2,
      mentionedAgentIds: [PEER]
    })
  })

  it('round-trips `addressed anyone` from the complete reply text through the claim', () => {
    // The whole producer → metadata → parser path for the one fact the final event cannot
    // otherwise carry (§2.3/§5.5): only the LAST section is marked final, so a mention the
    // splitter left in an earlier section exists nowhere else by the time this is read.
    const wholeReply = '<@UHUMAN> here is the summary.\n\n…and this is the tail section.'
    const tailSection = '…and this is the tail section.'

    // The producer reads the COMPLETE reply; the tail on its own addresses nobody, which
    // is exactly why the author has to state it.
    expect(slackTextAddressesAnyone(wholeReply)).toBe(true)
    expect(slackTextAddressesAnyone(tailSection)).toBe(false)

    expect(readAgentAuthorshipClaim(claim({ addressed_anyone: true }))?.addressedAnyone).toBe(true)

    // Absent ⇒ omitted, not `false`: an older author cannot report it, and its finals must
    // stay routable exactly as before. A non-boolean is not an assertion either, so a
    // malformed value degrades to "named nobody" rather than blocking every continuation.
    expect(readAgentAuthorshipClaim(claim())).not.toHaveProperty('addressedAnyone')
    expect(readAgentAuthorshipClaim(claim({ addressed_anyone: 'yes' }))).not.toHaveProperty('addressedAnyone')
    expect(readAgentAuthorshipClaim(claim({ addressed_anyone: false }))).not.toHaveProperty('addressedAnyone')
  })

  it('matches every mention form `mentionedBots` is built from', () => {
    // The producer and the reader must agree on what counts as an address, so this uses
    // the same pattern rather than a second opinion about it.
    expect(slackTextAddressesAnyone('plain prose with no address')).toBe(false)
    expect(slackTextAddressesAnyone('<@U012ABC> please look')).toBe(true)
    expect(slackTextAddressesAnyone('trailing address <@W99XYZ>')).toBe(true)
    // Stateful `/g` regexes give alternating answers when reused; this must not.
    expect(slackTextAddressesAnyone('<@U012ABC> one')).toBe(true)
    expect(slackTextAddressesAnyone('<@U012ABC> two')).toBe(true)
  })

  it('carries the paired agent-call delivery id when present', () => {
    expect(readAgentAuthorshipClaim(claim({ agent_call_delivery_id: 'd-9' }))?.agentCallDeliveryId).toBe('d-9')
  })

  it('ignores chrome and foreign metadata', () => {
    expect(
      readAgentAuthorshipClaim({ metadata: { event_type: 'agentconnect_chrome', event_payload: {} } })
    ).toBeUndefined()
    expect(readAgentAuthorshipClaim({})).toBeUndefined()
  })

  it('drops the WHOLE claim when hop depth is missing or unusable', () => {
    // §4.1: an unverifiable source depth is transcript-only. Defaulting it to 0 would
    // silently hand a runaway A→B→A chain a fresh loop-protection budget every hop, so a
    // partial claim must not survive as a half-read object.
    for (const hop_count of [undefined, -1, 1.5, '2', null]) {
      expect(readAgentAuthorshipClaim(claim({ hop_count }))).toBeUndefined()
    }
  })

  it('drops a claim with no author, no response id, or an unknown lifecycle state', () => {
    expect(readAgentAuthorshipClaim(claim({ author_agent_id: '  ' }))).toBeUndefined()
    expect(readAgentAuthorshipClaim(claim({ response_id: undefined }))).toBeUndefined()
    expect(readAgentAuthorshipClaim(claim({ delivery_state: 'done' }))).toBeUndefined()
    expect(readAgentAuthorshipClaim(claim({ mentioned_agent_ids: 'peer' }))).toBeUndefined()
  })

  it('rides along on an ordinary normalized message, untrusted', () => {
    const normalized = normalizeSlackMessage({
      type: 'message',
      channel: 'C1',
      ts: '1720000000.000100',
      bot_id: 'B1',
      app_id: 'A1',
      text: `<@U09SHARED> reviewer take a look`,
      ...claim({ delivery_state: 'streaming' })
    })
    expect(normalized?.agentAuthorship?.deliveryState).toBe('streaming')
    expect(normalized?.agentAuthorship?.authorAgentId).toBe(AUTHOR)
  })
})

describe('normalizeSlackResponseFinalization (§5)', () => {
  const wrapper = (nested: Record<string, unknown>) => ({
    type: 'message',
    subtype: 'message_changed' as const,
    channel: 'C1',
    ts: '1720000000.000999',
    message: {
      type: 'message',
      ts: '1720000000.000100',
      thread_ts: '1720000000.000001',
      bot_id: 'B1',
      app_id: 'A1',
      text: '<@U01PEER> please verify the rollout',
      ...nested
    }
  })

  it('unwraps the closing edit onto the ORIGINAL message identity', () => {
    const msg = normalizeSlackResponseFinalization(wrapper(claim()))
    expect(msg).not.toBeNull()
    // Channel comes from the wrapper; ts/thread/text/sender from the edited message —
    // normalizing the wrapper itself would produce an anonymous empty message.
    expect(msg!.channel).toBe('C1')
    expect(msg!.thread).toBe('1720000000.000001')
    expect(msg!.text).toBe('<@U01PEER> please verify the rollout')
    expect(msg!.sender.appId).toBe('A1')
    expect(msg!.agentAuthorship?.mentionedAgentIds).toEqual([PEER])
  })

  it('gives the finalization its own msgId so dedup cannot swallow it', () => {
    // The streaming post and its closing edit describe one Slack message and share a
    // `ts`; only the SECOND carries the recipient set, so they must not collide.
    const streaming = normalizeSlackMessage({
      type: 'message',
      channel: 'C1',
      ts: '1720000000.000100',
      bot_id: 'B1',
      text: 'partial',
      ...claim({ delivery_state: 'streaming' })
    })
    const final = normalizeSlackResponseFinalization(wrapper(claim()))
    expect(final!.msgId).toBe(`${streaming!.msgId}${SLACK_RESPONSE_FINAL_MSG_ID_SUFFIX}`)
    expect(final!.msgId).not.toBe(streaming!.msgId)
  })

  it('drops the wrapper subtype so later stages see an ordinary post', () => {
    // Leaving `message_changed` attached would make every downstream routability check
    // reject the very event this path exists to admit.
    const msg = normalizeSlackResponseFinalization(wrapper(claim()))
    expect((msg as unknown as { subtype?: string }).subtype).toBeUndefined()
  })

  it('returns null for a mid-answer streaming edit', () => {
    // §5.4: intermediate edits must never enter routing — their text may be a prefix.
    expect(normalizeSlackResponseFinalization(wrapper(claim({ delivery_state: 'streaming' })))).toBeNull()
  })

  it('returns null for an ordinary human edit and for non-edit events', () => {
    expect(normalizeSlackResponseFinalization(wrapper({ user: 'U1', metadata: undefined }))).toBeNull()
    expect(
      normalizeSlackResponseFinalization({ type: 'message', channel: 'C1', ts: '1', text: 'hi', ...claim() })
    ).toBeNull()
  })

  it('returns null for a chrome edit', () => {
    // Status bars and cards are edited constantly; none of them is a response event.
    expect(
      normalizeSlackResponseFinalization(
        wrapper({ metadata: { event_type: 'agentconnect_chrome', event_payload: {} } })
      )
    ).toBeNull()
  })
})
