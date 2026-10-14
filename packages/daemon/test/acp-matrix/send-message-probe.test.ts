import { describe, expect, it } from 'vitest'
import type { ToolDescriptor } from '../../src/tool-schema/descriptor.js'
import {
  actionRejection,
  aggregate,
  classifySendMessage,
  describeOp,
  IDS,
  judge,
  judgeVisibility,
  probeTools,
  SCENARIOS,
  sendMessageFixture,
  sessionRejection,
  toolShape,
  validateSendMessage,
  type SendMessageRun
} from './send-message-probe.js'

/** The real tools with `sendMessage` given the post-refactor `action` property, so the action-shape checks run today. */
function actionShapedTools(): ToolDescriptor[] {
  return probeTools().map((tool) => {
    if (tool.name !== 'sendMessage') return tool
    const schema = tool.inputSchema as { properties?: Record<string, unknown> }
    return {
      ...tool,
      inputSchema: {
        ...schema,
        properties: {
          action: { type: 'string', enum: ['callAgent', 'messageSubsession', 'replyToSession', 'postMessage'] },
          ...schema.properties
        }
      }
    } as unknown as ToolDescriptor
  })
}

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
    expect(await validateSendMessage({ toAgent: IDS.peer, message: 'm' }, tools)).toBeUndefined()
    expect(await validateSendMessage({ toAgent: IDS.self, message: 'm' }, tools)).toBeUndefined()
    expect(
      await validateSendMessage({ channel: IDS.updateChannel, thread: IDS.updateThread, message: 'm' }, tools)
    ).toBeUndefined()
    expect(await validateSendMessage({ toAgent: IDS.peer, thread: IDS.updateThread, message: 'm' }, tools)).toMatch(
      /sendMessage: invalid arguments/
    )
  })

  it('rejects an action-less or self-postless call whenever the served sendMessage takes an action', async () => {
    const tools = actionShapedTools()
    expect(toolShape(tools)).toBe('action')
    const peer = scenario('ask-peer-for-result')
    const legacy = { toAgent: { agentId: IDS.peer, needsReply: true }, message: 'm' }
    const error = await validateSendMessage(legacy, tools)
    expect(error).toMatch(/missing required argument `action`/)
    expect(judge(peer, [{ tool: 'sendMessage', args: legacy, error: error! }]).verdict).toBe('FAIL')
    expect(await validateSendMessage(legacy, probeTools())).toBeUndefined()
    // Today's daemon rejects `action` itself; these are the checks that apply once it accepts one.
    expect(actionRejection({ ...legacy, action: 'wakeAgent' })).toMatch(/`action` must be one of/)
    expect(actionRejection({ action: 'callAgent', toAgent: IDS.self, message: 'm' })).toMatch(
      /"action":"messageSubsession"/
    )
    expect(actionRejection({ action: 'callAgent', toAgent: IDS.self, channel: IDS.workChannel, message: 'm' })).toBe(
      undefined
    )
  })

  it('refuses session ids outside the scenario scope', async () => {
    const reply = { sessionId: IDS.origin, message: 'm' }
    expect(await validateSendMessage(reply, probeTools(), { origin: IDS.origin })).toBeUndefined()
    const continued = classifySendMessage({ action: 'messageSubsession', sessionId: IDS.child, message: 'm' }, IDS.self)
    expect(sessionRejection(continued, { child: IDS.child })).toBeUndefined()
    expect(sessionRejection(continued, {})).toMatch(/not a direct sub-session/)
    const peerSession = classifySendMessage(
      { action: 'callAgent', toAgent: IDS.peer, sessionId: IDS.child, message: 'm' },
      IDS.self
    )
    expect(sessionRejection(peerSession, { child: IDS.child })).toMatch(/not an existing session/)
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
      const call = await rpc('tools/call', { name: 'sendMessage', arguments: { sessionId: IDS.origin, message: 'm' } })
      expect(call.result.isError).toBeUndefined()
      expect(fixture.calls('k')).toEqual([{ tool: 'sendMessage', args: { sessionId: IDS.origin, message: 'm' } }])
      const other = fixture.descriptor('other') as { url: string }
      const refused = (await (
        await fetch(other.url, {
          method: 'POST',
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'sendMessage', arguments: { sessionId: IDS.origin, message: 'm' } }
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
