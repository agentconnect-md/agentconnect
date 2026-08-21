import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { createSessionReader } from '../src/cp/session-reader.js'
import { sessionThreadUrlFor } from '../src/platforms/session-links.js'

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const HOOK = '33333333-3333-4333-8333-333333333333'

async function store(): Promise<LocalStore> {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-reader-')), 'local.sqlite'))
}

async function seedHistorySession(
  s: LocalStore,
  { platform = 'slack', channel = 'C1', thread = 'T1' } = {}
): Promise<void> {
  await s.upsertSession({
    key: sessionKey(platform, channel, thread, AGENT),
    agentId: AGENT,
    platform,
    channel,
    thread,
    acpSessionId: 'acp-1',
    sessionId: 'sid-1',
    state: 'idle',
    lastDeliveredTs: null,
    updatedAt: 1
  })
}

describe('SessionReader', () => {
  it('uses the history page snapshot watermark as the initial live cursor', async () => {
    const s = await store()
    seedHistorySession(s)
    const currentTranscriptRevision = vi.fn(async () => 99)
    const history = await createSessionReader(s, undefined, {
      transcriptPageForAgentByEventTime: async () => ({ rows: [], hasMore: false, cursor: 17 }),
      transcriptPageForAgent: async () => ({ rows: [], hasMore: false, cursor: 17 }),
      transcriptTailForAgent: async () => ({ rows: [], hasMore: false, cursor: 17 }),
      currentTranscriptRevision,
      getToolBodyForAgent: async () => undefined
    } as never).history({ agentId: AGENT, sessionId: 'acp-1', limit: 20 })
    expect(history.liveCursor).toBe('17')
    expect(currentTranscriptRevision).not.toHaveBeenCalled()
    await s.close()
  })

  it('reads a session under the OUTWARD id the control plane knows it by', async () => {
    const s = await store()
    await seedHistorySession(s)
    const key = sessionKey('slack', 'C1', 'T1', AGENT)
    const outward = (await s.getSession(key))!.sessionId!
    // The id the console holds came from this daemon's own metadata frame, and it is not the
    // runtime's (session-concept.md §1.1) — a read that only knew ACP ids would answer empty.
    expect(outward).not.toBe('acp-1')
    const reader = await createSessionReader(s, undefined, {
      transcriptPageForAgentByEventTime: async () => ({ rows: [], hasMore: false, cursor: 5 }),
      transcriptPageForAgent: async () => ({ rows: [], hasMore: false, cursor: 5 }),
      transcriptTailForAgent: async () => ({ rows: [], hasMore: false, cursor: 5 }),
      currentTranscriptRevision: async () => 5,
      getToolBodyForAgent: async () => undefined
    } as never)
    expect((await reader.history({ agentId: AGENT, sessionId: outward, limit: 20 })).liveCursor).toBe('5')
    // A pre-v12 session was reported under its ACP id, so that still resolves.
    expect((await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 20 })).liveCursor).toBe('5')
    await s.close()
  })

  it('reads only the transcript namespace persisted on the session', async () => {
    const s = await store()
    await s.upsertSession({
      key: sessionKey('telegram', '42', 'dm', AGENT),
      agentId: AGENT,
      platform: 'telegram',
      channel: '42',
      thread: 'dm',
      transportScope: 'telegram:bot-b',
      acpSessionId: 'acp-scoped',
      sessionId: 'sid-scoped',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await s.appendTranscript({
      channel: transcriptChannelKey('42', 'telegram:bot-a'),
      thread: 'dm',
      ts: '1',
      sender: 'user-a',
      recipient: AGENT,
      kind: 'text',
      text: 'private to bot A'
    })
    await s.appendTranscript({
      channel: transcriptChannelKey('42', 'telegram:bot-b'),
      thread: 'dm',
      ts: '1',
      sender: 'user-b',
      recipient: AGENT,
      kind: 'text',
      text: 'private to bot B'
    })

    const history = await createSessionReader(s).history({
      agentId: AGENT,
      sessionId: 'acp-scoped',
      limit: 20
    })
    expect(history.messages.map((message) => message.text)).toEqual(['private to bot B'])
    await s.close()
  })

  it('list joins cached channel/triggeredBy names; unresolved ids omit the fields', async () => {
    const s = await store()
    await s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      sessionId: 'sid-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1,
      triggeredBy: 'U1',
      originSessionId: 'sid-parent'
    })
    await s.upsertSession({
      key: sessionKey('slack', 'C2', 'T2', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C2',
      thread: 'T2',
      acpSessionId: 'acp-2',
      sessionId: 'sid-2',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 2
    })
    await s.setDisplayName('C1', 'deploys', 1)
    await s.setDisplayName('U1', 'Dana Reyes', 1)
    await s.setSessionTitle(sessionKey('slack', 'C1', 'T1', AGENT), 'Roll back the deploy')

    const reader = createSessionReader(s)
    const { sessions } = await reader.list({})
    const byId = new Map(sessions.map((x) => [x.sessionId, x]))
    expect(byId.get('sid-1')).toMatchObject({
      parentSessionId: 'sid-parent',
      title: 'Roll back the deploy',
      channelName: 'deploys',
      triggeredBy: 'U1',
      triggeredByName: 'Dana Reyes'
    })
    // No cached names / no triggeredBy / no title → optional fields simply absent, ids intact.
    const bare = byId.get('sid-2')!
    expect(bare.sessionKey.channel).toBe('C2')
    expect(bare.title).toBeUndefined()
    expect(bare.channelName).toBeUndefined()
    expect(bare.triggeredBy).toBeUndefined()
    expect(bare.triggeredByName).toBeUndefined()
    await s.close()
  })

  it('falls back to the first user message as the title when the runtime pushed none', async () => {
    const s = await store()
    // A webchat/playground session: the runtime never pushed a session/info title.
    await s.upsertSession({
      key: sessionKey('webchat', 'conv-1', 'webchat:conv-1', AGENT),
      agentId: AGENT,
      platform: 'webchat',
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      acpSessionId: 'acp-wc',
      sessionId: 'sid-wc',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 3,
      triggeredBy: 'alice'
    })
    // The triggering user message, then the agent's reply (must NOT be used as a title).
    await s.appendTranscript({
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      ts: '1',
      sender: 'alice',
      kind: 'text',
      text: "what's your model?"
    })
    await s.appendTranscript({
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      ts: '2',
      sender: AGENT,
      kind: 'text',
      text: 'I am Claude.'
    })

    // A session that DOES have a runtime title — the fallback must not override it.
    await s.upsertSession({
      key: sessionKey('slack', 'C9', 'T9', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C9',
      thread: 'T9',
      acpSessionId: 'acp-titled',
      sessionId: 'sid-titled',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 4
    })
    await s.appendTranscript({
      channel: 'C9',
      thread: 'T9',
      ts: '1',
      sender: 'U9',
      kind: 'text',
      text: 'the first message'
    })
    await s.setSessionTitle(sessionKey('slack', 'C9', 'T9', AGENT), 'Runtime summary')

    const byId = new Map((await createSessionReader(s).list({})).sessions.map((x) => [x.sessionId, x]))
    // Untitled webchat session ⇒ named from its first user message (never the agent reply).
    expect(byId.get('sid-wc')!.title).toBe("what's your model?")
    // Runtime title wins over the first-message fallback.
    expect(byId.get('sid-titled')!.title).toBe('Runtime summary')
    await s.close()
  })

  it('first-message fallback takes one line, caps length, and rewrites <@U…> mentions', async () => {
    const s = await store()
    await s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      sessionId: 'sid-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const long = 'x'.repeat(200)
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      kind: 'text',
      text: `<@U1> ${long}\nsecond line`
    })
    await s.setDisplayName('U1', 'Dana Reyes', 1)

    const title = (await createSessionReader(s).list({})).sessions.find((x) => x.sessionId === 'sid-1')!.title!
    expect(title.startsWith('@Dana Reyes ')).toBe(true) // leading mention rewritten to @name
    expect(title.endsWith('…')).toBe(true) // long body truncated with an ellipsis
    expect(title).not.toContain('second line') // only the first line is used
    await s.close()
  })

  it('uses persisted source URLs and derives the Slack fallback from the owning workspace', async () => {
    const s = await store()
    // Slack session with a realistic thread-root ts.
    await s.upsertSession({
      key: sessionKey('slack', 'C1', '1710799200.123456', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: '1710799200.123456',
      acpSessionId: 'acp-slack',
      sessionId: 'sid-slack',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 2
    })
    // Telegram session — no Slack archives link even with a resolver.
    await s.upsertSession({
      key: sessionKey('telegram', 'chat1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'telegram',
      channel: 'chat1',
      thread: 'T1',
      acpSessionId: 'acp-tg',
      sessionId: 'sid-tg',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await s.upsertSession({
      key: sessionKey('hook', 'github:123', '42', AGENT),
      agentId: AGENT,
      platform: 'hook',
      channel: 'github:123',
      thread: '42',
      threadUrl: 'https://github.com/acme/infra/issues/42',
      acpSessionId: 'acp-github',
      sessionId: 'sid-github',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 3
    })

    // Persisted ingress links win; the strategy derives Slack's legacy/live fallback.
    const withUrl = createSessionReader(s, (session) =>
      sessionThreadUrlFor(session, { workspaceUrl: 'https://acme.slack.com/' })
    )
    const byId = new Map((await withUrl.list({})).sessions.map((x) => [x.sessionId, x]))
    expect(byId.get('sid-slack')!.threadUrl).toBe('https://acme.slack.com/archives/C1/p1710799200123456')
    expect(byId.get('sid-tg')!.threadUrl).toBeUndefined()
    expect(byId.get('sid-github')!.threadUrl).toBe('https://github.com/acme/infra/issues/42')

    // No resolver leaves only the persisted links available.
    expect(
      (await createSessionReader(s).list({})).sessions.find((x) => x.sessionId === 'sid-slack')!.threadUrl
    ).toBeUndefined()
    expect((await createSessionReader(s).list({})).sessions.find((x) => x.sessionId === 'sid-github')!.threadUrl).toBe(
      'https://github.com/acme/infra/issues/42'
    )
    expect(
      (await createSessionReader(s, () => undefined).list({})).sessions.find((x) => x.sessionId === 'sid-slack')!
        .threadUrl
    ).toBeUndefined()
    await s.close()
  })

  it('history labels senders with cached names and leaves unknown ids raw', async () => {
    const s = await store()
    const transportScope = 'slack:one'
    const transcriptChannel = transcriptChannelKey('C1', transportScope)
    await s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT, transportScope),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      transportScope,
      acpSessionId: 'acp-1',
      sessionId: 'sid-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    // The inbound message is delivered TO this agent (recipient), the reply is FROM it.
    await s.appendTranscript({
      channel: transcriptChannel,
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'hi'
    })
    await s.appendTranscript({
      channel: transcriptChannel,
      thread: 'T1',
      ts: '2',
      sender: AGENT,
      kind: 'text',
      text: 'hello'
    })
    await s.setDisplayName('U1', 'Dana Reyes', 1)
    await s.setProfileAvatar(transportScope, 'U1', 'https://avatars.example.test/dana.png', 1)

    const reader = createSessionReader(s)
    const { messages } = await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(messages.map((m) => [m.sender, m.senderName, m.senderAvatarUrl])).toEqual([
      ['U1', 'Dana Reyes', 'https://avatars.example.test/dana.png'],
      [AGENT, undefined, undefined] // agent-id senders have no cached provider profile → omitted
    ])
    await s.close()
  })

  it('history restores a daemon-local webchat image without the synthetic attachment suffix', async () => {
    const s = await store()
    seedHistorySession(s, { platform: 'webchat', channel: 'conv-1', thread: 'webchat:conv-1' })
    await s.appendTranscript({
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      ts: '1',
      sender: 'alice',
      recipient: AGENT,
      kind: 'text',
      text: 'Identify this\n[attached: screen.webp (image/webp)]',
      attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: 'aW1hZ2U=' }]
    })

    expect((await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      expect.objectContaining({
        text: 'Identify this',
        attachments: [{ name: 'screen.webp', mimeType: 'image/webp', data: 'aW1hZ2U=' }]
      })
    ])
    await s.close()
  })

  it('strips a label the row does not literally agree with (observer wrote it pre-download)', async () => {
    // recordObservedInbound recorded the Feishu label before any download settled the
    // type, so the row says application/octet-stream while the stored image is a PNG.
    const s = await store()
    seedHistorySession(s, { platform: 'feishu', channel: 'oc_1', thread: 'oc_1' })
    await s.appendTranscript({
      channel: 'oc_1',
      thread: 'oc_1',
      ts: '1',
      sender: 'ou_1',
      recipient: AGENT,
      kind: 'text',
      text: 'look\n[attached: img_v3_abc (application/octet-stream)]',
      attachments: [{ name: 'img_v3_abc', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })

    expect((await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      expect.objectContaining({
        text: 'look',
        attachments: [{ name: 'img_v3_abc', mimeType: 'image/png', data: 'aW1hZ2U=' }]
      })
    ])
    await s.close()
  })

  it('keeps the label for files it could not inline beside the one image it did', async () => {
    // Only the first small image is stored; the PDF and the over-cap second image must
    // still be visible as their labels rather than vanishing with the whole suffix.
    const s = await store()
    seedHistorySession(s)
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'review these\n[attached: small.png (image/png), report, final.pdf (application/pdf), huge.png (image/png)]',
      attachments: [{ name: 'small.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })

    expect((await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      // The comma inside `report, final.pdf` is part of the file NAME, not a separator.
      expect.objectContaining({
        text: 'review these\n[attached: report, final.pdf (application/pdf), huge.png (image/png)]',
        attachments: [{ name: 'small.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
      })
    ])
    await s.close()
  })

  it('leaves the row alone when the label names nothing the attachment matches', async () => {
    const s = await store()
    seedHistorySession(s)
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'see\n[attached: other.pdf (application/pdf)]',
      attachments: [{ name: 'shot.png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })

    expect((await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      expect.objectContaining({ text: 'see\n[attached: other.pdf (application/pdf)]' })
    ])
    await s.close()
  })

  it('carries daemon-verified Slack bot provenance to the session DTO', async () => {
    const s = await store()
    seedHistorySession(s)
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'UAPPBOT',
      trustedAgentBot: true,
      recipient: AGENT,
      kind: 'text',
      text: 'legacy agent reply'
    })

    expect((await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      expect.objectContaining({ sender: 'UAPPBOT', trustedAgentBot: true })
    ])
    await s.close()
  })

  it('binds session and tool-body reads to the authorized agent in a shared thread', async () => {
    const s = await store()
    seedHistorySession(s)
    await s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', OTHER_AGENT),
      agentId: OTHER_AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-peer',
      sessionId: 'sid-peer',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    const body = JSON.stringify({ toolCallId: 'peer-tc', rawOutput: 'restricted output' })
    await s.insertToolCall({
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
    expect((await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([])
    expect((await reader.toolBody({ agentId: AGENT, sessionId: 'acp-1', toolCallId: 'peer-tc', offset: 0 })).data).toBe(
      ''
    )
    // The session itself is also bound to its agent, while the peer owner can read its body.
    expect((await reader.history({ agentId: OTHER_AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([])
    expect(
      (await reader.toolBody({ agentId: OTHER_AGENT, sessionId: 'acp-1', toolCallId: 'peer-tc', offset: 0 })).data
    ).toBe('')
    expect(
      (await reader.toolBody({ agentId: OTHER_AGENT, sessionId: 'acp-peer', toolCallId: 'peer-tc', offset: 0 })).data
    ).toBe(body)
    await s.close()
  })

  it('keeps session reads available for a rolling upgrade from a legacy CP', async () => {
    const s = await store()
    seedHistorySession(s)
    const body = JSON.stringify({ toolCallId: 'tc-1', rawOutput: 'ok' })
    await s.insertToolCall({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: AGENT,
      toolCallId: 'tc-1',
      title: 'legacy-compatible tool call',
      body
    })

    const reader = createSessionReader(s)
    expect((await reader.history({ sessionId: 'acp-1', limit: 50 })).messages).toHaveLength(1)
    expect((await reader.toolBody({ sessionId: 'acp-1', toolCallId: 'tc-1', offset: 0 })).data).toBe(body)
    await s.close()
  })

  it('history scopes to what THIS agent received or produced (no peer cross-talk)', async () => {
    const s = await store()
    await s.upsertSession({
      key: sessionKey('slack', 'C1', 'T1', AGENT),
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'T1',
      acpSessionId: 'acp-1',
      sessionId: 'sid-1',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    // Delivered to THIS agent + its own reply.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'to-me'
    })
    await s.appendTranscript({ channel: 'C1', thread: 'T1', ts: '2', sender: AGENT, kind: 'text', text: 'my-reply' })
    // A peer sharing this (channel, thread): a message addressed to it + its own reply and
    // PRIVATE reasoning must NOT surface in this agent's session view.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '3',
      sender: 'U1',
      recipient: 'other-agent',
      kind: 'text',
      text: 'to-other'
    })
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '4',
      sender: 'other-agent',
      kind: 'text',
      text: 'other-reply'
    })
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '5',
      sender: 'other-agent',
      kind: 'reasoning',
      text: 'other-thinks'
    })

    const reader = createSessionReader(s)
    const { messages } = await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(messages.map((m) => m.text)).toEqual(['to-me', 'my-reply'])
    await s.close()
  })

  it('tails inserts, same-seq tool updates, and newly visible shared deliveries', async () => {
    const s = await store()
    seedHistorySession(s)
    const reader = createSessionReader(s)
    const initial = await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(initial.liveCursor).toBe('0')

    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      kind: 'text',
      text: 'first'
    })
    await s.insertToolCall({
      channel: 'C1',
      thread: 'T1',
      ts: '2',
      sender: AGENT,
      toolCallId: 'tc-live',
      title: 'Running',
      body: JSON.stringify({ toolCallId: 'tc-live', status: 'in_progress' })
    })

    const inserted = await reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: initial.liveCursor!,
      limit: 50
    })
    expect(inserted.messages.map((message) => message.text)).toEqual(['first', 'Running'])
    expect(inserted.liveCursor).toBe('2')

    const toolSeq = inserted.messages[1]!.seq
    await s.updateToolCall('C1', 'T1', AGENT, 'tc-live', {
      title: 'Complete',
      body: JSON.stringify({ toolCallId: 'tc-live', status: 'completed' })
    })
    const updated = await reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: inserted.liveCursor!,
      limit: 50
    })
    expect(updated.messages).toEqual([
      expect.objectContaining({ seq: toolSeq, text: 'Complete', toolStatus: 'completed' })
    ])

    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '3',
      sender: OTHER_AGENT,
      kind: 'reasoning',
      text: 'peer-private'
    })
    const privateAdvance = await reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: updated.liveCursor!,
      limit: 50
    })
    expect(privateAdvance.messages).toEqual([])

    for (const recipient of [OTHER_AGENT, AGENT]) {
      await s.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ts: '4',
        sender: 'U1',
        recipient,
        kind: 'text',
        text: 'shared-later'
      })
    }
    const shared = await reader.history({
      agentId: AGENT,
      sessionId: 'acp-1',
      after: privateAdvance.liveCursor!,
      limit: 50
    })
    expect(shared.messages.map((message) => message.text)).toEqual(['shared-later'])
    await s.close()
  })

  it('orders Slack history by event time when older thread rows are backfilled after the trigger', async () => {
    const s = await store()
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
      await s.appendTranscript({
        channel: 'C1',
        thread: 'T1',
        ...row,
        ...(row.kind === 'text' ? { recipient: AGENT } : {})
      })
    }

    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(messages.map((m) => m.text)).toEqual([
      'first request',
      'first backfilled reply',
      'second backfilled reply',
      'current trigger',
      'thinking after trigger'
    ])
    await s.close()
  })

  it('keeps chronological Slack order across history page boundaries', async () => {
    const s = await store()
    seedHistorySession(s)

    // Deliberately different event-time vs insertion orders. A per-page cosmetic
    // sort is insufficient: every page must be cut from the same global ordering.
    for (const n of [1, 6, 2, 5, 3, 4]) {
      await s.appendTranscript({
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
      const page = await reader.history({
        agentId: AGENT,
        sessionId: 'acp-1',
        limit: 2,
        ...(cursor ? { cursor } : {})
      })
      all.unshift(...page.messages.map((m) => m.text))
      if (!page.nextCursor) break
      cursor = page.nextCursor
    }

    expect(all).toEqual(['message-1', 'message-2', 'message-3', 'message-4', 'message-5', 'message-6'])
    await s.close()
  })

  it('uses seq as a deterministic cross-page tie-breaker for equal event times', async () => {
    const s = await store()
    seedHistorySession(s)
    for (const text of ['same-time-1', 'same-time-2', 'same-time-3']) {
      await s.appendTranscript({
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
      const page = await reader.history({
        agentId: AGENT,
        sessionId: 'acp-1',
        limit: 1,
        ...(cursor ? { cursor } : {})
      })
      all.unshift(...page.messages.map((m) => m.text))
      cursor = page.nextCursor
    } while (cursor)

    expect(all).toEqual(['same-time-1', 'same-time-2', 'same-time-3'])
    await s.close()
  })

  it('finishes an in-flight legacy numeric-cursor walk in seq order', async () => {
    const s = await store()
    seedHistorySession(s)
    for (const n of [1, 4, 2, 3]) {
      await s.appendTranscript({
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
    const page = await createSessionReader(s).history({
      agentId: AGENT,
      sessionId: 'acp-1',
      cursor: '3',
      limit: 50
    })
    expect(page.messages.map((m) => m.text)).toEqual(['seq-1', 'seq-4'])
    expect(page.nextCursor).toBeUndefined()
    await s.close()
  })

  it('preserves insertion ordering for non-Slack platform message ids', async () => {
    const s = await store()
    seedHistorySession(s, { platform: 'telegram', channel: 'chat-1', thread: 'T1' })
    for (const row of [
      { ts: '100', sender: 'user-1', kind: 'text' as const, text: 'telegram message 100' },
      { ts: '1784098701500', sender: AGENT, kind: 'reasoning' as const, text: 'reasoning after 100' },
      { ts: '101', sender: 'user-1', kind: 'text' as const, text: 'telegram message 101' }
    ]) {
      await s.appendTranscript({
        channel: 'chat-1',
        thread: 'T1',
        ...row,
        ...(row.kind === 'text' ? { recipient: AGENT } : {})
      })
    }

    expect(
      (await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages.map(
        (m) => m.text
      )
    ).toEqual(['telegram message 100', 'reasoning after 100', 'telegram message 101'])
    await s.close()
  })

  it('tails in mutation order where message ids are opaque, in event order where they are not', async () => {
    // Same two rows, observed newest-first, on two platforms. Mutation order and
    // display order can only diverge where the ids carry a native order — which is
    // exactly what platforms/message-ordering.ts answers.
    const tailFor = async (platform: string): Promise<string[]> => {
      const s = await store()
      seedHistorySession(s, { platform, channel: 'chat-1', thread: 'T1' })
      const reader = createSessionReader(s)
      const initial = await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
      for (const [ts, text] of [
        ['101', 'observed first'],
        ['100', 'older, backfilled after']
      ]) {
        await s.appendTranscript({
          channel: 'chat-1',
          thread: 'T1',
          ts: ts!,
          sender: 'user-1',
          recipient: AGENT,
          kind: 'text',
          text: text!
        })
      }
      const tail = await reader.history({
        agentId: AGENT,
        sessionId: 'acp-1',
        after: initial.liveCursor!,
        limit: 50
      })
      await s.close()
      return tail.messages.map((m) => m.text)
    }

    expect(await tailFor('telegram')).toEqual(['observed first', 'older, backfilled after'])
    expect(await tailFor('slack')).toEqual(['older, backfilled after', 'observed first'])
  })
  // The pool's shared store is read by every member, and a member holds only the agents whose
  // duty it took: an idle agent is installed nowhere, so no member can resolve its org locally.
  // The reading CP names the org in the frame, and that is what the read is partitioned by —
  // otherwise the transcript is one query away from a live member and answers a hard failure.
  it('reads a pooled transcript through a member that does not hold the agent', async () => {
    const database = SqliteAsyncDatabase.adopt(new DatabaseSync(':memory:'))
    const holder = await LocalStore.open({
      database,
      shared: true,
      ownerId: 'member-1',
      orgForAgent: (id) => (id === AGENT ? 'org-a' : undefined)
    })
    // The peer holds nothing: every agent is unknown to it, as after a rollout.
    const peer = await LocalStore.open({ database, shared: true, ownerId: 'member-2', orgForAgent: () => undefined })
    await seedHistorySession(holder)
    await holder.appendTranscript({
      channel: transcriptChannelKey('C1', null),
      thread: 'T1',
      ts: '1',
      sender: 'user-1',
      recipient: AGENT,
      kind: 'text',
      text: 'still there'
    })

    const read = createSessionReader(peer)
    const page = await read.history({ agentId: AGENT, sessionId: 'acp-1', limit: 20 }, { orgId: 'org-a' })
    expect(page.messages.map((m) => m.text)).toEqual(['still there'])
    // Without an org from the frame the peer has nothing to partition by, and says so.
    await expect(read.history({ agentId: AGENT, sessionId: 'acp-1', limit: 20 })).rejects.toThrow(
      /cannot resolve the transcript organization/
    )
    await holder.close() // one database behind both handles: closing it once is closing it
  })
})
