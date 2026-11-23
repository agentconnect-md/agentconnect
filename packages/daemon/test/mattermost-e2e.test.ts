import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CreateElicitationRequest } from '@agentclientprotocol/sdk/unstable'
import { EventSession } from '@agentconnect.md/protocol'
import { Daemon } from '../src/daemon.js'
import { executeTool } from '../src/mcp/ops.js'
import { mattermostExternalAppId } from '../src/platforms/mattermost/module.js'
import { FakeMattermostServer, fakeMmId } from './fakes/mattermost-server.js'

const AGENT_ID = '22222222-2222-4222-8222-222222222222'
const INTEGRATION_ID = '11111111-1111-4111-8111-111111111111'

const tempRoots: string[] = []
const daemons: Daemon[] = []

afterEach(async () => {
  for (const d of daemons.splice(0)) await d.stop()
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function scaffoldMattermostDaemon(server: FakeMattermostServer) {
  const root = mkdtempSync(join(tmpdir(), 'ac-mm-e2e-'))
  tempRoots.push(root)
  const workspace = join(root, 'workspace')
  mkdirSync(workspace, { recursive: true })
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      version: 1,
      controlPlane: { enabled: false },
      runtimes: { claude: { command: 'node', args: ['unused'] } }
    })
  )
  const agentDir = join(root, 'agents', AGENT_ID)
  mkdirSync(agentDir, { recursive: true })
  writeFileSync(
    join(agentDir, 'agent.json'),
    JSON.stringify({
      id: AGENT_ID,
      name: 'MM Helper',
      status: 'active',
      runtime: 'claude',
      workspace: { mode: 'from-scratch', path: workspace },
      output: { mode: 'low' },
      integrations: [
        {
          id: INTEGRATION_ID,
          platform: 'mattermost',
          core: {
            mode: 'direct',
            bindRules: [{ match: { kind: 'mention' } }, { match: { kind: 'dm' } }],
            mutedChannels: [],
            gated: false
          },
          config: {
            serverUrl: server.serverUrl,
            botToken: server.botToken,
            botUserId: server.botUser.id,
            botUsername: server.botUser.username
          }
        }
      ]
    })
  )
  return { root, workspace }
}

function elicitAsk(sessionId: string, message: string): CreateElicitationRequest {
  return {
    sessionId,
    mode: 'form',
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          title: 'Target',
          enum: ['staging', 'production']
        }
      },
      required: ['target']
    }
  } as CreateElicitationRequest
}

describe('Mattermost fake-server E2E', () => {
  it('covers channel @bot threaded stream+patch, user_typing, DM continuity, !status, numbered elicit reply, and shareFile', async () => {
    const server = new FakeMattermostServer({ maxPostSize: '4000' })
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const chan = server.addChannel(
      {
        id: fakeMmId('pubch', 1),
        team_id: [...server.teams.keys()][0]!,
        type: 'O',
        name: 'incidents',
        display_name: 'Incidents'
      },
      [server.botUser.id, alice.id]
    )
    const dmChan = server.addChannel(
      { id: fakeMmId('dmch', 1), type: 'D', name: `${alice.id}__${server.botUser.id}` },
      [server.botUser.id, alice.id]
    )

    const { root, workspace } = scaffoldMattermostDaemon(server)
    writeFileSync(join(workspace, 'summary.txt'), 'incident summary bytes\n')

    let nextSessionNum = 1
    const sessionCwds = new Map<string, string>()
    const sessionPrompts: { sessionId: string; text: string }[] = []
    let promptImpl: (
      sessionId: string,
      blocks: Array<{ type: string; text?: string }>,
      emit: (sid: string, u: unknown) => void
    ) => Promise<{ stopReason: 'end_turn' }> = async () => ({ stopReason: 'end_turn' })

    const daemon = new Daemon({
      root,
      mattermostTransport: {
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      },
      hostFactory: (_agent, onUpdate) =>
        ({
          start: vi.fn(async () => {}),
          stop: vi.fn(async () => {}),
          cancel: vi.fn(async () => {}),
          hasSession: () => true,
          newSession: vi.fn(async (cwd: string) => {
            const sid = `acp-mm-${nextSessionNum++}`
            sessionCwds.set(sid, cwd)
            return sid
          }),
          prompt: vi.fn(async (sessionId: string, blocks: Array<{ type: string; text?: string }>) => {
            const text = blocks.map((b) => b.text ?? '').join('\n')
            sessionPrompts.push({ sessionId, text })
            return await promptImpl(sessionId, blocks, onUpdate)
          })
        }) as never
    })
    daemons.push(daemon)
    const sessionEvents: EventSession[] = []
    await daemon.start()
    ;(daemon as any).cpClient = {
      stop: async () => {},
      supportsServerFeature: () => false,
      grantsRooms: () => false,
      emitIntegrationChannels: () => {},
      emitSessionActivity: () => {},
      emitUsageReport: () => {},
      emitEventSession: (event: EventSession) => sessionEvents.push(event)
    }

    await vi.waitFor(() =>
      expect((daemon as any).mattermostConnByIntegration.get(INTEGRATION_ID)?.connected).toBe(true)
    )

    // 1. Channel @bot mention -> user_typing WS ack + initial POST + throttled/final PUT /patch in thread.
    promptImpl = async (sid, _blocks, emit) => {
      emit(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Investigating ' } })
      await new Promise((r) => setTimeout(r, 20))
      emit(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'root cause now.' } })
      return { stopReason: 'end_turn' }
    }

    const chRoot = server.addPost({
      channel_id: chan.id,
      user_id: alice.id,
      message: `@${server.botUser.username} please triage`
    })
    server.lastSocket.emitPosted(chRoot, { mentions: [server.botUser.id] })

    await vi.waitFor(() => {
      const patches = server.requests.filter((r) => r.method === 'PUT' && r.path.endsWith('/patch'))
      expect(patches.length).toBeGreaterThanOrEqual(1)
      const reply = [...server.posts.values()].find(
        (p) => p.channel_id === chan.id && p.user_id === server.botUser.id && p.root_id === chRoot.id
      )
      expect(reply?.message).toContain('Investigating root cause now.')
      expect(reply?.message).toContain('_sent by [MM Helper](')
      expect(reply?.message).toContain('?source=mattermost)_')
    })

    const botChannelReply = [...server.posts.values()].find(
      (p) => p.channel_id === chan.id && p.user_id === server.botUser.id && p.root_id === chRoot.id
    )
    expect(botChannelReply?.message).toContain('Investigating root cause now.')
    expect(botChannelReply?.message).toContain('_sent by [MM Helper](')
    expect(botChannelReply?.message).toContain('?source=mattermost)_')
    expect(server.lastSocket.frames('user_typing').some((f) => f.data?.channel_id === chan.id)).toBe(true)
    await vi.waitFor(() => {
      expect(
        server.reactions.some(
          (r) => r.user_id === server.botUser.id && r.post_id === chRoot.id && r.emoji_name === 'eyes'
        )
      ).toBe(true)
    })

    // 2. !status inside that thread -> replies in-thread with rich telemetry + permalink.
    const statusCmd = server.addPost({
      channel_id: chan.id,
      user_id: alice.id,
      root_id: chRoot.id,
      message: '!status'
    })
    server.lastSocket.emitPosted(statusCmd)

    await vi.waitFor(() => {
      const statusReply = [...server.posts.values()].find(
        (p) =>
          p.channel_id === chan.id &&
          p.user_id === server.botUser.id &&
          p.root_id === chRoot.id &&
          p.message?.includes('📊') &&
          p.message?.includes('View session')
      )
      expect(statusReply).toBeDefined()
    })
    const threadSession = (await (daemon as any).store.listSessions()).find(
      (s: { channel: string; thread: string }) => s.channel === chan.id && s.thread === chRoot.id
    )
    expect(threadSession).toBeDefined()
    expect((daemon as any).sessionThreadUrl(threadSession)).toBe(`${server.serverUrl}/_redirect/pl/${chRoot.id}`)

    // 3. DM -> flat continuous session across 2 separate DM messages (`root_id` empty).
    promptImpl = async (sid, _blocks, emit) => {
      emit(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'DM ack' } })
      return { stopReason: 'end_turn' }
    }
    const dm1 = server.addPost({ channel_id: dmChan.id, user_id: alice.id, message: 'first dm' })
    server.lastSocket.emitPosted(dm1, { channelType: 'D' })
    await vi.waitFor(() => {
      const dmReply = [...server.posts.values()].find(
        (p) => p.channel_id === dmChan.id && p.user_id === server.botUser.id && p.message?.startsWith('DM ack')
      )
      expect(dmReply).toBeDefined()
      expect(dmReply?.root_id).toBe('')
    })

    const dm2 = server.addPost({ channel_id: dmChan.id, user_id: alice.id, message: 'second dm' })
    server.lastSocket.emitPosted(dm2, { channelType: 'D' })
    await vi.waitFor(() => expect(sessionPrompts.filter((p) => p.text.includes('second dm'))).toHaveLength(1))
    const firstDmPrompt = sessionPrompts.find((p) => p.text.includes('first dm'))!
    const secondDmPrompt = sessionPrompts.find((p) => p.text.includes('second dm'))!
    expect(secondDmPrompt.sessionId).toBe(firstDmPrompt.sessionId)

    // 4. Numbered text elicit inside a new channel thread:
    //    (a) bare number "2" when 1 open question is in that thread
    //    (b) explicit "<tag> 1" in a follow-up question in the same thread
    //    plus (c) shareFile MCP op with @channel/@all/@here caption neutralization.
    let firstElicitOutcome: unknown
    let secondElicitOutcome: unknown
    let shareOutcome: unknown
    const elicitChanRoot = server.addPost({
      channel_id: chan.id,
      user_id: alice.id,
      message: `@${server.botUser.username} deploy and attach`
    })

    promptImpl = async (sid, _blocks, emit) => {
      const pending = [...((daemon as any).pending.values() as Iterable<any>)].find((p) => p.acpSessionId === sid)
      expect(pending).toBeDefined()
      const cwd = sessionCwds.get(sid)!
      mkdirSync(cwd, { recursive: true })
      writeFileSync(join(cwd, 'summary.txt'), 'incident summary bytes\n')

      // Share a workspace file into the active turn's Mattermost thread.
      const mcpSessions = [...((daemon as any).mcp.sessions.values() as Iterable<any>)]
      const ctx = mcpSessions.find((s) => s.channel === chan.id && s.thread === elicitChanRoot.id)
      expect(ctx).toBeDefined()
      shareOutcome = await executeTool(
        ctx,
        'shareFile',
        { path: 'summary.txt', caption: 'FYI @channel @all @here ready' },
        (daemon as any).mcp.deps
      )

      firstElicitOutcome = await (daemon as any).permissions.onAcpElicit(
        pending.hostKey,
        sid,
        elicitAsk(sid, 'Choose environment 1:')
      )
      secondElicitOutcome = await (daemon as any).permissions.onAcpElicit(
        pending.hostKey,
        sid,
        elicitAsk(sid, 'Confirm environment 2:')
      )
      emit(sid, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Deployed!' } })
      return { stopReason: 'end_turn' }
    }

    server.lastSocket.emitPosted(elicitChanRoot, { mentions: [server.botUser.id] })

    // Wait for question 1 post and answer with bare number "2" (Production).
    await vi.waitFor(() => {
      const q1 = [...server.posts.values()].find(
        (p) =>
          p.channel_id === chan.id && p.root_id === elicitChanRoot.id && p.message?.includes('Choose environment 1:')
      )
      expect(q1).toBeDefined()
    })
    server.lastSocket.emitPosted(
      server.addPost({ channel_id: chan.id, user_id: alice.id, root_id: elicitChanRoot.id, message: '2' })
    )

    // Wait for question 2 post, extract its Q-XXXXXXXX tag, and answer with "<tag> 1" (Staging).
    let tag2 = ''
    await vi.waitFor(() => {
      const q2 = [...server.posts.values()].find(
        (p) =>
          p.channel_id === chan.id && p.root_id === elicitChanRoot.id && p.message?.includes('Confirm environment 2:')
      )
      expect(q2).toBeDefined()
      const m = /(Q-[0-9A-F]{8})/i.exec(q2!.message ?? '')
      expect(m).not.toBeNull()
      tag2 = m![1]!
    })
    server.lastSocket.emitPosted(
      server.addPost({ channel_id: chan.id, user_id: alice.id, root_id: elicitChanRoot.id, message: `${tag2} 1` })
    )

    await vi.waitFor(() => {
      const done = [...server.posts.values()].find(
        (p) => p.channel_id === chan.id && p.root_id === elicitChanRoot.id && p.message?.startsWith('Deployed!')
      )
      expect(done).toBeDefined()
    })

    expect(firstElicitOutcome).toEqual({ action: 'accept', content: { target: 'production' } })
    expect(secondElicitOutcome).toEqual({ action: 'accept', content: { target: 'staging' } })
    expect(shareOutcome).toMatchObject({ ok: true, shared: { path: 'summary.txt' } })

    const uploadedPost = [...server.posts.values()].find(
      (p) => p.channel_id === chan.id && p.root_id === elicitChanRoot.id && (p.file_ids?.length ?? 0) > 0
    )
    expect(uploadedPost).toBeDefined()
    expect(uploadedPost!.message).not.toContain('@channel')
    expect(uploadedPost!.message).not.toContain('@all')
    expect(uploadedPost!.message).not.toContain('@here')
    expect(uploadedPost!.message).toContain('@\u200bchannel')
    expect(uploadedPost!.message).toContain('@\u200ball')
    expect(uploadedPost!.message).toContain('@\u200bhere')

    const expectedRealm = mattermostExternalAppId(server.serverUrl)!
    await vi.waitFor(() => {
      const chEvent = sessionEvents.find((e) => e.channel === chan.id && e.thread === chRoot.id && e.phase === 'end')
      const dmEvent = sessionEvents.find((e) => e.channel === dmChan.id && e.thread === 'dm' && e.phase === 'end')
      expect(chEvent).toBeDefined()
      expect(dmEvent).toBeDefined()
      expect(EventSession.parse(chEvent).externalOrigin).toEqual({
        provider: 'mattermost',
        realmKey: expectedRealm,
        resourceKind: 'conversation',
        resourceKey: chan.id,
        integrationId: INTEGRATION_ID
      })
      expect(EventSession.parse(dmEvent).externalOrigin).toEqual({
        provider: 'mattermost',
        realmKey: expectedRealm,
        resourceKind: 'conversation',
        resourceKey: dmChan.id,
        integrationId: INTEGRATION_ID
      })
    })
  })
})
