// sendMessage's required action, checked before any effect, and the getToolGuide examples it points to (send-message-guide.md §3–§5).
import { describe, expect, it, vi } from 'vitest'
import { executeTool, type MessageAgentReq, type OpsDeps } from '../src/mcp/ops.js'
import type { SessionContext } from '../src/mcp/ops/context.js'
import { isPlatformPost } from '../src/mcp/ops/place-gate.js'
import { SEND_MESSAGE_ACTIONS, validateSendMessageAction } from '../src/mcp/ops/send-message-actions.js'
import { sendMessageGuide, type GuideExample } from '../src/mcp/ops/tool-guide.js'
import { toolsForIntegrations } from '../src/mcp/tools.js'
import { subsessionCoordinate } from '../src/session/subsession-coordinate.js'
import type { Integration } from '../src/agents/agent-schema.js'

const slack = { id: 'int-1', platform: 'slack' }
const ctx: SessionContext = {
  agentId: 'agent-self',
  platform: 'slack',
  integrationId: 'int-1',
  isDm: false,
  channel: 'C_HERE',
  thread: '100.1',
  deliveryThread: '100.1',
  tools: toolsForIntegrations([slack as Integration]),
  integrations: [slack]
}

/** Deps whose every use is recorded and refused: a rejected call must touch none of them. */
function effectBoundary(): { deps: OpsDeps; touched: string[] } {
  const touched: string[] = []
  const deps = new Proxy({} as OpsDeps, {
    get: (_target, key) => {
      if (key === 'canRun' || key === 'evaluationTool' || key === 'appTool' || key === 'log' || key === 'then')
        return undefined
      touched.push(String(key))
      return () => {
        throw new Error(`effect reached: ${String(key)}`)
      }
    }
  })
  return { deps, touched }
}

async function rejection(args: Record<string, unknown>, at: SessionContext = ctx): Promise<string> {
  const { deps, touched } = effectBoundary()
  const error = (await executeTool(at, 'sendMessage', args, deps).then(
    () => undefined,
    (err: Error) => err
  )) as Error | undefined
  expect(error, JSON.stringify(args)).toBeInstanceOf(Error)
  expect(touched, JSON.stringify(args)).toEqual([])
  return error!.message
}

/** A daemon-less wake path: records each agent call and refuses every platform lookup. */
function wakeDeps() {
  const calls: MessageAgentReq[] = []
  const gatewayFor = vi.fn(() => {
    throw new Error('no platform lookup expected')
  })
  const deps = {
    gatewayFor,
    messageAgent: async (req: MessageAgentReq) => {
      calls.push(req)
      return { delivered: true, targetSession: 'slack:C_HERE:subsession:1:agent-self', subsession: true as const }
    },
    replyToSession: vi.fn(),
    recordOutbound: vi.fn(),
    now: () => 0
  } as unknown as OpsDeps
  return { deps, calls, gatewayFor }
}

describe('sendMessage requires an explicit action', () => {
  it('rejects a call without action before any lookup, with the guide pointer', async () => {
    for (const legacy of [
      { toAgent: 'peer-1', message: 'm' },
      { toAgent: 'agent-self', message: 'm' },
      { toAgent: 'peer-1', channel: '#general', message: 'm' },
      { sessionId: 'sess-1', message: 'm' },
      { toUser: 'U1', message: 'm' },
      { channel: '#general', message: 'm' },
      { action: null, channel: 'C1', message: 'm' }
    ]) {
      const text = await rejection(legacy)
      expect(text).toMatch(/^sendMessage: invalid arguments — missing required argument `action`\. Nothing was sent/)
      expect(text).toContain('Call getToolGuide {"tool":"sendMessage"} to get the arguments and examples')
      expect(text).toContain('callAgent, messageSubsession, replyToSession, and postMessage')
    }
  })

  it('rejects an unknown or mistyped action and points to the overview', async () => {
    for (const action of ['wakeAgent', 'CallAgent', 3, true, {}]) {
      const text = await rejection({ action, toAgent: 'peer-1', message: 'm' })
      expect(text).toContain('`action` must be one of callAgent, messageSubsession, replyToSession, postMessage')
      expect(text).toContain('getToolGuide {"tool":"sendMessage"}')
      // Argument names only: a supplied value never enters the error.
      expect(text).not.toContain('wakeAgent')
    }
  })

  it('names the conflicting and missing fields of a recognized action and points to its guide', async () => {
    expect(await rejection({ action: 'replyToSession', toAgent: 'peer-1', message: 'm' })).toContain(
      'action `replyToSession` requires `sessionId` and does not accept `toAgent`. Nothing was sent. Call getToolGuide ' +
        '{"tool":"sendMessage","action":"replyToSession"} for the required arguments'
    )
    expect(await rejection({ action: 'postMessage', toAgent: 'peer-1', message: 'm' })).toContain(
      'action `postMessage` requires `toUser` or `channel` and does not accept `toAgent`'
    )
    expect(await rejection({ action: 'postMessage', channel: 'C1', sessionId: 's', message: 'm' })).toContain(
      'does not accept `sessionId`'
    )
    expect(await rejection({ action: 'callAgent', channel: 'C1', message: 'm' })).toContain(
      'action `callAgent` requires `toAgent`'
    )
    for (const extra of ['platform', 'integrationId', 'thread', 'attachment', 'needsReply']) {
      expect(await rejection({ action: 'callAgent', toAgent: 'peer-1', [extra]: 'x', message: 'm' })).toContain(
        `does not accept \`${extra}\``
      )
    }
    expect(await rejection({ action: 'callAgent', toAgent: 'peer-1' })).toContain(
      'missing required string argument: message'
    )
  })

  it('takes an existing peer session only as a nonempty id, without channel, and never one of your own', async () => {
    for (const sessionId of ['', '  ', null, 3]) {
      expect(await rejection({ action: 'callAgent', toAgent: 'peer-1', sessionId, message: 'm' })).toContain(
        'takes `sessionId` only as the nonempty id of an existing session of the agent in `toAgent`'
      )
    }
    expect(
      await rejection({ action: 'callAgent', toAgent: 'peer-1', sessionId: 's-1', channel: 'C1', message: 'm' })
    ).toContain('takes `channel` or `sessionId`, not both')
    const own = await rejection({ action: 'callAgent', toAgent: 'agent-self', sessionId: 's-1', message: 'm' })
    expect(own).toContain('never one of yours')
    expect(own).toContain('getToolGuide {"tool":"sendMessage","action":"messageSubsession"}')
  })

  it('keeps the existing combination rules inside an action', async () => {
    expect(await rejection({ action: 'postMessage', toUser: ['U1', 'U2'], message: 'm' })).toContain(
      'a `toUser` array requires `channel`'
    )
    expect(
      await rejection({ action: 'postMessage', toUser: 'U1', channel: 'C1', thread: '1.1', message: 'm' })
    ).toMatch(/action `postMessage` with `toUser` allows only .*unexpected `thread`/)
  })

  it('names the tool once, ends each sentence once, and points every recognized action at its guide', async () => {
    const stray = await rejection({ action: 'postMessage', toUser: 'U1', thread: 'x', message: 'hi' })
    expect(stray).toMatch(/^sendMessage: invalid arguments — action `postMessage`/)
    expect(stray).not.toContain('..')
    const pointer = (action: string) => `getToolGuide {"tool":"sendMessage","action":"${action}"}`
    const array = await rejection({ action: 'postMessage', toUser: ['U1', 'U2'], message: 'hi' })
    expect(array).toContain('Nothing was sent')
    expect(array).toContain(pointer('postMessage'))
    for (const [args, action] of [
      [{ action: 'callAgent', toAgent: 'peer-1', sessionId: 's-1', channel: 'C1', message: 'm' }, 'callAgent'],
      [{ action: 'callAgent', toAgent: 'peer-1', sessionId: '', message: 'm' }, 'callAgent'],
      [{ action: 'messageSubsession', sessionId: '', message: 'm' }, 'messageSubsession']
    ] as const) {
      const text = await rejection(args)
      expect(text).toContain(pointer(action))
      expect(text).not.toContain('..')
    }
  })
})

describe('messageSubsession', () => {
  it('opens the trusted self-delegation from `message` alone, postless', async () => {
    const { deps, calls, gatewayFor } = wakeDeps()
    const res = (await executeTool(ctx, 'sendMessage', { action: 'messageSubsession', message: 'fix it' }, deps)) as {
      childSessionId?: string
      nextAction?: string
    }
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      callerAgentId: 'agent-self',
      toAgentId: 'agent-self',
      text: 'fix it',
      channel: 'C_HERE',
      postless: true
    })
    expect(calls[0]).not.toHaveProperty('needsReply')
    expect(res.childSessionId).toBe('slack:C_HERE:subsession:1:agent-self')
    expect(res.nextAction).toBe('finish-turn-and-wait')
    expect(gatewayFor).not.toHaveBeenCalled()
  })

  it('rejects every target field, and a null, empty or mistyped sessionId, without effects', async () => {
    for (const extra of ['toAgent', 'channel', 'thread', 'platform', 'integrationId', 'attachment', 'needsReply']) {
      expect(await rejection({ action: 'messageSubsession', [extra]: 'x', message: 'm' })).toContain(
        `action \`messageSubsession\` does not accept \`${extra}\``
      )
    }
    for (const sessionId of ['', '  ', null, 7, {}]) {
      const text = await rejection({ action: 'messageSubsession', sessionId, message: 'm' })
      expect(text).toContain('action `messageSubsession` takes `sessionId` only as the nonempty `childSessionId`')
      expect(text).toContain('a null or empty id never starts one')
    }
  })

  it('sends into an existing child by its id, never through the creation path', async () => {
    const { deps, calls } = wakeDeps()
    const continued: unknown[] = []
    const child = 'slack:C_HERE:subsession:1:agent-self'
    const withChild = {
      ...deps,
      callId: 'call-1',
      continueSubsession: async (req: unknown) => {
        continued.push(req)
        return { delivered: true, targetSession: child, subsession: true as const }
      }
    } as OpsDeps
    const res = (await executeTool(
      ctx,
      'sendMessage',
      { action: 'messageSubsession', sessionId: child, message: 'also Windows' },
      withChild
    )) as Record<string, unknown>
    expect(calls).toHaveLength(0)
    expect(continued).toEqual([
      {
        callerAgentId: 'agent-self',
        platform: 'slack',
        callerChannel: 'C_HERE',
        callerThread: '100.1',
        sessionId: child,
        text: 'also Windows',
        submissionId: 'call-1'
      }
    ])
    expect(res).toMatchObject({
      ok: true,
      wake: { delivered: true, targetSession: child, subsession: true },
      childSessionId: child,
      reply: { requested: true, state: 'awaiting' },
      nextAction: 'finish-turn-and-wait'
    })
    expect(res.message).toContain('existing sub-session, which keeps its earlier context')
    const refusal = { delivered: false, targetSession: child, reason: 'subsession_not_found', message: 'no' }
    const refused = await executeTool(
      ctx,
      'sendMessage',
      { action: 'messageSubsession', sessionId: child, message: 'm' },
      { ...withChild, continueSubsession: async () => refusal } as OpsDeps
    )
    // A refusal keeps the creation family's shape and promises nothing.
    expect(refused).toEqual({ ok: true, wake: refusal })
  })
})

describe('callAgent', () => {
  it('refuses a postless self-target with the messageSubsession guide pointer', async () => {
    for (const toAgent of ['agent-self', { agentId: 'agent-self', needsReply: true }, '{"agentId":"agent-self"}']) {
      const text = await rejection({ action: 'callAgent', toAgent, message: 'm' })
      expect(text).toContain('action `callAgent` without `channel` cannot target yourself')
      expect(text).toContain('getToolGuide {"tool":"sendMessage","action":"messageSubsession"}')
    }
  })

  it('passes a peer call through unchanged', async () => {
    const { deps, calls } = wakeDeps()
    await executeTool(
      ctx,
      'sendMessage',
      { action: 'callAgent', toAgent: { agentId: 'peer-1', needsReply: 'TRUE' }, message: 'm' },
      deps
    )
    expect(calls[0]).toMatchObject({ toAgentId: 'peer-1', needsReply: true, postless: true })
  })
})

describe('write and join classification', () => {
  it('treats only postMessage as an ordinary platform post', () => {
    expect(isPlatformPost({ action: 'postMessage', channel: 'C1' })).toBe(true)
    expect(isPlatformPost({ action: 'postMessage', toUser: 'U1' })).toBe(true)
    expect(isPlatformPost({ action: 'callAgent', toAgent: 'peer-1', channel: 'C1' })).toBe(false)
    expect(isPlatformPost({ action: 'messageSubsession' })).toBe(false)
    expect(isPlatformPost({ action: 'replyToSession', sessionId: 's' })).toBe(false)
    expect(isPlatformPost({ channel: 'C1' })).toBe(false)
  })
})

describe('getToolGuide', () => {
  const examples = (guide: Record<string, unknown>): GuideExample[] =>
    (guide.examples as GuideExample[] | undefined) ??
    (guide.actions as { action: string; example: Record<string, unknown> }[]).map((entry) => ({
      use: entry.action,
      arguments: entry.example
    }))

  it('covers every action in the overview, with one runnable example each', () => {
    const overview = sendMessageGuide(ctx)
    const actions = overview.actions as { action: string; required: string[]; example: Record<string, unknown> }[]
    expect(actions.map((entry) => entry.action)).toEqual([...SEND_MESSAGE_ACTIONS])
    for (const entry of actions) expect(entry.example.action).toBe(entry.action)
    expect(overview.next).toContain('getToolGuide {"tool":"sendMessage","action":"<action>"}')
  })

  it('gives examples that every action validator accepts', () => {
    const all = [sendMessageGuide(ctx), ...SEND_MESSAGE_ACTIONS.map((action) => sendMessageGuide(ctx, action))]
    for (const guide of all) {
      for (const example of examples(guide)) {
        expect(() => validateSendMessageAction(ctx, example.arguments), example.use).not.toThrow()
      }
    }
    const callAgent = examples(sendMessageGuide(ctx, 'callAgent')).map((example) => example.arguments)
    expect(callAgent).toContainEqual(
      expect.objectContaining({ toAgent: 'agent-self', channel: '<project-channel-id>' })
    )
    expect(callAgent[0]).toMatchObject({ toAgent: { needsReply: true } })
  })

  it('advertises sub-session continuation and explicit peer sessions', () => {
    const subsession = examples(sendMessageGuide(ctx, 'messageSubsession')).map((example) => example.arguments)
    expect(subsession[0]).not.toHaveProperty('sessionId')
    expect(subsession).toContainEqual(
      expect.objectContaining({ sessionId: '<childSessionId returned by messageSubsession>' })
    )
    expect(JSON.stringify(sendMessageGuide(ctx, 'replyToSession'))).toContain('a reply does not end its work')
    // An approved task or a patrol is settled by its one reply, so its guide says so.
    for (const thread of ['subsession:task-d-1', 'subsession:patrol-d-1'])
      expect(sendMessageGuide({ ...ctx, thread }, 'replyToSession')).toMatchObject({
        availability: expect.stringContaining('send your parent one reply, at the end')
      })
    expect(sendMessageGuide({ ...ctx, thread: 'subsession:d-1' }, 'replyToSession')).not.toHaveProperty('availability')
    const send = toolsForIntegrations([slack as Integration]).find((tool) => tool.name === 'sendMessage')!
    expect(send.description).toContain('sends more work to one you started (sessionId: its childSessionId)')
    expect(send.description).toContain('sessionId continues its existing session from a childSessionId')
    expect(send.description).toContain('replies are never broadcast')
    const calls = examples(sendMessageGuide(ctx, 'callAgent')).map((example) => example.arguments)
    expect(calls[0]).not.toHaveProperty('sessionId')
    expect(calls).toContainEqual(expect.objectContaining({ sessionId: expect.any(String) }))
    for (const call of calls) expect('sessionId' in call && 'channel' in call).toBe(false)
  })

  it('tailors availability notes from trusted session context', () => {
    expect(sendMessageGuide(ctx, 'postMessage').availability).toBe(
      'Platforms: Slack. Direct messages: Slack. Thread updates: Slack.'
    )
    const bare = { ...ctx, integrations: [] }
    expect(sendMessageGuide(bare, 'postMessage').availability).toMatch(/^Unavailable here: .*no platform integration/)
    expect(sendMessageGuide(bare, 'callAgent').availability).toMatch(/^Postless calls only/)
    const inside = { ...ctx, thread: subsessionCoordinate('1') }
    expect(sendMessageGuide(inside, 'messageSubsession').availability).toMatch(/^Unavailable here: .*sub-session/)
    expect(sendMessageGuide(ctx, 'messageSubsession')).not.toHaveProperty('availability')
  })

  it('is served through executeTool without a platform connection', async () => {
    const { deps, touched } = effectBoundary()
    const guide = (await executeTool(ctx, 'getToolGuide', { tool: 'sendMessage', action: 'replyToSession' }, deps)) as {
      action: string
    }
    expect(guide.action).toBe('replyToSession')
    expect(touched).not.toContain('gatewayFor')
    await expect(executeTool(ctx, 'getToolGuide', { tool: 'listAgents' }, deps)).rejects.toThrow(
      /getToolGuide: invalid arguments — argument tool must be one of: sendMessage/
    )
  })
})
