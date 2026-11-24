import { afterEach, describe, expect, it, vi } from 'vitest'
import { elicitFormBlockId } from '@agentconnect.md/protocol'
import type { NormalizedMessage } from '../src/messages/normalized.js'
import {
  MATTERMOST_ELICIT_LABEL_CAP,
  MATTERMOST_ELICIT_SURFACE,
  mattermostElicitCards,
  mattermostElicitChoice,
  mattermostElicitText,
  mattermostQuestionTag
} from '../src/platforms/mattermost/elicit-card.js'
import { MattermostConnection } from '../src/platforms/mattermost/connection.js'
import type { ElicitCardHost, ElicitCardTurn } from '../src/platforms/elicit-card.js'
import { elicitOptionToken, type ElicitTarget } from '../src/slack/render.js'
import { FakeMattermostServer, fakeMmId, quietLog } from './fakes/mattermost-server.js'

const target: ElicitTarget = {
  propName: 'env',
  kind: 'enum',
  options: [
    { label: 'Staging', value: 'staging' },
    { label: 'Production', value: 'production' }
  ]
}

const connections: MattermostConnection[] = []
afterEach(async () => {
  for (const c of connections.splice(0)) await c.stop()
})

describe('Mattermost numbered text elicit cards', () => {
  it('renders numbered Markdown instructions and parses tagged/bare/label replies', () => {
    const tag = mattermostQuestionTag()
    expect(tag).toMatch(/^Q-[0-9A-F]{8}$/)

    const body = mattermostElicitText('Deploy where?', target, tag)
    expect(body).toContain('💬 Deploy where?')
    expect(body).toContain('1. Staging')
    expect(body).toContain('2. Production')
    expect(body).toContain(tag)

    expect(mattermostElicitChoice(target, `${tag} 2`, tag)).toBe(1)
    expect(mattermostElicitChoice(target, `@acbot ${tag}: 1`, tag)).toBe(0)
    expect(mattermostElicitChoice(target, '２', tag)).toBe(1)
    expect(mattermostElicitChoice(target, 'production', tag)).toBe(1)
    expect(mattermostElicitChoice(target, `${tag} 9`, tag)).toBeNull()
  })

  it('posts numbered card, tracks tag, validates reply, and patches card on settle', async () => {
    const createPost = vi.fn(async () => ({ id: fakeMmId('card', 1) }))
    const patchPost = vi.fn(async () => ({ id: fakeMmId('card', 1) }))
    const noteQuestionTag = vi.fn()
    const retireQuestionTag = vi.fn()
    const conn = {
      workspaceId: () => 'mm-0123456789abcdef',
      createPost,
      patchPost,
      noteQuestionTag,
      retireQuestionTag
    }

    const turnStateObj: Record<string, unknown> = { isDm: false }
    const host: ElicitCardHost = {
      postCardSerialized: async (_t, post) => await post(conn),
      sessionTarget: () => undefined,
      turnState: () => turnStateObj
    }
    const turn: ElicitCardTurn = {
      conn,
      plan: {
        platform: 'mattermost',
        agentId: 'agent-1',
        channel: 'ch1',
        thread: fakeMmId('root', 1),
        statusThread: fakeMmId('root', 1),
        agentName: 'Agent'
      }
    }
    const ask = {
      requestId: 'req-1',
      params: { mode: 'form', message: 'Deploy where?', requestedSchema: { type: 'object', properties: {} } } as any,
      message: 'Deploy where?',
      fallback: 'Deploy where?',
      form: [target]
    }

    expect(mattermostElicitCards.reduction).toBe(MATTERMOST_ELICIT_SURFACE)
    expect(
      mattermostElicitCards.build(host, turn, { ...ask, url: { elicitationId: 'u1', url: 'https://x' } })
    ).toBeNull()

    const draft = mattermostElicitCards.build(host, turn, ask)!
    expect(draft).not.toBeNull()

    const tag = (await mattermostElicitCards.send(host, turn, ask, draft))!
    expect(tag).toMatch(/^Q-[0-9A-F]{8}$/)
    expect(noteQuestionTag).toHaveBeenCalledWith('ch1', tag, fakeMmId('root', 1))
    expect(createPost).toHaveBeenCalledWith('ch1', expect.stringContaining('1. Staging'), {
      rootId: fakeMmId('root', 1)
    })

    const handle = { conn, channel: 'ch1', thread: fakeMmId('root', 1), ts: tag }
    expect(mattermostElicitCards.answerScope!(handle)).toBe('mm-0123456789abcdef')

    const tapTarget = { requestId: 'req-1', params: ask.params, form: [target] }
    const bad = mattermostElicitCards.claimReply!(handle, tapTarget, {
      conversation: 'conv-1',
      replyTo: tag,
      text: `${tag} 99`
    })
    expect(bad).toEqual({ kind: 'pending' })
    expect(createPost).toHaveBeenCalledWith('ch1', expect.stringContaining(tag), { rootId: fakeMmId('root', 1) })

    const ok = mattermostElicitCards.claimReply!(handle, tapTarget, {
      conversation: 'conv-1',
      replyTo: tag,
      text: `${tag} 2`
    })
    expect(ok).toEqual({ kind: 'submit', fields: { [elicitFormBlockId(0)]: elicitOptionToken(1) } })

    mattermostElicitCards.settle(handle, {
      params: ask.params,
      consent: false,
      mark: 'answered',
      text: 'Production'
    })
    expect(retireQuestionTag).toHaveBeenCalledWith(tag)
    expect(patchPost).toHaveBeenCalledWith(fakeMmId('card', 1), expect.stringContaining('✅ Production'))
  })

  it('routes bare numbers when 1 question is open in a thread and requires <tag> when 2 are open', async () => {
    const server = new FakeMattermostServer()
    const alice = server.addUser({ id: fakeMmId('alice', 1), username: 'alice', is_bot: false })
    const ch = server.addChannel({ id: fakeMmId('ch', 1), type: 'O', name: 'ops', display_name: 'Ops' }, [
      server.botUser.id,
      alice.id
    ])
    const rootPost = server.addPost({ channel_id: ch.id, user_id: alice.id, message: '@acbot help' })
    const inbound: NormalizedMessage[] = []
    const conn = new MattermostConnection(
      {
        serverUrl: server.serverUrl,
        botToken: server.botToken,
        integrations: [{ agentId: 'agent-1', integrationId: 'int-1' }]
      },
      {
        onMessage: (msg) => inbound.push(msg),
        log: quietLog,
        createSocket: server.createSocket,
        fetchImpl: server.fetchImpl,
        sendIntervalMs: 0
      }
    )
    connections.push(conn)
    await conn.start()

    conn.noteQuestionTag(ch.id, 'Q-AAAAAAAA', rootPost.id)
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: alice.id,
      root_id: rootPost.id,
      message: '2'
    })
    await vi.waitFor(() => expect(inbound).toHaveLength(1))
    expect(inbound[0]!.replyTo).toBe('Q-AAAAAAAA')

    // Second open question in same thread -> bare number must be ambiguous (unset), explicit tag routes cleanly.
    conn.noteQuestionTag(ch.id, 'Q-BBBBBBBB', rootPost.id)
    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: alice.id,
      root_id: rootPost.id,
      message: '1'
    })
    await vi.waitFor(() => expect(inbound).toHaveLength(2))
    expect(inbound[1]!.replyTo).toBeUndefined()

    server.lastSocket.emitPosted({
      id: server.nextId('p'),
      channel_id: ch.id,
      user_id: alice.id,
      root_id: rootPost.id,
      message: 'Q-BBBBBBBB 1'
    })
    await vi.waitFor(() => expect(inbound).toHaveLength(3))
    expect(inbound[2]!.replyTo).toBe('Q-BBBBBBBB')
  })

  it('attaches signed buttons when actionCallback is present and clears attachments on settle while keeping text fallback', async () => {
    const createPost = vi.fn(async () => ({ id: fakeMmId('ecard', 1) }))
    const patchPost = vi.fn(async () => ({ id: fakeMmId('ecard', 1) }))
    const noteQuestionTag = vi.fn()
    const retireQuestionTag = vi.fn()
    const callback = {
      url: 'https://relay.example.test/mattermost/actions',
      secret: 'secret-mm-key-for-tests',
      daemonId: '11111111-1111-4111-8111-111111111111'
    }
    const conn = {
      workspaceId: () => 'mm-0123456789abcdef',
      actionCallback: () => callback,
      createPost,
      patchPost,
      noteQuestionTag,
      retireQuestionTag
    }
    const turnStateObj: Record<string, unknown> = { isDm: false }
    const host: ElicitCardHost = {
      postCardSerialized: async (_t, post) => await post(conn),
      sessionTarget: () => undefined,
      turnState: () => turnStateObj
    }
    const turn: ElicitCardTurn = {
      conn,
      plan: {
        platform: 'mattermost',
        agentId: '22222222-2222-4222-8222-222222222222',
        integrationId: '33333333-3333-4333-8333-333333333333',
        channel: 'ch1',
        thread: fakeMmId('root', 1),
        statusThread: fakeMmId('root', 1),
        agentName: 'Agent'
      }
    }
    const ask = {
      requestId: 'req-elicit-1',
      params: { mode: 'form', message: 'Pick env?', requestedSchema: { type: 'object', properties: {} } } as any,
      message: 'Pick env?',
      fallback: 'Pick env?',
      form: [target]
    }

    const draft = mattermostElicitCards.build(host, turn, ask)!
    const tag = (await mattermostElicitCards.send(host, turn, ask, draft))!
    expect(tag).toMatch(/^Q-[0-9A-F]{8}$/)
    expect(noteQuestionTag).toHaveBeenCalledWith('ch1', tag, fakeMmId('root', 1))
    expect(createPost).toHaveBeenCalledWith(
      'ch1',
      expect.stringContaining('1. Staging'),
      expect.objectContaining({
        rootId: fakeMmId('root', 1),
        props: {
          attachments: [
            expect.objectContaining({
              actions: expect.arrayContaining([
                expect.objectContaining({ id: 'opt0', name: 'Staging', type: 'button' }),
                expect.objectContaining({ id: 'opt1', name: 'Production', type: 'button' }),
                expect.objectContaining({ id: 'dismiss', name: 'Dismiss', type: 'button', style: 'danger' })
              ])
            })
          ]
        }
      })
    )

    mattermostElicitCards.settle(
      { conn, channel: 'ch1', thread: fakeMmId('root', 1), ts: tag },
      { params: ask.params, consent: false, mark: 'answered', text: 'Staging' }
    )
    expect(retireQuestionTag).toHaveBeenCalledWith(tag)
    expect(patchPost).toHaveBeenCalledWith(fakeMmId('ecard', 1), expect.stringContaining('✅ Staging'), {
      props: { attachments: [] }
    })

    const longOpt = 'Deploy to multi-region active-active production cluster with zero downtime verification'
    const longTarget: ElicitTarget = {
      propName: 'cluster',
      kind: 'enum',
      options: [{ label: longOpt, value: 'prod-multi' }]
    }
    const longAsk = {
      requestId: 'req-elicit-long',
      params: { mode: 'form', message: 'Which cluster?', requestedSchema: { type: 'object', properties: {} } } as any,
      message: 'Which cluster?',
      fallback: 'Which cluster?',
      form: [longTarget]
    }
    const longDraft = mattermostElicitCards.build(host, turn, longAsk)!
    await mattermostElicitCards.send(host, turn, longAsk, longDraft)
    const lastCall = createPost.mock.calls.at(-1) as unknown[]
    expect(lastCall[1]).toContain(`1. ${longOpt}`)
    const sentActions = (lastCall[2] as any).props.attachments[0].actions as Array<{ name: string }>
    expect(sentActions[0]!.name.length).toBeLessThanOrEqual(MATTERMOST_ELICIT_LABEL_CAP)
  })
})
