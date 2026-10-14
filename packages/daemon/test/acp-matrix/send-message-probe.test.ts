import { describe, expect, it } from 'vitest'
import {
  aggregate,
  classifySendMessage,
  describeOp,
  IDS,
  judge,
  judgeVisibility,
  probeTools,
  SCENARIOS,
  sendMessageFixture,
  toolShape,
  validateSendMessage,
  type SendMessageRun
} from './send-message-probe.js'

const run = (scenario: string, verdict: SendMessageRun['verdict'], comparable = true): SendMessageRun => ({
  runtime: 'r',
  scenario: scenario as SendMessageRun['scenario'],
  rep: 1,
  comparable,
  verdict,
  ops: [],
  counts: { sendMessage: 0, getToolGuide: 0, otherMcp: 0, acpToolCalls: 0 },
  ms: 0,
  notes: []
})

const scenario = (id: string) => SCENARIOS.find((entry) => entry.id === id)!
const op = (args: Record<string, unknown>) => describeOp(classifySendMessage(args, IDS.self))

describe('runtime matrix sendMessage probe', () => {
  it('classifies the legacy target-inferred shape', () => {
    expect(op({ toAgent: { agentId: IDS.peer, needsReply: true }, message: 'm' })).toBe(
      `agent-call(${IDS.peer},needsReply)`
    )
    expect(op({ toAgent: IDS.self, message: 'm' })).toBe('subsession-create')
    expect(op({ toAgent: IDS.self, channel: IDS.workChannel, message: 'm' })).toBe(
      `agent-call(${IDS.self},channel=${IDS.workChannel})`
    )
    expect(op({ toUser: `<@${IDS.human}>`, message: 'm' })).toBe(`post-dm(${IDS.human})`)
    expect(op({ channel: IDS.updateChannel, thread: IDS.updateThread, message: 'm' })).toBe(
      `post-thread(${IDS.updateChannel},${IDS.updateThread})`
    )
    expect(op({ sessionId: IDS.origin, message: 'm' })).toBe(`origin-reply(${IDS.origin})`)
  })

  it('classifies the action shape to the same operations', () => {
    expect(op({ action: 'callAgent', toAgent: { agentId: IDS.peer, needsReply: 'true' }, message: 'm' })).toBe(
      `agent-call(${IDS.peer},needsReply)`
    )
    expect(op({ action: 'messageSubsession', message: 'm' })).toBe('subsession-create')
    expect(op({ action: 'messageSubsession', sessionId: IDS.child, message: 'm' })).toBe(
      `subsession-continue(${IDS.child})`
    )
    expect(op({ action: 'replyToSession', sessionId: IDS.origin, message: 'm' })).toBe(`origin-reply(${IDS.origin})`)
    expect(op({ action: 'postMessage', toUser: IDS.human, message: 'm' })).toBe(`post-dm(${IDS.human})`)
  })

  it('returns the daemon validation error a model reads', async () => {
    const tools = probeTools()
    expect(await validateSendMessage({ action: 'callAgent', toAgent: IDS.peer, message: 'm' }, tools)).toBeUndefined()
    expect(await validateSendMessage({ action: 'messageSubsession', message: 'm' }, tools)).toBeUndefined()
    expect(
      await validateSendMessage(
        { action: 'postMessage', channel: IDS.updateChannel, thread: IDS.updateThread, message: 'm' },
        tools
      )
    ).toBeUndefined()
    expect(
      await validateSendMessage(
        { action: 'callAgent', toAgent: IDS.peer, thread: IDS.updateThread, message: 'm' },
        tools
      )
    ).toMatch(/sendMessage: invalid arguments — action `callAgent` does not accept `thread`/)
  })

  it('rejects an action-less or self-postless call with the daemon’s own error', async () => {
    const tools = probeTools()
    expect(toolShape(tools)).toBe('action')
    const peer = scenario('ask-peer-for-result')
    const legacy = { toAgent: { agentId: IDS.peer, needsReply: true }, message: 'm' }
    const error = await validateSendMessage(legacy, tools)
    expect(error).toMatch(/missing required argument `action`/)
    expect(judge(peer, [{ tool: 'sendMessage', args: legacy, error: error! }]).verdict).toBe('FAIL')
    expect(await validateSendMessage({ ...legacy, action: 'wakeAgent' }, tools)).toMatch(/`action` must be one of/)
    expect(await validateSendMessage({ action: 'callAgent', toAgent: IDS.self, message: 'm' }, tools)).toMatch(
      /"action":"messageSubsession"/
    )
    expect(
      await validateSendMessage(
        { action: 'callAgent', toAgent: IDS.self, channel: IDS.workChannel, message: 'm' },
        tools
      )
    ).toBeUndefined()
  })

  it('refuses session ids outside the scenario scope', async () => {
    const reply = { action: 'replyToSession', sessionId: IDS.origin, message: 'm' }
    expect(await validateSendMessage(reply, probeTools(), { origin: IDS.origin })).toBeUndefined()
    // The daemon admits the continuation shape; its child check answers with a receipt, not an error.
    const continued = { action: 'messageSubsession', sessionId: IDS.child, message: 'm' }
    expect(await validateSendMessage(continued, probeTools(), { child: IDS.child })).toBeUndefined()
    expect(await validateSendMessage({ ...continued, sessionId: '' }, probeTools())).toMatch(
      /takes `sessionId` only as the nonempty `childSessionId`/
    )
    // Explicit peer sessions (§9): the daemon admits the shape; only its own rules on the combination refuse it.
    const peerSession = { action: 'callAgent', toAgent: IDS.peer, sessionId: IDS.child, message: 'm' }
    expect(await validateSendMessage(peerSession, probeTools())).toBeUndefined()
    expect(await validateSendMessage({ ...peerSession, channel: IDS.workChannel }, probeTools())).toMatch(
      /takes `channel` or `sessionId`, not both/
    )
    expect(await validateSendMessage({ ...peerSession, sessionId: '' }, probeTools())).toMatch(
      /takes `sessionId` only as the nonempty id of an existing session/
    )
    expect(await validateSendMessage({ ...peerSession, toAgent: IDS.self }, probeTools())).toMatch(
      /"action":"messageSubsession"/
    )
  })

  it('answers a peer-session call with the daemon’s receipt in scope, and its refusal outside it', async () => {
    const tools = probeTools()
    const fixture = await sendMessageFixture(tools)
    try {
      const call = async (key: string, sessionId: string) =>
        (await (
          await fetch((fixture.descriptor(key, { peerSession: IDS.child }) as { url: string }).url, {
            method: 'POST',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: {
                name: 'sendMessage',
                arguments: {
                  action: 'callAgent',
                  toAgent: { agentId: IDS.peer, needsReply: true },
                  sessionId,
                  message: 'm'
                }
              }
            })
          })
        ).json()) as { result: any }
      const joined = JSON.parse((await call('join', IDS.child)).result.content[0].text)
      expect(joined).toMatchObject({ ok: true, wake: { delivered: true }, childSessionId: IDS.child })
      expect(fixture.calls('join')[0]!.error).toBeUndefined()
      const other = JSON.parse((await call('other', IDS.origin)).result.content[0].text)
      expect(other.wake).toMatchObject({ delivered: false, reason: 'session_not_found' })
      expect(fixture.calls('other')[0]!.error).toBeDefined()
    } finally {
      fixture.server.close()
    }
  })

  it('answers a continuation with the daemon’s receipt, and an unowned id with its refusal', async () => {
    const tools = probeTools()
    const fixture = await sendMessageFixture(tools)
    try {
      const call = async (key: string, sessionId: string) =>
        (await (
          await fetch((fixture.descriptor(key, { child: IDS.child }) as { url: string }).url, {
            method: 'POST',
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'tools/call',
              params: { name: 'sendMessage', arguments: { action: 'messageSubsession', sessionId, message: 'm' } }
            })
          })
        ).json()) as { result: any }
      const owned = JSON.parse((await call('own', IDS.child)).result.content[0].text)
      expect(owned).toMatchObject({ ok: true, wake: { delivered: true }, childSessionId: IDS.child })
      expect(fixture.calls('own')[0]!.error).toBeUndefined()
      const other = JSON.parse((await call('other', IDS.origin)).result.content[0].text)
      expect(other.wake).toMatchObject({ delivered: false, reason: 'subsession_not_found' })
      expect(fixture.calls('other')[0]!.error).toBeDefined()
      expect(judge(scenario('continue-subsession'), fixture.calls('own')).verdict).toBe('PASS')
      expect(judge(scenario('continue-subsession'), fixture.calls('other')).verdict).toBe('FAIL')
    } finally {
      fixture.server.close()
    }
  })

  it('leaves new-only runs out of the matrix cell', () => {
    const cell = aggregate([run('ask-peer-for-result', 'PASS'), run('continue-subsession', 'FAIL', false)])
    expect(cell.status).toBe('ok')
    expect(cell.detail).toMatch(/^pass=1 degraded=0 fail=0 unavailable=0 new-only: continue-subsession#1=FAIL$/)
  })

  it('judges first-call correctness, late correction, and the negative case', () => {
    const peer = scenario('ask-peer-for-result')
    const right = { tool: 'sendMessage', args: { toAgent: { agentId: IDS.peer, needsReply: true }, message: 'm' } }
    const wrong = { tool: 'sendMessage', args: { toAgent: IDS.peer, message: 'm' } }
    expect(judge(peer, [right]).verdict).toBe('PASS')
    expect(judge(peer, [{ tool: 'getToolGuide', args: {} }, right]).verdict).toBe('PASS')
    expect(judge(peer, [wrong, right]).verdict).toBe('DEGRADED')
    expect(judge(peer, [right, wrong]).verdict).toBe('PASS')
    expect(judge(peer, [wrong]).verdict).toBe('FAIL')
    expect(judge(peer, []).verdict).toBe('FAIL')
    expect(judge(scenario('negative-current-thread'), []).verdict).toBe('PASS')
    expect(judge(scenario('negative-current-thread'), [right]).verdict).toBe('FAIL')
  })

  it('detects quoted description edges', () => {
    const description = probeTools().find((tool) => tool.name === 'sendMessage')!.description
    const notes = judgeVisibility(
      `YES\nFIRST: ${description.slice(0, 40)}\nLAST: ${description.slice(-40)}`,
      description
    )
    expect(notes.slice(0, 3)).toEqual(['hasTool=true', 'firstMatch=true', 'lastMatch=true'])
    expect(judgeVisibility('I will read the definition first.YES', description)[0]).toBe('hasTool=true')
    expect(judgeVisibility('NO, nothing yesterday', description)[0]).toBe('hasTool=false')
  })

  it('serves the real tools and records calls without effects', async () => {
    const tools = probeTools()
    const fixture = await sendMessageFixture(tools)
    try {
      const descriptor = fixture.descriptor('k', { origin: IDS.origin }) as { url: string }
      const rpc = async (method: string, params?: unknown) =>
        (await (
          await fetch(descriptor.url, {
            method: 'POST',
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
          })
        ).json()) as { result: any }
      expect((await rpc('tools/list')).result.tools).toEqual(tools)
      const reply = { action: 'replyToSession', sessionId: IDS.origin, message: 'm' }
      const call = await rpc('tools/call', { name: 'sendMessage', arguments: reply })
      expect(call.result.isError).toBeUndefined()
      expect(fixture.calls('k')).toEqual([{ tool: 'sendMessage', args: reply }])
      const guide = await rpc('tools/call', { name: 'getToolGuide', arguments: { tool: 'sendMessage' } })
      expect(JSON.parse(guide.result.content[0].text).actions).toHaveLength(4)
      const other = fixture.descriptor('other') as { url: string }
      const refused = (await (
        await fetch(other.url, {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: {
              name: 'sendMessage',
              arguments: { action: 'replyToSession', sessionId: IDS.origin, message: 'm' }
            }
          })
        })
      ).json()) as { result: any }
      expect(JSON.parse(refused.result.content[0].text)).toEqual({ delivered: false, reason: 'not_authorized' })
      expect(fixture.calls('other')[0]!.error).toBeDefined()
    } finally {
      fixture.server.close()
    }
  })
})
