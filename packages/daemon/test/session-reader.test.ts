import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { LocalStore, sessionKey, transcriptChannelKey } from '../src/store/local-store.js'
import { SqliteAsyncDatabase } from '../src/store/sqlite-async-database.js'
import { createSessionReader, previewAppBody } from '../src/cp/session-reader.js'
import { sessionThreadUrlFor } from '../src/platforms/session-links.js'
import { TranscriptRecorder } from '../src/session/transcript-recorder.js'
import { canonicalPostId } from '../src/messages/post-id.js'
import { SessionMessage } from '@agentconnect.md/protocol'

/** The admission a session-internal row (tool / plan / card) always carries — its own sender's
 *  session, keyed exactly as {@link readScope} keys a `createNew` conversation. */
export const admitted = <T extends { sender: string; channel: string; thread: string }>(
  e: T
): T & { admission: { agentId: string; sessionKey: string } } => ({
  ...e,
  admission: { agentId: e.sender, sessionKey: `k:${e.channel}:${e.thread}:${e.sender}` }
})

const AGENT = '11111111-1111-4111-8111-111111111111'
const OTHER_AGENT = '22222222-2222-4222-8222-222222222222'
const HOOK = '33333333-3333-4333-8333-333333333333'

async function store(): Promise<LocalStore> {
  return await LocalStore.open(join(mkdtempSync(join(tmpdir(), 'ac-reader-')), 'local.sqlite'))
}

/** The pair the ingest path writes for a delivery: provenance plus the admission naming the
 *  session this row joined, resolved from the session the fixture seeded. */
async function delivered(
  s: LocalStore,
  agentId: string,
  channel: string,
  thread: string
): Promise<{ recipient: string; admission: { agentId: string; sessionKey: string } }> {
  const rec = (await s.listSessions(agentId)).find(
    (r) => transcriptChannelKey(r.channel, r.transportScope) === channel && r.thread === thread
  )
  return { recipient: agentId, admission: { agentId, sessionKey: rec?.key ?? `k:${channel}:${thread}:${agentId}` } }
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
      ...(await delivered(s, AGENT, transcriptChannelKey('42', 'telegram:bot-a'), 'dm')),
      kind: 'text',
      text: 'private to bot A'
    })
    await s.appendTranscript({
      channel: transcriptChannelKey('42', 'telegram:bot-b'),
      thread: 'dm',
      ts: '1',
      sender: 'user-b',
      ...(await delivered(s, AGENT, transcriptChannelKey('42', 'telegram:bot-b'), 'dm')),
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
      ...(await delivered(s, AGENT, transcriptChannel, 'T1')),
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
      ...(await delivered(s, AGENT, 'conv-1', 'webchat:conv-1')),
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

  it('serves a row an AHP client keyed by a non-UUID turn id under its canonical post id', async () => {
    const s = await store()
    seedHistorySession(s, { platform: 'webchat', channel: 'conv-1', thread: 'webchat:conv-1' })
    await s.appendTranscript({
      channel: 'conv-1',
      thread: 'webchat:conv-1',
      ts: '1',
      sender: 'alice',
      ...(await delivered(s, AGENT, 'conv-1', 'webchat:conv-1')),
      kind: 'text',
      text: 'from VS Code',
      postId: 'request_1866be00-76e6-4e68-a870-016d6587d234'
    })
    const [message] = (await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages
    expect(message?.postId).toBe(canonicalPostId('request_1866be00-76e6-4e68-a870-016d6587d234'))
    expect(SessionMessage.safeParse(message).success).toBe(true)
    await s.close()
  })

  it('strips a label the row does not literally agree with (observer wrote it pre-download)', async () => {
    // The step-1 channel record wrote the Feishu label before any download settled the type, so the
    // row says application/octet-stream while the stored image is a PNG.
    const s = await store()
    seedHistorySession(s, { platform: 'feishu', channel: 'oc_1', thread: 'oc_1' })
    await s.appendTranscript({
      channel: 'oc_1',
      thread: 'oc_1',
      ts: '1',
      sender: 'ou_1',
      ...(await delivered(s, AGENT, 'oc_1', 'oc_1')),
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
      ...(await delivered(s, AGENT, 'C1', 'T1')),
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

  it('drops an inlined image from a marker whose file names contain brackets', async () => {
    const s = await store()
    seedHistorySession(s)
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      ...(await delivered(s, AGENT, 'C1', 'T1')),
      kind: 'text',
      text: 'see\n[attached: [a][b].png (image/png), [Tag].S01.torrent (application/x-bittorrent)]',
      attachments: [{ name: '[a][b].png', mimeType: 'image/png', data: 'aW1hZ2U=' }]
    })

    expect((await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      expect.objectContaining({ text: 'see\n[attached: [Tag].S01.torrent (application/x-bittorrent)]' })
    ])
    await s.close()
  })

  it('returns every stored image a CP admits and only the first to one that names no bound', async () => {
    // Pasted Slack images share one name, so each stored image strips one whole marker entry.
    const s = await store()
    seedHistorySession(s)
    const raccoon = { name: 'image.png', mimeType: 'image/png' as const, data: 'aW1hZ2U=' }
    const lion = { name: 'image.png', mimeType: 'image/jpeg' as const, data: 'bGlvbg==' }
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      ...(await delivered(s, AGENT, 'C1', 'T1')),
      kind: 'text',
      text: 'which animals?\n[attached: image.png (image/png), my-image.png (image/png), image.png (image/png)]',
      attachments: [raccoon, lion]
    })

    const reader = createSessionReader(s)
    expect(
      (await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50, imagesPerMessage: 4 })).messages
    ).toEqual([
      expect.objectContaining({
        text: 'which animals?\n[attached: my-image.png (image/png)]',
        attachments: [raccoon, lion]
      })
    ])
    // An older CP's response schema admits one image, so the second stays a label.
    expect((await reader.history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      expect.objectContaining({
        text: 'which animals?\n[attached: my-image.png (image/png), image.png (image/png)]',
        attachments: [raccoon]
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
      ...(await delivered(s, AGENT, 'C1', 'T1')),
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
      ...(await delivered(s, AGENT, 'C1', 'T1')),
      kind: 'text',
      text: 'legacy agent reply'
    })

    expect((await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages).toEqual([
      expect.objectContaining({ sender: 'UAPPBOT', trustedAgentBot: true })
    ])
    await s.close()
  })

  it('carries a text row’s turn body inline, and drops only the prompt when it is oversized', async () => {
    const s = await store()
    seedHistorySession(s)
    const small = JSON.stringify({
      prompt: 'full prompt',
      codehost: { provider: 'github', event: 'issues:opened', subject: {} }
    })
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      ...(await delivered(s, AGENT, 'C1', 'T1')),
      kind: 'text',
      text: 'Opened #1',
      body: small
    })
    const big = JSON.stringify({
      prompt: 'x'.repeat(40 * 1024),
      codehost: { provider: 'github', event: 'issues:opened', subject: {} }
    })
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '2',
      sender: 'U1',
      ...(await delivered(s, AGENT, 'C1', 'T1')),
      kind: 'text',
      text: 'Opened #2',
      body: big
    })
    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    const byTs = new Map(messages.map((m) => [m.ts, m]))
    expect(byTs.get('1')).toMatchObject({ text: 'Opened #1', body: small })
    expect(byTs.get('1')!.bodyTruncated).toBeUndefined()
    const shrunk = byTs.get('2')!
    expect(shrunk.text).toBe('Opened #2')
    expect(JSON.parse(shrunk.body!)).toEqual({ codehost: { provider: 'github', event: 'issues:opened', subject: {} } })
    expect(shrunk.bodyTruncated).toBe(true)
    expect(shrunk.bodyBytes).toBe(Buffer.byteLength(big))
    await s.close()
  })

  it('carries a persisted MCP App card’s body, so a reloaded conversation still shows the card', async () => {
    const s = await store()
    await seedHistorySession(s)
    const body = JSON.stringify({
      appId: 'app-1',
      title: 'Token balances',
      toolName: 'charts__get_wallet_balances',
      server: 'charts',
      conversationId: 'C1',
      html: '<p>chart</p>',
      outcome: 'closed'
    })
    await s.upsertApp(
      admitted({
        channel: 'C1',
        thread: 'T1',
        ts: '1',
        sender: AGENT,
        appId: 'app-1',
        text: 'Token balances',
        body
      })
    )
    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    // A card that fits rides whole — template included, which is what re-renders the page.
    expect(messages).toEqual([
      expect.objectContaining({ kind: 'app', text: 'Token balances', body, toolCallId: 'app:app-1' })
    ])
    expect(messages[0]!.bodyTruncated).toBeUndefined()
    await s.close()
  })

  it('carries a webchat capability card and its settlement, so a reloaded conversation still shows both', async () => {
    const s = await store()
    await seedHistorySession(s)
    const card = {
      requestId: '7f3a1c56-8a2b-4c3d-9e4f-0a1b2c3d4e5f',
      generation: 1,
      summary: 'add the MCP server "Linear"',
      reason: 'filing needs Linear',
      link: 'https://console.example.test/example-org/requests/7f3a'
    }
    const row = { channel: 'C1', thread: 'T1', ts: '1', sender: AGENT, requestId: card.requestId, text: card.summary }
    await s.upsertCapabilityCard(admitted({ ...row, body: JSON.stringify({ ...card, status: 'open' }) }))
    const settled = JSON.stringify({
      ...card,
      status: 'declined',
      text: '🚫 Declined by Ben — add the MCP server "Linear"'
    })
    await s.upsertCapabilityCard(admitted({ ...row, body: settled }))
    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    // One row per request, rewritten in place.
    expect(messages).toEqual([expect.objectContaining({ kind: 'capability', text: card.summary, body: settled })])
    await s.close()
  })

  it('reads a Fill card row with its descriptors, settled in place, and no value', async () => {
    const s = await store()
    await seedHistorySession(s)
    const card = {
      requestId: '7f9d6c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f',
      computerName: 'Desk',
      website: { origin: 'https://login.example.test' },
      kind: 'login',
      fields: [
        { id: 'f1', control: 'password', purpose: 'current-password', required: true, secret: true, empty: true }
      ],
      expiresAt: '2026-11-10T10:10:00.000Z'
    }
    const text = 'Fill form on https://login.example.test'
    const row = { channel: 'C1', thread: 'T1', ts: '1', sender: AGENT, requestId: card.requestId, text }
    await s.upsertFillCard(admitted({ ...row, body: JSON.stringify(card) }))
    const settled = JSON.stringify({ ...card, resolved: 'filled' })
    await s.upsertFillCard(admitted({ ...row, body: settled }))
    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    expect(messages).toEqual([expect.objectContaining({ kind: 'fill', text, body: settled })])
    await s.close()
  })

  it('drops only the TEMPLATE from an oversized app card, leaving the card fetchable whole', async () => {
    const s = await store()
    await seedHistorySession(s)
    const card = {
      appId: 'app-2',
      title: 'Token balances',
      toolName: 'charts__get_wallet_balances',
      server: 'charts',
      conversationId: 'C1',
      toolResult: { structuredContent: { total: 1 } }
    }
    const body = JSON.stringify({ ...card, html: `<p>${'x'.repeat(40 * 1024)}</p>` })
    await s.upsertApp(
      admitted({
        channel: 'C1',
        thread: 'T1',
        ts: '1',
        sender: AGENT,
        appId: 'app-2',
        text: 'Token balances',
        body
      })
    )
    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    const row = messages[0]!
    // The page never rides a transcript page; the row says so and names the key the console
    // pulls the whole card back under, which is the same read an oversized tool body uses.
    expect(JSON.parse(row.body!)).toEqual(card)
    expect(row.bodyTruncated).toBe(true)
    expect(row.bodyBytes).toBe(Buffer.byteLength(body))
    expect(row.toolCallId).toBe('app:app-2')
    expect(
      await createSessionReader(s).toolBody({ agentId: AGENT, sessionId: 'acp-1', toolCallId: 'app:app-2', offset: 0 })
    ).toMatchObject({ totalBytes: Buffer.byteLength(body) })
    await s.close()
  })

  it('keeps an app card READABLE when even its template-less body is oversized', async () => {
    // The shape that shipped broken: a `get_defi_positions` card whose own tool result is ~57 KiB,
    // so dropping the 500 KiB template still leaves a body over the page cap. Giving up there sent
    // the console a row with no body at all, which it cannot read as a card — so the card vanished
    // on reload, which is the whole bug this feature exists to fix.
    const s = await store()
    await seedHistorySession(s)
    const card = {
      appId: 'app-3',
      title: 'DeFi positions',
      toolName: 'charts__get_defi_positions',
      server: 'charts',
      conversationId: 'C1',
      outcome: 'expired',
      toolInput: { chain: 'eth' },
      // Big enough that dropping the 200 KiB template still leaves the body over the cap — the
      // whole point of the case. The real one was ~57 KiB of positions.
      toolResult: {
        structuredContent: { positions: Array.from({ length: 4000 }, (_, i) => `position-${i}-0x${'a'.repeat(12)}`) }
      }
    }
    const body = JSON.stringify({ ...card, html: `<p>${'x'.repeat(200 * 1024)}</p>` })
    await s.upsertApp(
      admitted({
        channel: 'C1',
        thread: 'T1',
        ts: '1',
        sender: AGENT,
        appId: 'app-3',
        text: 'DeFi positions',
        body
      })
    )
    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })
    const row = messages[0]!
    const preview = JSON.parse(row.body!) as Record<string, unknown>
    // The identity survives whatever else is shed — that is what makes it a card and not a line.
    expect(preview).toMatchObject({ appId: 'app-3', title: 'DeFi positions', toolName: 'charts__get_defi_positions' })
    expect(preview.outcome).toBe('expired')
    // Both heavy halves are gone — the template AND the result that kept it over the cap.
    expect(preview.html).toBeUndefined()
    expect(preview.toolResult).toBeUndefined()
    // Shed in order: the arguments are lighter than the result and survive it.
    expect(preview.toolInput).toEqual({ chain: 'eth' })
    expect(Buffer.byteLength(row.body!)).toBeLessThanOrEqual(32 * 1024)
    expect(row.bodyTruncated).toBe(true)
    expect(row.bodyBytes).toBe(Buffer.byteLength(body))
    // And the whole card — template and result — is still one fetch away under the same key.
    const full = await createSessionReader(s).toolBody({
      agentId: AGENT,
      sessionId: 'acp-1',
      toolCallId: 'app:app-3',
      offset: 0
    })
    expect(full.totalBytes).toBe(Buffer.byteLength(body))
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
    await s.insertToolCall(
      admitted({
        channel: 'C1',
        thread: 'T1',
        ts: '1',
        sender: OTHER_AGENT,
        toolCallId: 'peer-tc',
        title: 'restricted tool call',
        body
      })
    )

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
    await s.insertToolCall(
      admitted({
        channel: 'C1',
        thread: 'T1',
        ts: '1',
        sender: AGENT,
        toolCallId: 'tc-1',
        title: 'legacy-compatible tool call',
        body
      })
    )

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
      ...(await delivered(s, AGENT, 'C1', 'T1')),
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
      ...(await delivered(s, 'other-agent', 'C1', 'T1')),
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

  // message-intake.md §4: an append session's rows carry a physical thread its coordinate never
  // matches, so the console page can only find them through the admission.
  it('returns an append session its admitted rows, and no peer internal row from the same thread', async () => {
    const s = await store()
    const coordinate = 'append:1700000000000'
    const key = sessionKey('slack', 'C1', coordinate, AGENT)
    await s.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: coordinate,
      acpSessionId: 'acp-append',
      sessionId: 'sid-append',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '1',
      sender: 'U1',
      recipient: AGENT,
      admission: { agentId: AGENT, sessionKey: key },
      kind: 'text',
      text: 'mine'
    })
    // A peer's private rows in the SAME physical thread must not leak into this session.
    await s.appendTranscript({
      channel: 'C1',
      thread: 'T1',
      ts: '2',
      sender: OTHER_AGENT,
      kind: 'reasoning',
      text: 'peer-thinks'
    })
    await s.insertToolCall({
      channel: 'C1',
      thread: 'T1',
      ts: '3',
      sender: OTHER_AGENT,
      toolCallId: 'tc-peer',
      title: 'Bash',
      body: '{}',
      admission: { agentId: OTHER_AGENT, sessionKey: 'slack:C1:append:2:other' }
    })

    const { messages } = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-append', limit: 50 })
    expect(messages.map((m) => m.text)).toEqual(['mine'])
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
      ...(await delivered(s, AGENT, 'C1', 'T1')),
      kind: 'text',
      text: 'first'
    })
    await s.insertToolCall(
      admitted({
        channel: 'C1',
        thread: 'T1',
        ts: '2',
        sender: AGENT,
        toolCallId: 'tc-live',
        title: 'Running',
        body: JSON.stringify({ toolCallId: 'tc-live', status: 'in_progress' })
      })
    )

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
        ...(await delivered(s, recipient, 'C1', 'T1')),
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
        ...(row.kind === 'text' ? await delivered(s, AGENT, 'C1', 'T1') : {})
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
        ...(await delivered(s, AGENT, 'C1', 'T1')),
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
        ...(await delivered(s, AGENT, 'C1', 'T1')),
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
        ...(row.kind === 'text' ? await delivered(s, AGENT, 'chat-1', 'T1') : {})
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
          ...(await delivered(s, AGENT, 'chat-1', 'T1')),
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
      ...(await delivered(holder, AGENT, transcriptChannelKey('C1', null), 'T1')),
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

// A computer tool result as the runtime reports it: the screenshot's base64, then the text naming where it was stored.
const SHOT_HASH = 'c'.repeat(64)
const screenshotContent = (imageChars: number) => [
  { type: 'content', content: { type: 'image', mimeType: 'image/png', data: 'A'.repeat(imageChars) } },
  { type: 'content', content: { type: 'text', text: JSON.stringify({ width: 1280, stored: `sha256:${SHOT_HASH}` }) } }
]

describe('the roots view and session/thread (webchat-threads.md §8)', () => {
  it('uses the same scoped provider avatar in a thread summary and its messages', async () => {
    const s = await store()
    const transportScope = 'slack:one'
    const key = sessionKey('slack', 'C1', 'append:c', AGENT, transportScope)
    await s.upsertSession({
      key,
      agentId: AGENT,
      platform: 'slack',
      channel: 'C1',
      thread: 'append:c',
      transportScope,
      acpSessionId: 'acp-coord',
      sessionId: 'sid-coord',
      state: 'idle',
      lastDeliveredTs: null,
      updatedAt: 1
    })
    for (const [ts, sender] of [
      ['100.1', 'U1'],
      ['100.2', 'U2']
    ] as const) {
      await s.appendTranscript({
        channel: transcriptChannelKey('C1', transportScope),
        thread: '100.1',
        ts,
        sender,
        kind: 'text',
        text: 'hello',
        admission: { agentId: AGENT, sessionKey: key }
      })
    }
    await s.setDisplayName('U2', 'Dana Reyes', 1)
    await s.setProfileAvatar(transportScope, 'U2', 'https://avatars.example.test/dana.png', 1)
    await s.setProfileAvatar('slack:other', 'U2', 'https://avatars.example.test/other.png', 1)
    const reader = createSessionReader(s)
    const roots = await reader.history({ agentId: AGENT, sessionId: 'sid-coord', limit: 50, view: 'roots' })
    const thread = await reader.thread({ agentId: AGENT, sessionId: 'sid-coord', rootId: '100.1', limit: 50 })
    const author = { sender: 'U2', senderName: 'Dana Reyes', senderAvatarUrl: 'https://avatars.example.test/dana.png' }
    expect(roots.threads?.[0]?.participants).toEqual([author])
    expect(thread.summary?.participants).toEqual([author])
    expect(thread.messages.find((m) => m.sender === 'U2')).toMatchObject(author)
    await s.close()
  })

  const CONV = '5a0e8c4d-2b7f-4e19-9c3a-6d8b1f2e4a70'
  const R1 = '0f9c2b1e-5d4a-4c3b-9a8f-7e6d5c4b3a21'
  const R2 = '6b1d7e2f-3a4c-4d5e-8f90-a1b2c3d4e5f6'
  const LEGACY = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b'
  const REPLY = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
  const coordinatorKey = sessionKey('webchat', CONV, 'append:c', AGENT)
  const taskKey = sessionKey('webchat', CONV, R1, AGENT)
  const coordinator = { agentId: AGENT, sessionKey: coordinatorKey }
  const task = { agentId: AGENT, sessionKey: taskKey }
  const session = (key: string, thread: string, sessionId: string, state: 'idle' | 'prompting') => ({
    key,
    agentId: AGENT,
    platform: 'webchat',
    channel: CONV,
    thread,
    acpSessionId: `acp-${sessionId}`,
    sessionId,
    state,
    lastDeliveredTs: null,
    updatedAt: 1
  })
  const post = (ts: string, thread: string, extra: Record<string, unknown> = {}) => ({
    channel: CONV,
    thread,
    ts,
    sender: 'U1',
    kind: 'text' as const,
    text: `m${ts}`,
    postId: crypto.randomUUID(),
    ...extra
  })

  // A member's coordinator conversation: a root a task holds, the coordinator's turns on it and on a reply, its post in the thread, an empty root and a legacy root.
  async function conversation() {
    const s = await store()
    await s.upsertSession(session(coordinatorKey, 'append:c', 'sid-coord', 'idle'))
    await s.upsertSession(session(taskKey, R1, 'sid-task', 'prompting'))
    await s.appendTranscript(post('1', R1, { postId: R1, admission: coordinator }))
    await s.appendTranscript(post('2', R1, { sender: AGENT, admission: coordinator }))
    await s.appendTranscript(post('3', R1, { sender: 'U2', postId: REPLY, admission: coordinator }))
    await s.appendTranscript(post('4', R1, { sender: AGENT, admission: coordinator }))
    await s.appendTranscript(post('5', R1, { sender: AGENT, admission: coordinator, body: '{"threadPost":true}' }))
    await s.appendTranscript(post('6', R1, { sender: AGENT, admission: task }))
    await s.appendTranscript(post('7', R1, { sender: 'U3', text: `<@U2>   thanks,\n  that worked ${'x'.repeat(300)}` }))
    await s.appendTranscript(post('8', R2, { postId: R2, admission: coordinator }))
    await s.appendTranscript(post('9', `webchat:${CONV}`, { postId: LEGACY, admission: coordinator }))
    await s.appendTranscript(post('10', LEGACY, { admission: coordinator }))
    await s.assistantSubsessions.open({
      agentId: AGENT,
      childSessionKey: taskKey,
      parentSessionId: 'sid-coord',
      parentSessionKey: coordinatorKey,
      title: 'Fix the login bug',
      now: 1
    })
    await s.assistantSubsessions.attachThread({
      agentId: AGENT,
      childSessionKey: taskKey,
      platform: 'webchat',
      channel: CONV,
      thread: R1,
      sinceRound: 1,
      now: 1
    })
    await s.setDisplayName('U2', 'Dana Reyes', 1)
    return s
  }

  const heldThread = {
    rootId: R1,
    rootExcerpt: 'm1',
    replies: 4,
    lastReplyAt: '1970-01-01T00:00:07.000Z',
    lastReply: { sender: 'U3', excerpt: `@Dana Reyes thanks, that worked ${'x'.repeat(167)}…` },
    participants: [{ sender: 'U3' }, { sender: AGENT }, { sender: 'U2', senderName: 'Dana Reyes' }],
    task: { sessionId: 'sid-task', title: 'Fix the login bug', state: 'open' },
    running: true
  }

  it('shows roots and coordinator turns, marks a turn’s rows with their thread, and summarizes each thread', async () => {
    const s = await conversation()
    const page = await createSessionReader(s).history({
      agentId: AGENT,
      sessionId: 'sid-coord',
      limit: 50,
      view: 'roots'
    })
    expect(page.messages.map((m) => [m.ts, m.thread])).toEqual([
      ['1', undefined],
      ['2', R1],
      ['3', R1],
      ['4', R1],
      ['8', undefined],
      ['9', undefined],
      ['10', LEGACY]
    ])
    expect(SessionMessage.array().parse(page.messages)).toHaveLength(7)
    expect(page.threads).toEqual([
      heldThread,
      {
        rootId: LEGACY,
        rootExcerpt: 'm9',
        replies: 1,
        lastReplyAt: '1970-01-01T00:00:10.000Z',
        lastReply: { sender: 'U1', excerpt: 'm10' },
        participants: [{ sender: 'U1' }]
      }
    ])
    // The session's own transcript is unchanged: the post in the thread, and no marks or summaries.
    const flat = await createSessionReader(s).history({ agentId: AGENT, sessionId: 'sid-coord', limit: 50 })
    expect(flat.messages.map((m) => [m.ts, m.thread])).toEqual(
      ['1', '2', '3', '4', '5', '8', '9', '10'].map((ts) => [ts, undefined])
    )
    expect(flat.threads).toBeUndefined()
    await s.close()
  })

  it('carries, on a forward roots page, the threads that changed since its cursor', async () => {
    const s = await conversation()
    const reader = createSessionReader(s)
    const first = await reader.history({ agentId: AGENT, sessionId: 'sid-coord', limit: 50, view: 'roots' })
    await s.appendTranscript(post('11', R2, { sender: 'U2' }))
    const tail = await reader.history({
      agentId: AGENT,
      sessionId: 'sid-coord',
      limit: 50,
      view: 'roots',
      after: first.liveCursor!
    })
    expect(tail.messages).toEqual([])
    expect(tail.threads).toEqual([
      {
        rootId: R2,
        rootExcerpt: 'm8',
        replies: 1,
        lastReplyAt: '1970-01-01T00:00:11.000Z',
        lastReply: { sender: 'U2', senderName: 'Dana Reyes', excerpt: 'm11' },
        participants: [{ sender: 'U2', senderName: 'Dana Reyes' }]
      }
    ])
    await s.close()
  })

  it('holds a forward page’s cursor back when more threads changed than it carries, so none is skipped', async () => {
    const s = await conversation()
    const reader = createSessionReader(s)
    const roots = Array.from({ length: 21 }, () => crypto.randomUUID())
    for (const [i, root] of roots.entries())
      await s.appendTranscript(post(String(100 + i), root, { postId: root, admission: coordinator }))
    const first = await reader.history({ agentId: AGENT, sessionId: 'sid-coord', limit: 50, view: 'roots' })
    for (const [i, root] of roots.entries()) await s.appendTranscript(post(String(200 + i), root, { sender: 'U3' }))
    const tail = { agentId: AGENT, sessionId: 'sid-coord', limit: 50, view: 'roots' as const }
    const one = await reader.history({ ...tail, after: first.liveCursor! })
    expect(one.threads?.map((t) => t.rootId)).toEqual(roots.slice(0, 20))
    expect(one.liveMore).toBe(true)
    const two = await reader.history({ ...tail, after: one.liveCursor! })
    expect(two.threads?.map((t) => t.rootId)).toEqual(roots.slice(20))
    expect(two.liveMore).toBeUndefined()
    await s.close()
  })

  it('reads one thread’s record with its summary, and nothing for a reply, an unknown root or another agent', async () => {
    const s = await conversation()
    const reader = createSessionReader(s)
    const held = await reader.thread({ agentId: AGENT, sessionId: 'sid-coord', rootId: R1, limit: 50 })
    expect(held.messages.map((m) => m.ts)).toEqual(['1', '3', '5', '6', '7'])
    expect(held.summary).toEqual(heldThread)
    expect(held.nextCursor).toBeUndefined()
    const paged = await reader.thread({ agentId: AGENT, sessionId: 'sid-coord', rootId: R1, limit: 2 })
    expect(paged.messages.map((m) => m.ts)).toEqual(['6', '7'])
    const older = await reader.thread({
      agentId: AGENT,
      sessionId: 'sid-coord',
      rootId: R1,
      limit: 50,
      cursor: paged.nextCursor!
    })
    expect(older.messages.map((m) => m.ts)).toEqual(['1', '3', '5'])
    const empty = await reader.thread({ agentId: AGENT, sessionId: 'sid-coord', rootId: R2, limit: 50 })
    expect(empty.messages.map((m) => m.ts)).toEqual(['8'])
    expect(empty.summary).toEqual({ rootId: R2, rootExcerpt: 'm8', replies: 0, participants: [] })
    const legacy = await reader.thread({ agentId: AGENT, sessionId: 'sid-coord', rootId: LEGACY, limit: 50 })
    expect(legacy.messages.map((m) => m.ts)).toEqual(['9', '10'])
    for (const [agentId, rootId] of [
      [AGENT, REPLY],
      [AGENT, crypto.randomUUID()],
      [OTHER_AGENT, R1]
    ] as const) {
      expect(await reader.thread({ agentId, sessionId: 'sid-coord', rootId, limit: 50 })).toEqual({
        sessionId: 'sid-coord',
        rootId,
        messages: []
      })
    }
    await s.close()
  })

  // webchat-threads.md §5.1: a root handed to a task joins its thread, and one handed before stays a thread of its own.
  it('keeps a root handed into a task’s thread in the timeline, marked, read in that thread, and without a footer', async () => {
    const s = await conversation()
    const reader = createSessionReader(s)
    const HANDED = crypto.randomUUID()
    const ATTACHED = crypto.randomUUID()
    await s.appendTranscript(post('11', ATTACHED, { postId: ATTACHED, admission: coordinator }))
    await s.appendTranscript(post('11', R1, { postId: ATTACHED, admission: task }))
    await s.assistantSubsessions.attachThread({
      agentId: AGENT,
      childSessionKey: taskKey,
      platform: 'webchat',
      channel: CONV,
      thread: ATTACHED,
      sinceRound: 2,
      now: 2
    })
    await s.appendTranscript(post('12', ATTACHED, { sender: AGENT, admission: task }))
    await s.appendTranscript(post('13', HANDED, { postId: HANDED, admission: coordinator }))
    const before = await reader.history({ agentId: AGENT, sessionId: 'sid-coord', limit: 50, view: 'roots' })
    // The task's copy keeps the one row at the root; the mark is what moves its reading into the thread.
    await s.appendTranscript(post('13', R1, { postId: HANDED, admission: task }))
    const channel = transcriptChannelKey(CONV)
    expect(await s.markTranscriptHanded({ transcriptChannel: channel, agentId: AGENT }, HANDED, R1)).toBe(true)
    expect(await s.markTranscriptHanded({ transcriptChannel: channel, agentId: AGENT }, HANDED, R1)).toBe(false)

    const page = await reader.history({ agentId: AGENT, sessionId: 'sid-coord', limit: 50, view: 'roots' })
    expect(SessionMessage.array().parse(page.messages)).toHaveLength(page.messages.length)
    const at = (ts: string) => page.messages.find((m) => m.ts === ts)
    expect(at('13')).toMatchObject({ handedTo: R1 })
    expect(at('13')?.thread).toBeUndefined()
    expect(at('11')?.handedTo).toBeUndefined()
    const footers = new Map(page.threads?.map((t) => [t.rootId, t]))
    expect(footers.has(HANDED)).toBe(false)
    expect(footers.get(R1)).toMatchObject({ replies: 5, lastReply: { sender: 'U1', excerpt: 'm13' } })
    // A message handed before the change is the root of a thread the task holds, with its own footer.
    expect(footers.get(ATTACHED)).toMatchObject({ replies: 1, task: { title: 'Fix the login bug' } })

    const thread = await reader.thread({ agentId: AGENT, sessionId: 'sid-coord', rootId: R1, limit: 50 })
    expect(thread.messages.map((m) => [m.ts, m.handedTo])).toEqual([
      ['1', undefined],
      ['3', undefined],
      ['5', undefined],
      ['6', undefined],
      ['7', undefined],
      ['13', R1]
    ])
    expect(thread.summary).toMatchObject({ replies: 5, lastReply: { excerpt: 'm13' } })
    const attached = await reader.thread({ agentId: AGENT, sessionId: 'sid-coord', rootId: ATTACHED, limit: 50 })
    expect(attached.messages.map((m) => [m.ts, m.handedTo])).toEqual([
      ['11', undefined],
      ['12', undefined]
    ])

    // The mark reaches an open view as a change to the row, with the thread's footer.
    const tail = await reader.history({
      agentId: AGENT,
      sessionId: 'sid-coord',
      limit: 50,
      view: 'roots',
      after: before.liveCursor!
    })
    expect(tail.messages.map((m) => [m.ts, m.handedTo])).toEqual([['13', R1]])
    expect(tail.threads?.map((t) => t.rootId)).toEqual([R1])
    const threadTail = await reader.thread({
      agentId: AGENT,
      sessionId: 'sid-coord',
      rootId: R1,
      limit: 50,
      after: before.liveCursor!
    })
    expect(threadTail.messages.map((m) => m.ts)).toEqual(['13'])
    // The flat view carries the mark too.
    const flat = await reader.history({ agentId: AGENT, sessionId: 'sid-coord', limit: 50 })
    expect(flat.messages.find((m) => m.ts === '13')).toMatchObject({ handedTo: R1 })
    await s.close()
  })
})

describe('stored screenshot references survive a capped tool body', () => {
  it('rides beside the preview of a screenshot-sized body', async () => {
    const s = await store()
    await seedHistorySession(s)
    const content = screenshotContent(600 * 1024)
    const body = JSON.stringify({ toolCallId: 'shot-1', status: 'completed', content, rawOutput: { content } })
    await s.insertToolCall(
      admitted({ channel: 'C1', thread: 'T1', ts: '1', sender: AGENT, toolCallId: 'shot-1', title: 'shot', body })
    )
    const [row] = (await createSessionReader(s).history({ agentId: AGENT, sessionId: 'acp-1', limit: 50 })).messages
    expect(row!.bodyTruncated).toBe(true)
    expect(Buffer.byteLength(row!.body!)).toBeLessThanOrEqual(32 * 1024)
    expect(row!.body).not.toContain(`sha256:${SHOT_HASH}`)
    expect((JSON.parse(row!.body!) as { screenshots?: string[] }).screenshots).toEqual([SHOT_HASH])
    await s.close()
  })

  it('is kept when the write cap sheds the content that named it', () => {
    const content = screenshotContent(2 * 1024 * 1024)
    const [event] = new TranscriptRecorder().onUpdate({
      sessionUpdate: 'tool_call',
      toolCallId: 'shot-2',
      title: 'computer_screenshot',
      status: 'completed',
      content,
      rawOutput: { content }
    } as never)
    const body = JSON.parse((event as { body: string }).body) as {
      truncated?: boolean
      content?: unknown
      screenshots?: string[]
    }
    expect(body.truncated).toBe(true)
    expect(body.content).toBeUndefined()
    expect(body.screenshots).toEqual([SHOT_HASH])
  })
})

describe('previewAppBody — shedding one app card onto a transcript page', () => {
  const card = (over: Record<string, unknown> = {}) => ({
    appId: 'app-1',
    title: 'DeFi positions',
    toolName: 'charts__get_defi_positions',
    server: 'charts',
    conversationId: 'C1',
    outcome: 'expired',
    ...over
  })
  const bulk = (bytes: number) => 'x'.repeat(bytes)
  const parse = (body: string) => JSON.parse(previewAppBody(body)!) as Record<string, unknown>

  it('drops the template first, keeping the result the card reported', () => {
    const out = parse(JSON.stringify(card({ html: bulk(200 * 1024), toolResult: { structuredContent: { a: 1 } } })))
    expect(out.html).toBeUndefined()
    expect(out.toolResult).toEqual({ structuredContent: { a: 1 } })
  })

  it('drops the result next, when the template alone was not what made it too big', () => {
    const out = parse(
      JSON.stringify(card({ html: bulk(200 * 1024), toolResult: { structuredContent: { big: bulk(60 * 1024) } } }))
    )
    expect(out.toolResult).toBeUndefined()
    expect(out.title).toBe('DeFi positions')
  })

  it('drops the arguments last, after the result has already gone', () => {
    const out = parse(
      JSON.stringify(
        card({
          html: bulk(200 * 1024),
          toolResult: { structuredContent: { big: bulk(60 * 1024) } },
          toolInput: { blob: bulk(60 * 1024) }
        })
      )
    )
    expect(out.toolResult).toBeUndefined()
    expect(out.toolInput).toBeUndefined()
  })

  it('keeps the card’s IDENTITY whatever it has to shed — a row read as a line is a card that vanished', () => {
    // The floor. Unreachable for a schema-valid card, which is exactly why it is worth pinning:
    // a row is only ever rendered as a card when the console can still read these fields off it.
    const out = parse(JSON.stringify(card({ html: bulk(200 * 1024), unknownBulk: bulk(64 * 1024) })))
    expect(out).toEqual({
      appId: 'app-1',
      title: 'DeFi positions',
      toolName: 'charts__get_defi_positions',
      outcome: 'expired'
    })
  })

  it('returns null for a body that is not a card, leaving the row’s own title to stand alone', () => {
    expect(previewAppBody('not json')).toBeNull()
  })
})
