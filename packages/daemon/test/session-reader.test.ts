import { describe, it, expect } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { createSessionReader } from '../src/cp/session-reader.js'
import { sessionThreadUrlFor } from '../src/platforms/session-links.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const HOOK = '33333333-3333-4333-8333-333333333333'

function store(): LocalStore {
  return new LocalStore(join(mkdtempSync(join(tmpdir(), 'ac-reader-')), 'local.sqlite'))
}

function seedHistorySession(s: LocalStore, { platform = 'slack', channel = 'C1', thread = 'T1' } = {}): void {
  s.upsertSession({
    key: sessionKey(platform, channel, thread, AGENT),
    agentId: AGENT,
    platform,
    channel,
    thread,
    acpSessionId: 'acp-1',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1
  })
}

describe('SessionReader', () => {
  it('reads only the transcript namespace persisted on the session', () => {
    const s = store()
    s.upsertSession({
      key: sessionKey('telegram', '42', 'dm', AGENT),
      agentId: AGENT,
      platform: 'telegram',
      channel: '42',
      thread: 'dm',
      transportScope: 'telegram:bot-b',
      acpSessionId: 'acp-scoped',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    s.appendTranscript({
      channel: transcriptChannelKey('42', 'telegram:bot-a'),
      thread: 'dm',
      ts: '1',
      sender: 'user-a',
      recipient: AGENT,
      kind: 'text',
      text: 'private to bot A'
    })
    s.appendTranscript({
      channel: transcriptChannelKey('42', 'telegram:bot-b'),
      thread: 'dm',
      ts: '1',
      sender: 'user-b',
      recipient: AGENT,
      kind: 'text',
      text: 'private to bot B'
    })

    const history = createSessionReader(s).history({
      agentId: AGENT,
      sessionId: 'acp-scoped',
      limit: 20
    })
    expect(history.messages.map((message) => message.text)).toEqual(['private to bot B'])
    s.close()
  })

  it('list joins cached channel/triggeredBy names; unresolved ids omit the fields', () => {
    const s = store()
    s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      triggeredBy: 'U1',
      originSessionId: 'acp-parent'
    })
    s.upsertSession({
      key: sessionKey('slack', 'C2', 'T2', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C2',
      thread: 'T2',
      acpSessionId: 'acp-2',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 2
    })
    s.setDisplayName('C1', 'deploys', 1)
    s.setDisplayName('U1', 'Dana Reyes', 1)
    s.setSessionTitle(sessionKey('slack', 'C1', 'T1', AGENT), 'Roll back the deploy')

    const reader = createSessionReader(s)
    const { sessions } = reader.list({})
    const byId = new Map(sessions.map((x) => [x.sessionId, x]))
    expect(byId.get('acp-1')).toMatchObject({
      parentSessionId: 'acp-parent',
      title: 'Roll back the deploy',
      channelName: 'deploys',
      triggeredBy: 'U1',
      triggeredByName: 'Dana Reyes'
    })
    // No cached names / no triggeredBy / no title → optional fields simply absent, ids intact.
    const bare = byId.get('acp-2')!
    expect(bare.sessionKey.channel).toBe('C2')
    expect(bare.title).toBeUndefined()
    expect(bare.channelName).toBeUndefined()
    expect(bare.triggeredBy).toBeUndefined()
    expect(bare.triggeredByName).toBeUndefined()
    s.close()
  })

  it('falls back to the first user message as the title when the runtime pushed none', () => {
    const s = store()
    // A webchat/playground session: the runtime never pushed a session/info title.
    s.upsertSession({
      key: sessionKey('webchat', 'conv-1', 'webchat:conv-1', AGENT),
      agentId: AGENT,
      platform: 'webchat',
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      acpSessionId: 'acp-wc',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 3,
      triggeredBy: 'alice'
    })
    // The triggering user message, then the agent's reply (must NOT be used as a title).
    s.appendTranscript({
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      ts: '1',
      sender: 'alice',
      kind: 'text',
      text: "what's your model?"
    })
    s.appendTranscript({
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      ts: '2',
      sender: AGENT,
      kind: 'text',
      text: 'I am Claude.'
    })

    // A session that DOES have a runtime title — the fallback must not override it.
    s.upsertSession({
      key: sessionKey('slack', 'C9', 'T9', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C9',
      thread: 'T9',
      acpSessionId: 'acp-titled',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 4
    })
    s.appendTranscript({ channel: 'C9', thread: 'T9', ts: '1', sender: 'U9', kind: 'text', text: 'the first message' })
    s.setSessionTitle(sessionKey('slack', 'C9', 'T9', AGENT), 'Runtime summary')

    const byId = new Map(
      createSessionReader(s)
        .list({})
        .sessions.map((x) => [x.sessionId, x])
    )
    // Untitled webchat session ⇒ named from its first user message (never the agent reply).
    expect(byId.get('acp-wc')!.title).toBe("what's your model?")
    // Runtime title wins over the first-message fallback.
    expect(byId.get('acp-titled')!.title).toBe('Runtime summary')
    s.close()
  })

  it('first-message fallback takes one line, caps length, and rewrites <@U…> mentions', () => {
    const s = store()
    s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const long = 'x'.repeat(200)
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      kind: 'text',
      text: `<@U1> ${long}\nsecond line`
    })
    s.setDisplayName('U1', 'Dana Reyes', 1)

    const title = createSessionReader(s)
      .list({})
      .sessions.find((x) => x.sessionId === 'acp-1')!.title!
    expect(title.startsWith('@Dana Reyes ')).toBe(true) // leading mention rewritten to @name
    expect(title.endsWith('…')).toBe(true) // long body truncated with an ellipsis
    expect(title).not.toContain('second line') // only the first line is used
    s.close()
  })

  it('uses persisted source URLs and derives the Slack fallback from the owning workspace', () => {
    const s = store()
    // Slack session with a realistic thread-root ts.
    s.upsertSession({
      key: sessionKey('slack', 'C1', '1710799200.123456', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: '1710799200.123456',
      acpSessionId: 'acp-slack',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 2
    })
    // Telegram session — no Slack archives link even with a resolver.
    s.upsertSession({
      key: sessionKey('telegram', 'chat1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'telegram',
      channel: 'chat1',
      thread: 'T1',
      acpSessionId: 'acp-tg',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    s.upsertSession({
      key: sessionKey('hook', 'github:123', '42', AGENT),
      agentId: AGENT,
      platform: 'hook',
      channel: 'github:123',
      thread: '42',
      threadUrl: 'https://github.com/acme/infra/issues/42',
      acpSessionId: 'acp-github',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 3
    })

    // Persisted ingress links win; the strategy derives Slack's legacy/live fallback.
    const withUrl = createSessionReader(s, (session) =>
      sessionThreadUrlFor(session, { workspaceUrl: 'https://acme.slack.com/' })
    )
    const byId = new Map(withUrl.list({}).sessions.map((x) => [x.sessionId, x]))
    expect(byId.get('acp-slack')!.threadUrl).toBe('https://acme.slack.com/archives/C1/p1710799200123456')
    expect(byId.get('acp-tg')!.threadUrl).toBeUndefined()
    expect(byId.get('acp-github')!.threadUrl).toBe('https://github.com/acme/infra/issues/42')

    // No resolver leaves only the persisted links available.
    expect(
      createSessionReader(s)
        .list({})
        .sessions.find((x) => x.sessionId === 'acp-slack')!.threadUrl
    ).toBeUndefined()
    expect(
      createSessionReader(s)
        .list({})
        .sessions.find((x) => x.sessionId === 'acp-github')!.threadUrl
    ).toBe('https://github.com/acme/infra/issues/42')
    expect(
      createSessionReader(s, () => undefined)
        .list({})
        .sessions.find((x) => x.sessionId === 'acp-slack')!.threadUrl
    ).toBeUndefined()
    s.close()
  })

  it('history labels senders with cached names and leaves unknown ids raw', () => {
    const s = store()
    const transportScope = 'slack:one'
    const transcriptChannel = transcriptChannelKey('C1', transportScope)
    s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT, transportScope),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      transportScope,
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    // The inbound message is delivered TO this agent (recipient), the reply is FROM it.
    s.appendTranscript({
      channel: transcriptChannel,
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'hi'
    })
    s.appendTranscript({
      channel: transcriptChannel,
      thread: 'T1',
      ts: '2',
      sender: AGENT,
      kind: 'text',
      text: 'hello'
    })
    s.setDisplayName('U1', 'Dana Reyes', 1)
    s.setProfileAvatar(transportScope, 'U1', 'https://avatars.example.test/dana.png', 1)

    const reader = createSessionReader(s)
    const { messages } = reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(messages.map((m) => [m.sender, m.senderName, m.senderAvatarUrl])).toEqual([
      ['U1', 'Dana Reyes', 'https://avatars.example.test/dana.png'],
      [AGENT, undefined, undefined] // agent-id senders have no cached provider profile → omitted
    ])
    s.close()
  })

  it('recovers the GitHub actor for trusted transcript rows written before structured attribution', () => {
    const s = store()
    const transportScope = 'github:123'
    s.upsertSession({
      key: sessionKey('hook', 'acme/infra', '384', AGENT, transportScope),
      agentId: AGENT,
      platform: 'hook',
      channel: 'acme/infra',
      thread: '384',
      transportScope,
      acpSessionId: 'acp-github',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      triggeredBy: `hook:${HOOK}`
    })
    s.appendTranscript({
      channel: transcriptChannelKey('acme/infra', transportScope),
      thread: '384',
      ts: '1',
      sender: `hook:${HOOK}`,
      recipient: AGENT,
      kind: 'text',
      text: [
        'GitHub pull_request:opened — acme/infra#384 "fix participant attribution"',
        'From: alice (CONTRIBUTOR)',
        'https://github.invalid/acme/infra/pull/384'
      ].join('\n')
    })

    expect(createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-github', limit: 50 }).messages).toEqual([
      expect.objectContaining({ sender: 'alice' })
    ])
    s.close()
  })

  it('history restores a daemon-local webchat image without the synthetic attachment suffix', () => {
    const s = store()
    seedHistorySession(s, { platform: 'webchat', channel: 'conv-1', thread: 'webchat:conv-1' })
    s.appendTranscript({
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      ts: '1',
      sender: 'alice',
      recipient: AGENT,
      kind: 'text',
      text: 'Identify this\n[attached: screen.webp (image/webp)]',
      attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: 'aW1hZ2U=' }]
    })

    expect(createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 }).messages).toEqual([
      expect.objectContaining({
        text: 'Identify this',
        attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: 'aW1hZ2U=' }]
      })
    ])
    s.close()
  })

  it('strips a label the row does not literally agree with (observer wrote it pre-download)', () => {
    // recordObservedInbound recorded the Feishu label before any download settled the
    // type, so the row says application/octet-stream while the stored image is a PNG.
    const s = store()
    seedHistorySession(s, { platform: 'feishu', channel: 'oc_1', thread: 'oc_1' })
    s.appendTranscript({
      channel: 'oc_1',
      thread: 'oc_1',
      ts: '1',
      sender: 'ou_1',
      recipient: AGENT,
      kind: 'text',
      text: 'look\n[attached: img_v3_abc (application/octet-stream)]',
      attachments: [{ name: 'img_v3_abc', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })

    expect(createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 }).messages).toEqual([
      expect.objectContaining({
        text: 'look',
        attachments: [{ name: 'img_v3_abc', mimeType: 'image/png', data: 'aW1hZ2U=' }]
      })
    ])
    s.close()
  })

  it('keeps the label for files it could not inline beside the one image it did', () => {
    // Only the first small image is stored; the PDF and the over-cap second image must
    // still be visible as their labels rather than vanishing with the whole suffix.
    const s = store()
    seedHistorySession(s)
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'review these\n[attached: small.png (image/png), report, final.pdf (application/pdf), huge.png (image/png)]',
      attachments: [{ name: 'small.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })

    expect(createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 }).messages).toEqual([
      // The comma inside `report, final.pdf` is part of the file NAME, not a separator.
      expect.objectContaining({
        text: 'review these\n[attached: report, final.pdf (application/pdf), huge.png (image/png)]',
        attachments: [{ name: 'small.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
      })
    ])
    s.close()
  })

  it('leaves the row alone when the label names nothing the attachment matches', () => {
    const s = store()
    seedHistorySession(s)
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'see\n[attached: other.pdf (application/pdf)]',
      attachments: [{ name: 'shot.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })

    expect(createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 }).messages).toEqual([
      expect.objectContaining({ text: 'see\n[attached: other.pdf (application/pdf)]' })
    ])
    s.close()
  })

  it('carries daemon-verified Slack bot provenance to the session DTO', () => {
    const s = store()
    seedHistorySession(s)
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'UAPPBOT',
      trustedAgentBot: true,
      recipient: AGENT,
      kind: 'text',
      text: 'legacy agent reply'
    })

    expect(createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 }).messages).toEqual([
      expect.objectContaining({ sender: 'UAPPBOT', trustedAgentBot: true })
    ])
    s.close()
  })

  it('binds session and tool-body reads to the authorized agent in a shared thread', () => {
    const s = store()
    seedHistorySession(s)
    s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', OTHER_AGENT),
      agentId: OTHER_AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-peer',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const body = JSON.stringify({ toolCallId: 'peer-tc', rawOutput: 'restricted output' })
    s.insertToolCall({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: OTHER_AGENT,
      toolCallId: 'peer-tc',
      title: 'restricted tool call',
      body
    })

    const reader = createSessionReader(s)
    // A peer's private tool row is absent from both the visible agent's history
    // and its direct full-body lookup, even though the sessions share a thread.
    expect(reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 }).messages).toEqual([])
    expect(reader.toolBody({ agentId: AGENT, sessionId: 'acp-1', toolCallId: 'peer-tc', offset: 0 }).data).toBe('')
    // The session itself is also bound to its agent, while the peer owner can read its body.
    expect(reader.history({ agentId: OTHER_AGENT, sessionId: 'acp-1', limit: 50 }).messages).toEqual([])
    expect(reader.toolBody({ agentId: OTHER_AGENT, sessionId: 'acp-1', toolCallId: 'peer-tc', offset: 0 }).data).toBe(
      ''
    )
    expect(
      reader.toolBody({ agentId: OTHER_AGENT, sessionId: 'acp-peer', toolCallId: 'peer-tc', offset: 0 }).data
    ).toBe(body)
    s.close()
  })

  it('keeps session reads available for a rolling upgrade from a legacy CP', () => {
    const s = store()
    seedHistorySession(s)
    const body = JSON.stringify({ toolCallId: 'tc-1', rawOutput: 'ok' })
    s.insertToolCall({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: AGENT,
      toolCallId: 'tc-1',
      title: 'legacy-compatible tool call',
      body
    })

    const reader = createSessionReader(s)
    expect(reader.history({ sessionId: 'acp-1', limit: 50 }).messages).toHaveLength(1)
    expect(reader.toolBody({ sessionId: 'acp-1', toolCallId: 'tc-1', offset: 0 }).data).toBe(body)
    s.close()
  })

  it('history scopes to what THIS agent received or produced (no peer cross-talk)', () => {
    const s = store()
    s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    // Delivered to THIS agent + its own reply.
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'to-me'
    })
    s.appendTranscript({ channel: 'C1', thread: 'T1', ts: '2', sender: AGENT, kind: 'text', text: 'my-reply' })
    // A peer sharing this (channel, thread): a message addressed to it + its own reply and
    // PRIVATE reasoning must NOT surface in this agent's session view.
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '3',
      sender: 'U1',
      recipient: 'other-agent',
      kind: 'text',
      text: 'to-other'
    })
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '4',
      sender: 'other-agent',
      kind: 'text',
      text: 'other-reply'
    })
    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '5',
      sender: 'other-agent',
      kind: 'reasoning',
      text: 'other-thinks'
    })

    const reader = createSessionReader(s)
    const { messages } = reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(messages.map((m) => m.text)).toEqual(['to-me', 'my-reply'])
    s.close()
  })

  it('tails inserts, same-seq tool updates, and newly visible shared deliveries', () => {
    const s = store()
    seedHistorySession(s)
    const reader = createSessionReader(s)
    const initial = reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(initial.liveCursor).toBe('0')

    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'first'
    })
    s.insertToolCall({
      channel: 'C1',
      thread: 'T1',
      ts: '2',
      sender: AGENT,
      toolCallId: 'tc-live',
      title: 'Running',
      body: JSON.stringify({ toolCallId: 'tc-live', status: 'in_progress' })
    })

    const inserted = reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: initial.liveCursor!,
      limit: 50
    })
    expect(inserted.messages.map((message) => message.text)).toEqual(['first', 'Running'])
    expect(inserted.liveCursor).toBe('2')

    const toolSeq = inserted.messages[1]!.seq
    s.updateToolCall('C1', 'T1', AGENT, 'tc-live', {
      title: 'Complete',
      body: JSON.stringify({ toolCallId: 'tc-live', status: 'completed' })
    })
    const updated = reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: inserted.liveCursor!,
      limit: 50
    })
    expect(updated.messages).toEqual([
      expect.objectContaining({ seq: toolSeq, text: 'Complete', toolStatus: 'completed' })
    ])

    s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '3',
      sender: OTHER_AGENT,
      kind: 'reasoning',
      text: 'peer-private'
    })
    const privateAdvance = reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: updated.liveCursor!,
      limit: 50
    })
    expect(privateAdvance.messages).toEqual([])

    for (const recipient of [OTHER_AGENT, AGENT]) {
      s.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: '4',
        sender: 'U1',
        recipient,
        kind: 'text',
        text: 'shared-later'
      })
    }
    const shared = reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: privateAdvance.liveCursor!,
      limit: 50
    })
    expect(shared.messages.map((message) => message.text)).toEqual(['shared-later'])
    s.close()
  })

  it('orders Slack history by event time when older thread rows are backfilled after the trigger', () => {
    const s = store()
    seedHistorySession(s)

    // The trigger is recorded first. The warm-thread snapshot then discovers two
    // older Slack replies and appends them with later seq values. Internal activity
    // uses epoch milliseconds, so the history order must normalize both units.
    for (const row of [
      { ts: '1784098696.100000', sender: 'U1', kind: 'text' as const, text: 'first request' },
      { ts: '1784098843.000000', sender: 'peer-agent', kind: 'text' as const, text: 'current trigger' },
      { ts: '1784098711.000000', sender: 'ops-bot', kind: 'text' as const, text: 'first backfilled reply' },
      { ts: '1784098787.000000', sender: 'ops-bot', kind: 'text' as const, text: 'second backfilled reply' },
      { ts: '1784098844000', sender: AGENT, kind: 'reasoning' as const, text: 'thinking after trigger' }
    ]) {
      s.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ...row,
        ...(row.kind === 'text' ? { recipient: AGENT } : {})
      })
    }

    const { messages } = createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(messages.map((m) => m.text)).toEqual([
      'first request',
      'first backfilled reply',
      'second backfilled reply',
      'current trigger',
      'thinking after trigger'
    ])
    s.close()
  })

  it('keeps chronological Slack order across history page boundaries', () => {
    const s = store()
    seedHistorySession(s)

    // Deliberately different event-time vs insertion orders. A per-page cosmetic
    // sort is insufficient: every page must be cut from the same global ordering.
    for (const n of [1, 6, 2, 5, 3, 4]) {
      s.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: `178409870${n}.000000`,
        sender: 'U1',
        recipient: AGENT,
        kind: 'text',
        text: `message-${n}`
      })
    }

    const reader = createSessionReader(s)
    const all: string[] = []
    let cursor: string | undefined
    for (let pageNo = 0; pageNo < 10; pageNo++) {
      const page = reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 2, ...(cursor ? { cursor } : {}) })
      all.unshift(...page.messages.map((m) => m.text))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    expect(all).toEqual(['message-1', 'message-2', 'message-3', 'message-4', 'message-5', 'message-6'])
    s.close()
  })

  it('uses seq as a deterministic cross-page tie-breaker for equal event times', () => {
    const s = store()
    seedHistorySession(s)
    for (const text of ['same-time-1', 'same-time-2', 'same-time-3']) {
      s.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: '1784098701500',
        sender: AGENT,
        kind: 'reasoning',
        text
      })
    }

    const reader = createSessionReader(s)
    const all: string[] = []
    let cursor: string | undefined
    do {
      const page = reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 1, ...(cursor ? { cursor } : {}) })
      all.unshift(...page.messages.map((m) => m.text))
      cursor = page.nextCursor
    } while (cursor)

    expect(all).toEqual(['same-time-1', 'same-time-2', 'same-time-3'])
    s.close()
  })

  it('finishes an in-flight legacy numeric-cursor walk in seq order', () => {
    const s = store()
    seedHistorySession(s)
    for (const n of [1, 4, 2, 3]) {
      s.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: `178409870${n}.000000`,
        sender: 'U1',
        recipient: AGENT,
        kind: 'text',
        text: `seq-${n}`
      })
    }

    // Cursor "3" means the old client already saw seq >= 3. Do not reinterpret it
    // as an event-time cursor partway through that request's pagination loop.
    const page = createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', cursor: '3', limit: 50 })
    expect(page.messages.map((m) => m.text)).toEqual(['seq-1', 'seq-4'])
    expect(page.nextCursor).toBeUndefined()
    s.close()
  })

  it('preserves insertion ordering for non-Slack platform message ids', () => {
    const s = store()
    seedHistorySession(s, { platform: 'telegram', channel: 'chat-1', thread: 'T1' })
    for (const row of [
      { ts: '100', sender: 'user-1', kind: 'text' as const, text: 'telegram message 100' },
      { ts: '1784098701500', sender: AGENT, kind: 'reasoning' as const, text: 'reasoning after 100' },
      { ts: '101', sender: 'user-1', kind: 'text' as const, text: 'telegram message 101' }
    ]) {
      s.appendTranscript({
        channel: 'chat-1',
        thread: 'T1',
        ...row,
        ...(row.kind === 'text' ? { recipient: AGENT } : {})
      })
    }

    expect(
      createSessionReader(s)
        .history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
        .messages.map((m) => m.text)
    ).toEqual(['telegram message 100', 'reasoning after 100', 'telegram message 101'])
    s.close()
  })

  it('tails in mutation order where message ids are opaque, in event order where they are not', () => {
    // Same two rows, observed newest-first, on two platforms. Mutation order and
    // display order can only diverge where the ids carry a native order — which is
    // exactly what platforms/message-ordering.ts answers.
    const tailFor = (platform: string): string[] => {
      const s = store()
      seedHistorySession(s, { platform, channel: 'chat-1', thread: 'T1' })
      const reader = createSessionReader(s)
      const initial = reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
      for (const [ts, text] of [
        ['101', 'observed first'],
        ['100', 'older, backfilled after']
      ]) {
        s.appendTranscript({
          channel: 'chat-1',
          thread: 'T1',
          ts: ts!,
          sender: 'user-1',
          recipient: AGENT,
          kind: 'text',
          text: text!
        })
      }
      const tail = reader.history({ agentId: AGENT, sessionId: 'acp-1', after: initial.liveCursor!, limit: 50 })
      s.close()
      return tail.messages.map((m) => m.text)
    }

    expect(tailFor('telegram')).toEqual(['observed first', 'older, backfilled after'])
    expect(tailFor('slack')).toEqual(['older, backfilled after', 'observed first'])
  })

  it('repairs chronological reads from a pre-upgrade transcript table', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ac-reader-order-mig-')), 'local.sqlite')
    const legacy = new DatabaseSync(path)
    legacy.exec(`
      CREATE TABLE transcript (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL, thread TEXT NOT NULL, ts TEXT,
        sender TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
        tool_call_id TEXT, body TEXT, recipient TEXT
      );
      INSERT INTO transcript (channel, thread, ts, sender, kind, text, recipient) VALUES
        ('C1', 'T1', '1784098701.000000', 'U1', 'text', 'first', '${AGENT}'),
        ('C1', 'T1', '1784098703.000000', 'U1', 'text', 'third-trigger', '${AGENT}'),
        ('C1', 'T1', '1784098702.000000', 'ops-bot', 'text', 'second-backfilled', '${AGENT}');
    `)
    legacy.close()

    // Opening the upgraded store must make already-persisted sessions read correctly;
    // the fix cannot depend on rewriting only future appends.
    const s = new LocalStore(path)
    seedHistorySession(s)

    expect(
      createSessionReader(s)
        .history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
        .messages.map((m) => m.text)
    ).toEqual(['first', 'second-backfilled', 'third-trigger'])
    s.close()
  })
})
